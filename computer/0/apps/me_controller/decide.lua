-- 决策引擎（O 段）。decideTarget 由原 149 行单函数拆为阶段管线：
-- 每个阶段要么"认领"该目标（设置 status/message 并终止管线），要么放行给下一阶段。
-- 阶段顺序即原 if/elseif 链顺序，语义逐字对应，勿重排。
--
-- 禁止 yield：本模块运行在决策路径上（三循环共享 runtime 表），不得引入
-- sleep/pullEvent/新外设调用；外设请求只经 Planner.requestPlan → network。
return function(Core, Planner)
    local Util = require("util")
    local Items = require("items")
    local StateStore = require("state_store")
    local Tracking = require("tracking")

    local Decide = {}

    -- ctx = { runtime, target, availableInputs, data, targetState, timestamp, dirty }

    local function markDirty(ctx, dirty)
        ctx.dirty = dirty or ctx.dirty
    end

    -- 多数"不请求"阶段共享的收尾：清 pending 请求与低库存确认
    local function clearTransients(ctx)
        markDirty(ctx, Tracking.clearPendingRequest(ctx.targetState))
        markDirty(ctx, Tracking.clearDeficitConfirmation(ctx.targetState))
    end

    local function stageDisabled(ctx)
        if ctx.target.enabled then return false end
        clearTransients(ctx)
        ctx.data.status = "DISABLED"
        ctx.data.message = "Target disabled"
        return true
    end

    local function stageNoTicker(ctx)
        if ctx.runtime.stockTicker then return false end
        clearTransients(ctx)
        ctx.data.status = "ERROR"
        ctx.data.message = "No Stock Ticker peripheral found"
        return true
    end

    local function stageNetworkNotReady(ctx)
        if ctx.runtime.networkReady then return false end
        clearTransients(ctx)
        ctx.data.status = "ERROR"
        ctx.data.message = "Stock read failed: " .. tostring(ctx.runtime.stockError)
        return true
    end

    local function stageSatisfied(ctx)
        if (ctx.data.desiredBatches or 0) > 0 then return false end
        clearTransients(ctx)
        ctx.data.status = "SATISFIED"
        ctx.data.message = "ME target met"
        return true
    end

    local function stagePromisedOutput(ctx)
        if ctx.data.neededInputs > 0 then return false end
        clearTransients(ctx)
        ctx.data.status = "WAITING"
        ctx.data.message = "Waiting for promised output"
        return true
    end

    local function stageConfirmDeficit(ctx)
        local confirmed, confirmAge, confirmScans, confirmDirty =
            Tracking.confirmDeficit(ctx.runtime, ctx.targetState, ctx.target, ctx.data, ctx.timestamp)
        markDirty(ctx, confirmDirty)
        if confirmed then return false end

        markDirty(ctx, Tracking.clearPendingRequest(ctx.targetState))
        ctx.data.status = "WAITING"
        ctx.data.message = "Confirming low stock "
            .. tostring(confirmScans) .. "/" .. tostring(ctx.target.deficitConfirmScans)
            .. " " .. tostring(math.floor(confirmAge)) .. "s"
        return true
    end

    -- 原版在 elseif 条件与分支体内各调一次 firstMissingInput，此处只算一次（计划定点改进）
    local function stageMissingInput(ctx)
        local missing = Planner.firstMissingInput(ctx.target, ctx.data.neededInputItems, ctx.availableInputs)
        if not missing then return false end

        local producer = Planner.producerForItem(ctx.runtime, missing.item)
        markDirty(ctx, Tracking.clearPendingRequest(ctx.targetState))
        ctx.data.status = "WAITING"
        if Planner.dependencyBlockedForInput(ctx.runtime, ctx.target, missing.item) then
            ctx.data.message = "Dependency cycle blocks " .. Items.entryLabel(missing)
        elseif producer then
            ctx.data.message = "Waiting for " .. Items.displayName(producer.target) .. " -> " .. Items.entryLabel(missing)
        else
            ctx.data.message = "No " .. Items.entryLabel(missing) .. " in network"
        end
        return true
    end

    -- 终段：构建请求计划（不足则合批等待/冷却），达到条件即发出请求
    local function stageIssueRequest(ctx)
        local runtime, target, data, targetState, timestamp =
            ctx.runtime, ctx.target, ctx.data, ctx.targetState, ctx.timestamp

        local outstandingRoom = math.max(0, target.maxOutstandingInputs - data.promisedInputs)
        local _, committedTotals = Tracking.sumCommitments(targetState, target)
        local plan, requestCount, canFinishDeficit = Planner.buildRequestPlan(
            target,
            data.desiredBatches or 0,
            committedTotals,
            ctx.availableInputs,
            outstandingRoom
        )
        local canSendBatch = requestCount >= target.minImmediateRequest
        local pendingAge = 0
        local delayedReady = false

        if requestCount > 0 and not canFinishDeficit and not canSendBatch then
            if not targetState.pendingRequestSince or not targetState.pendingRequestAmount or requestCount < targetState.pendingRequestAmount then
                targetState.pendingRequestSince = timestamp
                markDirty(ctx, true)
            end
            if targetState.pendingRequestAmount ~= requestCount then
                targetState.pendingRequestAmount = requestCount
                markDirty(ctx, true)
            end
            pendingAge = timestamp - targetState.pendingRequestSince
            delayedReady = pendingAge >= target.delayedRequestSeconds
        end

        if requestCount <= 0 then
            markDirty(ctx, Tracking.clearPendingRequest(targetState))
            data.status = "WAITING"
            if outstandingRoom <= 0 then
                data.message = "Outstanding request cap reached"
            else
                -- 只发整批：原料有货但凑不满一批（或超出本轮额度）时等待
                data.message = "Waiting for a full batch of inputs"
            end
        elseif targetState.lastRequestAt and timestamp - targetState.lastRequestAt < target.requestCooldownSeconds then
            data.status = "WAITING"
            data.message = "Request cooldown"
        elseif not canFinishDeficit and not canSendBatch and not delayedReady then
            data.status = "WAITING"
            data.message = "Batching " .. requestCount .. "/" .. target.minImmediateRequest .. " " .. pendingAge .. "s"
        else
            local ok, requestedByItem, requested, err, commandDirty = Planner.requestPlan(runtime, target, plan, ctx.availableInputs)
            markDirty(ctx, commandDirty)
            requested = tonumber(requested) or 0
            if requested > 0 then
                Planner.recordCommitment(targetState, target, requestedByItem, requested, timestamp)
                markDirty(ctx, true)
            end

            if ok then
                targetState.lastRequestAt = timestamp
                -- 原文为 `dirty = clearPendingRequest(targetState) or true`（恒真）：
                -- lastRequestAt 已变更，本分支必然 dirty
                Tracking.clearPendingRequest(targetState)
                markDirty(ctx, true)

                if requested > 0 then
                    Planner.updateDemandData(runtime, target)
                    data.status = "REQUESTED"
                    data.message = "Requested " .. Planner.requestSummary(target, requestedByItem, requested) .. " to " .. target.address
                else
                    data.status = "WAITING"
                    data.message = "Network accepted 0 items"
                end
            else
                data.status = "ERROR"
                if requested > 0 then
                    Planner.updateDemandData(runtime, target)
                    data.message = "Partial request then failed: " .. tostring(err)
                else
                    data.message = "Request failed: " .. tostring(err)
                end
            end
        end
        return true
    end

    local STAGES = {
        stageDisabled,
        stageNoTicker,
        stageNetworkNotReady,
        stageSatisfied,
        stagePromisedOutput,
        stageConfirmDeficit,
        stageMissingInput,
        stageIssueRequest,
    }

    local function decideTarget(runtime, target, availableInputs)
        local data = Planner.ensureTargetData(runtime, target)
        local targetState = StateStore.getTargetState(runtime.state, target)
        local timestamp = Util.now()
        local expired = Tracking.pruneCommitments(targetState, target, timestamp)
        local ctx = {
            runtime = runtime,
            target = target,
            availableInputs = availableInputs,
            data = data,
            targetState = targetState,
            timestamp = timestamp,
            dirty = expired > 0,
        }
        local previousStatus = data.status
        local previousMessage = data.message

        Planner.updateDemandData(runtime, target)

        for _, stage in ipairs(STAGES) do
            if stage(ctx) then break end
        end

        if data.status ~= previousStatus or data.message ~= previousMessage then
            Util.logEvent(runtime, data.status == "ERROR" and "ERROR" or "INFO", "target_status", {
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
        return ctx.dirty
    end

    function Decide.decideTargets(runtime)
        Core.discoverPeripherals(runtime)
        Planner.syncTargetData(runtime)

        local dirty = false
        local timestamp = Util.now()
        for _, target in ipairs(runtime.targets) do
            local targetState = StateStore.getTargetState(runtime.state, target)
            local expired = Tracking.pruneCommitments(targetState, target, timestamp)
            if expired > 0 then
                Util.logEvent(runtime, "WARN", "promise_expired", {
                    target = target.id,
                    amount = expired,
                })
                dirty = true
            end
        end

        if runtime.networkReady then
            Planner.buildDependencyPlan(runtime)
        else
            runtime.dependencyDemandByTarget = {}
            runtime.dependencyPlan = nil
        end

        local availableInputs = Util.copyTable(runtime.stockCounts or {})
        local plannedTargets = runtime.dependencyPlan and runtime.dependencyPlan.targets or runtime.targets

        for _, target in ipairs(plannedTargets) do
            dirty = decideTarget(runtime, target, availableInputs) or dirty
        end

        return dirty
    end

    return Decide
end
