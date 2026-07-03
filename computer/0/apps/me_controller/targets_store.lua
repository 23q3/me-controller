-- 目标（targets.db）的规整与持久化。
--
-- 不变量（targets.db version=1 兼容性红线，勿破坏）：
-- normalizeTarget 产出"双表示"——legacy 标量（productItem/inputItem/targetCount/
-- inputPerProduct 等）与 products[]/inputs[] 数组同时存在且互相同步：
-- 数组是权威，规整末尾会把 products[1]/inputs[1] 回写进标量，
-- inputPerProduct 由配方整体重新推导。磁盘上两种表示都写入。
local Config = require("config")
local Util = require("util")
local Items = require("items")

local TargetsStore = {}

local numberOrDefault = Util.numberOrDefault
local boolOrDefault = Util.boolOrDefault
local labelOrDefault = Items.labelOrDefault
local isGeneratedLabel = Items.isGeneratedLabel
local positiveCount = Items.positiveCount

local function uniqueTargetId(existing, wanted)
    local base = Items.normalizeId(wanted)
    local candidate = base
    local index = 2
    while existing[candidate] do
        candidate = base .. "_" .. index
        index = index + 1
    end
    existing[candidate] = true
    return candidate
end

local function normalizeRecipeEntry(raw, isProduct, defaultTargetCount)
    if type(raw) ~= "table" then return nil end
    local item = raw.item or raw.name or raw.itemId
    if item == nil or tostring(item) == "" then return nil end

    local entry = {
        item = tostring(item),
        label = labelOrDefault(raw.label or raw.displayName, item),
        count = positiveCount(raw.count or raw.amount or raw.qty or raw.perBatch, 1),
    }

    if isProduct then
        entry.targetCount = numberOrDefault(raw.targetCount, defaultTargetCount or 0, 0)
    end

    return entry
end

local function appendRecipeEntry(entries, byItem, entry, isProduct)
    if not entry then return end
    local existing = byItem[entry.item]
    if existing then
        existing.count = existing.count + entry.count
        if isProduct and entry.targetCount ~= nil then existing.targetCount = entry.targetCount end
        if entry.label and isGeneratedLabel(existing.label, existing.item) then
            existing.label = entry.label
        end
    else
        byItem[entry.item] = entry
        entries[#entries + 1] = entry
    end
end

local function normalizeRecipeEntries(rawEntries, isProduct, fallback, defaultTargetCount)
    local entries, byItem = {}, {}

    if type(rawEntries) == "table" then
        if rawEntries.item or rawEntries.name or rawEntries.itemId then
            appendRecipeEntry(entries, byItem, normalizeRecipeEntry(rawEntries, isProduct, defaultTargetCount), isProduct)
        else
            for _, raw in ipairs(rawEntries) do
                appendRecipeEntry(entries, byItem, normalizeRecipeEntry(raw, isProduct, defaultTargetCount), isProduct)
            end

            if #entries == 0 then
                for key, value in pairs(rawEntries) do
                    if type(key) == "string" then
                        local raw = nil
                        if type(value) == "table" then
                            raw = Util.copyTable(value)
                            raw.item = raw.item or raw.name or key
                        else
                            raw = { item = key, count = value }
                        end
                        appendRecipeEntry(entries, byItem, normalizeRecipeEntry(raw, isProduct, defaultTargetCount), isProduct)
                    end
                end
            end
        end
    end

    if #entries == 0 and fallback and fallback.item then
        appendRecipeEntry(entries, byItem, normalizeRecipeEntry(fallback, isProduct, defaultTargetCount), isProduct)
    end

    return entries
end

function TargetsStore.normalizeTarget(raw, existing, index)
    raw = type(raw) == "table" and raw or {}
    existing = existing or {}
    local defaults = Config.TARGET_DEFAULTS
    local target = Util.copyTable(defaults)

    for key, value in pairs(raw) do
        target[key] = value
    end

    local rawProducts = target.products or target.outputs
    if target.id == nil and raw.productItem == nil and type(rawProducts) == "table" then
        local inferredProduct = nil
        if rawProducts.item or rawProducts.name or rawProducts.itemId then
            inferredProduct = rawProducts.item or rawProducts.name or rawProducts.itemId
        else
            local first = rawProducts[1]
            if type(first) == "table" then inferredProduct = first.item or first.name or first.itemId end
        end
        if inferredProduct then target.productItem = tostring(inferredProduct) end
    end

    target.id = uniqueTargetId(existing, target.id or target.productItem or ("target_" .. tostring(index or 1)))
    target.enabled = boolOrDefault(target.enabled, defaults.enabled)
    target.address = tostring(target.address or defaults.address)
    target.inputItem = tostring(target.inputItem or defaults.inputItem)
    target.inputLabel = labelOrDefault(target.inputLabel, target.inputItem)
    target.productItem = tostring(target.productItem or defaults.productItem)
    target.productLabel = labelOrDefault(target.productLabel, target.productItem)
    target.targetCount = numberOrDefault(target.targetCount, defaults.targetCount, 0)
    target.inputPerProduct = numberOrDefault(target.inputPerProduct, defaults.inputPerProduct, 0.0001)
    target.products = normalizeRecipeEntries(target.products or target.outputs, true, {
        item = target.productItem,
        label = target.productLabel,
        count = target.productCount or 1,
        targetCount = target.targetCount,
    }, target.targetCount)
    target.inputs = normalizeRecipeEntries(target.inputs or target.ingredients, false, {
        item = target.inputItem,
        label = target.inputLabel,
        count = target.inputPerProduct,
    }, target.targetCount)
    target.outputs = nil
    target.ingredients = nil
    target.productsText = nil
    target.inputsText = nil

    local product = target.products[1]
    local input = target.inputs[1]
    if product then
        target.productItem = product.item
        target.productLabel = product.label
        target.targetCount = numberOrDefault(product.targetCount, target.targetCount, 0)
    end
    if input then
        target.inputItem = input.item
        target.inputLabel = input.label
    end
    target.inputPerProduct = Items.totalInputUnitsForBatches(target, 1) / Items.primaryProductCountPerBatch(target)
    target.priority = numberOrDefault(target.priority, defaults.priority)
    target.requestCooldownSeconds = numberOrDefault(target.requestCooldownSeconds, defaults.requestCooldownSeconds, 0)
    target.minImmediateRequest = numberOrDefault(target.minImmediateRequest, defaults.minImmediateRequest, 1)
    target.delayedRequestSeconds = numberOrDefault(target.delayedRequestSeconds, defaults.delayedRequestSeconds, 0)
    target.promiseTtlSeconds = numberOrDefault(target.promiseTtlSeconds, defaults.promiseTtlSeconds, 1)
    target.maxOutstandingInputs = numberOrDefault(target.maxOutstandingInputs, defaults.maxOutstandingInputs, 1)
    target.maxRequestPerCycle = numberOrDefault(target.maxRequestPerCycle, defaults.maxRequestPerCycle, 1)
    target.deficitConfirmScans = numberOrDefault(target.deficitConfirmScans, defaults.deficitConfirmScans, 1)
    target.deficitConfirmSeconds = numberOrDefault(target.deficitConfirmSeconds, defaults.deficitConfirmSeconds, 0)
    target.stockDropConfirmScans = numberOrDefault(target.stockDropConfirmScans, defaults.stockDropConfirmScans, 1)
    target.stockDropConfirmSeconds = numberOrDefault(target.stockDropConfirmSeconds, defaults.stockDropConfirmSeconds, 0)

    return target
end

function TargetsStore.normalizeTargets(rawTargets)
    local targets = {}
    local existing = {}

    for index, raw in ipairs(rawTargets or {}) do
        targets[#targets + 1] = TargetsStore.normalizeTarget(raw, existing, index)
    end

    table.sort(targets, function(a, b)
        if a.priority == b.priority then return Items.displayName(a) < Items.displayName(b) end
        return a.priority < b.priority
    end)

    return targets
end

function TargetsStore.saveTargets(targets)
    local handle = fs.open(Config.CONFIG.targetsFile, "w")
    if not handle then
        -- 保存失败必须响亮：静默丢失目标配置排查代价极高（计划定点改进）
        Util.logEvent(nil, "ERROR", "targets_save_failed", { file = Config.CONFIG.targetsFile })
        return false
    end
    handle.write(textutils.serialize({
        version = 1,
        targets = targets,
    }))
    handle.close()
    return true
end

function TargetsStore.loadTargets()
    local decoded = Util.readSerialized(Config.CONFIG.targetsFile)

    local rawTargets = nil
    if type(decoded) == "table" and type(decoded.targets) == "table" then
        rawTargets = decoded.targets
    elseif type(decoded) == "table" then
        rawTargets = decoded
    end

    local targets = TargetsStore.normalizeTargets(rawTargets)
    if #targets == 0 then targets = TargetsStore.normalizeTargets(Config.DEFAULT_TARGETS) end
    TargetsStore.saveTargets(targets)
    return targets
end

function TargetsStore.findTarget(runtime, targetId)
    targetId = tostring(targetId or "")
    if targetId == "" then return nil, nil end
    for index, target in ipairs(runtime.targets or {}) do
        if target.id == targetId then return target, index end
    end
    return nil, nil
end

return TargetsStore
