-- 配置常量模块。CONFIG 表会被 main.lua 启动时原地改写文件路径
-- （targetsFile 等），全程序共享同一张表，勿做拷贝。
local Config = {}

Config.CONFIG = {
    -- 状态文件结构版本；控制逻辑或状态形状变更时升版，旧状态会自动迁移补齐。
    stateVersion = 6,

    -- 目标配置文件；工程师在 UI 中增删改查的数据会持久化到这里。
    targetsFile = "targets.db",

    -- 运行状态文件；保存每个目标的在途承诺、冷却和统计数据。
    stateFile = "state.db",

    -- 事件日志文件；记录关键决策、请求和错误，方便离线排查。
    eventsFile = "events.log",

    -- 可选 WebSocket 桥接配置文件；没有启用时控制器完全离线运行。
    bridgeFile = "bridge.db",

    -- 事件日志超过这个大小会轮转到 events.log.old。
    maxEventLogBytes = 65536,

    -- 本地命令历史保留条数，用于去重和未来后端命令回放保护。
    commandHistoryLimit = 256,

    -- 读取 Create Stock Ticker 全网库存的间隔。
    stockPollSeconds = 1,

    -- 判断每个目标是否需要请求输入物品的间隔。
    decisionSeconds = 1,

    -- 刷新终端/显示器界面的间隔。
    renderSeconds = 0.5,

    -- 主循环空闲睡眠时间，避免空转占用过高。
    idleSleepSeconds = 0.05,

    -- 串联配方需求向上游传播时最多迭代多少轮。
    maxDependencyPasses = 8,

    -- WebSocket 桥接层的默认心跳与重连间隔。
    bridgeHeartbeatSeconds = 1,
    bridgeReconnectSeconds = 5,
    bridgeReceiveTimeoutSeconds = 0.2,
}

Config.TARGET_DEFAULTS = {
    -- 新目标默认启用。
    enabled = true,

    -- 默认工序地址，Create Stock Ticker 会把输入物品请求到这里。
    address = "press",

    -- 默认输入物品 ID。
    inputItem = "minecraft:iron_ingot",

    -- 默认输入物品显示名。
    inputLabel = "Iron Ingot",

    -- 默认需要维持库存的成品物品 ID。
    productItem = "create:iron_sheet",

    -- 默认成品显示名。
    productLabel = "Iron Sheet",

    -- 默认目标网络库存。
    targetCount = 2048,

    -- 每生产 1 个成品需要多少输入物品。
    inputPerProduct = 1,

    -- 优先级；数字越小越先获得输入物品。
    priority = 100,

    -- 两次请求之间的最短冷却时间。
    requestCooldownSeconds = 5,

    -- 立即发送请求的最小批量；不足时先等待合批。
    minImmediateRequest = 64,

    -- 小批量等待超过这个时间后也会发送。
    delayedRequestSeconds = 20,

    -- 已请求但尚未在网络中体现的承诺有效期。
    promiseTtlSeconds = 90,

    -- 单个目标同时在途的最大输入物品数量。
    maxOutstandingInputs = 1024,

    -- 单次决策最多请求多少输入物品。
    maxRequestPerCycle = 576,

    -- 产物库存连续低于目标多少次后才允许下单，避免 Stock Ticker 忙碌时的瞬时误报。
    deficitConfirmScans = 3,

    -- 产物库存低于目标至少持续多久后才允许下单。
    deficitConfirmSeconds = 2,

    -- 产物库存下降连续出现多少次后才接受为真实下降。
    stockDropConfirmScans = 3,

    -- 产物库存下降至少持续多久后才接受为真实下降。
    stockDropConfirmSeconds = 2,
}

Config.DEFAULT_TARGETS = {
    {
        id = "iron_sheet",
        enabled = true,
        address = "press",
        inputItem = "minecraft:iron_ingot",
        inputLabel = "Iron Ingot",
        productItem = "create:iron_sheet",
        productLabel = "Iron Sheet",
        targetCount = 2048,
        inputPerProduct = 1,
        priority = 100,
    },
}

return Config
