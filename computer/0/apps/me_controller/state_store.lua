-- 运行状态（state.db，stateVersion=6）与命令账本的持久化。
-- 账本红线：命令历史按 id 去重（后写覆盖前写并移到末尾）、
-- 上限 commandHistoryLimit 截断头部；sequence 单调递增。
local Config = require("config")
local Util = require("util")
local Items = require("items")

local StateStore = {}

local numberOrDefault = Util.numberOrDefault

function StateStore.loadState()
    local state = Util.readSerialized(Config.CONFIG.stateFile)

    if type(state) ~= "table" then state = {} end
    state.version = Config.CONFIG.stateVersion
    if type(state.targets) ~= "table" then state.targets = {} end
    if type(state.commands) ~= "table" then state.commands = {} end
    if type(state.commands.history) ~= "table" then state.commands.history = {} end
    state.commands.sequence = numberOrDefault(state.commands.sequence, 0, 0)
    return state
end

function StateStore.saveState(state)
    state.version = Config.CONFIG.stateVersion
    if type(state.targets) ~= "table" then state.targets = {} end
    if type(state.commands) ~= "table" then state.commands = {} end
    if type(state.commands.history) ~= "table" then state.commands.history = {} end
    state.commands.sequence = numberOrDefault(state.commands.sequence, 0, 0)

    local handle = fs.open(Config.CONFIG.stateFile, "w")
    if not handle then
        -- 与 targets_store.saveTargets 同理：保存失败必须响亮
        Util.logEvent(nil, "ERROR", "state_save_failed", { file = Config.CONFIG.stateFile })
        return false
    end
    handle.write(textutils.serialize(state))
    handle.close()
    return true
end

function StateStore.resetAllState()
    if fs.exists(Config.CONFIG.stateFile) then fs.delete(Config.CONFIG.stateFile) end
    return true
end

function StateStore.getTargetState(state, target)
    if type(state.targets) ~= "table" then state.targets = {} end
    local targetState = state.targets[target.id]
    if type(targetState) ~= "table" then
        targetState = { commitments = {} }
        state.targets[target.id] = targetState
    end
    if type(targetState.commitments) ~= "table" then targetState.commitments = {} end
    return targetState
end

-- 清理 state.targets 里已无对应目标的孤儿条目（目标被删除后残留）。
-- 只改内存，返回 dirty；是否落盘由调用方决定（dirty-flag 模式）。
function StateStore.pruneOrphanedTargetState(state, targets)
    if type(state) ~= "table" or type(state.targets) ~= "table" then return false end

    local live = {}
    for _, target in ipairs(targets or {}) do live[target.id] = true end

    local dirty = false
    for id in pairs(state.targets) do
        if not live[id] then
            state.targets[id] = nil
            dirty = true
        end
    end
    return dirty
end

function StateStore.commandState(state)
    if type(state.commands) ~= "table" then state.commands = {} end
    if type(state.commands.history) ~= "table" then state.commands.history = {} end
    state.commands.sequence = numberOrDefault(state.commands.sequence, 0, 0)
    return state.commands
end

function StateStore.findCommandRecord(commands, commandId)
    if not commandId then return nil end
    for _, record in ipairs(commands.history or {}) do
        if record.id == commandId then return record end
    end
    return nil
end

function StateStore.rememberCommand(state, record)
    local commands = StateStore.commandState(state)
    local history = commands.history

    for index = #history, 1, -1 do
        if history[index].id == record.id then table.remove(history, index) end
    end
    history[#history + 1] = record

    local limit = math.max(1, Config.CONFIG.commandHistoryLimit or 256)
    while #history > limit do table.remove(history, 1) end
    return record
end

function StateStore.recentCommands(state, limit)
    local commands = StateStore.commandState(state or {})
    local history = commands.history or {}
    limit = math.max(1, math.floor(tonumber(limit) or 20))

    local out = {}
    local first = math.max(1, #history - limit + 1)
    for index = first, #history do
        out[#out + 1] = Util.copyTable(history[index])
    end
    return out
end

function StateStore.nextLocalCommandId(runtime, target)
    local commands = StateStore.commandState(runtime.state)
    commands.sequence = (tonumber(commands.sequence) or 0) + 1
    return "local_" .. Items.normalizeId(target.id) .. "_" .. tostring(Util.now()) .. "_" .. tostring(commands.sequence)
end

return StateStore
