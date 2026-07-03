local inbox = "cc_agent/inbox"
local current = "cc_agent/current"
local outbox = "cc_agent/outbox"
local running = true

local function ensureDir(path)
    if not fs.exists(path) then fs.makeDir(path) end
end

local function readAll(path)
    local handle = fs.open(path, "r")
    if not handle then return nil end
    local data = handle.readAll()
    handle.close()
    return data
end

local function writeAll(path, data)
    local handle = fs.open(path, "w")
    if not handle then error("Could not open " .. path .. " for writing") end
    handle.write(data or "")
    handle.close()
end

local function capture(fn)
    local lines = {}
    local oldPrint = print
    local oldWrite = write
    local oldTerm = term.current and term.current() or nil
    local cursorX, cursorY = 1, 1
    local width, height = term.getSize()
    local isColor = false
    if oldTerm then
        if oldTerm.isColor then isColor = oldTerm.isColor()
        elseif oldTerm.isColour then isColor = oldTerm.isColour() end
    elseif term.isColor then isColor = term.isColor()
    elseif term.isColour then isColor = term.isColour() end

    local function putChar(ch)
        local line = lines[cursorY] or ""
        if #line < cursorX - 1 then
            line = line .. (" "):rep(cursorX - 1 - #line)
        end
        lines[cursorY] = line:sub(1, cursorX - 1) .. ch .. line:sub(cursorX + 1)
        cursorX = cursorX + 1
    end

    local function append(text)
        text = tostring(text or "")
        for i = 1, #text do
            local ch = text:sub(i, i)
            if ch == "\n" then
                cursorX, cursorY = 1, cursorY + 1
            else
                putChar(ch)
            end
        end
    end

    local function capturedOutput()
        local out = {}
        local maxLine = 0
        for line in pairs(lines) do
            if line > maxLine then maxLine = line end
        end
        for i = 1, maxLine do
            out[i] = (lines[i] or ""):gsub("%s+$", "")
        end
        return table.concat(out, "\n")
    end

    local fakeTerm = {
        write = append,
        blit = function(text)
            append(text)
        end,
        clear = function()
            lines = {}
            cursorX, cursorY = 1, 1
        end,
        clearLine = function()
            lines[cursorY] = ""
            cursorX = 1
        end,
        getCursorPos = function()
            return cursorX, cursorY
        end,
        setCursorPos = function(x, y)
            cursorX, cursorY = math.floor(x), math.floor(y)
        end,
        getCursorBlink = function()
            return false
        end,
        setCursorBlink = function() end,
        isColor = function()
            return isColor
        end,
        isColour = function()
            return isColor
        end,
        getSize = function()
            return width, height
        end,
        scroll = function(n)
            for _ = 1, n do table.remove(lines, 1) end
        end,
        getTextColor = function()
            return colors.white
        end,
        getTextColour = function()
            return colors.white
        end,
        setTextColor = function() end,
        setTextColour = function() end,
        getBackgroundColor = function()
            return colors.black
        end,
        getBackgroundColour = function()
            return colors.black
        end,
        setBackgroundColor = function() end,
        setBackgroundColour = function() end
    }

    print = function(...)
        local parts = {}
        for i = 1, select("#", ...) do
            parts[#parts + 1] = tostring(select(i, ...))
        end
        append(table.concat(parts, "\t") .. "\n")
    end

    write = function(text)
        append(text)
    end

    if term.redirect then term.redirect(fakeTerm) end
    local ok, result = pcall(fn)
    if oldTerm and term.redirect then term.redirect(oldTerm) end
    print = oldPrint
    write = oldWrite

    return ok, result, capturedOutput()
end

local function splitCommand(command)
    local args = {}
    for token in tostring(command):gmatch("%S+") do
        args[#args + 1] = token
    end
    return args
end

local aliases = {
    ls = "list",
    dir = "list",
    cat = "type",
    rm = "delete",
    del = "delete",
    cp = "copy",
    mv = "move"
}

local programPaths = {
    "",
    "rom/programs",
    "rom/programs/fun",
    "rom/programs/http",
    "rom/programs/rednet",
    "rom/programs/turtle",
    "rom/programs/pocket",
    "rom/programs/command"
}

local currentDir = ""

local function resolveProgram(name)
    name = aliases[name] or name
    local candidates = {}

    if name:find("/") then
        candidates[#candidates + 1] = name
        candidates[#candidates + 1] = name .. ".lua"
    else
        for _, base in ipairs(programPaths) do
            local path = base == "" and name or fs.combine(base, name)
            candidates[#candidates + 1] = path
            candidates[#candidates + 1] = path .. ".lua"
        end
    end

    for _, path in ipairs(candidates) do
        if fs.exists(path) and not fs.isDir(path) then
            return path
        end
    end
    return nil
end

local function resolvePath(path)
    path = tostring(path or "")
    if path == "" then return currentDir end
    if path:sub(1, 1) == "/" then return fs.combine("", path:sub(2)) end
    return fs.combine(currentDir, path)
end

local function makeShellApi()
    local api = {}
    -- 真实 shell 会跟踪当前运行的程序；main.lua 等程序靠
    -- shell.getRunningProgram() 推导自身目录，缺了它相对路径全会解析到根目录
    local runningProgram = nil

    function api.getRunningProgram()
        return runningProgram
    end

    function api.dir()
        return currentDir
    end

    function api.setDir(path)
        currentDir = resolvePath(path)
    end

    function api.resolve(path)
        return resolvePath(path)
    end

    function api.resolveProgram(name)
        return resolveProgram(name)
    end

    function api.programs(includeHidden)
        local seen, out = {}, {}
        for _, base in ipairs(programPaths) do
            if fs.isDir(base) then
                for _, file in ipairs(fs.list(base)) do
                    if includeHidden or file:sub(1, 1) ~= "." then
                        local name = file:gsub("%.lua$", "")
                        if not seen[name] then
                            seen[name] = true
                            out[#out + 1] = name
                        end
                    end
                end
            end
        end
        table.sort(out)
        return out
    end

    function api.run(command, ...)
        local args = splitCommand(command)
        for i = 1, select("#", ...) do
            args[#args + 1] = tostring(select(i, ...))
        end
        if #args == 0 then return true end

        local program = resolveProgram(args[1])
        if not program then return false end

        local env = setmetatable({ shell = api }, { __index = _G })
        local unpackArgs = table.unpack or unpack
        local previous = runningProgram
        runningProgram = program
        local ok = os.run(env, program, unpackArgs(args, 2))
        runningProgram = previous
        return ok
    end

    function api.openTab()
        return nil
    end

    function api.switchTab()
        return false
    end

    return api
end

local function runBuiltinShell(args)
    local command = aliases[args[1]] or args[1]

    if command == "list" then
        local target = resolvePath(args[2] or "")
        if not fs.isDir(target) then
            printError("Not a directory")
            return false
        end

        local entries = fs.list(target)
        table.sort(entries)
        for _, entry in ipairs(entries) do
            if entry:sub(1, 1) ~= "." then
                print(entry)
            end
        end
        return true
    elseif command == "pwd" then
        print(currentDir == "" and "/" or currentDir)
        return true
    elseif command == "cd" then
        local target = resolvePath(args[2] or "")
        if not fs.isDir(target) then
            printError("Not a directory")
            return false
        end
        currentDir = target
        return true
    elseif command == "type" then
        local target = resolvePath(args[2] or "")
        local handle = fs.open(target, "r")
        if not handle then
            printError("No such file")
            return false
        end
        print(handle.readAll() or "")
        handle.close()
        return true
    end

    return nil
end

local function decodeCommand(data)
    local firstLine = data:match("([^\n]*)")
    local id, kind = firstLine:match("^id=([^%s]+)%s+kind=([^%s]+)")
    local body = data:match("\n(.*)") or ""
    return id, kind, body
end

local function encodeResult(id, ok, output, value)
    return table.concat({
        "id=" .. id,
        "ok=" .. tostring(ok),
        "",
        "VALUE",
        textutils.serialize(value),
        "OUTPUT",
        output or ""
    }, "\n")
end

local function runLua(code)
    local env = setmetatable({
        stopAgent = function()
            running = false
            return "stopping"
        end
    }, { __index = _G })

    local chunk, err = load(code, "@cc_agent_command", "t", env)
    if not chunk then return false, err, "" end

    local ok, value, output = capture(chunk)
    return ok, value, output
end

local function runShell(command)
    local ok, value, output = capture(function()
        local args = splitCommand(command)
        if #args == 0 then return true end

        local builtin = runBuiltinShell(args)
        if builtin ~= nil then return builtin end

        if not resolveProgram(args[1]) then error("Program not found: " .. args[1]) end

        -- 经 api.run 执行，顶层程序也进入 runningProgram 跟踪
        return makeShellApi().run(command)
    end)
    return ok and value ~= false, value, output
end

local function processCommand(path)
    local data = readAll(path)
    if not data or data == "" then return end

    local id, kind, body = decodeCommand(data)
    if not id or not kind then
        writeAll(outbox .. "/bad-command.txt", encodeResult("bad-command", false, "Invalid command header", nil))
        fs.delete(path)
        return
    end

    local ok, value, output
    if kind == "lua" then
        ok, value, output = runLua(body)
    elseif kind == "shell" then
        ok, value, output = runShell(body)
    elseif kind == "ping" then
        ok, value, output = true, {
            id = os.computerID(),
            label = os.computerLabel(),
            version = os.version(),
            time = os.epoch and os.epoch("utc") or os.clock()
        }, "pong"
    elseif kind == "stop" then
        ok, value, output = true, "stopping", "stopping"
        running = false
    else
        ok, value, output = false, "Unknown command kind: " .. kind, ""
    end

    writeAll(outbox .. "/" .. id .. ".txt", encodeResult(id, ok, output, value))
    fs.delete(path)
end

ensureDir("cc_agent")
ensureDir(inbox)
ensureDir(outbox)

term.clear()
term.setCursorPos(1, 1)
print("CC agent ready.")
print("Inbox:  " .. inbox)
print("Outbox: " .. outbox)
print("Use stopAgent() or send kind=stop to stop.")

while running do
    local files = fs.list(inbox)
    table.sort(files)
    for _, name in ipairs(files) do
        local path = fs.combine(inbox, name)
        if not fs.isDir(path) then
            local target = fs.combine(current, name)
            ensureDir(current)
            if fs.exists(target) then fs.delete(target) end
            fs.move(path, target)
            processCommand(target)
        end
    end
    sleep(0.2)
end

print("CC agent stopped.")
