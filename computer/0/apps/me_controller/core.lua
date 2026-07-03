local Config = require("config")
local Util = require("util")
local Items = require("items")
local TargetsStore = require("targets_store")
local StateStore = require("state_store")

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

function Core.saveRuntimeTargets(runtime)
    runtime.targets = Core.normalizeTargets(runtime.targets or {})
    Core.saveTargets(runtime.targets)
    if Core.syncTargetData then Core.syncTargetData(runtime) end
    return true
end

function Core.executeRequestCommand(runtime, target, command)
    local commands = commandState(runtime.state)
    local existing = findCommandRecord(commands, command.id)
    if existing then
        Core.logEvent(runtime, "WARN", "command_duplicate", {
            commandId = command.id,
            target = target.id,
            item = command.item,
            status = existing.status,
        })
        return true, 0, nil, true
    end

    local timestamp = Core.now()
    local record = {
        id = command.id,
        kind = "request",
        source = command.source or "local",
        targetId = target.id,
        address = command.address,
        item = command.item,
        requested = 0,
        wanted = command.count,
        createdAt = timestamp,
        completedAt = timestamp,
    }

    local filter = { name = command.item, _requestCount = command.count }
    local ok, requested = pcall(function()
        return runtime.stockTicker.requestFiltered(command.address, filter)
    end)

    if ok then
        requested = math.max(0, tonumber(requested) or 0)
        record.requested = requested
        record.status = requested > 0 and "done" or "zero"
        rememberCommand(runtime.state, record)
        Core.logEvent(runtime, requested > 0 and "INFO" or "WARN", "command_request_" .. record.status, {
            commandId = command.id,
            target = target.id,
            item = command.item,
            wanted = command.count,
            requested = requested,
            address = command.address,
        })
        return true, requested, nil, false
    end

    record.status = "failed"
    record.error = tostring(requested)
    rememberCommand(runtime.state, record)
    Core.logEvent(runtime, "ERROR", "command_request_failed", {
        commandId = command.id,
        target = target.id,
        item = command.item,
        wanted = command.count,
        address = command.address,
        error = record.error,
    })
    return false, 0, requested, false
end

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
    local remaining = Core.copyTable(requiredInputs or {})
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

function Core.discoverPeripherals(runtime)
    local monitorName, monitor = findPeripheral("monitor")
    local stockName, stockTicker = findPeripheral("Create_StockTicker")

    runtime.monitorName = monitorName
    runtime.monitor = monitor
    runtime.stockName = stockName
    runtime.stockTicker = stockTicker
end

function Core.readNetworkStock(stockTicker)
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
    local targetState = Core.getTargetState(runtime.state, target)
    local effectiveCounts = targetState.effectiveProductCounts
    if type(effectiveCounts) ~= "table" then return counts end

    local out = nil
    for _, product in ipairs(target.products or {}) do
        local effective = effectiveCounts[product.item]
        if effective ~= nil and effective ~= counts[product.item] then
            if not out then out = Core.copyTable(counts) end
            out[product.item] = effective
        end
    end

    return out or counts
end

local function effectiveStockCounts(runtime)
    local counts = Core.copyTable(runtime.stockCounts or {})
    for _, target in ipairs(runtime.targets or {}) do
        local targetState = Core.getTargetState(runtime.state, target)
        local effectiveCounts = targetState.effectiveProductCounts
        if type(effectiveCounts) == "table" then
            for _, product in ipairs(target.products or {}) do
                if effectiveCounts[product.item] ~= nil then counts[product.item] = effectiveCounts[product.item] end
            end
        end
    end
    return counts
end

local function buildProducerMap(targets)
    local producers = {}
    for _, target in ipairs(targets or {}) do
        if target.enabled then
            for _, product in ipairs(target.products or {}) do
                local current = producers[product.item]
                if not current
                    or target.priority < current.target.priority
                    or (target.priority == current.target.priority and Core.displayName(target) < Core.displayName(current.target)) then
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
        return Core.displayName(a) < Core.displayName(b)
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

local function buildDependencyPlan(runtime)
    local producers = buildProducerMap(runtime.targets)
    local edges = buildDependencyEdges(runtime.targets, producers)
    local blockedInputs = buildCycleBlockedInputs(runtime.targets, producers, edges)
    local effectivePriorities = buildEffectivePriorities(runtime.targets, edges, blockedInputs, producers)
    local sortedTargets = sortedTargetsForPlan(runtime.targets, effectivePriorities)
    local stockCounts = effectiveStockCounts(runtime)
    local demands = {}
    local passes = 0

    for pass = 1, math.max(1, Core.CONFIG.maxDependencyPasses or 1) do
        passes = pass
        local nextDemands = {}

        for _, target in ipairs(sortedTargets) do
            if target.enabled then
                local targetState = Core.getTargetState(runtime.state, target)
                local desiredBatches = desiredBatchesForTarget(target, stockCounts, demands[target.id])
                local _, committedTotals = sumCommitments(targetState, target)
                local neededInputItems = inputPlanForBatches(target, desiredBatches, committedTotals)

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

function Core.updatePromiseData(runtime, target)
    local data = runtime.dataById[target.id]
    local targetState = Core.getTargetState(runtime.state, target)
    local promisedInputs, promisedInputItems = sumCommitments(targetState, target)
    local promisedBatches = inputTotalsToBatches(target, promisedInputItems)
    local product = primaryProduct(target)

    data.promisedInputs = promisedInputs
    data.promisedInputItems = promisedInputItems
    data.promisedBatches = promisedBatches
    data.promisedProducts = math.floor(promisedBatches * productCountPerBatch(product))
    data.nextExpiry = nextExpiry(targetState, Core.now())
end

local function updateDemandData(runtime, target)
    local data = Core.ensureTargetData(runtime, target)
    local targetState = Core.getTargetState(runtime.state, target)
    local stockCounts = stockCountsForTarget(runtime, target)
    local extraProducts = runtime.dependencyDemandByTarget and runtime.dependencyDemandByTarget[target.id] or nil
    local desiredBatches, productData = desiredBatchesForTarget(target, stockCounts, extraProducts)
    local _, promisedInputItems = sumCommitments(targetState, target)
    local neededInputItems, neededInputs = inputPlanForBatches(target, desiredBatches, promisedInputItems)
    local product = primaryProduct(target)
    local primaryData = productData[product.item] or {
        count = stockCounts[product.item] or 0,
        baseTargetCount = productTargetCount(target, product),
        dependencyDemand = extraProducts and (extraProducts[product.item] or 0) or 0,
        targetCount = productTargetCount(target, product, extraProducts),
        deficit = 0,
        batches = 0,
    }

    data.productCounts = productData
    data.inputCounts = inputStockCounts(target, stockCounts)
    data.productCount = primaryData.count
    data.inputCount = stockCounts[target.inputItem] or 0
    data.baseTargetCount = primaryData.baseTargetCount
    data.dependencyDemand = primaryData.dependencyDemand
    data.targetCount = primaryData.targetCount
    data.deficitProducts = primaryData.deficit
    data.desiredBatches = desiredBatches
    data.neededInputItems = neededInputItems
    data.neededInputs = neededInputs

    Core.updatePromiseData(runtime, target)
    data.neededBatches = math.max(0, desiredBatches - (data.promisedBatches or 0))
    return data
end

function Core.ensureTargetData(runtime, target)
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
        lastChangedAt = Core.now(),
    }
    runtime.dataById[target.id] = data
    return data
end

function Core.syncTargetData(runtime)
    local live = {}
    for _, target in ipairs(runtime.targets) do
        live[target.id] = true
        Core.ensureTargetData(runtime, target)
    end
    for id in pairs(runtime.dataById) do
        if not live[id] then runtime.dataById[id] = nil end
    end
end

function Core.refreshNetwork(runtime)
    Core.discoverPeripherals(runtime)
    Core.syncTargetData(runtime)

    if not runtime.stockTicker then
        runtime.networkReady = false
        runtime.stockError = "No Stock Ticker peripheral found"
        runtime.stockCounts = {}
        runtime.dependencyDemandByTarget = {}
        runtime.dependencyPlan = nil
        if runtime.lastLoggedStockError ~= runtime.stockError then
            Core.logEvent(runtime, "ERROR", "stock_offline", { message = runtime.stockError })
            runtime.lastLoggedStockError = runtime.stockError
        end
        for _, target in ipairs(runtime.targets) do
            local data = Core.ensureTargetData(runtime, target)
            data.status = "ERROR"
            data.message = runtime.stockError
            data.productCount = 0
            data.inputCount = 0
            Core.updatePromiseData(runtime, target)
        end
        return false
    end

    local report, err = Core.readNetworkStock(runtime.stockTicker)
    if not report then
        runtime.networkReady = false
        runtime.stockError = tostring(err)
        runtime.stockCounts = {}
        runtime.dependencyDemandByTarget = {}
        runtime.dependencyPlan = nil
        if runtime.lastLoggedStockError ~= runtime.stockError then
            Core.logEvent(runtime, "ERROR", "stock_read_failed", { message = runtime.stockError })
            runtime.lastLoggedStockError = runtime.stockError
        end
        for _, target in ipairs(runtime.targets) do
            local data = Core.ensureTargetData(runtime, target)
            data.status = "ERROR"
            data.message = "Stock read failed: " .. runtime.stockError
            data.productCount = 0
            data.inputCount = 0
            Core.updatePromiseData(runtime, target)
        end
        return false
    end

    local dirty = false
    local timestamp = Core.now()
    runtime.networkReady = true
    runtime.stockError = nil
    if runtime.lastLoggedStockError then
        Core.logEvent(runtime, "INFO", "stock_recovered", { entries = report.entries or 0 })
        runtime.lastLoggedStockError = nil
    end
    runtime.stockCounts = report.counts or {}
    runtime.stockEntries = report.entries or 0
    runtime.lastStockReadAt = timestamp
    runtime.stockSerial = (runtime.stockSerial or 0) + 1

    for _, target in ipairs(runtime.targets) do
        local targetState = Core.getTargetState(runtime.state, target)
        local observed = updateObservedProductCounts(targetState, target, runtime.stockCounts, timestamp)
        dirty = observed.dirty or dirty

        if observed.deliveredBatches > 0 then
            local reduced = reduceCommitments(targetState, target, inputRequirementsForBatches(target, observed.deliveredBatches))
            if reduced > 0 then
                targetState.totalSettledInputs = (targetState.totalSettledInputs or 0) + reduced
                targetState.totalDeliveredProducts = (targetState.totalDeliveredProducts or 0) + observed.deliveredProducts
                targetState.totalDeliveredBatches = (targetState.totalDeliveredBatches or 0) + observed.deliveredBatches
                dirty = true
            end
        end
    end

    buildDependencyPlan(runtime)
    for _, target in ipairs(runtime.targets) do updateDemandData(runtime, target) end

    return dirty
end

local function inputEntryForItem(target, item)
    for _, input in ipairs(target.inputs or {}) do
        if input.item == item then return input end
    end
    return { item = item, label = Core.defaultDisplayName(item), count = 1 }
end

local function firstMissingInput(target, neededInputItems, availableInputs)
    for _, input in ipairs(target.inputs or {}) do
        local needed = neededInputItems[input.item] or 0
        if needed > 0 and (availableInputs[input.item] or 0) <= 0 then return input end
    end
    return nil
end

local function producerForItem(runtime, item)
    local plan = runtime.dependencyPlan
    local producers = plan and plan.producers
    return producers and producers[item] or nil
end

local function dependencyBlockedForInput(runtime, target, item)
    local plan = runtime.dependencyPlan
    local blockedInputs = plan and plan.blockedInputs
    return blockedInputs and blockedInputs[target.id] and blockedInputs[target.id][item]
end

local function canRequestPlan(plan, availableInputs, allowance)
    local total = 0
    for item, amount in pairs(plan or {}) do
        if amount > (availableInputs[item] or 0) then return false, total end
        total = total + amount
        if total > allowance then return false, total end
    end
    return true, total
end

local function buildCompleteRequestPlan(target, desiredBatches, committedTotals, availableInputs, allowance)
    local low, high = 0, math.max(0, desiredBatches or 0)
    local bestPlan, bestTotal, bestBatches = nil, 0, 0

    while low <= high do
        local mid = math.floor((low + high) / 2)
        local plan = nil
        local total = 0
        plan, total = inputPlanForBatches(target, mid, committedTotals)
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
    local fullPlan = inputPlanForBatches(target, desiredBatches, committedTotals)
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

local function buildRequestPlan(target, desiredBatches, committedTotals, availableInputs, outstandingRoom)
    local allowance = math.floor(math.min(outstandingRoom, target.maxRequestPerCycle))
    if allowance <= 0 then return nil, 0, false, 0 end

    local plan, total, plannedBatches = buildCompleteRequestPlan(target, desiredBatches, committedTotals, availableInputs, allowance)
    if plan and total > 0 then
        return plan, total, plannedBatches >= desiredBatches, plannedBatches
    end

    plan, total = buildPartialRequestPlan(target, desiredBatches, committedTotals, availableInputs, allowance)
    return plan, total, false, 0
end

local function recordCommitment(targetState, target, requestedByItem, totalRequested, timestamp)
    if totalRequested <= 0 then return end
    targetState.commitments[#targetState.commitments + 1] = {
        inputs = requestedByItem,
        amount = totalRequested,
        createdAt = timestamp,
        expiresAt = timestamp + target.promiseTtlSeconds,
    }
    targetState.totalRequestedInputs = (targetState.totalRequestedInputs or 0) + totalRequested
end

local function requestPlan(runtime, target, plan, availableInputs)
    local requestedByItem, totalRequested = {}, 0
    local handled = {}
    local commandDirty = false

    for _, input in ipairs(target.inputs or {}) do
        local item = input.item
        local amount = plan and plan[item] or 0
        if amount > 0 and not handled[item] then
            handled[item] = true
            local command = {
                id = nextLocalCommandId(runtime, target),
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

local function requestSummary(target, requestedByItem, totalRequested)
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
        return tostring(totalRequested) .. " " .. entryLabel(entry)
    end
    return tostring(totalRequested) .. " inputs across " .. tostring(kinds) .. " types"
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
