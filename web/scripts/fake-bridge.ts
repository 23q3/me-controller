// 开发工具:模拟游戏内 Lua 桥接(hello + 带 stockCounts 的快照心跳 + 命令确认),
// 让前端开发/验收不依赖游戏在跑。用法:PORT=8787 bun run scripts/fake-bridge.ts
// 时序刻意贴近 bridge.lua:命令执行 ~1.2s 后回 command_result 并立即回快照
// (此时 enabled 已变但 status 仍是旧值),再过 ~2.5s 模拟 decide 循环重算
// status 后再发一份快照。用于复核"无乐观闪烁"的修复。
const PORT = Number(process.env.PORT || 8787);
// FAKE_SILENT=1:收到命令后不执行也不回包,用于测试前端的在途超时路径
const SILENT = process.env.FAKE_SILENT === "1";

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

type FakeTarget = {
  id: string;
  enabled: boolean;
  address: string;
  priority: number;
  products: Array<{ item: string; count: number; targetCount: number }>;
  inputs: Array<{ item: string; count: number }>;
  status: string;
  message: string;
  productCount: number;
  targetCount: number;
  neededInputs: number;
  promisedInputs: number;
};

const targets: FakeTarget[] = [
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
];

function summarize() {
  const summary = { total: targets.length, enabled: 0, requested: 0, waiting: 0, error: 0, satisfied: 0, disabled: 0 };
  for (const target of targets) {
    if (target.enabled) summary.enabled += 1;
    if (target.status === "SATISFIED") summary.satisfied += 1;
    else if (target.status === "DISABLED") summary.disabled += 1;
  }
  return summary;
}

function makeSnapshot() {
  return {
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
    summary: summarize(),
    targets,
    commands: [],
    stockCounts,
  };
}

// decide 循环滞后模拟:先只改 enabled,过 2.5s 才把 status 重算成 DISABLED/SATISFIED
function applyFakeCommand(command: { kind?: string; targetId?: string; enabled?: boolean; target?: FakeTarget }) {
  const kind = command.kind || "";
  const target = targets.find((item) => item.id === command.targetId);

  if ((kind === "set_enabled" || kind === "target_enabled") && target) {
    target.enabled = command.enabled !== false;
    setTimeout(() => {
      target.status = target.enabled ? "SATISFIED" : "DISABLED";
      target.message = target.enabled ? "ME target met" : "target disabled";
      sendSnapshot("snapshot");
    }, 2500);
    return;
  }

  if (kind === "delete_target" && command.targetId) {
    const index = targets.findIndex((item) => item.id === command.targetId);
    if (index >= 0) targets.splice(index, 1);
    return;
  }

  if ((kind === "upsert_target" || kind === "save_target") && command.target) {
    const next = command.target;
    const index = targets.findIndex((item) => item.id === (command.targetId || next.id));
    const merged: FakeTarget = {
      status: "NEW",
      message: "created",
      productCount: 0,
      targetCount: next.products?.[0]?.targetCount ?? 0,
      neededInputs: 0,
      promisedInputs: 0,
      ...(index >= 0 ? targets[index] : {}),
      ...next,
    } as FakeTarget;
    if (index >= 0) targets[index] = merged;
    else targets.push(merged);
  }
}

const ws = new WebSocket(`ws://localhost:${PORT}/bridge`);

function sendSnapshot(type: "snapshot" | "heartbeat") {
  ws.send(JSON.stringify({ type, clientId: "fake_bridge_test", time: Math.floor(Date.now() / 1000), snapshot: makeSnapshot() }));
}

ws.onopen = () => {
  console.log("[fake-bridge] connected");
  ws.send(JSON.stringify({ type: "hello", clientId: "fake_bridge_test", protocol: "me_controller.bridge.v1", time: Math.floor(Date.now() / 1000) }));
  sendSnapshot("snapshot");
  setInterval(() => sendSnapshot("heartbeat"), 5000);
};

ws.onmessage = (event) => {
  const payload = JSON.parse(String(event.data));
  console.log("[fake-bridge] received:", payload.type, payload.commandId || "");
  if (payload.type === "command" && payload.commandId) {
    if (SILENT) {
      console.log("[fake-bridge] SILENT:忽略命令", payload.commandId);
      return;
    }
    // 模拟执行耗时,然后按 bridge.lua 的顺序:先回结果,紧接着回快照
    setTimeout(() => {
      applyFakeCommand(payload.command || {});
      ws.send(JSON.stringify({ type: "command_result", clientId: "fake_bridge_test", commandId: payload.commandId, ok: true, response: { ok: true } }));
      sendSnapshot("snapshot");
      console.log("[fake-bridge] executed + acked", payload.commandId);
    }, 1200);
  }
};

ws.onclose = () => {
  console.log("[fake-bridge] closed");
  process.exit(0);
};
