// 开发工具:模拟游戏内 Lua 桥接(hello + 带 stockCounts 的快照心跳 + 命令确认),
// 让前端开发/验收不依赖游戏在跑。用法:PORT=8787 bun run scripts/fake-bridge.ts
const PORT = Number(process.env.PORT || 8787);

const stockCounts: Record<string, number> = {
  "minecraft:iron_ingot": 1_000_000_000,
  "create:iron_sheet": 2560,
  "minecraft:cobblestone": 3_412_887,
  "minecraft:oak_log": 45_210,
  "minecraft:redstone": 128_400,
  "minecraft:gold_ingot": 8231,
  "minecraft:copper_ingot": 96_115,
  "create:andesite_alloy": 18_326,
  "create:brass_ingot": 4820,
  "create:zinc_ingot": 7742,
  "minecraft:diamond": 342,
  "minecraft:coal": 220_919,
  "minecraft:glass": 12_034,
  "minecraft:sand": 88_012,
  "minecraft:gravel": 51_226,
  "minecraft:clay_ball": 9034,
  "minecraft:oak_planks": 130_552,
  "minecraft:stick": 64_002,
  "create:precision_mechanism": 187,
  "create:electron_tube": 1204,
  "minecraft:quartz": 15_600,
  "minecraft:obsidian": 96,
  "minecraft:netherite_ingot": 7,
  "minecraft:emerald": 1518,
  "minecraft:lapis_lazuli": 30_704,
};

const snapshot = {
  schema: "me_controller.snapshot.v1",
  time: Math.floor(Date.now() / 1000),
  network: {
    ready: true,
    error: null,
    stockEntries: Object.keys(stockCounts).length,
    stockSerial: 9001,
    lastStockReadAt: Math.floor(Date.now() / 1000),
    stockName: "Create_StockTicker_0",
    monitorName: "right",
  },
  dependency: { passes: 1, demandByTarget: {} },
  summary: { total: 1, enabled: 1, requested: 0, waiting: 0, error: 0, satisfied: 1, disabled: 0 },
  targets: [
    {
      id: "create_iron_sheet",
      enabled: true,
      address: "press",
      priority: 100,
      products: [{ item: "create:iron_sheet", count: 1, targetCount: 2560 }],
      inputs: [{ item: "minecraft:iron_ingot", count: 1 }],
      status: "SATISFIED",
      message: "ME target met",
      productCount: 2560,
      targetCount: 2560,
      neededInputs: 0,
      promisedInputs: 0,
    },
  ],
  commands: [],
  stockCounts,
};

const ws = new WebSocket(`ws://localhost:${PORT}/bridge`);

ws.onopen = () => {
  console.log("[fake-bridge] connected");
  ws.send(JSON.stringify({ type: "hello", clientId: "fake_bridge_test", protocol: "me_controller.bridge.v1", time: snapshot.time }));
  ws.send(JSON.stringify({ type: "snapshot", clientId: "fake_bridge_test", time: snapshot.time, snapshot }));
  setInterval(() => {
    snapshot.time = Math.floor(Date.now() / 1000);
    ws.send(JSON.stringify({ type: "heartbeat", clientId: "fake_bridge_test", time: snapshot.time, snapshot }));
  }, 5000);
};

ws.onmessage = (event) => {
  const payload = JSON.parse(String(event.data));
  console.log("[fake-bridge] received:", payload.type, payload.commandId || "");
  if (payload.type === "command" && payload.commandId) {
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "command_result", clientId: "fake_bridge_test", commandId: payload.commandId, ok: true, response: { ok: true } }));
      console.log("[fake-bridge] acked", payload.commandId);
    }, 300);
  }
};

ws.onclose = () => {
  console.log("[fake-bridge] closed");
  process.exit(0);
};
