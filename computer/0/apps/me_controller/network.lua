-- 唯一允许触碰外设（peripheral.* / stockTicker.*）的模块（I 段 + M 段 + G 段的
-- executeRequestCommand）。其他模块新增外设调用 = 破坏协作式多任务不变量。
--
-- 采用 function(Core) 工厂：refreshNetwork 需要回调仍在 core/planner 侧的
-- syncTargetData/ensureTargetData/updatePromiseData/buildDependencyPlan/
-- updateDemandData，经 Core 表晚绑定（planner.lua 归位后可改直连）。
return function(Core)
    local Util = require("util")
    local StateStore = require("state_store")
    local Tracking = require("tracking")

    local Network = {}

    local function hasType(name, wanted)
        for _, typeName in ipairs({ peripheral.getType(name) }) do
            if typeName == wanted then return true end
        end
        return false
    end

    local function findPeripheral(wanted, predicate)
        for _, name in ipairs(peripheral.getNames()) do
            if hasType(name, wanted) then
                local wrapped = peripheral.wrap(name)
                if not predicate or predicate(name, wrapped) then return name, wrapped end
            end
        end
        return nil, nil
    end

    function Network.discoverPeripherals(runtime)
        local monitorName, monitor = findPeripheral("monitor")
        local stockName, stockTicker = findPeripheral("Create_StockTicker")

        runtime.monitorName = monitorName
        runtime.monitor = monitor
        runtime.stockName = stockName
        runtime.stockTicker = stockTicker
    end

    function Network.readNetworkStock(stockTicker)
        if type(stockTicker.stock) ~= "function" then return nil, "stock() unavailable" end
        local ok, stock = pcall(function() return stockTicker.stock(false) end)
        if not ok then return nil, stock end

        local counts = {}
        local entries = 0
        for _, item in ipairs(stock or {}) do
            if item.name then
                local count = item.count or 0
                counts[item.name] = (counts[item.name] or 0) + count
                entries = entries + 1
            end
        end

        return { counts = counts, entries = entries }, nil
    end

    -- 请求命令统一为多物品形态：command.items = { {item,count}... }（兼容旧
    -- 单物品 command.item/count）。全部物品必须经一次 requestFiltered 变参调用
    -- 汇入同一 PackageOrder：理包机按订单合包，逐物品多次调用会把一批原料拆成
    -- 多个订单/包裹，需要"同批同包"的产线会因此卡死（勿改回逐物品循环）。
    local function commandItems(command)
        if type(command.items) == "table" and #command.items > 0 then return command.items end
        return { { item = command.item, count = command.count } }
    end

    function Network.executeRequestCommand(runtime, target, command)
        local commands = StateStore.commandState(runtime.state)
        local existing = StateStore.findCommandRecord(commands, command.id)
        local items = commandItems(command)
        if existing then
            Util.logEvent(runtime, "WARN", "command_duplicate", {
                commandId = command.id,
                target = target.id,
                items = items,
                status = existing.status,
            })
            return true, 0, nil, true
        end

        local filters = {}
        local wanted = 0
        local wantedByItem = {}
        for index, entry in ipairs(items) do
            filters[index] = { name = entry.item, _requestCount = entry.count }
            local count = tonumber(entry.count) or 0
            wanted = wanted + count
            wantedByItem[entry.item] = (wantedByItem[entry.item] or 0) + count
        end

        local timestamp = Util.now()
        local record = {
            id = command.id,
            kind = "request",
            source = command.source or "local",
            targetId = target.id,
            address = command.address,
            item = #items == 1 and items[1].item or nil,
            items = items,
            requested = 0,
            wanted = wanted,
            createdAt = timestamp,
            completedAt = timestamp,
        }

        -- 成功/失败两分支的日志字段原为两份近乎相同的表，合并为一处（计划定点改进）
        local details = {
            commandId = command.id,
            target = target.id,
            items = items,
            wanted = wanted,
            address = command.address,
        }

        -- 下单前置校验（严格对齐）：按最新网络库存全量校验，任一物品不足则整单
        -- 拒发。requestFiltered 本身是"有多少拿多少"语义，不校验就会在缺料时发出
        -- 原料不齐的订单——理包机合出的残缺包裹会卡死"同批同包"的产线。
        -- 读不到库存同样拒发：无法证明足额就不下单。
        local report, readErr = Network.readNetworkStock(runtime.stockTicker)
        if not report then
            local message = "Stock read failed before request: " .. tostring(readErr)
            record.status = "failed"
            record.error = message
            StateStore.rememberCommand(runtime.state, record)
            details.error = message
            Util.logEvent(runtime, "ERROR", "command_request_failed", details)
            return false, 0, message, false
        end

        local shortages = {}
        for _, entry in ipairs(items) do
            local want = wantedByItem[entry.item]
            if want then
                wantedByItem[entry.item] = nil
                local have = math.floor(report.counts[entry.item] or 0)
                if have < want then
                    shortages[#shortages + 1] = tostring(entry.item) .. " " .. tostring(have) .. "/" .. tostring(want)
                end
            end
        end
        if #shortages > 0 then
            local message = "Insufficient stock: " .. table.concat(shortages, ", ")
            record.status = "short"
            record.error = message
            StateStore.rememberCommand(runtime.state, record)
            details.error = message
            Util.logEvent(runtime, "WARN", "command_request_short", details)
            return false, 0, message, false
        end

        local ok, requested = pcall(function()
            return runtime.stockTicker.requestFiltered(command.address, table.unpack(filters))
        end)

        if ok then
            requested = math.max(0, tonumber(requested) or 0)
            record.requested = requested
            record.status = requested > 0 and "done" or "zero"
            StateStore.rememberCommand(runtime.state, record)
            details.requested = requested
            local level = requested >= wanted and "INFO" or "WARN"
            Util.logEvent(runtime, requested > 0 and level or "WARN", "command_request_" .. record.status, details)
            return true, requested, nil, false
        end

        record.status = "failed"
        record.error = tostring(requested)
        StateStore.rememberCommand(runtime.state, record)
        details.error = record.error
        Util.logEvent(runtime, "ERROR", "command_request_failed", details)
        return false, 0, requested, false
    end

    -- 原 refreshNetwork 里"无外设"与"读取失败"两段仅事件类型与 message 前缀不同，
    -- 合并为一处（计划定点改进；事件类型与 message 文本保持原样）
    local function markStockUnavailable(runtime, eventType, message, dataMessage)
        runtime.networkReady = false
        runtime.stockError = message
        runtime.stockCounts = {}
        runtime.dependencyDemandByTarget = {}
        runtime.dependencyPlan = nil
        if runtime.lastLoggedStockError ~= runtime.stockError then
            Util.logEvent(runtime, "ERROR", eventType, { message = runtime.stockError })
            runtime.lastLoggedStockError = runtime.stockError
        end
        for _, target in ipairs(runtime.targets) do
            local data = Core.ensureTargetData(runtime, target)
            data.status = "ERROR"
            data.message = dataMessage
            data.productCount = 0
            data.inputCount = 0
            Core.updatePromiseData(runtime, target)
        end
        return false
    end

    function Network.refreshNetwork(runtime)
        Network.discoverPeripherals(runtime)
        Core.syncTargetData(runtime)

        if not runtime.stockTicker then
            local message = "No Stock Ticker peripheral found"
            return markStockUnavailable(runtime, "stock_offline", message, message)
        end

        local report, err = Network.readNetworkStock(runtime.stockTicker)
        if not report then
            local message = tostring(err)
            return markStockUnavailable(runtime, "stock_read_failed", message, "Stock read failed: " .. message)
        end

        local dirty = false
        local timestamp = Util.now()
        runtime.networkReady = true
        runtime.stockError = nil
        if runtime.lastLoggedStockError then
            Util.logEvent(runtime, "INFO", "stock_recovered", { entries = report.entries or 0 })
            runtime.lastLoggedStockError = nil
        end
        runtime.stockCounts = report.counts or {}
        runtime.stockEntries = report.entries or 0
        runtime.lastStockReadAt = timestamp
        runtime.stockSerial = (runtime.stockSerial or 0) + 1

        for _, target in ipairs(runtime.targets) do
            local targetState = StateStore.getTargetState(runtime.state, target)
            local observed = Tracking.updateObservedProductCounts(targetState, target, runtime.stockCounts, timestamp)
            dirty = observed.dirty or dirty

            if observed.deliveredBatches > 0 then
                local reduced = Tracking.reduceCommitments(targetState, target,
                    Tracking.inputRequirementsForBatches(target, observed.deliveredBatches))
                if reduced > 0 then
                    targetState.totalSettledInputs = (targetState.totalSettledInputs or 0) + reduced
                    targetState.totalDeliveredProducts = (targetState.totalDeliveredProducts or 0) + observed.deliveredProducts
                    targetState.totalDeliveredBatches = (targetState.totalDeliveredBatches or 0) + observed.deliveredBatches
                    dirty = true
                end
            end
        end

        Core.buildDependencyPlan(runtime)
        for _, target in ipairs(runtime.targets) do Core.updateDemandData(runtime, target) end

        return dirty
    end

    return Network
end
