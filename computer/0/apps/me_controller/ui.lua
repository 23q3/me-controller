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
            writeAt(target, 2, h - 1, "A Add  E Edit  D Delete  Space Toggle  R Reset  Q Quit", colors.gray)
            writeAt(target, 2, h, "Up/Down Select  PgUp/PgDn Page", colors.gray)
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
            elseif field.kind == "recipeProducts" then
                value = promptRecipe(runtime, title, field.label, draft[field.key], true, draft.targetCount, allowBack)
            elseif field.kind == "recipeInputs" then
                value = promptRecipe(runtime, title, field.label, draft[field.key], false, draft.targetCount, allowBack)
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

    local function labelsByItem(entries)
        local labels = {}
        for _, entry in ipairs(entries or {}) do
            labels[entry.item] = entry.label
        end
        return labels
    end

    local function prepareRecipeDraft(draft)
        draft.productsText = Core.formatRecipeEntries(draft.products, true)
        draft.inputsText = Core.formatRecipeEntries(draft.inputs, false)
        if draft.products and draft.products[1] then draft.productLabel = draft.products[1].label end
        if draft.inputs and draft.inputs[1] then draft.inputLabel = draft.inputs[1].label end
    end

    local function applyRecipeDraft(draft)
        local oldProductLabels = labelsByItem(draft.products)
        local oldInputLabels = labelsByItem(draft.inputs)
        local products = Core.parseRecipeEntries(draft.productsText, true, draft.targetCount)
        local inputs = Core.parseRecipeEntries(draft.inputsText, false, draft.targetCount)

        if not products or not inputs then return false end
        for _, product in ipairs(products) do
            product.label = oldProductLabels[product.item] or product.item
        end
        for _, input in ipairs(inputs) do
            input.label = oldInputLabels[input.item] or input.item
        end
        if products[1] then
            products[1].label = tostring(draft.productLabel or products[1].label or products[1].item)
            draft.productItem = products[1].item
            draft.productLabel = products[1].label
            draft.targetCount = products[1].targetCount
        end
        if inputs[1] then
            inputs[1].label = tostring(draft.inputLabel or inputs[1].label or inputs[1].item)
            draft.inputItem = inputs[1].item
            draft.inputLabel = inputs[1].label
        end

        draft.products = products
        draft.inputs = inputs
        draft.productsText = nil
        draft.inputsText = nil
        return true
    end

    function UI.reloadTargets(runtime)
        Core.reloadTargets(runtime)
        UI.ensureSelection(runtime)
    end

    function UI.addTarget(runtime)
        local title = "Add Target"
        local defaults = Core.normalizeTarget(Core.TARGET_DEFAULTS, {}, 1)
        local draft = Core.copyTable(defaults)
        draft.id = Core.normalizeId(defaults.productItem)
        prepareRecipeDraft(draft)

        local ok = runFields(runtime, title, {
            { key = "productsText", label = "Products item=count@target", kind = "recipeProducts", required = true },
            { key = "productLabel", label = "Primary product label" },
            { key = "id", label = "Target id", required = true },
            { key = "inputsText", label = "Inputs item=count", kind = "recipeInputs", required = true },
            { key = "inputLabel", label = "Primary input label" },
            { key = "address", label = "Request address", required = true },
            { key = "priority", label = "Priority, lower is earlier", kind = "number" },
        }, draft)
        if not ok then return end
        if not applyRecipeDraft(draft) then return end

        local existing = {}
        for _, target in ipairs(runtime.targets) do existing[target.id] = true end
        local normalized = Core.normalizeTarget(draft, existing, #runtime.targets + 1)
        runtime.targets[#runtime.targets + 1] = normalized
        Core.logEvent(runtime, "INFO", "target_added", { target = normalized.id, name = Core.displayName(normalized) })

        Core.saveTargets(Core.normalizeTargets(runtime.targets))
        UI.reloadTargets(runtime)
    end

    function UI.editTarget(runtime)
        local target = runtime.targets[runtime.selectedIndex]
        if not target then return end

        local draft = Core.copyTable(target)
        local title = "Edit " .. Core.displayName(draft)
        prepareRecipeDraft(draft)

        local ok = runFields(runtime, title, {
            { key = "enabled", label = "Enabled", kind = "yesno" },
            { key = "productsText", label = "Products item=count@target", kind = "recipeProducts", required = true },
            { key = "productLabel", label = "Primary product label" },
            { key = "inputsText", label = "Inputs item=count", kind = "recipeInputs", required = true },
            { key = "inputLabel", label = "Primary input label" },
            { key = "address", label = "Request address", required = true },
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
        if not applyRecipeDraft(draft) then return end

        -- 单实现：与远程 upsert_target 共用 Core.upsertTarget（uiEvents 保持 target_edited 事件名）
        Core.upsertTarget(runtime, draft, target.id, { uiEvents = true })
        UI.reloadTargets(runtime)
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
        elseif key == keys.q then
            runtime.running = false
        end
    end

    return UI
end
