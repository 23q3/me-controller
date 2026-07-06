-- 快照/汇总（P 段）+ 远程命令应用与共享目标/样板操作（Q 段）。
--
-- 红线：快照 schema me_controller.snapshot.v1 形状（recipes/recipeId/orders 为
-- additive 扩展）、命令种类及别名对（upsert_recipe/save_recipe 同 upsert_target/
-- save_target 的配对方式）、mutating 命令必须带 commandId（幂等，账本去重）。
-- 共享目标/样板操作（setTargetEnabled/resetTargetStateById/deleteTargetById/
-- upsertTarget/upsertRecipe/deleteRecipeById）
-- 是 ui.lua 与远程命令的单一实现；opts.uiEvents=true 时事件类型不带 remote_ 前缀
-- （保持两条路径的 events.log 输出与拆分前逐字一致）。
-- 下单纳管：request_recipe 入队订单（orders.lua），request 经订单层立即派发，
-- cancel_order 取消/释放跟踪——所有请求都以订单实体呈现在自动合成页。
return function(Core, Planner)
    local Util = require("util")
    local Items = require("items")
    local StateStore = require("state_store")

    local Commands = {}

    function Commands.summarize(runtime)
        local summary = {
            total = #runtime.targets,
            enabled = 0,
            requested = 0,
            waiting = 0,
            error = 0,
            satisfied = 0,
            disabled = 0,
        }

        for _, target in ipairs(runtime.targets) do
            if target.enabled then summary.enabled = summary.enabled + 1 end
            local data = runtime.dataById[target.id] or {}
            if data.status == "REQUESTED" then summary.requested = summary.requested + 1
            elseif data.status == "WAITING" then summary.waiting = summary.waiting + 1
            elseif data.status == "ERROR" then summary.error = summary.error + 1
            elseif data.status == "SATISFIED" then summary.satisfied = summary.satisfied + 1
            elseif data.status == "DISABLED" then summary.disabled = summary.disabled + 1 end
        end

        return summary
    end

    function Commands.makeSnapshot(runtime, options)
        options = options or {}
        local targets = {}

        for _, target in ipairs(runtime.targets or {}) do
            local data = runtime.dataById[target.id] or {}
            targets[#targets + 1] = {
                id = target.id,
                enabled = target.enabled,
                address = target.address,
                priority = target.priority,
                recipeId = target.recipeId,
                products = Util.copyTable(target.products or {}),
                inputs = Util.copyTable(target.inputs or {}),
                status = data.status,
                message = data.message,
                productCount = data.productCount,
                productCounts = Util.copyTable(data.productCounts or {}),
                inputCount = data.inputCount,
                inputCounts = Util.copyTable(data.inputCounts or {}),
                baseTargetCount = data.baseTargetCount,
                targetCount = data.targetCount,
                dependencyDemand = data.dependencyDemand,
                deficitProducts = data.deficitProducts,
                desiredBatches = data.desiredBatches,
                neededBatches = data.neededBatches,
                neededInputs = data.neededInputs,
                neededInputItems = Util.copyTable(data.neededInputItems or {}),
                promisedInputs = data.promisedInputs,
                promisedInputItems = Util.copyTable(data.promisedInputItems or {}),
                promisedBatches = data.promisedBatches,
                promisedProducts = data.promisedProducts,
                nextExpiry = data.nextExpiry,
                lastChangedAt = data.lastChangedAt,
            }
        end

        local snapshot = {
            schema = "me_controller.snapshot.v1",
            time = Util.now(),
            network = {
                ready = runtime.networkReady,
                error = runtime.stockError,
                stockEntries = runtime.stockEntries or 0,
                stockSerial = runtime.stockSerial or 0,
                lastStockReadAt = runtime.lastStockReadAt,
                stockName = runtime.stockName,
                monitorName = runtime.monitorName,
            },
            dependency = {
                passes = runtime.dependencyPlan and runtime.dependencyPlan.passes or 0,
                demandByTarget = Util.copyTable(runtime.dependencyDemandByTarget or {}),
            },
            summary = Commands.summarize(runtime),
            -- 样板库随快照下发（additive，schema 仍为 v1）：web 样板管理页与
            -- 目标编辑器的样板选择都以它为数据源
            recipes = Util.copyTable(runtime.recipes or {}),
            -- 订单随快照下发（additive）：自动合成页的数据源——活动单全量 +
            -- 最近终态单，新在前
            orders = Core.snapshotOrders(runtime, options.orderLimit),
            targets = targets,
            commands = StateStore.recentCommands(runtime.state, options.commandLimit or 20),
        }

        if options.includeStock then
            snapshot.stockCounts = Util.copyTable(runtime.stockCounts or {})
        end

        return snapshot
    end

    local function commandKindOf(command)
        return tostring(command and (command.kind or command.type) or "")
    end

    local function commandTargetId(command)
        if not command then return nil end
        if command.targetId then return tostring(command.targetId) end
        if type(command.target) == "table" then return command.target.id end
        if command.target then return tostring(command.target) end
        return nil
    end

    local function recordAppliedCommand(runtime, record, status, result, err)
        if not record then return false end
        record.status = status
        record.completedAt = Util.now()
        if err then record.error = tostring(err) end
        if result ~= nil and type(result) ~= "table" then record.result = tostring(result) end
        StateStore.rememberCommand(runtime.state, record)
        return true
    end

    local function eventName(opts, name)
        if opts and opts.uiEvents then return name end
        return "remote_" .. name
    end

    function Commands.setTargetEnabled(runtime, targetId, enabled, opts)
        local target = Core.findTarget(runtime, targetId)
        if not target then error("Unknown target: " .. tostring(targetId)) end
        target.enabled = Util.boolOrDefault(enabled, true)
        Core.saveRuntimeTargets(runtime)
        Util.logEvent(runtime, "INFO", eventName(opts, "target_toggled"), { target = target.id, enabled = target.enabled })
        return { target = target.id, enabled = target.enabled }, true
    end

    function Commands.resetTargetStateById(runtime, targetId, opts)
        local target = Core.findTarget(runtime, targetId)
        if not target then error("Unknown target: " .. tostring(targetId)) end
        -- 先收订单再清承诺：否则订单对账会把消失的承诺误判成交付完成
        Core.releaseTargetOrders(runtime, target.id, "Target state reset")
        runtime.state.targets[target.id] = { commitments = {} }
        runtime.dataById[target.id] = nil
        Planner.ensureTargetData(runtime, target)
        Util.logEvent(runtime, "WARN", eventName(opts, "target_state_reset"), { target = target.id, name = Items.displayName(target) })
        return { target = target.id }, true
    end

    function Commands.deleteTargetById(runtime, targetId, opts)
        local target, index = Core.findTarget(runtime, targetId)
        if not target then error("Unknown target: " .. tostring(targetId)) end
        Core.releaseTargetOrders(runtime, target.id, "Target deleted")
        table.remove(runtime.targets, index)
        runtime.state.targets[target.id] = nil
        runtime.dataById[target.id] = nil
        Core.saveRuntimeTargets(runtime)
        Util.logEvent(runtime, "WARN", eventName(opts, "target_deleted"), { target = target.id, name = Items.displayName(target) })
        return { target = target.id }, true
    end

    function Commands.upsertTarget(runtime, rawTarget, targetId, opts)
        if type(rawTarget) ~= "table" then error("target must be a table") end
        rawTarget = Util.copyTable(rawTarget)
        if targetId and not rawTarget.id then rawTarget.id = targetId end

        -- 样板是配方唯一权威：带 recipeId 的目标在规整前先把样板内容覆写进来
        --（未知样板直接报错）；不带 recipeId 的旧客户端 payload 仍按内嵌配方
        -- 保存，下次加载时由迁移逻辑挂接样板。
        local recipeId = Util.trimText(rawTarget.recipeId or "")
        if recipeId ~= "" then
            local recipe = Core.findRecipe(runtime.recipes, recipeId)
            if not recipe then error("Unknown recipe: " .. recipeId) end
            Core.resolveTarget(rawTarget, recipe)
        end

        local wantedId = targetId or rawTarget.id or rawTarget.targetId or rawTarget.productItem
        local _, existingIndex = Core.findTarget(runtime, wantedId)
        local oldId = existingIndex and runtime.targets[existingIndex].id or nil
        local existing = {}
        for _, target in ipairs(runtime.targets or {}) do
            if not oldId or target.id ~= oldId then existing[target.id] = true end
        end

        local normalized = Core.normalizeTarget(rawTarget, existing, existingIndex or (#runtime.targets + 1))
        if existingIndex then
            runtime.targets[existingIndex] = normalized
            if oldId ~= normalized.id then
                runtime.state.targets[normalized.id] = runtime.state.targets[oldId]
                runtime.state.targets[oldId] = nil
                runtime.dataById[oldId] = nil
            end
        else
            runtime.targets[#runtime.targets + 1] = normalized
        end

        Core.saveRuntimeTargets(runtime)
        Util.logEvent(runtime, "INFO", eventName(opts, existingIndex and "target_edited" or "target_added"), {
            target = normalized.id,
            name = Items.displayName(normalized),
        })
        return { target = normalized.id, name = Items.displayName(normalized) }, true
    end

    -- 样板 CRUD（ui.lua 与远程命令共用的单实现，语义对齐 upsertTarget）。
    -- 保存后立即把新配方内容重解析进所有引用它的目标——样板是配方唯一权威。
    function Commands.upsertRecipe(runtime, rawRecipe, recipeId, opts)
        if type(rawRecipe) ~= "table" then error("recipe must be a table") end
        rawRecipe = Util.copyTable(rawRecipe)
        if recipeId and not rawRecipe.id then rawRecipe.id = recipeId end

        local wantedId = recipeId or rawRecipe.id or rawRecipe.recipeId
        local _, existingIndex = Core.findRecipe(runtime.recipes, wantedId)
        local oldId = existingIndex and runtime.recipes[existingIndex].id or nil
        local existing = {}
        for _, recipe in ipairs(runtime.recipes or {}) do
            if not oldId or recipe.id ~= oldId then existing[recipe.id] = true end
        end

        local normalized = Core.normalizeRecipe(rawRecipe, existing, existingIndex or (#runtime.recipes + 1))
        if #(normalized.products or {}) == 0 then error("Recipe needs at least one product") end
        if #(normalized.inputs or {}) == 0 then error("Recipe needs at least one input") end

        if existingIndex then
            runtime.recipes[existingIndex] = normalized
            if oldId ~= normalized.id then
                -- 样板改名：同步所有引用它的目标
                for _, target in ipairs(runtime.targets or {}) do
                    if target.recipeId == oldId then target.recipeId = normalized.id end
                end
            end
        else
            runtime.recipes[#runtime.recipes + 1] = normalized
        end
        Core.saveRecipes(runtime.recipes)

        local touched = false
        for _, target in ipairs(runtime.targets or {}) do
            if target.recipeId == normalized.id then
                Core.resolveTarget(target, normalized)
                touched = true
            end
        end
        if touched then Core.saveRuntimeTargets(runtime) end

        Util.logEvent(runtime, "INFO", eventName(opts, existingIndex and "recipe_edited" or "recipe_added"), {
            recipe = normalized.id,
            name = normalized.name,
        })
        return { recipe = normalized.id, name = normalized.name }, true
    end

    function Commands.deleteRecipeById(runtime, recipeId, opts)
        local recipe, index = Core.findRecipe(runtime.recipes, recipeId)
        if not recipe then error("Unknown recipe: " .. tostring(recipeId)) end

        -- 被目标引用的样板拒删（AE2 语义：使用中的样板不可移除），
        -- 避免产生悬空 recipeId
        local users = {}
        for _, target in ipairs(runtime.targets or {}) do
            if target.recipeId == recipe.id then users[#users + 1] = target.id end
        end
        if #users > 0 then
            error("Recipe in use by: " .. table.concat(users, ", "))
        end

        table.remove(runtime.recipes, index)
        Core.saveRecipes(runtime.recipes)
        Util.logEvent(runtime, "WARN", eventName(opts, "recipe_deleted"), { recipe = recipe.id, name = recipe.name })
        return { recipe = recipe.id }, true
    end

    -- 样板下单 = 排队一张合成订单（下单纳管：不再直接请求外设 API）。控制
    -- 循环的 processOrders 在原料齐备时一次性派发（一次 requestFiltered 变参
    -- 调用 = 同一 PackageOrder），原料不足时排队等待，可在自动合成页取消。
    -- 样板订单不参与承诺跟踪——按主产物库存基线观测完成；相关目标会把到货
    -- 当作外部入库观测。
    -- jobId/parentOrderId 原样透传：预留给未来"手动请求自动合成"的合成链
    -- 规划器（整条链拆成多张订单共享 jobId、父子经 parentOrderId 关联，均经
    -- 此路径/Orders.place 入队），扩链时协议无需再动。
    local function applyRequestRecipe(runtime, command, commandId)
        local recipeId = command.recipeId or command.recipe
        local recipe = Core.findRecipe(runtime.recipes, recipeId)
        if not recipe then error("Unknown recipe: " .. tostring(recipeId)) end

        local batches = math.floor(tonumber(command.batches or command.count) or 1)
        if batches <= 0 then error("batches must be positive") end
        if #(recipe.inputs or {}) == 0 then error("Recipe has no inputs: " .. recipe.id) end

        local items = {}
        local wanted = 0
        for _, input in ipairs(recipe.inputs) do
            local amount = math.ceil((tonumber(input.count) or 0) * batches)
            if amount > 0 then
                items[#items + 1] = { item = input.item, count = amount }
                wanted = wanted + amount
            end
        end
        if #items == 0 then error("Recipe inputs are empty: " .. recipe.id) end

        local products = {}
        for _, product in ipairs(recipe.products or {}) do
            local amount = math.ceil((tonumber(product.count) or 0) * batches)
            if amount > 0 then products[#products + 1] = { item = product.item, count = amount } end
        end

        local order = Core.placeOrder(runtime, {
            kind = "recipe",
            source = tostring(command.source or "remote"),
            recipeId = recipe.id,
            recipeName = recipe.name,
            address = recipe.address,
            batches = batches,
            items = items,
            products = products,
            jobId = command.jobId,
            parentOrderId = command.parentOrderId,
        })
        -- 原料已齐时立刻试派发：命令响应与紧随的快照直接看到在途状态
        Core.processOrders(runtime)

        return {
            order = order.id,
            status = order.status,
            note = order.note,
            recipe = recipe.id,
            name = recipe.name,
            address = recipe.address,
            batches = batches,
            items = items,
            wanted = wanted,
        }, true
    end

    local function applyRemoteRequest(runtime, command, commandId)
        if not runtime.stockTicker then error("No Stock Ticker peripheral found") end

        local target = nil
        if command.targetId or command.target then
            target = Core.findTarget(runtime, command.targetId or command.target)
            if not target then error("Unknown target: " .. tostring(command.targetId or command.target)) end
        end
        if not target then
            target = {
                id = "remote",
                address = tostring(command.address or ""),
                promiseTtlSeconds = Core.TARGET_DEFAULTS.promiseTtlSeconds,
                inputs = {},
                products = {},
            }
        end

        -- 多物品：command.items = {{item,count}...}；兼容旧单物品 item/count。
        -- 全部物品并入一条命令 = 一张订单（同一 PackageOrder），理包机才能合包
        local rawItems = command.items
        if type(rawItems) ~= "table" or #rawItems == 0 then
            rawItems = { { item = command.item, count = command.count or command.amount or command.requested } }
        end

        local items = {}
        local wanted = 0
        for _, entry in ipairs(rawItems) do
            local item = type(entry) == "table" and tostring(entry.item or "") or ""
            local count = math.floor(tonumber(type(entry) == "table" and entry.count or nil) or 0)
            if item == "" then error("item is required") end
            if count <= 0 then error("count must be positive") end
            items[#items + 1] = { item = item, count = count }
            wanted = wanted + count
        end

        -- 目标绑定的人工请求必须整批对齐样板：覆盖全部原料、每种数量 = 每批消耗 ×
        -- 同一整批数。残缺/畸比订单即使库存足额也会破坏"同批同包"产线的批次完整性
        if #(target.inputs or {}) > 0 then
            local wantedByItem = {}
            for _, entry in ipairs(items) do
                wantedByItem[entry.item] = (wantedByItem[entry.item] or 0) + entry.count
            end
            local batches = nil
            for _, input in ipairs(target.inputs) do
                local per = math.floor(tonumber(input.count) or 0)
                if per > 0 then
                    local got = wantedByItem[input.item] or 0
                    if got <= 0 then
                        error("Request must cover all recipe inputs, missing: " .. Items.entryLabel(input))
                    end
                    if got % per ~= 0 then
                        error("Request must be whole batches: " .. Items.entryLabel(input)
                            .. " " .. got .. " is not a multiple of " .. per)
                    end
                    local itemBatches = got / per
                    batches = batches or itemBatches
                    if itemBatches ~= batches then
                        error("Request items are not in recipe ratio (every input must cover the same batch count)")
                    end
                    wantedByItem[input.item] = nil
                end
            end
            for item in pairs(wantedByItem) do
                error("Requested item is not a recipe input: " .. tostring(item))
            end
        end

        -- 下单纳管：经订单层立即派发（订单实体入账，自动合成页可见/可取消）。
        -- 派发命令 id 沿用远程 commandId，保持账本幂等去重锚点不变。
        local order, ok, requested, err, duplicate = Core.dispatchOrderNow(runtime, {
            kind = "manual",
            source = tostring(command.source or "remote"),
            targetId = target.id ~= "remote" and target.id or nil,
            address = tostring(command.address or target.address or ""),
            items = items,
            ttlSeconds = target.promiseTtlSeconds,
        }, { target = target, commandId = commandId })

        -- 承诺跟踪：只入账属于目标原料的条目；回包只有总数，按下单量全额入账
        -- （宁可虚高等 TTL 自愈，不低记引发重复下单）
        local trackable, trackableTotal = {}, 0
        for _, entry in ipairs(items) do
            for _, input in ipairs(target.inputs or {}) do
                if input.item == entry.item then
                    trackable[entry.item] = (trackable[entry.item] or 0) + entry.count
                    trackableTotal = trackableTotal + entry.count
                    break
                end
            end
        end
        local trackCommitment = command.trackCommitment ~= false and trackableTotal > 0
        if ok and requested > 0 and not duplicate and target.id ~= "remote" and trackCommitment then
            local targetState = StateStore.getTargetState(runtime.state, target)
            Planner.recordCommitment(targetState, target, trackable, trackableTotal, Util.now(), order.id)
            -- 承诺入账后挂接订单跟踪：结清/过期驱动订单终态与进度显示
            Core.attachOrderCommitment(runtime, targetState, order.id)
            Planner.updatePromiseData(runtime, target)
        end

        Core.saveState(runtime.state)
        return ok, {
            target = target.id,
            order = order.id,
            item = #items == 1 and items[1].item or nil,
            items = items,
            wanted = wanted,
            requested = requested,
            duplicate = duplicate,
            error = err and tostring(err) or nil,
        }, true
    end

    function Commands.applyCommand(runtime, command)
        if type(command) ~= "table" then
            return false, { ok = false, error = "command must be a table" }, false
        end

        local kind = commandKindOf(command)
        if kind == "" then return false, { ok = false, error = "command kind is required" }, false end

        local commandId = Util.commandIdOf(command)
        local mutating = kind ~= "ping" and kind ~= "snapshot"
        if mutating and not commandId then
            return false, { ok = false, error = "commandId is required for mutating commands" }, false
        end

        if commandId then
            local existing = StateStore.findCommandRecord(StateStore.commandState(runtime.state), commandId)
            if existing then
                Util.logEvent(runtime, "WARN", "remote_command_duplicate", {
                    commandId = commandId,
                    kind = kind,
                    status = existing.status,
                })
                return true, { ok = true, duplicate = true, commandId = commandId, record = Util.copyTable(existing) }, false
            end
        end

        if kind == "request" then
            local ok, result, dirty = pcall(function()
                local requestOk, requestResult, requestDirty = applyRemoteRequest(runtime, command, commandId)
                if not requestOk then error(requestResult.error or "request failed") end
                return requestResult, requestDirty
            end)
            if ok then
                return true, { ok = true, commandId = commandId, kind = kind, result = result }, dirty
            end
            StateStore.rememberCommand(runtime.state, {
                id = commandId,
                kind = kind,
                source = tostring(command.source or "remote"),
                targetId = commandTargetId(command),
                createdAt = Util.now(),
                completedAt = Util.now(),
                status = "failed",
                error = tostring(result),
            })
            Core.saveState(runtime.state)
            return false, { ok = false, commandId = commandId, kind = kind, error = tostring(result) }, true
        end

        local record = nil
        if commandId then
            record = {
                id = commandId,
                kind = kind,
                source = tostring(command.source or "remote"),
                targetId = commandTargetId(command),
                createdAt = Util.now(),
            }
        end

        local ok, result, dirty = pcall(function()
            if kind == "ping" then
                return { pong = true, time = Util.now() }, false
            elseif kind == "snapshot" then
                return Commands.makeSnapshot(runtime, command.options or {}), false
            elseif kind == "set_enabled" or kind == "target_enabled" then
                return Commands.setTargetEnabled(runtime, command.targetId or command.target, command.enabled)
            elseif kind == "reset_target_state" or kind == "reset_target" then
                return Commands.resetTargetStateById(runtime, command.targetId or command.target)
            elseif kind == "delete_target" then
                return Commands.deleteTargetById(runtime, command.targetId or command.target)
            elseif kind == "upsert_target" or kind == "save_target" then
                return Commands.upsertTarget(runtime, command.target, command.targetId)
            elseif kind == "upsert_recipe" or kind == "save_recipe" then
                return Commands.upsertRecipe(runtime, command.recipe, command.recipeId)
            elseif kind == "delete_recipe" then
                return Commands.deleteRecipeById(runtime, command.recipeId or command.recipe)
            elseif kind == "request_recipe" then
                return applyRequestRecipe(runtime, command, commandId)
            elseif kind == "cancel_order" then
                return Core.cancelOrder(runtime, command.orderId or command.order)
            elseif kind == "reload_targets" then
                Core.reloadTargets(runtime)
                Util.logEvent(runtime, "INFO", "remote_targets_reloaded", {})
                return { targets = #runtime.targets }, true
            end
            error("Unknown command kind: " .. kind)
        end)

        if ok then
            local recordDirty = recordAppliedCommand(runtime, record, "done", result, nil)
            if dirty or recordDirty then Core.saveState(runtime.state) end
            return true, { ok = true, commandId = commandId, kind = kind, result = result }, dirty or recordDirty
        end

        recordAppliedCommand(runtime, record, "failed", nil, result)
        Core.saveState(runtime.state)
        Util.logEvent(runtime, "ERROR", "remote_command_failed", {
            commandId = commandId,
            kind = kind,
            error = tostring(result),
        })
        return false, { ok = false, commandId = commandId, kind = kind, error = tostring(result) }, true
    end

    return Commands
end
