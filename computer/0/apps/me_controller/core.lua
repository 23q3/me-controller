local Config = require("config")
local Util = require("util")
local Items = require("items")
local TargetsStore = require("targets_store")
local StateStore = require("state_store")
local Tracking = require("tracking")

local Core = {}

-- 配置常量（config.lua)。CONFIG 与 config.lua 是同一张表：
-- main.lua 启动时经 Core.CONFIG 原地改写文件路径，util.lua 内部读的也是它。
Core.CONFIG = Config.CONFIG
Core.TARGET_DEFAULTS = Config.TARGET_DEFAULTS
Core.DEFAULT_TARGETS = Config.DEFAULT_TARGETS

-- 通用工具（util.lua）重导出；ui.lua / bridge.lua 一律经 Core 消费单实现
Core.nowSeconds = Util.nowSeconds
Core.now = Util.now
Core.copyTable = Util.copyTable
Core.logEvent = Util.logEvent
Core.readEventLog = Util.readEventLog
Core.readSerialized = Util.readSerialized
Core.writeSerialized = Util.writeSerialized
Core.commandIdOf = Util.commandIdOf

-- 物品/配方纯函数（items.lua）重导出
Core.normalizeId = Items.normalizeId
Core.defaultDisplayName = Items.defaultDisplayName
Core.displayName = Items.displayName
Core.formatRecipeEntries = Items.formatRecipeEntries
Core.parseRecipeEntries = Items.parseRecipeEntries
Core.productsToInputs = Items.productsToInputs
Core.inputsToProducts = Items.inputsToProducts

-- 目标存取（targets_store.lua）重导出
Core.normalizeTarget = TargetsStore.normalizeTarget
Core.normalizeTargets = TargetsStore.normalizeTargets
Core.saveTargets = TargetsStore.saveTargets
Core.loadTargets = TargetsStore.loadTargets
Core.findTarget = TargetsStore.findTarget

-- 状态/账本存取（state_store.lua）重导出
Core.loadState = StateStore.loadState
Core.saveState = StateStore.saveState
Core.resetAllState = StateStore.resetAllState
Core.getTargetState = StateStore.getTargetState
Core.recentCommands = StateStore.recentCommands
Core.pruneOrphanedTargetState = StateStore.pruneOrphanedTargetState

-- 外设访问（network.lua，function(Core) 工厂：refreshNetwork 经 Core 回调
-- planner 的 syncTargetData/ensureTargetData/updatePromiseData/buildDependencyPlan/updateDemandData）
local Network = require("network")(Core)
Core.discoverPeripherals = Network.discoverPeripherals
Core.readNetworkStock = Network.readNetworkStock
Core.refreshNetwork = Network.refreshNetwork
Core.executeRequestCommand = Network.executeRequestCommand

-- 规划与目标数据同步（planner.lua，function(Core) 工厂：requestPlan 经
-- Core.executeRequestCommand 触达外设）
local Planner = require("planner")(Core)
Core.buildDependencyPlan = Planner.buildDependencyPlan
Core.updateDemandData = Planner.updateDemandData
Core.updatePromiseData = Planner.updatePromiseData
Core.ensureTargetData = Planner.ensureTargetData
Core.syncTargetData = Planner.syncTargetData

-- 本文件沿用的短名
local numberOrDefault = Util.numberOrDefault
local boolOrDefault = Util.boolOrDefault
local trimText = Util.trimText
local formatNumber = Util.formatNumber
local commandIdOf = Util.commandIdOf
local recipeInputCounts = Items.recipeInputCounts
local productCountPerBatch = Items.productCountPerBatch
local primaryProduct = Items.primaryProduct
local entryLabel = Items.entryLabel
local commandState = StateStore.commandState
local findCommandRecord = StateStore.findCommandRecord
local rememberCommand = StateStore.rememberCommand
local nextLocalCommandId = StateStore.nextLocalCommandId
local sumCommitments = Tracking.sumCommitments
local inputTotalsToBatches = Tracking.inputTotalsToBatches
local inputRequirementsForBatches = Tracking.inputRequirementsForBatches
local inputPlanForBatches = Tracking.inputPlanForBatches
local pruneCommitments = Tracking.pruneCommitments
local reduceCommitments = Tracking.reduceCommitments
local clearPendingRequest = Tracking.clearPendingRequest
local clearDeficitConfirmation = Tracking.clearDeficitConfirmation
local confirmDeficit = Tracking.confirmDeficit
local nextExpiry = Tracking.nextExpiry
local productTargetCount = Tracking.productTargetCount
local desiredBatchesForTarget = Tracking.desiredBatchesForTarget
local inputStockCounts = Tracking.inputStockCounts
local updateObservedProductCounts = Tracking.updateObservedProductCounts
local stockCountsForTarget = Tracking.stockCountsForTarget
local effectiveStockCounts = Tracking.effectiveStockCounts
local firstMissingInput = Planner.firstMissingInput
local producerForItem = Planner.producerForItem
local dependencyBlockedForInput = Planner.dependencyBlockedForInput
local buildRequestPlan = Planner.buildRequestPlan
local recordCommitment = Planner.recordCommitment
local requestPlan = Planner.requestPlan
local requestSummary = Planner.requestSummary
local updateDemandData = Planner.updateDemandData
local syncTargetData = Planner.syncTargetData
local ensureTargetData = Planner.ensureTargetData
local buildDependencyPlan = Planner.buildDependencyPlan

function Core.saveRuntimeTargets(runtime)
    runtime.targets = Core.normalizeTargets(runtime.targets or {})
    Core.saveTargets(runtime.targets)
    if Core.syncTargetData then Core.syncTargetData(runtime) end
    return true
end

local function decideTarget(runtime, target, availableInputs)
    local data = Core.ensureTargetData(runtime, target)
    local targetState = Core.getTargetState(runtime.state, target)
    local timestamp = Core.now()
    local expired = pruneCommitments(targetState, target, timestamp)
    local dirty = expired > 0
    local previousStatus = data.status
    local previousMessage = data.message

    updateDemandData(runtime, target)

    if not target.enabled then
        dirty = clearPendingRequest(targetState) or dirty
        dirty = clearDeficitConfirmation(targetState) or dirty
        data.status = "DISABLED"
        data.message = "Target disabled"
    elseif not runtime.stockTicker then
        dirty = clearPendingRequest(targetState) or dirty
        dirty = clearDeficitConfirmation(targetState) or dirty
        data.status = "ERROR"
        data.message = "No Stock Ticker peripheral found"
    elseif not runtime.networkReady then
        dirty = clearPendingRequest(targetState) or dirty
        dirty = clearDeficitConfirmation(targetState) or dirty
        data.status = "ERROR"
        data.message = "Stock read failed: " .. tostring(runtime.stockError)
    elseif (data.desiredBatches or 0) <= 0 then
        dirty = clearPendingRequest(targetState) or dirty
        dirty = clearDeficitConfirmation(targetState) or dirty
        data.status = "SATISFIED"
        data.message = "ME target met"
    elseif data.neededInputs <= 0 then
        dirty = clearPendingRequest(targetState) or dirty
        dirty = clearDeficitConfirmation(targetState) or dirty
        data.status = "WAITING"
        data.message = "Waiting for promised output"
    else
        local deficitConfirmed, confirmAge, confirmScans, confirmDirty = confirmDeficit(runtime, targetState, target, data, timestamp)
        dirty = confirmDirty or dirty

        if not deficitConfirmed then
            dirty = clearPendingRequest(targetState) or dirty
            data.status = "WAITING"
            data.message = "Confirming low stock "
                .. tostring(confirmScans) .. "/" .. tostring(target.deficitConfirmScans)
                .. " " .. tostring(math.floor(confirmAge)) .. "s"
        elseif firstMissingInput(target, data.neededInputItems, availableInputs) then
            local missing = firstMissingInput(target, data.neededInputItems, availableInputs)
            local producer = producerForItem(runtime, missing.item)
            dirty = clearPendingRequest(targetState) or dirty
            data.status = "WAITING"
            if dependencyBlockedForInput(runtime, target, missing.item) then
                data.message = "Dependency cycle blocks " .. entryLabel(missing)
            elseif producer then
                data.message = "Waiting for " .. Core.displayName(producer.target) .. " -> " .. entryLabel(missing)
            else
                data.message = "No " .. entryLabel(missing) .. " in network"
            end
        else
            local outstandingRoom = math.max(0, target.maxOutstandingInputs - data.promisedInputs)
            local _, committedTotals = sumCommitments(targetState, target)
            local plan, requestCount, canFinishDeficit = buildRequestPlan(
                target,
                data.desiredBatches or 0,
                committedTotals,
                availableInputs,
                outstandingRoom
            )
            local canSendBatch = requestCount >= target.minImmediateRequest
            local pendingAge = 0
            local delayedReady = false

            if requestCount > 0 and not canFinishDeficit and not canSendBatch then
                if not targetState.pendingRequestSince or not targetState.pendingRequestAmount or requestCount < targetState.pendingRequestAmount then
                    targetState.pendingRequestSince = timestamp
                    dirty = true
                end
                if targetState.pendingRequestAmount ~= requestCount then
                    targetState.pendingRequestAmount = requestCount
                    dirty = true
                end
                pendingAge = timestamp - targetState.pendingRequestSince
                delayedReady = pendingAge >= target.delayedRequestSeconds
            end

            if requestCount <= 0 then
                dirty = clearPendingRequest(targetState) or dirty
                data.status = "WAITING"
                if outstandingRoom <= 0 then
                    data.message = "Outstanding request cap reached"
                else
                    data.message = "Waiting for available inputs"
                end
            elseif targetState.lastRequestAt and timestamp - targetState.lastRequestAt < target.requestCooldownSeconds then
                data.status = "WAITING"
                data.message = "Request cooldown"
            elseif not canFinishDeficit and not canSendBatch and not delayedReady then
                data.status = "WAITING"
                data.message = "Batching " .. requestCount .. "/" .. target.minImmediateRequest .. " " .. pendingAge .. "s"
            else
                local ok, requestedByItem, requested, err, commandDirty = requestPlan(runtime, target, plan, availableInputs)
                dirty = commandDirty or dirty
                requested = tonumber(requested) or 0
                if requested > 0 then
                    recordCommitment(targetState, target, requestedByItem, requested, timestamp)
                    dirty = true
                end

                if ok then
                    targetState.lastRequestAt = timestamp
                    dirty = clearPendingRequest(targetState) or true

                    if requested > 0 then
                        updateDemandData(runtime, target)
                        data.status = "REQUESTED"
                        data.message = "Requested " .. requestSummary(target, requestedByItem, requested) .. " to " .. target.address
                    else
                        data.status = "WAITING"
                        data.message = "Network accepted 0 items"
                    end
                else
                    data.status = "ERROR"
                    if requested > 0 then
                        updateDemandData(runtime, target)
                        data.message = "Partial request then failed: " .. tostring(err)
                    else
                        data.message = "Request failed: " .. tostring(err)
                    end
                end
            end
        end
    end

    if data.status ~= previousStatus or data.message ~= previousMessage then
        Core.logEvent(runtime, data.status == "ERROR" and "ERROR" or "INFO", "target_status", {
            target = target.id,
            status = data.status,
            message = data.message,
            product = data.productCount,
            targetCount = data.targetCount,
            neededInputs = data.neededInputs,
            promisedInputs = data.promisedInputs,
            chain = data.dependencyDemand,
        })
    end

    data.lastChangedAt = timestamp
    return dirty
end

function Core.decideTargets(runtime)
    Core.discoverPeripherals(runtime)
    Core.syncTargetData(runtime)

    local dirty = false
    local timestamp = Core.now()
    for _, target in ipairs(runtime.targets) do
        local targetState = Core.getTargetState(runtime.state, target)
        local expired = pruneCommitments(targetState, target, timestamp)
        if expired > 0 then
            Core.logEvent(runtime, "WARN", "promise_expired", {
                target = target.id,
                amount = expired,
            })
            dirty = true
        end
    end

    if runtime.networkReady then
        buildDependencyPlan(runtime)
    else
        runtime.dependencyDemandByTarget = {}
        runtime.dependencyPlan = nil
    end

    local availableInputs = Core.copyTable(runtime.stockCounts or {})
    local plannedTargets = runtime.dependencyPlan and runtime.dependencyPlan.targets or runtime.targets

    for _, target in ipairs(plannedTargets) do
        dirty = decideTarget(runtime, target, availableInputs) or dirty
    end

    return dirty
end

function Core.summarize(runtime)
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

function Core.makeSnapshot(runtime, options)
    options = options or {}
    local targets = {}

    for _, target in ipairs(runtime.targets or {}) do
        local data = runtime.dataById[target.id] or {}
        targets[#targets + 1] = {
            id = target.id,
            enabled = target.enabled,
            address = target.address,
            priority = target.priority,
            products = Core.copyTable(target.products or {}),
            inputs = Core.copyTable(target.inputs or {}),
            status = data.status,
            message = data.message,
            productCount = data.productCount,
            productCounts = Core.copyTable(data.productCounts or {}),
            inputCount = data.inputCount,
            inputCounts = Core.copyTable(data.inputCounts or {}),
            baseTargetCount = data.baseTargetCount,
            targetCount = data.targetCount,
            dependencyDemand = data.dependencyDemand,
            deficitProducts = data.deficitProducts,
            desiredBatches = data.desiredBatches,
            neededBatches = data.neededBatches,
            neededInputs = data.neededInputs,
            neededInputItems = Core.copyTable(data.neededInputItems or {}),
            promisedInputs = data.promisedInputs,
            promisedInputItems = Core.copyTable(data.promisedInputItems or {}),
            promisedBatches = data.promisedBatches,
            promisedProducts = data.promisedProducts,
            nextExpiry = data.nextExpiry,
            lastChangedAt = data.lastChangedAt,
        }
    end

    local snapshot = {
        schema = "me_controller.snapshot.v1",
        time = Core.now(),
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
            demandByTarget = Core.copyTable(runtime.dependencyDemandByTarget or {}),
        },
        summary = Core.summarize(runtime),
        targets = targets,
        commands = Core.recentCommands(runtime.state, options.commandLimit or 20),
    }

    if options.includeStock then
        snapshot.stockCounts = Core.copyTable(runtime.stockCounts or {})
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
    record.completedAt = Core.now()
    if err then record.error = tostring(err) end
    if result ~= nil and type(result) ~= "table" then record.result = tostring(result) end
    rememberCommand(runtime.state, record)
    return true
end

local function setTargetEnabled(runtime, targetId, enabled)
    local target = Core.findTarget(runtime, targetId)
    if not target then error("Unknown target: " .. tostring(targetId)) end
    target.enabled = boolOrDefault(enabled, true)
    Core.saveRuntimeTargets(runtime)
    Core.logEvent(runtime, "INFO", "remote_target_toggled", { target = target.id, enabled = target.enabled })
    return { target = target.id, enabled = target.enabled }, true
end

local function resetTargetState(runtime, targetId)
    local target = Core.findTarget(runtime, targetId)
    if not target then error("Unknown target: " .. tostring(targetId)) end
    runtime.state.targets[target.id] = { commitments = {} }
    runtime.dataById[target.id] = nil
    Core.ensureTargetData(runtime, target)
    Core.logEvent(runtime, "WARN", "remote_target_state_reset", { target = target.id, name = Core.displayName(target) })
    return { target = target.id }, true
end

local function deleteTarget(runtime, targetId)
    local target, index = Core.findTarget(runtime, targetId)
    if not target then error("Unknown target: " .. tostring(targetId)) end
    table.remove(runtime.targets, index)
    runtime.state.targets[target.id] = nil
    runtime.dataById[target.id] = nil
    Core.saveRuntimeTargets(runtime)
    Core.logEvent(runtime, "WARN", "remote_target_deleted", { target = target.id, name = Core.displayName(target) })
    return { target = target.id }, true
end

local function upsertTarget(runtime, rawTarget, targetId)
    if type(rawTarget) ~= "table" then error("target must be a table") end
    rawTarget = Core.copyTable(rawTarget)
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
    Core.logEvent(runtime, "INFO", existingIndex and "remote_target_edited" or "remote_target_added", {
        target = normalized.id,
        name = Core.displayName(normalized),
    })
    return { target = normalized.id, name = Core.displayName(normalized) }, true
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
        recordCommitment(Core.getTargetState(runtime.state, target), target, { [item] = requested }, requested, Core.now())
        Core.updatePromiseData(runtime, target)
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

function Core.applyCommand(runtime, command)
    if type(command) ~= "table" then
        return false, { ok = false, error = "command must be a table" }, false
    end

    local kind = commandKindOf(command)
    if kind == "" then return false, { ok = false, error = "command kind is required" }, false end

    local commandId = commandIdOf(command)
    local mutating = kind ~= "ping" and kind ~= "snapshot"
    if mutating and not commandId then
        return false, { ok = false, error = "commandId is required for mutating commands" }, false
    end

    if commandId then
        local existing = findCommandRecord(commandState(runtime.state), commandId)
        if existing then
            Core.logEvent(runtime, "WARN", "remote_command_duplicate", {
                commandId = commandId,
                kind = kind,
                status = existing.status,
            })
            return true, { ok = true, duplicate = true, commandId = commandId, record = Core.copyTable(existing) }, false
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
        rememberCommand(runtime.state, {
            id = commandId,
            kind = kind,
            source = tostring(command.source or "remote"),
            targetId = commandTargetId(command),
            createdAt = Core.now(),
            completedAt = Core.now(),
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
            createdAt = Core.now(),
        }
    end

    local ok, result, dirty = pcall(function()
        if kind == "ping" then
            return { pong = true, time = Core.now() }, false
        elseif kind == "snapshot" then
            return Core.makeSnapshot(runtime, command.options or {}), false
        elseif kind == "set_enabled" or kind == "target_enabled" then
            return setTargetEnabled(runtime, command.targetId or command.target, command.enabled)
        elseif kind == "reset_target_state" or kind == "reset_target" then
            return resetTargetState(runtime, command.targetId or command.target)
        elseif kind == "delete_target" then
            return deleteTarget(runtime, command.targetId or command.target)
        elseif kind == "upsert_target" or kind == "save_target" then
            return upsertTarget(runtime, command.target, command.targetId)
        elseif kind == "reload_targets" then
            Core.reloadTargets(runtime)
            Core.logEvent(runtime, "INFO", "remote_targets_reloaded", {})
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
    Core.logEvent(runtime, "ERROR", "remote_command_failed", {
        commandId = commandId,
        kind = kind,
        error = tostring(result),
    })
    return false, { ok = false, commandId = commandId, kind = kind, error = tostring(result) }, true
end

function Core.makeRuntime()
    local runtime = {
        targets = Core.loadTargets(),
        state = Core.loadState(),
        dataById = {},
        stockCounts = {},
        stockEntries = 0,
        stockSerial = 0,
        dependencyDemandByTarget = {},
        dependencyPlan = nil,
        stockTicker = nil,
        stockName = nil,
        monitor = nil,
        monitorName = nil,
        networkReady = false,
        stockError = nil,
        selectedIndex = 1,
        pageOffset = 1,
        promptActive = false,
        running = true,
    }

    Core.syncTargetData(runtime)
    return runtime
end

function Core.reloadTargets(runtime)
    runtime.targets = Core.loadTargets()
    Core.syncTargetData(runtime)
end

function Core.runOnce(runtime)
    local dirty = false
    dirty = Core.refreshNetwork(runtime) or dirty
    dirty = Core.decideTargets(runtime) or dirty
    Core.saveState(runtime.state)
    return dirty
end

function Core.formatTimeLeft(seconds)
    seconds = math.max(0, math.floor(seconds or 0))
    return tostring(seconds) .. "s"
end

return Core
