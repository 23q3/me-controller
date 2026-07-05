-- 目标（targets.db）的规整与持久化。
--
-- 不变量（targets.db version=1 兼容性红线，勿破坏）：
-- normalizeTarget 产出"双表示"——legacy 标量（productItem/inputItem/targetCount/
-- inputPerProduct 等）与 products[]/inputs[] 数组同时存在且互相同步：
-- 数组是权威，规整末尾会把 products[1]/inputs[1] 回写进标量，
-- inputPerProduct 由配方整体重新推导。磁盘上两种表示都写入。
-- targetCount 位置化默认：products[1]（主产物）缺省继承目标级 targetCount，
-- 其余产物（副产物）缺省 0；规整后每个产物都带显式 targetCount 落盘。
-- recipeId（可选）指向样板库；无 recipeId 的旧目标由 recipes_store 迁移升格。
local Config = require("config")
local Util = require("util")
local Items = require("items")

local TargetsStore = {}

local numberOrDefault = Util.numberOrDefault
local boolOrDefault = Util.boolOrDefault
local labelOrDefault = Items.labelOrDefault
-- 配方条目规整已上移 items.lua（样板存储共用同一实现）
local normalizeRecipeEntries = Items.normalizeRecipeEntries

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
    -- recipeId：指向样板库（recipes.db）的引用；样板内容在加载/保存时经
    -- recipes_store.resolveTarget 覆写进本目标的 products/inputs/address。
    -- 缺省不补值（旧数据保持无此字段，normalize 才能维持定点性质）。
    local recipeId = Util.trimText(target.recipeId or "")
    target.recipeId = recipeId ~= "" and recipeId or nil
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
    })
    target.inputs = normalizeRecipeEntries(target.inputs or target.ingredients, false, {
        item = target.inputItem,
        label = target.inputLabel,
        count = target.inputPerProduct,
    })
    target.outputs = nil
    target.ingredients = nil
    target.productsText = nil
    target.inputsText = nil

    -- 位置化 targetCount 默认（AE2 副产物语义）：products[1] 是主产物，缺省
    -- 继承目标级 targetCount；其余是副产物，缺省 0——不主动驱动生产，只在
    -- 下游依赖需求拉动或显式设定目标库存时参与批次计算。
    for index, product in ipairs(target.products) do
        if product.targetCount == nil then
            product.targetCount = index == 1 and target.targetCount or 0
        end
    end

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
