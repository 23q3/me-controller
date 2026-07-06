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
  // TACZ 数据驱动物品:所有枪/弹药共享一个 id,报点器聚合后就是这样的合并行
  "tacz:modern_kinetic_gun": 12,
  "tacz:ammo": 8640,
};

type FakeTarget = {
  id: string;
  enabled: boolean;
  address: string;
  priority: number;
  recipeId?: string;
  products: Array<{ item: string; count: number; targetCount: number }>;
  inputs: Array<{ item: string; count: number }>;
  status: string;
  message: string;
  productCount: number;
  productCounts?: Record<string, { count: number; targetCount: number; deficit: number; batches: number }>;
  targetCount: number;
  neededBatches?: number;
  neededInputs: number;
  neededInputItems?: Record<string, number>;
  promisedInputs: number;
};

type FakeRecipe = {
  id: string;
  name: string;
  address: string;
  products: Array<{ item: string; count: number }>;
  inputs: Array<{ item: string; count: number }>;
};

// 样板 = 配方唯一权威;目标经 recipeId 引用(与 Lua recipes.db 迁移后的形态一致)
const recipes: FakeRecipe[] = [
  {
    id: "create_iron_sheet",
    name: "Iron Sheet",
    address: "press",
    products: [{ item: "create:iron_sheet", count: 1 }],
    inputs: [{ item: "minecraft:iron_ingot", count: 1 }],
  },
  {
    id: "create_brass_ingot",
    name: "Brass Ingot",
    address: "mixer",
    products: [
      { item: "create:brass_ingot", count: 2 },
      { item: "create:andesite_alloy", count: 1 },
    ],
    inputs: [
      { item: "minecraft:copper_ingot", count: 1 },
      { item: "create:zinc_ingot", count: 1 },
    ],
  },
];

const targets: FakeTarget[] = [
  {
    id: "create_iron_sheet",
    enabled: true,
    address: "press",
    priority: 100,
    recipeId: "create_iron_sheet",
    products: [{ item: "create:iron_sheet", count: 1, targetCount: 2560 }],
    inputs: [{ item: "minecraft:iron_ingot", count: 1 }],
    status: "SATISFIED",
    message: "ME target met",
    productCount: 2560,
    targetCount: 2560,
    neededInputs: 0,
    promisedInputs: 0,
  },
  // 多原料 + 副产物示例:黄铜(主产,目标 8192)混合产出安山合金(副产,目标 0 不驱动)
  {
    id: "create_brass_ingot",
    enabled: true,
    address: "mixer",
    priority: 90,
    recipeId: "create_brass_ingot",
    products: [
      { item: "create:brass_ingot", count: 2, targetCount: 8192 },
      { item: "create:andesite_alloy", count: 1, targetCount: 0 },
    ],
    inputs: [
      { item: "minecraft:copper_ingot", count: 1 },
      { item: "create:zinc_ingot", count: 1 },
    ],
    status: "WAITING",
    message: "Batching 96/128 12s",
    productCount: 4820,
    // 与 Lua updateDemandData 的 productData 形状一致:值为产物数据表而非数字
    productCounts: {
      "create:brass_ingot": { count: 4820, targetCount: 8192, deficit: 3372, batches: 1686 },
      "create:andesite_alloy": { count: 18_326, targetCount: 0, deficit: 0, batches: 0 },
    },
    targetCount: 8192,
    neededBatches: 1558,
    neededInputs: 3372,
    neededInputItems: { "minecraft:copper_ingot": 1686, "create:zinc_ingot": 1686 },
    promisedInputs: 256,
  },
];

// 订单(下单纳管):覆盖全部状态供自动合成页验收;heartbeat 推进在途单进度,
// request_recipe 入队新订单并模拟"排队→派发→完成"流转,cancel_order 立即取消
type FakeOrder = {
  id: string;
  kind: string;
  source: string;
  status: string;
  recipeId?: string;
  recipeName?: string;
  targetId?: string;
  jobId?: string;
  address: string;
  batches?: number;
  items: Array<{ item: string; count: number }>;
  products?: Array<{ item: string; count: number }>;
  wanted: number;
  requested: number;
  tracked?: boolean;
  trackedInputs?: number;
  remainingInputs?: number;
  deliveredProducts?: number;
  note?: string;
  error?: string;
  createdAt: number;
  dispatchedAt?: number;
  completedAt?: number;
  expiresAt?: number;
};

const nowSec = () => Math.floor(Date.now() / 1000);
let orderSeq = 100;
const bootAt = nowSec();

const orders: FakeOrder[] = [
  {
    id: "ord_demo_1",
    kind: "maintain",
    source: "local",
    status: "dispatched",
    targetId: "create_brass_ingot",
    address: "mixer",
    items: [
      { item: "minecraft:copper_ingot", count: 128 },
      { item: "create:zinc_ingot", count: 128 },
    ],
    wanted: 256,
    requested: 256,
    tracked: true,
    trackedInputs: 256,
    remainingInputs: 192,
    note: "Packages dispatched",
    createdAt: bootAt - 40,
    dispatchedAt: bootAt - 39,
    expiresAt: bootAt + 50,
  },
  {
    id: "ord_demo_2",
    kind: "recipe",
    source: "web",
    status: "queued",
    recipeId: "create_brass_ingot",
    recipeName: "Brass Ingot",
    address: "mixer",
    batches: 400_000_000,
    items: [
      { item: "minecraft:copper_ingot", count: 400_000_000 },
      { item: "create:zinc_ingot", count: 400_000_000 },
    ],
    products: [
      { item: "create:brass_ingot", count: 800_000_000 },
      { item: "create:andesite_alloy", count: 400_000_000 },
    ],
    wanted: 800_000_000,
    requested: 0,
    note: "Missing 399903885x minecraft:copper_ingot",
    createdAt: bootAt - 120,
  },
  {
    id: "ord_demo_3",
    kind: "recipe",
    source: "web",
    status: "dispatched",
    recipeId: "create_iron_sheet",
    recipeName: "Iron Sheet",
    address: "press",
    batches: 64,
    items: [{ item: "minecraft:iron_ingot", count: 64 }],
    products: [{ item: "create:iron_sheet", count: 64 }],
    wanted: 64,
    requested: 64,
    deliveredProducts: 18,
    note: "Packages dispatched",
    createdAt: bootAt - 25,
    dispatchedAt: bootAt - 24,
    expiresAt: bootAt + 160,
  },
  {
    id: "ord_demo_4",
    kind: "manual",
    source: "web",
    status: "completed",
    targetId: "create_brass_ingot",
    address: "mixer",
    items: [
      { item: "minecraft:copper_ingot", count: 64 },
      { item: "create:zinc_ingot", count: 64 },
    ],
    wanted: 128,
    requested: 128,
    tracked: true,
    trackedInputs: 128,
    remainingInputs: 0,
    note: "Committed inputs settled by delivery",
    createdAt: bootAt - 600,
    dispatchedAt: bootAt - 599,
    completedAt: bootAt - 480,
  },
  {
    id: "ord_demo_5",
    kind: "recipe",
    source: "web",
    status: "failed",
    recipeId: "create_iron_sheet",
    recipeName: "Iron Sheet",
    address: "press",
    batches: 8,
    items: [{ item: "minecraft:iron_ingot", count: 8 }],
    products: [{ item: "create:iron_sheet", count: 8 }],
    wanted: 8,
    requested: 0,
    error: "Insufficient stock: minecraft:iron_ingot 2/8",
    note: "Request failed",
    createdAt: bootAt - 900,
    completedAt: bootAt - 899,
  },
  {
    id: "ord_demo_6",
    kind: "recipe",
    source: "web",
    status: "expired",
    recipeId: "create_brass_ingot",
    recipeName: "Brass Ingot",
    address: "mixer",
    batches: 4,
    items: [
      { item: "minecraft:copper_ingot", count: 4 },
      { item: "create:zinc_ingot", count: 4 },
    ],
    products: [{ item: "create:brass_ingot", count: 8 }],
    wanted: 8,
    requested: 8,
    deliveredProducts: 3,
    note: "Tracking window elapsed (production may still finish)",
    createdAt: bootAt - 1500,
    dispatchedAt: bootAt - 1499,
    completedAt: bootAt - 1200,
  },
  {
    id: "ord_demo_7",
    kind: "maintain",
    source: "local",
    status: "cancelled",
    targetId: "create_iron_sheet",
    address: "press",
    items: [{ item: "minecraft:iron_ingot", count: 256 }],
    wanted: 256,
    requested: 256,
    note: "Tracking released; dispatched packages cannot be recalled",
    createdAt: bootAt - 2200,
    dispatchedAt: bootAt - 2199,
    completedAt: bootAt - 2000,
  },
];

// 在途单进度推进:承诺单每拍结算 32,基线单每拍入账 9,走完转 completed
function tickOrders() {
  for (const order of orders) {
    if (order.status !== "dispatched") continue;
    if (order.tracked && typeof order.remainingInputs === "number") {
      order.remainingInputs = Math.max(0, order.remainingInputs - 32);
      if (order.remainingInputs === 0) {
        order.status = "completed";
        order.note = "Committed inputs settled by delivery";
        order.completedAt = nowSec();
      }
    } else if (order.products && order.products[0]) {
      const expected = order.products[0].count;
      order.deliveredProducts = Math.min(expected, (order.deliveredProducts || 0) + 9);
      if (order.deliveredProducts >= expected) {
        order.status = "completed";
        order.note = "Observed expected product delivery";
        order.completedAt = nowSec();
      }
    }
  }
}

function summarize() {
  const summary = { total: targets.length, enabled: 0, requested: 0, waiting: 0, error: 0, satisfied: 0, disabled: 0 };
  for (const target of targets) {
    if (target.enabled) summary.enabled += 1;
    if (target.status === "SATISFIED") summary.satisfied += 1;
    else if (target.status === "WAITING") summary.waiting += 1;
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
    recipes,
    targets,
    // 新在前(与 Lua snapshotOrders 一致)
    orders: [...orders].reverse(),
    commands: [],
    stockCounts,
  };
}

// decide 循环滞后模拟:先只改 enabled,过 2.5s 才把 status 重算成 DISABLED/SATISFIED
function applyFakeCommand(command: {
  kind?: string;
  targetId?: string;
  enabled?: boolean;
  target?: FakeTarget;
  recipeId?: string;
  recipe?: FakeRecipe;
  batches?: number;
  item?: string;
  count?: number;
  items?: Array<{ item?: string; count?: number }>;
  orderId?: string;
}) {
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

  if ((kind === "upsert_recipe" || kind === "save_recipe") && command.recipe) {
    const next = command.recipe;
    const wantedId = command.recipeId || next.id;
    const index = recipes.findIndex((item) => item.id === wantedId);
    const merged: FakeRecipe = {
      name: next.products?.[0]?.item || "Recipe",
      address: "press",
      ...(index >= 0 ? recipes[index] : {}),
      ...next,
      id: next.id || wantedId || `recipe_${recipes.length + 1}`,
    } as FakeRecipe;
    if (index >= 0) recipes[index] = merged;
    else recipes.push(merged);
    return;
  }

  if (kind === "delete_recipe" && (command.recipeId || command.recipe)) {
    const recipeId = command.recipeId || (command.recipe as FakeRecipe).id;
    const index = recipes.findIndex((item) => item.id === recipeId);
    if (index >= 0) recipes.splice(index, 1);
    return;
  }

  // 下单纳管:request_recipe 入队订单,~1.5s 后派发,再由 heartbeat 推进到完成
  if (kind === "request_recipe") {
    const recipe = recipes.find((entry) => entry.id === command.recipeId);
    const batches = Math.max(1, Math.floor(Number(command.batches) || 1));
    if (!recipe) {
      console.log("[fake-bridge] request_recipe unknown recipe", command.recipeId);
      return;
    }
    orderSeq += 1;
    const order: FakeOrder = {
      id: `ord_${nowSec()}_${orderSeq}`,
      kind: "recipe",
      source: "web",
      status: "queued",
      recipeId: recipe.id,
      recipeName: recipe.name,
      address: recipe.address,
      batches,
      items: recipe.inputs.map((entry) => ({ item: entry.item, count: entry.count * batches })),
      products: recipe.products.map((entry) => ({ item: entry.item, count: entry.count * batches })),
      wanted: recipe.inputs.reduce((sum, entry) => sum + entry.count * batches, 0),
      requested: 0,
      note: "Queued, waiting for dispatch",
      createdAt: nowSec(),
    };
    orders.push(order);
    console.log("[fake-bridge] request_recipe queued", order.id, recipe.id, "batches:", batches);
    setTimeout(() => {
      if (order.status !== "queued") return;
      order.status = "dispatched";
      order.requested = order.wanted;
      order.dispatchedAt = nowSec();
      order.expiresAt = nowSec() + 180;
      order.deliveredProducts = 0;
      order.note = "Packages dispatched";
      sendSnapshot("snapshot");
      console.log("[fake-bridge] order dispatched", order.id);
    }, 1500);
    return;
  }

  // 取消:排队单真取消;在途单释放跟踪(与 Lua cancelOrder 文案一致)
  if (kind === "cancel_order") {
    const order = orders.find((entry) => entry.id === command.orderId);
    if (!order || (order.status !== "queued" && order.status !== "dispatched")) {
      console.log("[fake-bridge] cancel_order not active", command.orderId);
      return;
    }
    order.note = order.status === "queued"
      ? "Cancelled before dispatch"
      : "Tracking released; dispatched packages cannot be recalled";
    order.status = "cancelled";
    order.completedAt = nowSec();
    console.log("[fake-bridge] order cancelled", order.id);
    return;
  }

  // 多物品单订单:一条命令的全部条目会在 Lua 侧汇入同一 PackageOrder
  if (kind === "request") {
    const parts = Array.isArray(command.items) && command.items.length > 0
      ? command.items.map((entry) => `${entry.item}×${entry.count}`).join(", ")
      : `${command.item}×${command.count}`;
    console.log("[fake-bridge] request", command.targetId ?? "(no target)", "order:", parts);
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
  setInterval(() => {
    tickOrders();
    sendSnapshot("heartbeat");
  }, 5000);
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
