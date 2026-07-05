return function(Core)
    local UI = {}
    local CANCEL = {}
    local BACK = {}

    local function writeAt(target, x, y, text, fg, bg)
        if fg and target.setTextColor then target.setTextColor(fg) end
        if bg and target.setBackgroundColor then target.setBackgroundColor(bg) end
        target.setCursorPos(x, y)
        target.write(tostring(text))
    end

    local function clearLine(target, y, bg)
        local w = target.getSize()
        if bg and target.setBackgroundColor then target.setBackgroundColor(bg) end
        target.setCursorPos(1, y)
        target.write(string.rep(" ", w))
    end

    local function trim(text, width)
        text = tostring(text or "")
        width = math.floor(width or 0)
        if width <= 0 then return "" end
        if #text <= width then return text end
        if width <= 1 then return text:sub(1, width) end
        return text:sub(1, width - 1) .. "."
    end

    local function statusColor(status)
        if status == "ERROR" then return colors.red end
        if status == "WAITING" then return colors.yellow end
        if status == "REQUESTED" then return colors.cyan end
        if status == "DISABLED" then return colors.gray end
        if status == "SATISFIED" then return colors.lime end
        return colors.white
    end

    function UI.ensureSelection(runtime)
        if #runtime.targets == 0 then
            runtime.selectedIndex = 1
            runtime.pageOffset = 1
            return
        end

        runtime.selectedIndex = math.max(1, math.min(runtime.selectedIndex or 1, #runtime.targets))
        runtime.pageOffset = math.max(1, math.min(runtime.pageOffset or 1, runtime.selectedIndex))
    end

    function UI.renderList(target, runtime, interactive)
        local w, h = target.getSize()
        if target.setTextScale and w >= 30 then target.setTextScale(1) end
        target.setBackgroundColor(colors.black)
        target.setTextColor(colors.white)
        target.clear()

        UI.ensureSelection(runtime)
        local summary = Core.summarize(runtime)
        writeAt(target, 2, 1, "ME CONTROLLER", colors.lime)
        writeAt(target, math.max(1, w - 10), 1, textutils.formatTime(os.time(), true), colors.gray)
        writeAt(target, 2, 2, string.rep("-", math.max(1, w - 2)), colors.gray)

        local stockLabel = runtime.networkReady and ("stock " .. tostring(runtime.stockEntries or 0)) or "stock offline"
        local bridgeLabel = ""
        if runtime.bridge and runtime.bridge.enabled then
            bridgeLabel = runtime.bridge.connected and "  bridge online" or "  bridge offline"
        end
        local summaryLine = "Total " .. summary.total
            .. "  On " .. summary.enabled
            .. "  Req " .. summary.requested
            .. "  Wait " .. summary.waiting
            .. "  Err " .. summary.error
            .. "  " .. stockLabel .. bridgeLabel
        writeAt(target, 2, 3, trim(summaryLine, w - 2), colors.gray)

        local headerY = 5
        writeAt(target, 2, headerY, "#", colors.gray)
        writeAt(target, 5, headerY, "E", colors.gray)
        writeAt(target, 7, headerY, "Status", colors.gray)
        writeAt(target, 18, headerY, "Product", colors.gray)
        writeAt(target, math.max(35, w - 34), headerY, "Stock/Target", colors.gray)
        writeAt(target, math.max(49, w - 20), headerY, "Need", colors.gray)

        local firstRow = headerY + 1
        local lastRow = interactive and h - 3 or h
        local rows = math.max(0, lastRow - firstRow + 1)
        if rows <= 0 then return end

        if runtime.selectedIndex < runtime.pageOffset then runtime.pageOffset = runtime.selectedIndex end
        if runtime.selectedIndex >= runtime.pageOffset + rows then runtime.pageOffset = runtime.selectedIndex - rows + 1 end
        runtime.pageOffset = math.max(1, runtime.pageOffset)

        for row = 0, rows - 1 do
            local index = runtime.pageOffset + row
            local y = firstRow + row
            local targetInfo = runtime.targets[index]
            local selected = interactive and index == runtime.selectedIndex
            local bg = selected and colors.gray or colors.black
            clearLine(target, y, bg)

            if targetInfo then
                local data = runtime.dataById[targetInfo.id] or {}
                local fg = selected and colors.black or colors.white
                local statFg = selected and colors.black or statusColor(data.status)
                local enabledFlag = targetInfo.enabled and "*" or "-"
                local countText = tostring(data.productCount or 0) .. "/" .. tostring(data.targetCount or targetInfo.targetCount)
                local needText = tostring(data.neededInputs or 0)

                writeAt(target, 2, y, tostring(index), fg, bg)
                writeAt(target, 5, y, enabledFlag, targetInfo.enabled and colors.lime or colors.gray, bg)
                writeAt(target, 7, y, trim(data.status or "-", 10), statFg, bg)
                writeAt(target, 18, y, trim(Core.displayName(targetInfo), math.max(10, w - 55)), fg, bg)
                writeAt(target, math.max(35, w - 34), y, trim(countText, 13), fg, bg)
                writeAt(target, math.max(49, w - 20), y, trim(needText, 8), fg, bg)
            end
        end

        if interactive then
            local selectedTarget = runtime.targets[runtime.selectedIndex]
            local selectedData = selectedTarget and runtime.dataById[selectedTarget.id] or nil
            clearLine(target, h - 2, colors.black)
            clearLine(target, h - 1, colors.black)
            clearLine(target, h, colors.black)
            if selectedTarget and selectedData then
                local ttl = selectedData.nextExpiry and Core.formatTimeLeft(selectedData.nextExpiry) or "-"
                local detail = "Need " .. tostring(selectedData.neededInputs or 0)
                    .. "/" .. tostring(selectedData.neededBatches or 0) .. "b"
                    .. "  Chain " .. tostring(selectedData.dependencyDemand or 0)
                    .. "  Promised " .. tostring(selectedData.promisedInputs or 0)
                    .. "/" .. tostring(selectedData.promisedBatches or 0) .. "b"
                    .. "  TTL " .. ttl
                    .. "  " .. tostring(selectedData.message or "-")
                writeAt(target, 2, h - 2, trim(detail, w - 2), statusColor(selectedData.status))
            end
            writeAt(target, 2, h - 1, "A Add  E Edit  D Delete  Space Toggle  R Reset", colors.gray)
            writeAt(target, 2, h, "P Patterns  Up/Down Select  PgUp/PgDn Page  Q Quit", colors.gray)
        end
    end

    function UI.renderAll(runtime)
        if runtime.monitor then UI.renderList(runtime.monitor, runtime, false) end
        if not runtime.promptActive then UI.renderList(term, runtime, true) end
    end

    local function isCancel(value)
        return value == CANCEL
    end

    local function isBack(value)
        return value == BACK
    end

    local function redrawInputLine(y, value, cursor)
        local w = term.getSize()
        local maxWidth = math.max(1, w - 3)
        local viewStart = math.max(1, cursor - maxWidth + 1)
        if #value - viewStart + 1 < maxWidth then
            viewStart = math.max(1, #value - maxWidth + 1)
        end
        local view = value:sub(viewStart, viewStart + maxWidth - 1)
        term.setCursorPos(1, y)
        term.clearLine()
        write("> " .. view)
        term.setCursorPos(math.max(3, math.min(w, 3 + cursor - viewStart)), y)
    end

    local function promptValue(runtime, title, label, defaultValue, allowBack)
        runtime.promptActive = true
        term.setBackgroundColor(colors.black)
        term.setTextColor(colors.white)
        term.clear()
        term.setCursorPos(1, 1)
        print(title)
        print("")
        if defaultValue ~= nil and tostring(defaultValue) ~= "" then
            print(label .. " [" .. tostring(defaultValue) .. "]")
        else
            print(label)
        end
        print("")
        if defaultValue ~= nil and tostring(defaultValue) ~= "" then
            print("Enter keeps current.")
        else
            print("Enter confirms.")
        end
        if allowBack then
            print("F3 back | F1 cancel")
        else
            print("F1 cancel")
        end
        print("")

        local inputY = select(2, term.getCursorPos())
        local value = ""
        local cursor = 0
        if term.setCursorBlink then term.setCursorBlink(true) end
        redrawInputLine(inputY, value, cursor)

        while true do
            local event, p1 = os.pullEvent()
            if event == "char" then
                local ch = tostring(p1 or "")
                value = value:sub(1, cursor) .. ch .. value:sub(cursor + 1)
                cursor = cursor + #ch
                redrawInputLine(inputY, value, cursor)
            elseif event == "paste" then
                local text = tostring(p1 or "")
                value = value:sub(1, cursor) .. text .. value:sub(cursor + 1)
                cursor = cursor + #text
                redrawInputLine(inputY, value, cursor)
            elseif event == "key" then
                local key = p1
                if key == keys.f1 or key == keys.escape then
                    if term.setCursorBlink then term.setCursorBlink(false) end
                    runtime.promptActive = false
                    return CANCEL
                elseif allowBack and key == keys.f3 then
                    if term.setCursorBlink then term.setCursorBlink(false) end
                    runtime.promptActive = false
                    return BACK
                elseif key == keys.enter or key == keys.numPadEnter then
                    if value == "" and defaultValue ~= nil then value = tostring(defaultValue) end
                    if term.setCursorBlink then term.setCursorBlink(false) end
                    runtime.promptActive = false
                    return value
                elseif key == keys.backspace and cursor > 0 then
                    value = value:sub(1, cursor - 1) .. value:sub(cursor + 1)
                    cursor = cursor - 1
                    redrawInputLine(inputY, value, cursor)
                elseif key == keys.delete and cursor < #value then
                    value = value:sub(1, cursor) .. value:sub(cursor + 2)
                    redrawInputLine(inputY, value, cursor)
                elseif key == keys.left then
                    cursor = math.max(0, cursor - 1)
                    redrawInputLine(inputY, value, cursor)
                elseif key == keys.right then
                    cursor = math.min(#value, cursor + 1)
                    redrawInputLine(inputY, value, cursor)
                elseif key == keys.home then
                    cursor = 0
                    redrawInputLine(inputY, value, cursor)
                elseif key == keys["end"] then
                    cursor = #value
                    redrawInputLine(inputY, value, cursor)
                end
            end
        end
    end

    local function promptNumber(runtime, title, label, defaultValue, minimum, allowBack)
        while true do
            local value = promptValue(runtime, title, label, defaultValue, allowBack)
            if isCancel(value) or isBack(value) then return value end
            local number = tonumber(value)
            if number and (minimum == nil or number >= minimum) then return number end
            runtime.promptActive = true
            print("")
            print("Invalid number. Enter a valid number, F3 back, or F1 cancel.")
            sleep(0.8)
            runtime.promptActive = false
        end
    end

    local function promptYesNo(runtime, title, label, defaultValue, allowBack)
        local defaultText = defaultValue and "y" or "n"
        while true do
            local value = promptValue(runtime, title, label .. " (y/n)", defaultText, allowBack)
            if isCancel(value) or isBack(value) then return value end
            value = tostring(value):lower()
            if value == "y" or value == "yes" then return true end
            if value == "n" or value == "no" then return false end
            runtime.promptActive = true
            print("")
            print("Enter y or n. F3 back, or F1 cancel.")
            sleep(0.8)
            runtime.promptActive = false
        end
    end

    local function promptRecipe(runtime, title, label, defaultValue, isProduct, defaultTargetCount, allowBack)
        while true do
            local value = promptValue(runtime, title, label, defaultValue, allowBack)
            if isCancel(value) or isBack(value) then return value end
            local entries, err = Core.parseRecipeEntries(value, isProduct, defaultTargetCount)
            if entries then return value end
            runtime.promptActive = true
            print("")
            print("Invalid recipe: " .. tostring(err))
            sleep(0.8)
            runtime.promptActive = false
        end
    end

    -- 样板 id 校验循环：输错时列出现有样板 id 再重试
    local function promptRecipeId(runtime, title, defaultValue, allowBack)
        while true do
            local ids = {}
            for _, recipe in ipairs(runtime.recipes or {}) do ids[#ids + 1] = recipe.id end
            local value = promptValue(runtime, title, "Recipe id (" .. #ids .. " available)", defaultValue, allowBack)
            if isCancel(value) or isBack(value) then return value end
            if Core.findRecipe(runtime.recipes, value) then return value end
            runtime.promptActive = true
            print("")
            print("Unknown recipe. Available:")
            print(table.concat(ids, ", "))
            sleep(1.5)
            runtime.promptActive = false
        end
    end

    local function runFields(runtime, title, fields, draft)
        local index = 1
        while index <= #fields do
            local field = fields[index]
            local value
            local allowBack = index > 1

            if field.kind == "number" then
                value = promptNumber(runtime, title, field.label, draft[field.key], field.minimum, allowBack)
            elseif field.kind == "yesno" then
                value = promptYesNo(runtime, title, field.label, draft[field.key], allowBack)
            elseif field.kind == "recipeEntries" then
                value = promptRecipe(runtime, title, field.label, draft[field.key], false, nil, allowBack)
            elseif field.kind == "recipeId" then
                value = promptRecipeId(runtime, title, draft[field.key], allowBack)
            else
                value = promptValue(runtime, title, field.label, draft[field.key], allowBack)
            end

            if isCancel(value) then return false end
            if isBack(value) then
                index = math.max(1, index - 1)
            else
                if field.required and value == "" then
                    runtime.promptActive = true
                    print("")
                    print("This field is required.")
                    sleep(0.8)
                    runtime.promptActive = false
                else
                    draft[field.key] = value
                    index = index + 1
                end
            end
        end

        return true
    end

    local function showMessage(runtime, text, seconds)
        runtime.promptActive = true
        term.setBackgroundColor(colors.black)
        term.setTextColor(colors.white)
        term.clear()
        term.setCursorPos(1, 1)
        print(text)
        sleep(seconds or 1.5)
        runtime.promptActive = false
    end

    -- 沿用旧配方文本编辑的标签保留语义：物品在旧条目里出现过则带回旧标签
    local function preserveEntryLabels(entries, oldEntries)
        local byItem = {}
        for _, entry in ipairs(oldEntries or {}) do byItem[entry.item] = entry.label end
        for _, entry in ipairs(entries or {}) do
            if byItem[entry.item] then entry.label = byItem[entry.item] end
        end
    end

    function UI.reloadTargets(runtime)
        Core.reloadTargets(runtime)
        UI.ensureSelection(runtime)
    end

    -- 目标 = 样板引用 + 库存策略：新增/编辑只选样板、填目标库存与优先级，
    -- 配方内容（产物/原料/地址）完全由样板控制（upsertTarget 内解析覆写）。
    function UI.addTarget(runtime)
        if #(runtime.recipes or {}) == 0 then
            showMessage(runtime, "No recipes yet. Press P to add a recipe first.")
            return
        end

        local title = "Add Target"
        local defaults = Core.TARGET_DEFAULTS
        local draft = {
            enabled = true,
            recipeId = runtime.recipes[1].id,
            targetCount = defaults.targetCount,
            id = "",
            priority = defaults.priority,
        }

        local ok = runFields(runtime, title, {
            { key = "recipeId", label = "Recipe id", kind = "recipeId", required = true },
            { key = "targetCount", label = "Target stock (primary product)", kind = "number", minimum = 0 },
            { key = "id", label = "Target id (empty = from recipe)" },
            { key = "priority", label = "Priority, lower is earlier", kind = "number" },
        }, draft)
        if not ok then return end
        if draft.id == nil or draft.id == "" then draft.id = Core.normalizeId(draft.recipeId) end

        -- 单实现：与远程 upsert_target 共用 Core.upsertTarget（样板解析在其内完成）
        local okUpsert, err = pcall(Core.upsertTarget, runtime, draft, nil, { uiEvents = true })
        if not okUpsert then
            showMessage(runtime, "Save failed: " .. tostring(err), 2)
            return
        end
        UI.reloadTargets(runtime)
    end

    function UI.editTarget(runtime)
        local target = runtime.targets[runtime.selectedIndex]
        if not target then return end

        local draft = Core.copyTable(target)
        local title = "Edit " .. Core.displayName(draft)

        local ok = runFields(runtime, title, {
            { key = "enabled", label = "Enabled", kind = "yesno" },
            { key = "recipeId", label = "Recipe id", kind = "recipeId", required = true },
            { key = "targetCount", label = "Target stock (primary product)", kind = "number", minimum = 0 },
            { key = "priority", label = "Priority, lower is earlier", kind = "number" },
            { key = "requestCooldownSeconds", label = "Request cooldown seconds", kind = "number", minimum = 0 },
            { key = "minImmediateRequest", label = "Immediate batch size", kind = "number", minimum = 1 },
            { key = "delayedRequestSeconds", label = "Small batch delay seconds", kind = "number", minimum = 0 },
            { key = "promiseTtlSeconds", label = "Promise ttl seconds", kind = "number", minimum = 1 },
            { key = "maxOutstandingInputs", label = "Max outstanding inputs", kind = "number", minimum = 1 },
            { key = "maxRequestPerCycle", label = "Max request per cycle", kind = "number", minimum = 1 },
            { key = "deficitConfirmScans", label = "Low stock confirm scans", kind = "number", minimum = 1 },
            { key = "deficitConfirmSeconds", label = "Low stock confirm seconds", kind = "number", minimum = 0 },
            { key = "stockDropConfirmScans", label = "Stock drop confirm scans", kind = "number", minimum = 1 },
            { key = "stockDropConfirmSeconds", label = "Stock drop confirm seconds", kind = "number", minimum = 0 },
        }, draft)
        if not ok then return end

        -- 主产物目标库存以本次输入为准：写回 products[1]，否则解析时会被
        -- "按物品保留旧值"盖掉本次编辑
        if draft.products and draft.products[1] then
            draft.products[1].targetCount = tonumber(draft.targetCount) or draft.products[1].targetCount
        end

        -- 单实现：与远程 upsert_target 共用 Core.upsertTarget（uiEvents 保持 target_edited 事件名）
        local okUpsert, err = pcall(Core.upsertTarget, runtime, draft, target.id, { uiEvents = true })
        if not okUpsert then
            showMessage(runtime, "Save failed: " .. tostring(err), 2)
            return
        end
        UI.reloadTargets(runtime)
    end

    -- ---- 样板管理（P 键）：样板承载配方（输入/输出/地址），目标只引用 ----

    local function listRecipesScreen(runtime)
        runtime.promptActive = true
        term.setBackgroundColor(colors.black)
        term.setTextColor(colors.white)
        term.clear()
        term.setCursorPos(1, 1)
        print("Recipes (" .. #(runtime.recipes or {}) .. ")")
        print("")
        for index, recipe in ipairs(runtime.recipes or {}) do
            print(index .. ". " .. recipe.id .. "  @" .. recipe.address)
            print("   " .. Core.formatRecipeEntries(recipe.inputs, false)
                .. " -> " .. Core.formatRecipeEntries(recipe.products, false))
        end
        print("")
        print("Press any key")
        os.pullEvent("key")
        runtime.promptActive = false
    end

    local function runRecipeFields(runtime, title, draft)
        return runFields(runtime, title, {
            { key = "productsText", label = "Products item=count", kind = "recipeEntries", required = true },
            { key = "name", label = "Recipe name (primary product label)" },
            { key = "id", label = "Recipe id (empty = from product)" },
            { key = "inputsText", label = "Inputs item=count", kind = "recipeEntries", required = true },
            { key = "address", label = "Request address", required = true },
        }, draft)
    end

    local function upsertRecipeFromDraft(runtime, draft, recipeId, oldRecipe)
        local products = Core.parseRecipeEntries(draft.productsText, false)
        local inputs = Core.parseRecipeEntries(draft.inputsText, false)
        if not products or not inputs then return end
        preserveEntryLabels(products, oldRecipe and oldRecipe.products)
        preserveEntryLabels(inputs, oldRecipe and oldRecipe.inputs)

        draft.products = products
        draft.inputs = inputs
        draft.productsText = nil
        draft.inputsText = nil

        -- 单实现：与远程 upsert_recipe 共用（保存后自动重解析引用它的目标）
        local ok, err = pcall(Core.upsertRecipe, runtime, draft, recipeId, { uiEvents = true })
        if not ok then showMessage(runtime, "Save failed: " .. tostring(err), 2) end
    end

    function UI.managePatterns(runtime)
        local action = promptValue(runtime, "Patterns (" .. #(runtime.recipes or {}) .. ")",
            "a add | e edit | d delete | l list", "l")
        if isCancel(action) then return end
        action = tostring(action):lower()

        if action == "l" or action == "list" then
            listRecipesScreen(runtime)
            return
        end

        if action == "a" or action == "add" then
            local defaults = Core.TARGET_DEFAULTS
            local draft = {
                id = "",
                name = "",
                address = defaults.address,
                productsText = defaults.productItem .. "=1",
                inputsText = defaults.inputItem .. "=1",
            }
            if runRecipeFields(runtime, "Add Recipe", draft) then
                upsertRecipeFromDraft(runtime, draft, nil, nil)
                UI.ensureSelection(runtime)
            end
            return
        end

        if action == "e" or action == "edit" then
            if #(runtime.recipes or {}) == 0 then
                showMessage(runtime, "No recipes yet.")
                return
            end
            local selected = runtime.targets[runtime.selectedIndex]
            local defaultId = selected and selected.recipeId or runtime.recipes[1].id
            local recipeId = promptRecipeId(runtime, "Edit Recipe", defaultId, false)
            if isCancel(recipeId) or isBack(recipeId) then return end

            local recipe = Core.findRecipe(runtime.recipes, recipeId)
            local draft = Core.copyTable(recipe)
            draft.productsText = Core.formatRecipeEntries(draft.products, false)
            draft.inputsText = Core.formatRecipeEntries(draft.inputs, false)
            if runRecipeFields(runtime, "Edit Recipe " .. recipe.id, draft) then
                upsertRecipeFromDraft(runtime, draft, recipe.id, recipe)
                UI.ensureSelection(runtime)
            end
            return
        end

        if action == "d" or action == "delete" then
            if #(runtime.recipes or {}) == 0 then
                showMessage(runtime, "No recipes yet.")
                return
            end
            local recipeId = promptRecipeId(runtime, "Delete Recipe", runtime.recipes[1].id, false)
            if isCancel(recipeId) or isBack(recipeId) then return end

            local value = promptValue(runtime, "Delete recipe " .. tostring(recipeId), "Type DELETE to confirm", "")
            if isCancel(value) or value ~= "DELETE" then return end

            -- 被目标引用时 deleteRecipeById 会报错并列出引用者
            local ok, err = pcall(Core.deleteRecipeById, runtime, recipeId, { uiEvents = true })
            if not ok then showMessage(runtime, "Delete failed: " .. tostring(err), 2.5) end
            return
        end

        showMessage(runtime, "Unknown action: " .. action, 1)
    end

    function UI.deleteTarget(runtime)
        local target = runtime.targets[runtime.selectedIndex]
        if not target then return end

        local value = promptValue(runtime, "Delete " .. Core.displayName(target), "Type DELETE to confirm", "")
        if isCancel(value) or value ~= "DELETE" then return end

        Core.deleteTargetById(runtime, target.id, { uiEvents = true })
        Core.saveState(runtime.state)
        UI.reloadTargets(runtime)
    end

    function UI.toggleTarget(runtime)
        local target = runtime.targets[runtime.selectedIndex]
        if not target then return end

        target.enabled = not target.enabled
        Core.logEvent(runtime, "INFO", "target_toggled", { target = target.id, enabled = target.enabled })
        Core.saveTargets(Core.normalizeTargets(runtime.targets))
        UI.reloadTargets(runtime)
    end

    function UI.resetTargetState(runtime)
        local target = runtime.targets[runtime.selectedIndex]
        if not target then return end

        local value = promptValue(runtime, "Reset " .. Core.displayName(target), "Type RESET to clear promises", "")
        if isCancel(value) or value ~= "RESET" then return end

        Core.resetTargetStateById(runtime, target.id, { uiEvents = true })
        Core.saveState(runtime.state)
    end

    function UI.handleKey(runtime, key)
        UI.ensureSelection(runtime)

        if key == keys.up then
            runtime.selectedIndex = math.max(1, (runtime.selectedIndex or 1) - 1)
        elseif key == keys.down then
            runtime.selectedIndex = math.min(#runtime.targets, (runtime.selectedIndex or 1) + 1)
        elseif key == keys.pageUp then
            runtime.selectedIndex = math.max(1, (runtime.selectedIndex or 1) - 10)
        elseif key == keys.pageDown then
            runtime.selectedIndex = math.min(#runtime.targets, (runtime.selectedIndex or 1) + 10)
        elseif key == keys.home then
            runtime.selectedIndex = 1
        elseif key == keys["end"] then
            runtime.selectedIndex = math.max(1, #runtime.targets)
        elseif key == keys.a then
            UI.addTarget(runtime)
        elseif key == keys.e or key == keys.enter then
            UI.editTarget(runtime)
        elseif key == keys.d or key == keys.delete then
            UI.deleteTarget(runtime)
        elseif key == keys.space then
            UI.toggleTarget(runtime)
        elseif key == keys.r then
            UI.resetTargetState(runtime)
        elseif key == keys.p then
            UI.managePatterns(runtime)
        elseif key == keys.q then
            runtime.running = false
        end
    end

    return UI
end
