-- 依赖规划（K 段：生产者图/环阻断/有效优先级/需求传播）
-- + 目标数据同步（L 段：ensureTargetData/updateDemandData/updatePromiseData/syncTargetData）
-- + 请求计划构建与执行（N 段：buildRequestPlan 二分/部分计划、requestPlan）。
--
-- 禁止 yield：本模块运行在决策路径上（三循环共享 runtime 表），不得引入
-- sleep/pullEvent/新外设调用；外设请求只经 Core.executeRequestCommand（network.lua）。
-- function(Core) 工厂：executeRequestCommand 在 network.lua，经组合根 Core 晚绑定。
return function(Core)
    local Config = require("config")
    local Util = require("util")
    local Items = require("items")
    local StateStore = require("state_store")
    local Tracking = require("tracking")

    local Planner = {}

    local function buildProducerMap(targets)
        local producers = {}
        for _, target in ipairs(targets or {}) do
            if target.enabled then
                for _, product in ipairs(target.products or {}) do
                    local current = producers[product.item]
                    if not current
                        or target.priority < current.target.priority
                        or (target.priority == current.target.priority and Items.displayName(target) < Items.displayName(current.target)) then
                        producers[product.item] = { target = target, product = product }
                    end
                end
            end
        end
        return producers
    end

    local function buildDependencyEdges(targets, producers)
        local edges = {}
        for _, target in ipairs(targets or {}) do
            if target.enabled then
                local targetEdges = {}
                for _, input in ipairs(target.inputs or {}) do
                    local producer = producers[input.item]
                    if producer and producer.target.id ~= target.id then targetEdges[producer.target.id] = true end
                end
                edges[target.id] = targetEdges
            end
        end
        return edges
    end

    local function pathExists(edges, fromId, wantedId, seen)
        if fromId == wantedId then return true end
        if seen[fromId] then return false end
        seen[fromId] = true
        for nextId in pairs(edges[fromId] or {}) do
            if pathExists(edges, nextId, wantedId, seen) then return true end
        end
        return false
    end

    local function buildCycleBlockedInputs(targets, producers, edges)
        local blocked = {}
        for _, target in ipairs(targets or {}) do
            local targetBlocked = {}
            for _, input in ipairs(target.inputs or {}) do
                local producer = producers[input.item]
                if producer and producer.target.id ~= target.id and pathExists(edges, producer.target.id, target.id, {}) then
                    targetBlocked[input.item] = true
                end
            end
            blocked[target.id] = targetBlocked
        end
        return blocked
    end

    local function buildEffectivePriorities(targets, edges, blockedInputs, producers)
        local priorities = {}
        for _, target in ipairs(targets or {}) do priorities[target.id] = target.priority end

        for _ = 1, #(targets or {}) do
            local changed = false
            for _, consumer in ipairs(targets or {}) do
                for _, input in ipairs(consumer.inputs or {}) do
                    local producer = producers[input.item]
                    if producer and not (blockedInputs[consumer.id] and blockedInputs[consumer.id][input.item]) then
                        local producerId = producer.target.id
                        if priorities[consumer.id] and priorities[producerId] and priorities[consumer.id] < priorities[producerId] then
                            priorities[producerId] = priorities[consumer.id]
                            changed = true
                        end
                    end
                end
            end
            if not changed then break end
        end

        return priorities
    end

    local function sortedTargetsForPlan(targets, effectivePriorities)
        local sorted = {}
        for index, target in ipairs(targets or {}) do sorted[index] = target end
        table.sort(sorted, function(a, b)
            local ap = effectivePriorities[a.id] or a.priority
            local bp = effectivePriorities[b.id] or b.priority
            if ap ~= bp then return ap < bp end
            if a.priority ~= b.priority then return a.priority < b.priority end
            return Items.displayName(a) < Items.displayName(b)
        end)
        return sorted
    end

    local function demandMapsEqual(a, b)
        for targetId, items in pairs(a or {}) do
            for item, amount in pairs(items or {}) do
                if math.ceil(amount or 0) ~= math.ceil(((b or {})[targetId] or {})[item] or 0) then return false end
            end
        end
        for targetId, items in pairs(b or {}) do
            for item, amount in pairs(items or {}) do
                if math.ceil(amount or 0) ~= math.ceil(((a or {})[targetId] or {})[item] or 0) then return false end
            end
        end
        return true
    end

    local function addDemand(demands, targetId, item, amount)
        amount = math.ceil(math.max(0, amount or 0))
        if amount <= 0 then return end
        if type(demands[targetId]) ~= "table" then demands[targetId] = {} end
        demands[targetId][item] = (demands[targetId][item] or 0) + amount
    end

    function Planner.buildDependencyPlan(runtime)
        local producers = buildProducerMap(runtime.targets)
        local edges = buildDependencyEdges(runtime.targets, producers)
        local blockedInputs = buildCycleBlockedInputs(runtime.targets, producers, edges)
        local effectivePriorities = buildEffectivePriorities(runtime.targets, edges, blockedInputs, producers)
        local sortedTargets = sortedTargetsForPlan(runtime.targets, effectivePriorities)
        local stockCounts = Tracking.effectiveStockCounts(runtime)
        local demands = {}
        local passes = 0

        for pass = 1, math.max(1, Config.CONFIG.maxDependencyPasses or 1) do
            passes = pass
            local nextDemands = {}

            for _, target in ipairs(sortedTargets) do
                if target.enabled then
                    local targetState = StateStore.getTargetState(runtime.state, target)
                    local desiredBatches = Tracking.desiredBatchesForTarget(target, stockCounts, demands[target.id])
                    local _, committedTotals = Tracking.sumCommitments(targetState, target)
                    local neededInputItems = Tracking.inputPlanForBatches(target, desiredBatches, committedTotals)

                    for _, input in ipairs(target.inputs or {}) do
                        local item = input.item
                        local needed = neededInputItems[item] or 0
                        local producer = producers[item]
                        if needed > 0
                            and producer
                            and producer.target.id ~= target.id
                            and not (blockedInputs[target.id] and blockedInputs[target.id][item]) then
                            addDemand(nextDemands, producer.target.id, item, needed)
                        end
                    end
                end
            end

            if demandMapsEqual(demands, nextDemands) then
                demands = nextDemands
                break
            end
            demands = nextDemands
        end

        runtime.dependencyDemandByTarget = demands
        runtime.dependencyPlan = {
            producers = producers,
            effectivePriorities = effectivePriorities,
            targets = sortedTargets,
            blockedInputs = blockedInputs,
            passes = passes,
        }
    end

    function Planner.updatePromiseData(runtime, target)
        local data = runtime.dataById[target.id]
        local targetState = StateStore.getTargetState(runtime.state, target)
        local promisedInputs, promisedInputItems = Tracking.sumCommitments(targetState, target)
        local promisedBatches = Tracking.inputTotalsToBatches(target, promisedInputItems)
        local product = Items.primaryProduct(target)

        data.promisedInputs = promisedInputs
        data.promisedInputItems = promisedInputItems
        data.promisedBatches = promisedBatches
        data.promisedProducts = math.floor(promisedBatches * Items.productCountPerBatch(product))
        data.nextExpiry = Tracking.nextExpiry(targetState, Util.now())
    end

    function Planner.updateDemandData(runtime, target)
        local data = Planner.ensureTargetData(runtime, target)
        local targetState = StateStore.getTargetState(runtime.state, target)
        local stockCounts = Tracking.stockCountsForTarget(runtime, target)
        local extraProducts = runtime.dependencyDemandByTarget and runtime.dependencyDemandByTarget[target.id] or nil
        local desiredBatches, productData = Tracking.desiredBatchesForTarget(target, stockCounts, extraProducts)
        local _, promisedInputItems = Tracking.sumCommitments(targetState, target)
        local neededInputItems, neededInputs = Tracking.inputPlanForBatches(target, desiredBatches, promisedInputItems)
        local product = Items.primaryProduct(target)
        local primaryData = productData[product.item] or {
            count = stockCounts[product.item] or 0,
            baseTargetCount = Tracking.productTargetCount(target, product),
            dependencyDemand = extraProducts and (extraProducts[product.item] or 0) or 0,
            targetCount = Tracking.productTargetCount(target, product, extraProducts),
            deficit = 0,
            batches = 0,
        }

        data.productCounts = productData
        data.inputCounts = Tracking.inputStockCounts(target, stockCounts)
        data.productCount = primaryData.count
        data.inputCount = stockCounts[target.inputItem] or 0
        data.baseTargetCount = primaryData.baseTargetCount
        data.dependencyDemand = primaryData.dependencyDemand
        data.targetCount = primaryData.targetCount
        data.deficitProducts = primaryData.deficit
        data.desiredBatches = desiredBatches
        data.neededInputItems = neededInputItems
        data.neededInputs = neededInputs

        Planner.updatePromiseData(runtime, target)
        data.neededBatches = math.max(0, desiredBatches - (data.promisedBatches or 0))
        return data
    end

    function Planner.ensureTargetData(runtime, target)
        local data = runtime.dataById[target.id]
        if data then return data end

        data = {
            status = "NEW",
            message = "Waiting for first scan",
            productCount = 0,
            productCounts = {},
            inputCount = 0,
            inputCounts = {},
            targetCount = target.targetCount,
            baseTargetCount = target.targetCount,
            dependencyDemand = 0,
            deficitProducts = 0,
            desiredBatches = 0,
            neededBatches = 0,
            neededInputs = 0,
            neededInputItems = {},
            promisedInputs = 0,
            promisedInputItems = {},
            promisedBatches = 0,
            promisedProducts = 0,
            nextExpiry = nil,
            lastChangedAt = Util.now(),
        }
        runtime.dataById[target.id] = data
        return data
    end

    function Planner.syncTargetData(runtime)
        local live = {}
        for _, target in ipairs(runtime.targets) do
            live[target.id] = true
            Planner.ensureTargetData(runtime, target)
        end
        for id in pairs(runtime.dataById) do
            if not live[id] then runtime.dataById[id] = nil end
        end
    end

    local function inputEntryForItem(target, item)
        for _, input in ipairs(target.inputs or {}) do
            if input.item == item then return input end
        end
        return { item = item, label = Items.defaultDisplayName(item), count = 1 }
    end

    function Planner.firstMissingInput(target, neededInputItems, availableInputs)
        for _, input in ipairs(target.inputs or {}) do
            local needed = neededInputItems[input.item] or 0
            if needed > 0 and (availableInputs[input.item] or 0) <= 0 then return input end
        end
        return nil
    end

    function Planner.producerForItem(runtime, item)
        local plan = runtime.dependencyPlan
        local producers = plan and plan.producers
        return producers and producers[item] or nil
    end

    function Planner.dependencyBlockedForInput(runtime, target, item)
        local plan = runtime.dependencyPlan
        local blockedInputs = plan and plan.blockedInputs
        return blockedInputs and blockedInputs[target.id] and blockedInputs[target.id][item]
    end

    -- 原版返回 (ok, total)，total 无调用方使用（计划定点清理），改为只返回 ok
    local function canRequestPlan(plan, availableInputs, allowance)
        local total = 0
        for item, amount in pairs(plan or {}) do
            if amount > (availableInputs[item] or 0) then return false end
            total = total + amount
            if total > allowance then return false end
        end
        return true
    end

    local function buildCompleteRequestPlan(target, desiredBatches, committedTotals, availableInputs, allowance)
        local low, high = 0, math.max(0, desiredBatches or 0)
        local bestPlan, bestTotal, bestBatches = nil, 0, 0

        while low <= high do
            local mid = math.floor((low + high) / 2)
            local plan = nil
            local total = 0
            plan, total = Tracking.inputPlanForBatches(target, mid, committedTotals)
            local ok = canRequestPlan(plan, availableInputs, allowance)

            if ok then
                bestPlan, bestTotal, bestBatches = plan, total, mid
                low = mid + 1
            else
                high = mid - 1
            end
        end

        if bestTotal <= 0 then return nil, 0, bestBatches end
        return bestPlan, bestTotal, bestBatches
    end

    local function buildPartialRequestPlan(target, desiredBatches, committedTotals, availableInputs, allowance)
        local fullPlan = Tracking.inputPlanForBatches(target, desiredBatches, committedTotals)
        local plan, total, handled = {}, 0, {}

        for _, input in ipairs(target.inputs or {}) do
            local item = input.item
            if not handled[item] then
                handled[item] = true
                local wanted = fullPlan[item] or 0
                local available = math.floor(availableInputs[item] or 0)
                local room = math.floor(allowance - total)
                local amount = math.min(wanted, available, room)
                if amount > 0 then
                    plan[item] = amount
                    total = total + amount
                end
            end
            if total >= allowance then break end
        end

        if total <= 0 then return nil, 0 end
        return plan, total
    end

    function Planner.buildRequestPlan(target, desiredBatches, committedTotals, availableInputs, outstandingRoom)
        local allowance = math.floor(math.min(outstandingRoom, target.maxRequestPerCycle))
        if allowance <= 0 then return nil, 0, false, 0 end

        local plan, total, plannedBatches = buildCompleteRequestPlan(target, desiredBatches, committedTotals, availableInputs, allowance)
        if plan and total > 0 then
            return plan, total, plannedBatches >= desiredBatches, plannedBatches
        end

        plan, total = buildPartialRequestPlan(target, desiredBatches, committedTotals, availableInputs, allowance)
        return plan, total, false, 0
    end

    function Planner.recordCommitment(targetState, target, requestedByItem, totalRequested, timestamp)
        if totalRequested <= 0 then return end
        targetState.commitments[#targetState.commitments + 1] = {
            inputs = requestedByItem,
            amount = totalRequested,
            createdAt = timestamp,
            expiresAt = timestamp + target.promiseTtlSeconds,
        }
        targetState.totalRequestedInputs = (targetState.totalRequestedInputs or 0) + totalRequested
    end

    function Planner.requestPlan(runtime, target, plan, availableInputs)
        local requestedByItem, totalRequested = {}, 0
        local handled = {}
        local commandDirty = false

        for _, input in ipairs(target.inputs or {}) do
            local item = input.item
            local amount = plan and plan[item] or 0
            if amount > 0 and not handled[item] then
                handled[item] = true
                local command = {
                    id = StateStore.nextLocalCommandId(runtime, target),
                    source = "local",
                    address = target.address,
                    item = item,
                    count = amount,
                }
                local ok, requested, err, duplicate = Core.executeRequestCommand(runtime, target, command)
                commandDirty = true

                if not ok then return false, requestedByItem, totalRequested, err, commandDirty end

                requested = math.max(0, tonumber(requested) or 0)
                if requested > 0 and not duplicate then
                    requestedByItem[item] = (requestedByItem[item] or 0) + requested
                    totalRequested = totalRequested + requested
                    availableInputs[item] = math.max(0, (availableInputs[item] or 0) - requested)
                end
            end
        end

        return true, requestedByItem, totalRequested, nil, commandDirty
    end

    function Planner.requestSummary(target, requestedByItem, totalRequested)
        local kinds = 0
        local firstItem = nil
        for item, amount in pairs(requestedByItem or {}) do
            if amount > 0 then
                kinds = kinds + 1
                firstItem = firstItem or item
            end
        end

        if kinds == 1 then
            local entry = inputEntryForItem(target, firstItem)
            return tostring(totalRequested) .. " " .. Items.entryLabel(entry)
        end
        return tostring(totalRequested) .. " inputs across " .. tostring(kinds) .. " types"
    end

    return Planner
end
