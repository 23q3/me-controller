-- 通用工具：时间、深拷贝、数值/文本规整、事件日志、serialize 文件读写、commandId 规整。
-- 事件日志路径经 Config.CONFIG 动态读取（main.lua 启动时会原地改写路径）。
local Config = require("config")

local Util = {}

function Util.nowSeconds()
    if os.epoch then return os.epoch("utc") / 1000 end
    return os.clock()
end

function Util.now()
    return math.floor(Util.nowSeconds())
end

function Util.copyTable(value)
    if type(value) ~= "table" then return value end
    local out = {}
    for key, item in pairs(value) do
        out[key] = Util.copyTable(item)
    end
    return out
end

function Util.numberOrDefault(value, defaultValue, minimum)
    local number = tonumber(value)
    if number == nil then number = defaultValue end
    if minimum ~= nil and number < minimum then number = minimum end
    return number
end

function Util.boolOrDefault(value, defaultValue)
    if value == nil then return defaultValue end
    return value ~= false and value ~= "false" and value ~= "0" and value ~= "n" and value ~= "no"
end

function Util.trimText(text)
    return tostring(text or ""):match("^%s*(.-)%s*$")
end

function Util.formatNumber(value)
    local number = tonumber(value) or 0
    if number == math.floor(number) then return tostring(math.floor(number)) end
    return tostring(number)
end

local function logText(value)
    local text = tostring(value or "")
    return text:gsub("[\r\n\t]+", " ")
end

local function logValue(value, depth)
    depth = depth or 0
    if type(value) == "table" and depth < 2 then
        local parts = {}
        for key, item in pairs(value) do
            parts[#parts + 1] = logText(key) .. ":" .. logValue(item, depth + 1)
        end
        return "{" .. table.concat(parts, ",") .. "}"
    end
    return logText(value)
end

local function rotateEventLogIfNeeded()
    local path = Config.CONFIG.eventsFile
    local maxBytes = Config.CONFIG.maxEventLogBytes or 0
    if maxBytes <= 0 or not fs.exists(path) then return end
    if fs.getSize(path) <= maxBytes then return end

    local oldPath = path .. ".old"
    if fs.exists(oldPath) then fs.delete(oldPath) end
    fs.move(path, oldPath)
end

function Util.logEvent(runtime, level, eventType, details)
    if runtime and runtime.eventLogDisabled then return false end

    local ok = pcall(function()
        rotateEventLogIfNeeded()
        local handle = fs.open(Config.CONFIG.eventsFile, "a")
        if not handle then error("event log open failed") end

        local parts = {
            "t=" .. tostring(Util.now()),
            "level=" .. logText(level or "INFO"),
            "type=" .. logText(eventType or "event"),
        }
        for key, value in pairs(details or {}) do
            parts[#parts + 1] = logText(key) .. "=" .. logValue(value)
        end
        handle.writeLine(table.concat(parts, " "))
        handle.close()
    end)

    if not ok and runtime then runtime.eventLogDisabled = true end
    return ok
end

function Util.readEventLog(limit)
    limit = math.max(1, math.floor(tonumber(limit) or 40))
    if not fs.exists(Config.CONFIG.eventsFile) then return {} end

    local handle = fs.open(Config.CONFIG.eventsFile, "r")
    if not handle then return {} end

    local lines = {}
    while true do
        local line = handle.readLine()
        if line == nil then break end
        lines[#lines + 1] = line
        if #lines > limit then table.remove(lines, 1) end
    end
    handle.close()
    return lines
end

function Util.readSerialized(path)
    if not fs.exists(path) then return nil end
    local handle = fs.open(path, "r")
    if not handle then return nil end
    local data = handle.readAll()
    handle.close()
    return textutils.unserialize(data or "")
end

function Util.writeSerialized(path, value)
    local handle = fs.open(path, "w")
    if not handle then return false end
    handle.write(textutils.serialize(value))
    handle.close()
    return true
end

-- 原 core.lua 与 bridge.lua 各有一版的合并超集：
-- 取 bridge 版的 table 类型守卫 + core 版的 tostring 与空串→nil 规整。
function Util.commandIdOf(command)
    if type(command) ~= "table" then return nil end
    local commandId = command.commandId or command.id
    if commandId == nil or tostring(commandId) == "" then return nil end
    return tostring(commandId)
end

return Util
