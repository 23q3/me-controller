-- 承诺跟踪（H 段）+ 库存观测平滑（J 段）。
-- debounce 语义红线：deficitConfirm*/stockDropConfirm* 的确认节奏
-- （按 stockSerial 计 scan、按时间计 age）原样保留，勿改判定顺序。
-- 本模块只改 targetState / 返回 dirty，不碰外设、不落盘。
local Util = require("util")
local Items = require("items")
local StateStore = require("state_store")

local numberOrDefault = Util.numberOrDefault
local recipeInputCounts = Items.recipeInputCounts
local productCountPerBatch = Items.productCountPerBatch

local function promiseInputs(promise, target)
    local inputs = {}

    if type(promise.inputs) == "table" then
        for item, amount in pairs(promise.inputs) do
            amount = tonumber(amount) or 0
            if amount > 0 then inputs[tostring(item)] = (inputs[tostring(item)] or 0) + amount end
        end
    elseif promise.item and promise.amount then
        inputs[tostring(promise.item)] = tonumber(promise.amount) or 0
    elseif target and target.inputItem and promise.amount then
        inputs[target.inputItem] = tonumber(promise.amount) or 0
    end

    return inputs
end

local function totalInputAmount(inputs)
    local total = 0
    for _, amount in pairs(inputs or {}) do
        total = total + (tonumber(amount) or 0)
    end
    return total
end

local function sumCommitments(targetState, target)
    local totals = {}
    for _, promise in ipairs(targetState.commitments or {}) do
        for item, amount in pairs(promiseInputs(promise, target)) do
            totals[item] = (totals[item] or 0) + amount
        end
    end
    return totalInputAmount(totals), totals
end

local function inputTotalsToBatches(target, totals)
    local batches = nil
    for item, required in pairs(recipeInputCounts(target)) do
        local itemBatches = math.floor((totals[item] or 0) / required)
        if batches == nil or itemBatches < batches then batches = itemBatches end
    end
    return batches or 0
end

local function inputRequirementsForBatches(target, batches)
    local required = {}
    for item, amount in pairs(recipeInputCounts(target)) do
        required[item] = amount * math.max(0, batches or 0)
    end
    return required
end

local function inputPlanForBatches(target, batches, committedTotals)
    local plan, total = {}, 0
    for item, required in pairs(inputRequirementsForBatches(target, batches)) do
        local missing = math.ceil(math.max(0, required - (committedTotals[item] or 0)))
        if missing > 0 then
            plan[item] = missing
            total = total + missing
        end
    end
    return plan, total
end

local function pruneCommitments(targetState, target, timestamp)
    local kept, expired = {}, 0
    for _, promise in ipairs(targetState.commitments or {}) do
        local amount = totalInputAmount(promiseInputs(promise, target))
        if (promise.expiresAt or 0) > timestamp and amount > 0 then
            promise.inputs = promiseInputs(promise, target)
            promise.amount = amount
            kept[#kept + 1] = promise
        else
            expired = expired + amount
        end
    end
    targetState.commitments = kept
    targetState.totalExpiredInputs = (targetState.totalExpiredInputs or 0) + expired
    return expired
end

local function reduceCommitments(targetState, target, requiredInputs)
    local remaining = Util.copyTable(requiredInputs or {})
    local reduced = 0
    local kept = {}

    for _, promise in ipairs(targetState.commitments or {}) do
        local inputs = promiseInputs(promise, target)
        local nextInputs = {}

        for item, current in pairs(inputs) do
            local needed = remaining[item] or 0
            if needed > 0 then
                local used = math.min(current, needed)
                current = current - used
                remaining[item] = needed - used
                reduced = reduced + used
            end
            if current > 0 then nextInputs[item] = current end
        end

        local amount = totalInputAmount(nextInputs)
        if amount > 0 then
            promise.inputs = nextInputs
            promise.amount = amount
            kept[#kept + 1] = promise
        end
    end

    targetState.commitments = kept
    return reduced
end

local function clearPendingRequest(targetState)
    local dirty = targetState.pendingRequestSince ~= nil or targetState.pendingRequestAmount ~= nil
    targetState.pendingRequestSince = nil
    targetState.pendingRequestAmount = nil
    return dirty
end

local function clearDeficitConfirmation(targetState)
    local dirty = targetState.deficitConfirmSince ~= nil
        or targetState.deficitConfirmScans ~= nil
        or targetState.deficitConfirmLastStockSerial ~= nil
    targetState.deficitConfirmSince = nil
    targetState.deficitConfirmScans = nil
    targetState.deficitConfirmLastStockSerial = nil
    return dirty
end

local function confirmDeficit(runtime, targetState, target, data, timestamp)
    if (data.desiredBatches or 0) <= 0 or (data.neededInputs or 0) <= 0 then
        return true, 0, 0, clearDeficitConfirmation(targetState)
    end

    local dirty = false
    local stockSerial = runtime.stockSerial or 0
    if not targetState.deficitConfirmSince then
        targetState.deficitConfirmSince = timestamp
        targetState.deficitConfirmScans = 0
        targetState.deficitConfirmLastStockSerial = nil
        dirty = true
    end

    if targetState.deficitConfirmLastStockSerial ~= stockSerial then
        targetState.deficitConfirmScans = (targetState.deficitConfirmScans or 0) + 1
        targetState.deficitConfirmLastStockSerial = stockSerial
        dirty = true
    end

    local scans = targetState.deficitConfirmScans or 0
    local age = timestamp - (targetState.deficitConfirmSince or timestamp)
    local confirmed = scans >= target.deficitConfirmScans and age >= target.deficitConfirmSeconds
    return confirmed, age, scans, dirty
end

local function nextExpiry(targetState, timestamp)
    local nearest = nil
    for _, promise in ipairs(targetState.commitments or {}) do
        if not nearest or promise.expiresAt < nearest then nearest = promise.expiresAt end
    end
    if not nearest then return nil end
    return nearest - timestamp
end

local function productTargetCount(target, product, extraProducts)
    local base = numberOrDefault(product and product.targetCount, target.targetCount or 0, 0)
    local extra = extraProducts and product and (extraProducts[product.item] or 0) or 0
    return math.max(base, math.max(0, extra))
end

local function desiredBatchesForTarget(target, stockCounts, extraProducts)
    local desiredBatches = 0
    local productData = {}

    for _, product in ipairs(target.products or {}) do
        local count = stockCounts[product.item] or 0
        local baseTargetCount = productTargetCount(target, product)
        local dependencyDemand = extraProducts and (extraProducts[product.item] or 0) or 0
        local targetCount = productTargetCount(target, product, extraProducts)
        local deficit = math.max(0, targetCount - count)
        local batches = math.ceil(deficit / productCountPerBatch(product))

        productData[product.item] = {
            count = count,
            baseTargetCount = baseTargetCount,
            dependencyDemand = dependencyDemand,
            targetCount = targetCount,
            deficit = deficit,
            batches = batches,
        }
        if batches > desiredBatches then desiredBatches = batches end
    end

    return desiredBatches, productData
end

local function inputStockCounts(target, stockCounts)
    local counts = {}
    for _, input in ipairs(target.inputs or {}) do
        counts[input.item] = stockCounts[input.item] or 0
    end
    return counts
end

local function clearPendingProductDrop(targetState, item)
    local dirty = false
    for _, field in ipairs({ "pendingProductDropCounts", "pendingProductDropSince", "pendingProductDropScans" }) do
        local bucket = targetState[field]
        if type(bucket) == "table" and bucket[item] ~= nil then
            bucket[item] = nil
            dirty = true
        end
    end
    return dirty
end

local function updateObservedProductCounts(targetState, target, rawCounts, timestamp)
    local previousCounts = targetState.lastProductCounts
    if type(previousCounts) ~= "table" and targetState.lastProductCount ~= nil then
        previousCounts = { [target.productItem] = targetState.lastProductCount }
    end
    if type(previousCounts) ~= "table" then previousCounts = {} end

    if type(targetState.pendingProductDropCounts) ~= "table" then targetState.pendingProductDropCounts = {} end
    if type(targetState.pendingProductDropSince) ~= "table" then targetState.pendingProductDropSince = {} end
    if type(targetState.pendingProductDropScans) ~= "table" then targetState.pendingProductDropScans = {} end

    local acceptedCounts = {}
    local effectiveCounts = {}
    local deliveredBatches = 0
    local deliveredProducts = 0
    local dirty = type(targetState.lastProductCounts) ~= "table"

    for _, product in ipairs(target.products or {}) do
        local item = product.item
        local current = rawCounts[item] or 0
        local previous = previousCounts[item]

        if previous == nil then
            acceptedCounts[item] = current
            effectiveCounts[item] = current
            dirty = true
            clearPendingProductDrop(targetState, item)
        elseif current >= previous then
            acceptedCounts[item] = current
            effectiveCounts[item] = current

            if current > previous then
                local delta = current - previous
                deliveredProducts = deliveredProducts + delta
                deliveredBatches = math.max(deliveredBatches, math.ceil(delta / productCountPerBatch(product)))
                dirty = true
            end
            dirty = clearPendingProductDrop(targetState, item) or dirty
        else
            local pendingCounts = targetState.pendingProductDropCounts
            local pendingSince = targetState.pendingProductDropSince
            local pendingScans = targetState.pendingProductDropScans

            if pendingCounts[item] ~= current then
                pendingCounts[item] = current
                pendingSince[item] = timestamp
                pendingScans[item] = 1
            else
                pendingScans[item] = (pendingScans[item] or 0) + 1
            end

            local age = timestamp - (pendingSince[item] or timestamp)
            local confirmed = pendingScans[item] >= target.stockDropConfirmScans
                and age >= target.stockDropConfirmSeconds

            if confirmed then
                acceptedCounts[item] = current
                effectiveCounts[item] = current
                dirty = clearPendingProductDrop(targetState, item) or true
            else
                acceptedCounts[item] = previous
                effectiveCounts[item] = previous
                dirty = true
            end
        end
    end

    targetState.lastProductCounts = acceptedCounts
    targetState.lastProductCount = acceptedCounts[target.productItem]
    targetState.effectiveProductCounts = effectiveCounts

    return {
        deliveredBatches = deliveredBatches,
        deliveredProducts = deliveredProducts,
        dirty = dirty,
    }
end

local function stockCountsForTarget(runtime, target)
    local counts = runtime.stockCounts or {}
    local targetState = StateStore.getTargetState(runtime.state, target)
    local effectiveCounts = targetState.effectiveProductCounts
    if type(effectiveCounts) ~= "table" then return counts end

    local out = nil
    for _, product in ipairs(target.products or {}) do
        local effective = effectiveCounts[product.item]
        if effective ~= nil and effective ~= counts[product.item] then
            if not out then out = Util.copyTable(counts) end
            out[product.item] = effective
        end
    end

    return out or counts
end

local function effectiveStockCounts(runtime)
    local counts = Util.copyTable(runtime.stockCounts or {})
    for _, target in ipairs(runtime.targets or {}) do
        local targetState = StateStore.getTargetState(runtime.state, target)
        local effectiveCounts = targetState.effectiveProductCounts
        if type(effectiveCounts) == "table" then
            for _, product in ipairs(target.products or {}) do
                if effectiveCounts[product.item] ~= nil then counts[product.item] = effectiveCounts[product.item] end
            end
        end
    end
    return counts
end

return {
    sumCommitments = sumCommitments,
    inputTotalsToBatches = inputTotalsToBatches,
    inputRequirementsForBatches = inputRequirementsForBatches,
    inputPlanForBatches = inputPlanForBatches,
    pruneCommitments = pruneCommitments,
    reduceCommitments = reduceCommitments,
    clearPendingRequest = clearPendingRequest,
    clearDeficitConfirmation = clearDeficitConfirmation,
    confirmDeficit = confirmDeficit,
    nextExpiry = nextExpiry,
    productTargetCount = productTargetCount,
    desiredBatchesForTarget = desiredBatchesForTarget,
    inputStockCounts = inputStockCounts,
    updateObservedProductCounts = updateObservedProductCounts,
    stockCountsForTarget = stockCountsForTarget,
    effectiveStockCounts = effectiveStockCounts,
}
