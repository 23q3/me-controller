// 类型化 AppState + 极简 subscribe/notify store(无框架)。
// pending 层(乐观预测已移除):pendingTargets 只记录"哪个目标有命令在途",
// 渲染层据此显示转圈,不改写快照;由 command_result / 权威快照 / 超时三者之一清除。
import type { BridgeState, ControllerSnapshot, StoredCommand } from "../shared/protocol";

export type ItemAsset = {
  id: string;
  name: string;
  englishName?: string;
  icon?: string;
  iconKind?: "flat" | "cube" | "export";
};

export type PendingTarget = {
  commandId: string;
  kind: string;
  label: string; // 停用中/启用中/重置中/保存中/删除中
  expectEnabled?: boolean; // set_enabled:等快照的 enabled 变成该值才算确认
  expectDeleted?: boolean; // delete_target:等目标从快照消失
  resultOk?: boolean; // 已收到 command_result ok=true,仍在等快照确认
  expiresAt: number;
};

// 订单在途操作(目前只有取消):按 orderId 挂转圈,command_result / 快照终态 /
// 超时三者之一清除
export type PendingOrder = {
  commandId: string;
  label: string; // 取消中
  expiresAt: number;
};

// 命令在途上限:超时后清除转圈并提示(桥接在线时 Lua 执行+回快照通常 <1s,
// 12s 覆盖 decide 循环重算 status 的滞后)
const PENDING_TTL_MS = 12_000;

export type UiMessage = {
  time: number;
  text: string;
  tone: "info" | "good" | "bad";
};

export type ViewId = "overview" | "terminal" | "targets" | "crafting" | "patterns" | "commands";

export type AppState = {
  bridge: BridgeState;
  snapshot: ControllerSnapshot | null;
  commands: StoredCommand[];
  items: Record<string, ItemAsset>;
  pendingTargets: Record<string, PendingTarget>;
  pendingOrders: Record<string, PendingOrder>;
  messages: UiMessage[];
  view: ViewId;
  terminalQuery: string;
  terminalSort: "count" | "name";
  uiConnected: boolean;
};

export const app: AppState = {
  bridge: { connected: false },
  snapshot: null,
  commands: [],
  items: {},
  pendingTargets: {},
  pendingOrders: {},
  messages: [],
  view: "overview",
  terminalQuery: "",
  terminalSort: "count",
  uiConnected: false,
};

const listeners = new Set<() => void>();

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notify() {
  for (const listener of listeners) listener();
}

export function pushMessage(text: string, tone: UiMessage["tone"] = "info") {
  app.messages.unshift({ time: Date.now(), text, tone });
  if (app.messages.length > 30) app.messages.length = 30;
}

export function itemAsset(itemId: string | undefined | null): ItemAsset | undefined {
  if (!itemId) return undefined;
  return app.items[itemId];
}

export function markPendingTarget(targetId: string, entry: Omit<PendingTarget, "expiresAt">) {
  app.pendingTargets[targetId] = { ...entry, expiresAt: Date.now() + PENDING_TTL_MS };
}

export function targetPending(targetId: string): PendingTarget | null {
  const pending = app.pendingTargets[targetId];
  if (!pending) return null;
  if (pending.expiresAt < Date.now()) return null; // 过期条目由 sweep 统一清除+提示
  return pending;
}

export function markPendingOrder(orderId: string, entry: Omit<PendingOrder, "expiresAt">) {
  app.pendingOrders[orderId] = { ...entry, expiresAt: Date.now() + PENDING_TTL_MS };
}

export function orderPending(orderId: string): PendingOrder | null {
  const pending = app.pendingOrders[orderId];
  if (!pending) return null;
  if (pending.expiresAt < Date.now()) return null;
  return pending;
}

// command_result 到达:失败立即清除;成功时若还有快照层面的确认要等
// (启停/删除),保留转圈并小幅续期,否则(重置/保存)直接清除。
// 订单侧(取消):结果一到即清除——快照里的订单状态本身就是权威展示。
export function resolvePendingCommand(commandId: string | undefined, ok: boolean) {
  if (!commandId) return null;
  for (const [targetId, entry] of Object.entries(app.pendingTargets)) {
    if (entry.commandId !== commandId) continue;
    if (!ok || (entry.expectEnabled === undefined && !entry.expectDeleted)) {
      delete app.pendingTargets[targetId];
    } else {
      entry.resultOk = true;
      entry.expiresAt = Math.max(entry.expiresAt, Date.now() + 8000);
    }
    return { targetId, entry };
  }
  for (const [orderId, entry] of Object.entries(app.pendingOrders)) {
    if (entry.commandId !== commandId) continue;
    delete app.pendingOrders[orderId];
    return { orderId, entry };
  }
  return null;
}

const TERMINAL_ORDER_STATUS = new Set(["completed", "expired", "failed", "cancelled"]);

// 权威快照到达(乐观层已移除,快照只可能来自 Lua):对账清除已确认的 pending
export function reconcilePendingTargets() {
  const targets = app.snapshot?.targets || [];
  const now = Date.now();

  for (const [targetId, pending] of Object.entries(app.pendingTargets)) {
    if (pending.expiresAt < now) continue; // 留给 sweep 报超时
    const target = targets.find((item) => item.id === targetId);

    if (pending.expectDeleted && !target) {
      delete app.pendingTargets[targetId];
      continue;
    }
    if (pending.expectEnabled !== undefined && target && (target.enabled !== false) === pending.expectEnabled) {
      delete app.pendingTargets[targetId];
    }
  }

  // 订单:快照显示终态(或订单已被历史裁剪掉)即确认
  const orders = app.snapshot?.orders || [];
  for (const orderId of Object.keys(app.pendingOrders)) {
    const order = orders.find((item) => item.id === orderId);
    if (!order || TERMINAL_ORDER_STATUS.has(String(order.status || "").toLowerCase())) {
      delete app.pendingOrders[orderId];
    }
  }
}

// 周期清扫:返回超时条目供调用方提示
export function sweepPendingTargets(): Array<{ targetId: string; entry: PendingTarget }> {
  const now = Date.now();
  const expired: Array<{ targetId: string; entry: PendingTarget }> = [];
  for (const [targetId, entry] of Object.entries(app.pendingTargets)) {
    if (entry.expiresAt < now) {
      expired.push({ targetId, entry });
      delete app.pendingTargets[targetId];
    }
  }
  return expired;
}

export function sweepPendingOrders(): Array<{ orderId: string; entry: PendingOrder }> {
  const now = Date.now();
  const expired: Array<{ orderId: string; entry: PendingOrder }> = [];
  for (const [orderId, entry] of Object.entries(app.pendingOrders)) {
    if (entry.expiresAt < now) {
      expired.push({ orderId, entry });
      delete app.pendingOrders[orderId];
    }
  }
  return expired;
}
