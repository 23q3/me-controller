local Config = require("config")
local Util = require("util")
local Items = require("items")
local TargetsStore = require("targets_store")
local StateStore = require("state_store")
local Tracking = require("tracking")

local Core = {}

-- 配置常量（config.lua)。CONFIG 与 config.lua 是同一张表：
-- main.lua 启动时经 Core.CONFIG 原地改写文件路径，util.lua 内部读的也是它。
Core.CONFIG = Config.CONFIG
Core.TARGET_DEFAULTS = Config.TARGET_DEFAULTS
Core.DEFAULT_TARGETS = Config.DEFAULT_TARGETS

-- 通用工具（util.lua）重导出；ui.lua / bridge.lua 一律经 Core 消费单实现
Core.nowSeconds = Util.nowSeconds
Core.now = Util.now
Core.copyTable = Util.copyTable
Core.logEvent = Util.logEvent
Core.readEventLog = Util.readEventLog
Core.readSerialized = Util.readSerialized
Core.writeSerialized = Util.writeSerialized
Core.commandIdOf = Util.commandIdOf

-- 物品/配方纯函数（items.lua）重导出
Core.normalizeId = Items.normalizeId
Core.defaultDisplayName = Items.defaultDisplayName
Core.displayName = Items.displayName
Core.formatRecipeEntries = Items.formatRecipeEntries
Core.parseRecipeEntries = Items.parseRecipeEntries
Core.productsToInputs = Items.productsToInputs
Core.inputsToProducts = Items.inputsToProducts

-- 目标存取（targets_store.lua）重导出
Core.normalizeTarget = TargetsStore.normalizeTarget
Core.normalizeTargets = TargetsStore.normalizeTargets
Core.saveTargets = TargetsStore.saveTargets
Core.loadTargets = TargetsStore.loadTargets
Core.findTarget = TargetsStore.findTarget

-- 状态/账本存取（state_store.lua）重导出
Core.loadState = StateStore.loadState
Core.saveState = StateStore.saveState
Core.resetAllState = StateStore.resetAllState
Core.getTargetState = StateStore.getTargetState
Core.recentCommands = StateStore.recentCommands
Core.pruneOrphanedTargetState = StateStore.pruneOrphanedTargetState

-- 外设访问（network.lua，function(Core) 工厂：refreshNetwork 经 Core 回调
-- planner 的 syncTargetData/ensureTargetData/updatePromiseData/buildDependencyPlan/updateDemandData）
local Network = require("network")(Core)
Core.discoverPeripherals = Network.discoverPeripherals
Core.readNetworkStock = Network.readNetworkStock
Core.refreshNetwork = Network.refreshNetwork
Core.executeRequestCommand = Network.executeRequestCommand

-- 规划与目标数据同步（planner.lua，function(Core) 工厂：requestPlan 经
-- Core.executeRequestCommand 触达外设）
local Planner = require("planner")(Core)
Core.buildDependencyPlan = Planner.buildDependencyPlan
Core.updateDemandData = Planner.updateDemandData
Core.updatePromiseData = Planner.updatePromiseData
Core.ensureTargetData = Planner.ensureTargetData
Core.syncTargetData = Planner.syncTargetData

-- 决策引擎（decide.lua）与命令/快照/共享目标操作（commands.lua）
local Decide = require("decide")(Core, Planner)
Core.decideTargets = Decide.decideTargets

local Commands = require("commands")(Core, Planner)
Core.summarize = Commands.summarize
Core.makeSnapshot = Commands.makeSnapshot
Core.applyCommand = Commands.applyCommand
Core.setTargetEnabled = Commands.setTargetEnabled
Core.resetTargetStateById = Commands.resetTargetStateById
Core.deleteTargetById = Commands.deleteTargetById
Core.upsertTarget = Commands.upsertTarget

function Core.saveRuntimeTargets(runtime)
    runtime.targets = Core.normalizeTargets(runtime.targets or {})
    Core.saveTargets(runtime.targets)
    Core.syncTargetData(runtime)
    return true
end

function Core.makeRuntime()
    local runtime = {
        targets = Core.loadTargets(),
        state = Core.loadState(),
        dataById = {},
        stockCounts = {},
        stockEntries = 0,
        stockSerial = 0,
        dependencyDemandByTarget = {},
        dependencyPlan = nil,
        stockTicker = nil,
        stockName = nil,
        monitor = nil,
        monitorName = nil,
        networkReady = false,
        stockError = nil,
        selectedIndex = 1,
        pageOffset = 1,
        promptActive = false,
        running = true,
    }

    Core.syncTargetData(runtime)
    -- 目标集合刚从磁盘加载：顺手清掉 state 里已无对应目标的孤儿条目
    if Core.pruneOrphanedTargetState(runtime.state, runtime.targets) then
        Core.saveState(runtime.state)
    end
    return runtime
end

function Core.reloadTargets(runtime)
    runtime.targets = Core.loadTargets()
    Core.syncTargetData(runtime)
    if Core.pruneOrphanedTargetState(runtime.state, runtime.targets) then
        Core.saveState(runtime.state)
    end
end

function Core.runOnce(runtime)
    local dirty = false
    dirty = Core.refreshNetwork(runtime) or dirty
    dirty = Core.decideTargets(runtime) or dirty
    Core.saveState(runtime.state)
    return dirty
end

function Core.formatTimeLeft(seconds)
    seconds = math.max(0, math.floor(seconds or 0))
    return tostring(seconds) .. "s"
end

return Core
