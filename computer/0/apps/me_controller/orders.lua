-- 订单管理（R 段）：所有下单路径的统一抽象——订单实体、排队派发、跟踪与取消。
-- 下单纳管：任何请求都先落成订单再触达外设，自动合成页按订单展示/取消。
-- 一张订单 = 一次 requestFiltered 变参调用 = 一个 PackageOrder（红线：一批
-- 原料必须合并为一次调用，理包机按订单合包，拆单会卡死同批同包的产线）。
--
-- 生命周期：
--   queued（排队，等原料齐备/外设可用，可真取消）
--   → dispatched（已派发，包裹物理在途）
--   → completed（目标联动单：承诺被交付结清；样板单：主产物库存较派发基线
--     增长达预期）| expired（跟踪窗口超时，生产可能仍在继续）
--   | failed（外设拒绝/0 接受）| cancelled（人工取消/目标重置删除联动）。
-- 取消语义：queued 是真取消（尚未发包）；dispatched 只能释放跟踪——Create
-- 物流没有召回 API，包裹已发出无法撤回，目标联动单同时移除对应承诺条目，
-- 让决策器重新评估缺口。
--
-- 预留接口（未来"手动请求自动合成"/合成链）：链式规划器把整条链拆成多张
-- 订单统一经 Orders.place 入队，共享 jobId 分组、父子经 parentOrderId 关联；
-- 订单实体、快照与前端均已携带这两个字段，扩链时无需再动协议。
--
-- 禁止 yield 约定同 planner：外设只经 Core.executeRequestCommand 触达；
-- 承诺联动读写 targetState，但不越权改 tracking 的 debounce 状态。
return function(Core)
    local Config = require("config")
    local Util = require("util")
    local StateStore = require("state_store")

    local Orders = {}

    local ACTIVE_STATUS = { queued = true, dispatched = true }

    function Orders.isActive(order)
        return order ~= nil and ACTIVE_STATUS[order.status] == true
    end

    local function ordersList(state)
        return StateStore.ordersState(state).list
    end

    local function findOrder(state, orderId)
        if not orderId then return nil end
        for _, order in ipairs(ordersList(state)) do
            if order.id == orderId then return order end
        end
        return nil
    end

    local function activeCount(state)
        local count = 0
        for _, order in ipairs(ordersList(state)) do
            if Orders.isActive(order) then count = count + 1 end
        end
        return count
    end

    local function normalizeEntries(rawEntries)
        local entries, total = {}, 0
        for _, entry in ipairs(rawEntries or {}) do
            local item = type(entry) == "table" and tostring(entry.item or "") or ""
            local count = math.floor(tonumber(type(entry) == "table" and entry.count or nil) or 0)
            if item ~= "" and count > 0 then
                entries[#entries + 1] = { item = item, count = count }
                total = total + count
            end
        end
        return entries, total
    end

    local function primaryProduct(order)
        return type(order.products) == "table" and order.products[1] or nil
    end

    -- spec = { kind, source, address, items, products?, recipeId?, recipeName?,
    --          targetId?, batches?, jobId?, parentOrderId?, ttlSeconds? }
    local function buildOrder(runtime, spec, status)
        local items, wanted = normalizeEntries(spec.items)
        if #items == 0 then error("Order needs at least one item") end
        local address = Util.trimText(spec.address or "")
        if address == "" then error("Order needs an address") end

        local order = {
            id = StateStore.nextOrderId(runtime.state),
            kind = tostring(spec.kind or "manual"),
            source = tostring(spec.source or "local"),
            status = status,
            address = address,
            items = items,
            wanted = wanted,
            requested = 0,
            createdAt = Util.now(),
        }
        if spec.recipeId then order.recipeId = tostring(spec.recipeId) end
        if spec.recipeName then order.recipeName = tostring(spec.recipeName) end
        if spec.targetId then order.targetId = tostring(spec.targetId) end
        if spec.jobId then order.jobId = tostring(spec.jobId) end
        if spec.parentOrderId then order.parentOrderId = tostring(spec.parentOrderId) end
        if spec.batches then order.batches = math.max(1, math.floor(tonumber(spec.batches) or 1)) end
        if spec.ttlSeconds then order.ttlSeconds = math.max(1, tonumber(spec.ttlSeconds) or 1) end

        local products = normalizeEntries(spec.products)
        if #products > 0 then order.products = products end

        local list = ordersList(runtime.state)
        list[#list + 1] = order
        return order
    end

    local function finish(runtime, order, status, note, level)
        order.status = status
        if note then order.note = note end
        order.completedAt = Util.now()
        Util.logEvent(runtime, level or "INFO", "order_" .. status, {
            order = order.id,
            kind = order.kind,
            target = order.targetId,
            recipe = order.recipeId,
            note = note,
        })
    end

    -- 缓存库存判可发但派发被严格校验拒绝（network.lua 的下单前置校验用的是
    -- 派发瞬间的新读数）属瞬态竞态：识别其两种报错前缀。排队单据此回退排队
    -- 下拍重试；立即派发路径（决策/催单）不重试，由调用方按失败处理。
    local TRANSIENT_DISPATCH_ERRORS = { "Insufficient stock: ", "Stock read failed before request: " }

    local function isTransientDispatchError(err)
        local message = tostring(err or "")
        for _, prefix in ipairs(TRANSIENT_DISPATCH_ERRORS) do
            if message:sub(1, #prefix) == prefix then return true end
        end
        return false
    end

    -- 派发 = 一次 executeRequestCommand（内部一次 requestFiltered 变参调用，
    -- 且带下单前置严格校验：库存不足/读不到库存整单拒发）。
    -- commandId 缺省用"订单 id_d尝试序号"（排队单可能多次尝试，每次要新 id
    -- 才不撞账本幂等去重）；远程 request 命令传入原 commandId，保持命令账本
    -- 的幂等去重锚点不变。allowDefer 时瞬态失败回退排队而非终态。
    local function dispatchOrder(runtime, order, dispatchTarget, commandId, allowDefer)
        order.dispatchAttempts = (order.dispatchAttempts or 0) + 1
        order.commandId = tostring(commandId or (order.id .. "_d" .. order.dispatchAttempts))
        local command = {
            id = order.commandId,
            source = order.source,
            address = order.address,
            -- 必须深拷贝：executeRequestCommand 会把 command.items 原样存进命令
            -- 账本（state.commands.history），与 state.orders.list 里的订单共享
            -- 同一张表会让 textutils.serialize 拒绝落盘（repeated entries），
            -- state.db 保存失败进而崩溃重启。
            items = Util.copyTable(order.items),
        }
        local ok, requested, err, duplicate =
            Core.executeRequestCommand(runtime, dispatchTarget or { id = "order" }, command)
        local timestamp = Util.now()

        if not ok then
            if allowDefer and isTransientDispatchError(err) then
                order.status = "queued"
                order.note = "Dispatch deferred: " .. tostring(err)
                Util.logEvent(runtime, "WARN", "order_deferred", { order = order.id, error = tostring(err) })
                return false, 0, err, false
            end
            order.error = tostring(err)
            finish(runtime, order, "failed", "Request failed", "ERROR")
            return false, 0, err, false
        end

        requested = math.max(0, tonumber(requested) or 0)
        if duplicate then
            finish(runtime, order, "cancelled", "Duplicate command, nothing dispatched", "WARN")
            return true, 0, nil, true
        end
        if requested <= 0 then
            order.error = "Network accepted 0 items"
            finish(runtime, order, "failed", "Network accepted 0 items", "WARN")
            return true, 0, nil, false
        end

        order.status = "dispatched"
        order.requested = requested
        order.dispatchedAt = timestamp
        order.expiresAt = timestamp + (tonumber(order.ttlSeconds) or Config.CONFIG.orderTtlSeconds)
        order.note = requested < order.wanted
            and ("Shortfall: network accepted " .. requested .. "/" .. order.wanted)
            or "Packages dispatched"

        -- 样板单产物基线：完成判定 = 主产物库存较派发时刻净增长达到预期。
        -- 并发消耗会压低净增长导致只能等超时，属已知取舍（诚实优于臆测）。
        local product = primaryProduct(order)
        if product then
            order.baselineProductCount = (runtime.stockCounts or {})[product.item] or 0
            order.deliveredProducts = 0
        end

        Util.logEvent(runtime, "INFO", "order_dispatched", {
            order = order.id,
            kind = order.kind,
            address = order.address,
            wanted = order.wanted,
            requested = requested,
        })
        return true, requested, nil, false
    end

    -- 公开入口一：排队下单（样板下单与未来合成链规划器都走这里）。
    -- 不检查外设/库存——那是 processOrders 的活，排队单等得起。
    function Orders.place(runtime, spec)
        if activeCount(runtime.state) >= Config.CONFIG.maxActiveOrders then
            error("Too many active orders (limit " .. Config.CONFIG.maxActiveOrders .. ")")
        end
        local order = buildOrder(runtime, spec, "queued")
        order.note = "Queued, waiting for dispatch"
        Util.logEvent(runtime, "INFO", "order_placed", {
            order = order.id,
            kind = order.kind,
            address = order.address,
            wanted = order.wanted,
        })
        return order
    end

    -- 公开入口二：立即派发（自动维持决策与目标缺料催单走这里——它们自带
    -- 冷却/合批/可负担判定，订单层只负责入账与后续跟踪）。
    -- opts.target 供命令账本记 targetId；opts.commandId 覆盖派发命令 id。
    function Orders.dispatchNow(runtime, spec, opts)
        opts = opts or {}
        local order = buildOrder(runtime, spec, "queued")
        local ok, requested, err, duplicate = dispatchOrder(runtime, order, opts.target, opts.commandId)
        return order, ok, requested, err, duplicate
    end

    -- 目标联动单：承诺入账后挂接跟踪（承诺条目带 orderId，结清/过期驱动订单
    -- 终态）。派发与承诺入账之间隔着外设 yield，期间订单按"未跟踪"处理，
    -- 避免 processOrders 在另一协程抢跑误判完成。
    function Orders.attachCommitment(runtime, targetState, orderId)
        if not orderId then return false end
        local order = findOrder(runtime.state, orderId)
        if not order or order.status ~= "dispatched" then return false end
        for _, promise in ipairs(targetState.commitments or {}) do
            if promise.orderId == orderId then
                order.tracked = true
                order.trackedInputs = tonumber(promise.amount) or 0
                order.remainingInputs = order.trackedInputs
                order.expiresAt = promise.expiresAt or order.expiresAt
                return true
            end
        end
        return false
    end

    local function targetStateFor(runtime, targetId)
        local target = Core.findTarget(runtime, targetId)
        if not target then return nil, nil end
        return StateStore.getTargetState(runtime.state, target), target
    end

    -- 目标联动单对账：承诺条目还在 → 同步剩余量；不在 → 结清（交付触发
    -- reduceCommitments 移除）或过期（pruneCommitments 移除），按 expiresAt
    -- 边界区分——临近过期时刻的消失按超时算，避免把过期误报成完成。
    local function reconcileTracked(runtime, order, timestamp)
        local targetState = targetStateFor(runtime, order.targetId)
        if not targetState then
            finish(runtime, order, "cancelled", "Target removed, tracking released", "WARN")
            return true
        end

        for _, promise in ipairs(targetState.commitments or {}) do
            if promise.orderId == order.id then
                local remaining = tonumber(promise.amount) or 0
                local dirty = false
                if order.remainingInputs ~= remaining then
                    order.remainingInputs = remaining
                    dirty = true
                end
                if promise.expiresAt and order.expiresAt ~= promise.expiresAt then
                    order.expiresAt = promise.expiresAt
                    dirty = true
                end
                return dirty
            end
        end

        if timestamp >= (order.expiresAt or 0) - 1 then
            finish(runtime, order, "expired", "Promise expired before delivery was observed", "WARN")
        else
            order.remainingInputs = 0
            finish(runtime, order, "completed", "Committed inputs settled by delivery")
        end
        return true
    end

    -- 样板单对账：主产物库存基线观测。
    local function reconcileBaseline(runtime, order, timestamp)
        local product = primaryProduct(order)
        local dirty = false

        if runtime.networkReady and product then
            local current = (runtime.stockCounts or {})[product.item] or 0
            local delivered = math.max(0, math.min(product.count, current - (order.baselineProductCount or 0)))
            if order.deliveredProducts ~= delivered then
                order.deliveredProducts = delivered
                dirty = true
            end
            if delivered >= product.count then
                finish(runtime, order, "completed", "Observed expected product delivery")
                return true
            end
        end

        if timestamp >= (order.expiresAt or 0) then
            finish(runtime, order, "expired", "Tracking window elapsed (production may still finish)", "WARN")
            return true
        end
        return dirty
    end

    -- 缺料判断按物品聚合：顺序敏感样板的同一物品拆成多条条目，逐条独立
    -- 判断会漏掉"单条够、合计超库存"的短缺——放行后必被派发前置严格校验
    -- 拒回，排队单每拍空转重试、命令账本反复记 short。
    local function firstShortage(order, available)
        local neededByItem = {}
        for _, entry in ipairs(order.items) do
            neededByItem[entry.item] = (neededByItem[entry.item] or 0) + entry.count
        end
        for _, entry in ipairs(order.items) do
            local have = available[entry.item] or 0
            local need = neededByItem[entry.item]
            if need > have then
                return entry, need - have
            end
        end
        return nil, 0
    end

    local function setNote(order, note)
        if order.note == note then return false end
        order.note = note
        return true
    end

    -- 排队单派发：外设可用且全部原料齐备才发（整单原料一次变参调用；缺一项
    -- 整单等待，不发残缺订单）。available 是本轮共享的可用量副本，派发后
    -- 扣减，防止同轮多张排队单重复认领同一批库存。
    local function processQueued(runtime, order, available)
        if not runtime.stockTicker then
            return setNote(order, "Waiting for Stock Ticker peripheral")
        end
        if not runtime.networkReady then
            return setNote(order, "Waiting for network stock: " .. tostring(runtime.stockError or "not ready"))
        end

        local missing, shortage = firstShortage(order, available)
        if missing then
            return setNote(order, "Missing " .. shortage .. "x " .. missing.item)
        end

        local dispatchTarget = { id = order.recipeId and ("recipe:" .. order.recipeId) or ("order:" .. order.kind) }
        local ok = dispatchOrder(runtime, order, dispatchTarget, nil, true)
        if ok then
            for _, entry in ipairs(order.items) do
                available[entry.item] = math.max(0, (available[entry.item] or 0) - entry.count)
            end
        end
        return true
    end

    -- 控制循环每个决策拍调用：排队单派发 + 在途单对账 + 终态历史裁剪。
    -- 只在实际变化时返回 dirty，避免每拍空转落盘。
    function Orders.processOrders(runtime)
        local list = ordersList(runtime.state)
        if #list == 0 then return false end

        local dirty = false
        local timestamp = Util.now()
        local available = Util.copyTable(runtime.stockCounts or {})

        for _, order in ipairs(list) do
            if order.status == "queued" then
                dirty = processQueued(runtime, order, available) or dirty
            elseif order.status == "dispatched" then
                if order.tracked and order.targetId then
                    dirty = reconcileTracked(runtime, order, timestamp) or dirty
                elseif primaryProduct(order) then
                    dirty = reconcileBaseline(runtime, order, timestamp) or dirty
                elseif timestamp >= (order.expiresAt or 0) then
                    finish(runtime, order, "expired", "No delivery tracking for this order", "WARN")
                    dirty = true
                end
            end
        end

        -- 终态订单裁剪：活动单永不裁，历史保最近 orderHistoryLimit 张
        local terminal = 0
        for _, order in ipairs(list) do
            if not Orders.isActive(order) then terminal = terminal + 1 end
        end
        local index = 1
        while terminal > Config.CONFIG.orderHistoryLimit and index <= #list do
            if Orders.isActive(list[index]) then
                index = index + 1
            else
                table.remove(list, index)
                terminal = terminal - 1
                dirty = true
            end
        end

        return dirty
    end

    -- 手动取消：queued 真取消；dispatched 释放跟踪并移除对应承诺条目（包裹
    -- 无法召回），让决策器按真实库存重新评估。
    function Orders.cancelOrder(runtime, orderId)
        orderId = Util.trimText(orderId or "")
        if orderId == "" then error("orderId is required") end
        local order = findOrder(runtime.state, orderId)
        if not order then error("Unknown order: " .. orderId) end
        if not Orders.isActive(order) then
            error("Order already finished: " .. orderId .. " (" .. tostring(order.status) .. ")")
        end

        local released = 0
        if order.status == "dispatched" and order.tracked and order.targetId then
            local targetState, target = targetStateFor(runtime, order.targetId)
            if targetState then
                local kept = {}
                for _, promise in ipairs(targetState.commitments or {}) do
                    if promise.orderId == order.id then
                        released = released + (tonumber(promise.amount) or 0)
                    else
                        kept[#kept + 1] = promise
                    end
                end
                targetState.commitments = kept
                if released > 0 and target then Core.updatePromiseData(runtime, target) end
            end
        end

        local note = order.status == "queued"
            and "Cancelled before dispatch"
            or "Tracking released; dispatched packages cannot be recalled"
        finish(runtime, order, "cancelled", note, "WARN")

        local result = { order = order.id, status = order.status }
        if released > 0 then result.releasedInputs = released end
        return result, true
    end

    -- 目标重置/删除联动：该目标的活动订单全部取消（承诺由调用方清理，这里
    -- 只收订单侧，避免对账把消失的承诺误判成交付完成）。
    function Orders.releaseTargetOrders(runtime, targetId, reason)
        local dirty = false
        for _, order in ipairs(ordersList(runtime.state)) do
            if Orders.isActive(order) and order.targetId == targetId then
                finish(runtime, order, "cancelled", reason or "Target state released", "WARN")
                dirty = true
            end
        end
        return dirty
    end

    -- 快照订单数组：新在前；活动单始终全量携带，终态单填充到 limit 为止。
    function Orders.snapshotOrders(runtime, limit)
        limit = math.max(1, math.floor(tonumber(limit) or Config.CONFIG.ordersSnapshotLimit))
        local list = ordersList(runtime.state)
        local out = {}
        for index = #list, 1, -1 do
            local order = list[index]
            if Orders.isActive(order) or #out < limit then
                out[#out + 1] = Util.copyTable(order)
            end
        end
        return out
    end

    return Orders
end
