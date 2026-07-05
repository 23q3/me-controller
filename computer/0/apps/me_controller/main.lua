-- require 引导：三种启动路径（me_controller stub / run_all / 直接运行本文件）
-- 都经 shell.run，程序目录由 shell.getRunningProgram() 推导。
local dir = fs.getDir(shell.getRunningProgram())
package.path = fs.combine(dir, "?.lua") .. ";" .. package.path

local Core = require("core")
Core.CONFIG.targetsFile = fs.combine(dir, "targets.db")
Core.CONFIG.recipesFile = fs.combine(dir, "recipes.db")
Core.CONFIG.stateFile = fs.combine(dir, "state.db")
Core.CONFIG.eventsFile = fs.combine(dir, "events.log")
Core.CONFIG.bridgeFile = fs.combine(dir, "bridge.db")

local Bridge = require("bridge")(Core)
local UI = require("ui")(Core)

local function controlLoop(runtime)
    local config = Core.CONFIG
    local nextStockAt = 0
    local nextDecisionAt = 0
    local nextRenderAt = 0

    while runtime.running do
        local clock = Core.nowSeconds()
        local dirty = false

        if clock >= nextStockAt then
            dirty = Core.refreshNetwork(runtime) or dirty
            nextStockAt = clock + config.stockPollSeconds
        end

        if clock >= nextDecisionAt then
            if not runtime.networkReady then dirty = Core.refreshNetwork(runtime) or dirty end
            dirty = Core.decideTargets(runtime) or dirty
            nextDecisionAt = clock + config.decisionSeconds
        end

        if dirty then Core.saveState(runtime.state) end

        if clock >= nextRenderAt then
            UI.renderAll(runtime)
            nextRenderAt = clock + config.renderSeconds
        end

        sleep(config.idleSleepSeconds)
    end
end

local function uiLoop(runtime)
    while runtime.running do
        local event, key = os.pullEvent("key")
        if event == "key" and not runtime.promptActive then
            UI.handleKey(runtime, key)
            UI.renderAll(runtime)
        end
    end
end

local function bridgeLoop(runtime)
    Bridge.run(runtime)
end

local function printTargets(runtime)
    for index, target in ipairs(runtime.targets) do
        local enabled = target.enabled and "on" or "off"
        print(index .. ". [" .. enabled .. "] " .. target.id
            .. " recipe=" .. tostring(target.recipeId or "-")
            .. " products=" .. Core.formatRecipeEntries(target.products, true)
            .. " inputs=" .. Core.formatRecipeEntries(target.inputs, false)
            .. " address=" .. target.address)
    end
end

local function printRecipes(runtime)
    local recipes = runtime.recipes or {}
    print("recipes=" .. #recipes)
    for index, recipe in ipairs(recipes) do
        local users = 0
        for _, target in ipairs(runtime.targets or {}) do
            if target.recipeId == recipe.id then users = users + 1 end
        end
        print(index .. ". " .. recipe.id
            .. " name=" .. recipe.name
            .. " address=" .. recipe.address
            .. " products=" .. Core.formatRecipeEntries(recipe.products, false)
            .. " inputs=" .. Core.formatRecipeEntries(recipe.inputs, false)
            .. " targets=" .. users)
    end
end

local function printBridgeStatus()
    local config = Bridge.loadConfig()
    print("bridge enabled=" .. tostring(config.enabled))
    print("url=" .. tostring(config.url))
    print("clientId=" .. tostring(config.clientId))
    print("heartbeatSeconds=" .. tostring(config.heartbeatSeconds))
    print("includeStock=" .. tostring(config.includeStock))
end

local function printEvents(limit)
    local lines = Core.readEventLog(limit)
    if #lines == 0 then
        print("no events")
        return
    end

    for _, line in ipairs(lines) do
        print(line)
    end
end

local function printCommands(limit)
    limit = math.max(1, math.floor(tonumber(limit) or 20))

    local state = Core.loadState()
    local commands = state.commands or {}
    local history = commands.history or {}
    if #history == 0 then
        print("no commands")
        return
    end

    local first = math.max(1, #history - limit + 1)
    for index = first, #history do
        local command = history[index] or {}
        local line = tostring(index) .. ". "
            .. "t=" .. tostring(command.createdAt or "?")
            .. " status=" .. tostring(command.status or "?")
            .. " kind=" .. tostring(command.kind or "?")
            .. " source=" .. tostring(command.source or "?")
            .. " id=" .. tostring(command.id or "?")
        if command.targetId then line = line .. " target=" .. tostring(command.targetId) end
        if command.item then
            line = line .. " item=" .. tostring(command.item)
        elseif type(command.items) == "table" and #command.items > 0 then
            local parts = {}
            for _, entry in ipairs(command.items) do
                parts[#parts + 1] = tostring(entry.item) .. "x" .. tostring(entry.count)
            end
            line = line .. " items=" .. table.concat(parts, ",")
        end
        if command.wanted then line = line .. " wanted=" .. tostring(command.wanted) end
        if command.requested then line = line .. " requested=" .. tostring(command.requested) end
        if command.error then line = line .. " error=" .. tostring(command.error) end
        print(line)
    end
end

local args = { ... }

if args[1] == "reset" then
    Core.resetAllState()
    print("me_controller state reset")
    return
elseif args[1] == "targets" or args[1] == "list" then
    printTargets(Core.makeRuntime())
    return
elseif args[1] == "recipes" or args[1] == "patterns" then
    printRecipes(Core.makeRuntime())
    return
elseif args[1] == "events" or args[1] == "logs" or args[1] == "log" then
    printEvents(args[2])
    return
elseif args[1] == "commands" then
    printCommands(args[2])
    return
elseif args[1] == "bridge" then
    if args[2] == "enable" then
        if not args[3] or args[3] == "" then
            printError("usage: me_controller bridge enable ws://host:port/path")
            return
        end
        local config = Bridge.configure(args[3], true)
        print("bridge enabled " .. config.url)
        return
    elseif args[2] == "disable" then
        Bridge.configure(nil, false)
        print("bridge disabled")
        return
    elseif args[2] == "status" or not args[2] then
        printBridgeStatus()
        return
    else
        printError("usage: me_controller bridge [status|enable <url>|disable]")
        return
    end
elseif args[1] == "once" then
    local runtime = Core.makeRuntime()
    local ok, err = pcall(function()
        Core.runOnce(runtime)
    end)
    if not ok then
        printError(err)
        return
    end
    local summary = Core.summarize(runtime)
    print("targets=" .. summary.total .. " requested=" .. summary.requested .. " waiting=" .. summary.waiting .. " errors=" .. summary.error)
    return
end

while true do
    local runtime = Core.makeRuntime()
    local ok, err = pcall(function()
        parallel.waitForAny(
            function() controlLoop(runtime) end,
            function() uiLoop(runtime) end,
            function() bridgeLoop(runtime) end
        )
    end)

    term.setBackgroundColor(colors.black)
    term.setTextColor(colors.white)
    term.clear()
    term.setCursorPos(1, 1)

    if not ok then
        printError(err)
        sleep(1)
    elseif not runtime.running then
        print("ME Controller stopped.")
        return
    end
end
