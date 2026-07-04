// 类型化 AppState + 极简 subscribe/notify store（无框架）。
// 乐观层：pendingTargets 记录"命令已发出但控制器快照尚未确认"的目标，
// 用于把行内开关钉在"同步中"态，8 秒未确认自动过期（与原 app.js 行为一致）。
import type { BridgeState, ControllerSnapshot, StoredCommand } from "../shared/protocol";
import { recomputeSummary } from "../shared/summary";

export type ItemAsset = {
  id: string;
  name: string;
  englishName?: string;
  icon?: string;
};

export type PendingTarget = {
  enabled?: boolean;
  message?: string;
  expiresAt: number;
};

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

export function markPendingTarget(targetId: string | undefined, patch: Omit<PendingTarget, "expiresAt">) {
  if (!targetId) return;
  app.pendingTargets[targetId] = { ...patch, expiresAt: Date.now() + 8000 };
}

export function targetPending(targetId: string): boolean {
  const pending = app.pendingTargets[targetId];
  if (!pending) return false;
  if (pending.expiresAt < Date.now()) {
    delete app.pendingTargets[targetId];
    return false;
  }
  return true;
}

// 服务器快照到达后重放未过期的 pending 效果（快照可能先于控制器确认到达）
export function applyPendingTargets() {
  if (!app.snapshot || !app.snapshot.targets) return;
  const now = Date.now();

  for (const [targetId, pending] of Object.entries(app.pendingTargets)) {
    const target = app.snapshot.targets.find((item) => item.id === targetId);
    if (!target || pending.expiresAt < now) {
      delete app.pendingTargets[targetId];
      continue;
    }

    if (pending.enabled !== undefined && target.enabled === pending.enabled) {
      delete app.pendingTargets[targetId];
      continue;
    }

    if (pending.enabled !== undefined) {
      target.enabled = pending.enabled;
      target.status = pending.enabled ? "NEW" : "DISABLED";
    }
    if (pending.message) target.message = pending.message;
  }

  recomputeSummary(app.snapshot);
}
