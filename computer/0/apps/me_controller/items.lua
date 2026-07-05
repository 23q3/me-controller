-- 物品与配方条目的纯函数：ID 规整、显示名推导、配方条目解析/格式化、产入换算。
-- 无状态、不碰文件、不碰外设。
local Util = require("util")

local Items = {}

local trimText = Util.trimText
local numberOrDefault = Util.numberOrDefault
local formatNumber = Util.formatNumber

function Items.normalizeId(text)
    text = tostring(text or ""):lower()
    text = text:gsub("[^%w_%-]+", "_"):gsub("^_+", ""):gsub("_+$", "")
    if text == "" then return "target" end
    return text
end

function Items.defaultDisplayName(item)
    local text = tostring(item or "")
    local name = text:match("^[^:]+:(.+)$") or text
    name = name:gsub("[_%-%./]+", " "):gsub("[^%w%s]+", " ")
    name = trimText(name:gsub("%s+", " "))
    if name == "" then return text ~= "" and text or "Item" end

    return (name:gsub("(%S)(%S*)", function(first, rest)
        return first:upper() .. rest:lower()
    end))
end

function Items.labelOrDefault(label, item)
    local itemText = tostring(item or "")
    local text = label ~= nil and trimText(label) or ""
    if text == "" or text == itemText then return Items.defaultDisplayName(itemText) end
    return text
end

function Items.isGeneratedLabel(label, item)
    local itemText = tostring(item or "")
    local text = label ~= nil and trimText(label) or ""
    return text == "" or text == itemText or text == Items.defaultDisplayName(itemText)
end

function Items.displayName(target)
    local product = target.products and target.products[1]
    if product and product.label then return product.label end
    if target.productLabel then return target.productLabel end
    if target.productItem then return Items.defaultDisplayName(target.productItem) end
    return target.id
end

function Items.positiveCount(value, defaultValue)
    return numberOrDefault(value, defaultValue or 1, 0.0001)
end

function Items.primaryProduct(target)
    return target.products and target.products[1] or {
        item = target.productItem,
        label = target.productLabel,
        count = 1,
        targetCount = target.targetCount,
    }
end

function Items.recipeInputCounts(target)
    local counts = {}
    for _, input in ipairs(target.inputs or {}) do
        counts[input.item] = (counts[input.item] or 0) + Items.positiveCount(input.count)
    end
    return counts
end

function Items.totalInputUnitsForBatches(target, batches)
    local total = 0
    for _, amount in pairs(Items.recipeInputCounts(target)) do
        total = total + (amount * math.max(0, batches or 0))
    end
    return total
end

function Items.productCountPerBatch(product)
    return Items.positiveCount(product and product.count, 1)
end

function Items.primaryProductCountPerBatch(target)
    return Items.productCountPerBatch(Items.primaryProduct(target))
end

function Items.entryLabel(entry)
    return entry and (entry.label or entry.item) or "item"
end

-- 配方条目规整（原 targets_store 私有实现原样上移，供目标与样板两个存储共用）。
-- isProduct=true 时保留显式 targetCount；缺省值由调用方（normalizeTarget 的
-- 位置化默认）补齐。样板的产物条目按 isProduct=false 规整——targetCount 是
-- 目标侧库存策略，不属于样板。
local function normalizeRecipeEntry(raw, isProduct)
    if type(raw) ~= "table" then return nil end
    local item = raw.item or raw.name or raw.itemId
    if item == nil or tostring(item) == "" then return nil end

    local entry = {
        item = tostring(item),
        label = Items.labelOrDefault(raw.label or raw.displayName, item),
        count = Items.positiveCount(raw.count or raw.amount or raw.qty or raw.perBatch, 1),
    }

    if isProduct and raw.targetCount ~= nil then
        entry.targetCount = numberOrDefault(raw.targetCount, 0, 0)
    end

    return entry
end

local function appendRecipeEntry(entries, byItem, entry, isProduct)
    if not entry then return end
    local existing = byItem[entry.item]
    if existing then
        existing.count = existing.count + entry.count
        if isProduct and entry.targetCount ~= nil then existing.targetCount = entry.targetCount end
        if entry.label and Items.isGeneratedLabel(existing.label, existing.item) then
            existing.label = entry.label
        end
    else
        byItem[entry.item] = entry
        entries[#entries + 1] = entry
    end
end

function Items.normalizeRecipeEntries(rawEntries, isProduct, fallback)
    local entries, byItem = {}, {}

    if type(rawEntries) == "table" then
        if rawEntries.item or rawEntries.name or rawEntries.itemId then
            appendRecipeEntry(entries, byItem, normalizeRecipeEntry(rawEntries, isProduct), isProduct)
        else
            for _, raw in ipairs(rawEntries) do
                appendRecipeEntry(entries, byItem, normalizeRecipeEntry(raw, isProduct), isProduct)
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
                        appendRecipeEntry(entries, byItem, normalizeRecipeEntry(raw, isProduct), isProduct)
                    end
                end
            end
        end
    end

    if #entries == 0 and fallback and fallback.item then
        appendRecipeEntry(entries, byItem, normalizeRecipeEntry(fallback, isProduct), isProduct)
    end

    return entries
end

function Items.formatRecipeEntries(entries, isProduct)
    local parts = {}
    for _, entry in ipairs(entries or {}) do
        local text = tostring(entry.item) .. "=" .. formatNumber(entry.count or 1)
        if isProduct then text = text .. "@" .. formatNumber(entry.targetCount or 0) end
        parts[#parts + 1] = text
    end
    return table.concat(parts, ", ")
end

function Items.parseRecipeEntries(text, isProduct, defaultTargetCount)
    local entries = {}
    text = tostring(text or "")

    for token in text:gmatch("[^,]+") do
        token = trimText(token)
        if token ~= "" then
            local targetCount = nil
            if isProduct then
                local beforeTarget, targetText = token:match("^(.-)@([^@]+)$")
                if beforeTarget then
                    token = trimText(beforeTarget)
                    targetCount = tonumber(trimText(targetText))
                    if not targetCount or targetCount < 0 then
                        return nil, "Invalid target count: " .. tostring(targetText)
                    end
                end
            end

            local item = token
            local count = 1
            local beforeCount, countText = token:match("^(.-)=([^=]+)$")
            if beforeCount then
                item = trimText(beforeCount)
                count = tonumber(trimText(countText))
            end

            item = trimText(item)
            if item == "" then return nil, "Missing item id" end
            if not count or count <= 0 then return nil, "Invalid item count for " .. item end

            local entry = {
                item = item,
                label = Items.defaultDisplayName(item),
                count = count,
            }
            if isProduct then
                if targetCount ~= nil then
                    entry.targetCount = numberOrDefault(targetCount, 0, 0)
                else
                    -- 首个产物是主产物，未写 @ 时继承默认目标库存；
                    -- 其余是副产物，默认 0（不驱动生产）
                    entry.targetCount = #entries == 0 and numberOrDefault(defaultTargetCount, 0, 0) or 0
                end
            end
            entries[#entries + 1] = entry
        end
    end

    if #entries == 0 then return nil, "Enter at least one item" end
    return entries
end

function Items.productsToInputs(target, products)
    local batches = math.ceil(math.max(0, products or 0) / Items.primaryProductCountPerBatch(target))
    return math.ceil(Items.totalInputUnitsForBatches(target, batches))
end

function Items.inputsToProducts(target, inputs)
    local inputPerBatch = Items.totalInputUnitsForBatches(target, 1)
    if inputPerBatch <= 0 then return 0 end
    local batches = math.floor(math.max(0, inputs or 0) / inputPerBatch)
    return math.floor(batches * Items.primaryProductCountPerBatch(target))
end

return Items
