-- 快照/汇总（P 段）+ 远程命令应用与共享目标操作（Q 段）。
--
-- 红线：快照 schema me_controller.snapshot.v1 形状、命令种类及别名对、
-- mutating 命令必须带 commandId（幂等，账本去重）。
-- 共享目标操作（setTargetEnabled/resetTargetStateById/deleteTargetById/upsertTarget）
-- 是 ui.lua 与远程命令的单一实现；opts.uiEvents=true 时事件类型不带 remote_ 前缀
-- （保持两条路径的 events.log 输出与拆分前逐字一致）。
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
        runtime.state.targets[target.id] = { commitments = {} }
        runtime.dataById[target.id] = nil
        Planner.ensureTargetData(runtime, target)
        Util.logEvent(runtime, "WARN", eventName(opts, "target_state_reset"), { target = target.id, name = Items.displayName(target) })
        return { target = target.id }, true
    end

    function Commands.deleteTargetById(runtime, targetId, opts)
        local target, index = Core.findTarget(runtime, targetId)
        if not target then error("Unknown target: " .. tostring(targetId)) end
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

        local item = tostring(command.item or "")
        if item == "" then error("item is required") end

        local count = math.floor(tonumber(command.count or command.amount or command.requested) or 0)
        if count <= 0 then error("count must be positive") end

        local requestCommand = {
            id = commandId,
            source = tostring(command.source or "remote"),
            address = tostring(command.address or target.address or ""),
            item = item,
            count = count,
        }

        local ok, requested, err, duplicate = Core.executeRequestCommand(runtime, target, requestCommand)
        local itemIsTargetInput = false
        for _, input in ipairs(target.inputs or {}) do
            if input.item == item then itemIsTargetInput = true end
        end
        local trackCommitment = command.trackCommitment == true or (command.trackCommitment ~= false and itemIsTargetInput)
        if ok and requested > 0 and not duplicate and target.id ~= "remote" and trackCommitment then
            Planner.recordCommitment(StateStore.getTargetState(runtime.state, target), target, { [item] = requested }, requested, Util.now())
            Planner.updatePromiseData(runtime, target)
        end

        Core.saveState(runtime.state)
        return ok, {
            target = target.id,
            item = item,
            wanted = count,
            requested = requested,
            duplicate = duplicate,
            error = err and tostring(err) or nil,
        }, requested > 0
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
