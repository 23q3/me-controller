-- 样板库（recipes.db version=1）的规整、持久化与目标解析。
--
-- 模型：样板 = 配方（address + products[] + inputs[]）的唯一权威；目标经
-- recipeId 引用样板，只保留库存策略（targetCount/优先级/调优参数）。
-- resolveTarget 在加载与样板变更时把样板内容覆写进目标的运行时形态
-- （products/inputs/address 照旧材料化），decide/planner/tracking 链路不感知样板。
-- 样板的产物条目不带 targetCount——那是目标侧策略，解析时按物品保留既有值，
-- 新产物交 normalizeTarget 位置化补齐（主产物继承目标级、副产物 0）。
--
-- 兼容与迁移：无 recipeId 的旧目标（targets.db version=1 旧数据、DEFAULT_TARGETS）
-- 由 syncTargetsWithRecipes 自动升格出样板并挂接；形状相同（地址+条目一致）的
-- 直接复用现有样板。recipeId 指向缺失样板时保留目标内嵌副本并报 WARN，不丢数据。
local Config = require("config")
local Util = require("util")
local Items = require("items")

local RecipesStore = {}

local function uniqueRecipeId(existing, wanted)
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

function RecipesStore.normalizeRecipe(raw, existing, index)
    raw = type(raw) == "table" and raw or {}
    existing = existing or {}

    local recipe = {
        -- isProduct=false：样板条目一律不携带 targetCount（目标侧策略）
        products = Items.normalizeRecipeEntries(raw.products or raw.outputs, false, nil),
        inputs = Items.normalizeRecipeEntries(raw.inputs or raw.ingredients, false, nil),
        address = tostring(raw.address or Config.TARGET_DEFAULTS.address),
    }

    local primary = recipe.products[1]
    local wantedId = raw.id or raw.recipeId or (primary and primary.item) or ("recipe_" .. tostring(index or 1))
    recipe.id = uniqueRecipeId(existing, wantedId)

    -- 样板名即主产物显示名：手工名同步写回 products[1].label（与目标编辑器
    -- 原「显示名称」字段的行为一致），缺省从主产物推导。
    local name = Util.trimText(raw.name or "")
    if name ~= "" then
        recipe.name = name
        if primary and Items.isGeneratedLabel(primary.label, primary.item) then
            primary.label = name
        end
    else
        recipe.name = primary and Items.entryLabel(primary) or recipe.id
    end

    return recipe
end

function RecipesStore.normalizeRecipes(rawRecipes)
    local recipes = {}
    local existing = {}

    for index, raw in ipairs(rawRecipes or {}) do
        local recipe = RecipesStore.normalizeRecipe(raw, existing, index)
        -- 没有产物的样板无法参与任何合成，加载时丢弃并留痕
        if #recipe.products > 0 then
            recipes[#recipes + 1] = recipe
        else
            Util.logEvent(nil, "WARN", "recipe_invalid", { recipe = recipe.id, reason = "no products" })
        end
    end

    table.sort(recipes, function(a, b)
        if a.name == b.name then return a.id < b.id end
        return a.name < b.name
    end)

    return recipes
end

function RecipesStore.saveRecipes(recipes)
    local handle = fs.open(Config.CONFIG.recipesFile, "w")
    if not handle then
        -- 与 targets_store.saveTargets 同理：保存失败必须响亮
        Util.logEvent(nil, "ERROR", "recipes_save_failed", { file = Config.CONFIG.recipesFile })
        return false
    end
    handle.write(textutils.serialize({
        version = 1,
        recipes = recipes,
    }))
    handle.close()
    return true
end

function RecipesStore.loadRecipes()
    local decoded = Util.readSerialized(Config.CONFIG.recipesFile)

    local rawRecipes = nil
    if type(decoded) == "table" and type(decoded.recipes) == "table" then
        rawRecipes = decoded.recipes
    elseif type(decoded) == "table" then
        rawRecipes = decoded
    end

    local recipes = RecipesStore.normalizeRecipes(rawRecipes)
    RecipesStore.saveRecipes(recipes)
    return recipes
end

function RecipesStore.findRecipe(recipes, recipeId)
    recipeId = tostring(recipeId or "")
    if recipeId == "" then return nil, nil end
    for index, recipe in ipairs(recipes or {}) do
        if recipe.id == recipeId then return recipe, index end
    end
    return nil, nil
end

-- 配方形状指纹：地址 + 条目（物品=数量，排序后拼接）。标签与 targetCount 不参与，
-- 用于迁移时把内容相同的旧目标挂到同一块样板上。
local function entriesKey(entries)
    local parts = {}
    for _, entry in ipairs(entries or {}) do
        parts[#parts + 1] = tostring(entry.item) .. "=" .. Util.formatNumber(entry.count or 1)
    end
    table.sort(parts)
    return table.concat(parts, ",")
end

local function recipeShapeKey(recipe)
    return tostring(recipe.address) .. "|" .. entriesKey(recipe.products) .. "|" .. entriesKey(recipe.inputs)
end

-- 从内嵌配方的旧目标提炼样板（迁移用）：剥掉 targetCount，保留标签。
function RecipesStore.recipeFromTarget(target)
    local products = {}
    for index, product in ipairs(target.products or {}) do
        products[index] = { item = product.item, label = product.label, count = product.count }
    end
    return {
        id = target.recipeId or target.id,
        name = Items.displayName(target),
        address = target.address,
        products = products,
        inputs = Util.copyTable(target.inputs or {}),
    }
end

-- 解析后目标的配方指纹（含 targetCount）：解析前后不变则无需落盘
local function targetRecipeKey(target)
    return tostring(target.address)
        .. "|" .. Items.formatRecipeEntries(target.products, true)
        .. "|" .. Items.formatRecipeEntries(target.inputs, false)
end

-- 把样板内容覆写进目标（就地修改）。targetCount 按物品保留目标既有值；
-- 样板新增的产物留空，由随后的 normalizeTarget 位置化补齐。
-- 返回是否发生实际变化（调用方据此决定落盘）。
function RecipesStore.resolveTarget(target, recipe)
    local before = targetRecipeKey(target)

    local previousTargetCounts = {}
    for _, product in ipairs(target.products or {}) do
        if product.targetCount ~= nil then previousTargetCounts[product.item] = product.targetCount end
    end

    local products = {}
    for index, product in ipairs(recipe.products or {}) do
        products[index] = {
            item = product.item,
            label = product.label,
            count = product.count,
            targetCount = previousTargetCounts[product.item],
        }
    end

    target.address = tostring(recipe.address)
    target.products = products
    target.inputs = Util.copyTable(recipe.inputs or {})

    return targetRecipeKey(target) ~= before
end

-- 迁移 + 解析（加载与 reload 时调用，就地修改两个列表）：
-- 1) 无 recipeId 的目标升格出样板（形状相同的复用现有样板）；
-- 2) 有 recipeId 的目标以样板为准覆写配方内容。
-- 返回 recipesDirty, targetsDirty, missing（recipeId 悬空的 {target, recipe} 列表）。
function RecipesStore.syncTargetsWithRecipes(recipes, targets)
    local recipesDirty, targetsDirty = false, false
    local missing = {}

    local byId = {}
    for _, recipe in ipairs(recipes or {}) do byId[recipe.id] = recipe end

    for _, target in ipairs(targets or {}) do
        if not target.recipeId then
            local candidate = RecipesStore.recipeFromTarget(target)
            local candidateKey = recipeShapeKey(candidate)
            local linked = nil
            for _, recipe in ipairs(recipes or {}) do
                if recipeShapeKey(recipe) == candidateKey then
                    linked = recipe
                    break
                end
            end

            if not linked then
                local existing = {}
                for _, recipe in ipairs(recipes or {}) do existing[recipe.id] = true end
                linked = RecipesStore.normalizeRecipe(candidate, existing, #recipes + 1)
                recipes[#recipes + 1] = linked
                byId[linked.id] = linked
                recipesDirty = true
                Util.logEvent(nil, "INFO", "recipe_migrated", { recipe = linked.id, target = target.id })
            end

            target.recipeId = linked.id
            targetsDirty = true
        end
    end

    for _, target in ipairs(targets or {}) do
        local recipe = target.recipeId and byId[target.recipeId] or nil
        if recipe then
            if RecipesStore.resolveTarget(target, recipe) then targetsDirty = true end
        elseif target.recipeId then
            missing[#missing + 1] = { target = target.id, recipe = target.recipeId }
        end
    end

    return recipesDirty, targetsDirty, missing
end

return RecipesStore
