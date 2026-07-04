// /ui WebSocket 会话:断线后固定 1.5 秒重连(保留原 backoff 行为)。
// 乐观预测已移除:发命令不再改写快照,只给目标挂 pending(渲染层显示转圈),
// 等 command_result + 权威快照确认;快照永远是 Lua 权威结果。
import type { ControllerCommand, UiEnvelope } from "../shared/protocol";
import type { PendingTarget } from "./state";
import {
  app,
  markPendingTarget,
  notify,
  pushMessage,
  reconcilePendingTargets,
  resolvePendingCommand,
} from "./state";
import { text, toast } from "./dom";
import { fetchStatus } from "./api";

let socket: WebSocket | null = null;

export async function reloadStatus() {
  const payload = await fetchStatus();
  if (payload.type === "state") {
    app.bridge = payload.bridge || app.bridge;
    app.snapshot = payload.snapshot || null;
    app.commands = payload.commands || [];
    reconcilePendingTargets();
    notify();
  }
}

function reloadAfterFailure() {
  reloadStatus().catch((error) => pushMessage(error instanceof Error ? error.message : String(error), "bad"));
}

function responseError(response: unknown, fallback: string): string {
  if (response && typeof response === "object" && !Array.isArray(response)) {
    return text((response as { error?: string }).error, fallback);
  }
  return fallback;
}

function handleEnvelope(payload: UiEnvelope) {
  if (payload.type === "state") {
    app.bridge = payload.bridge || app.bridge;
    app.snapshot = payload.snapshot || null;
    app.commands = payload.commands || [];
    reconcilePendingTargets();
    notify();
    return;
  }

  if (payload.type === "command_accepted") {
    if (payload.ok) {
      pushMessage("命令已提交", "info");
    } else {
      const message = responseError(payload.response, "命令提交失败");
      resolvePendingCommand(payload.commandId, false);
      pushMessage(message, "bad");
      toast(message, "bad");
      reloadAfterFailure();
    }
    notify();
    return;
  }

  if (payload.type === "command_result") {
    const resolved = resolvePendingCommand(payload.commandId, payload.ok);
    if (payload.ok) {
      // "停用中"→"停用成功";没有 pending 的命令(如物品请求)走通用文案
      const message = resolved ? `${resolved.entry.label.replace(/中$/, "")}成功` : "控制器执行成功";
      pushMessage(message, "good");
      if (resolved) toast(message, "good");
    } else {
      const message = responseError(payload.response, "控制器执行失败");
      pushMessage(message, "bad");
      toast(message, "bad");
      reloadAfterFailure();
    }
    notify();
    return;
  }

  if (payload.type === "error") {
    pushMessage(payload.error || "未知错误", "bad");
    notify();
  }
}

export function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/ui`);
  socket = ws;

  ws.onopen = () => {
    app.uiConnected = true;
    pushMessage("控制台已连接", "good");
    ws.send(JSON.stringify({ type: "refresh" }));
    notify();
  };

  ws.onmessage = (event) => {
    try {
      handleEnvelope(JSON.parse(String(event.data)) as UiEnvelope);
    } catch {
      pushMessage("收到无法解析的服务器消息", "bad");
      notify();
    }
  };

  ws.onclose = () => {
    app.uiConnected = false;
    app.bridge = { ...app.bridge, connected: false };
    pushMessage("控制台连接断开,1.5 秒后重连", "bad");
    notify();
    setTimeout(connect, 1500);
  };
}

export function requestRefresh() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "refresh" }));
  } else {
    reloadAfterFailure();
  }
}

function makeCommandId() {
  return `web_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// kind → 在途标签;expectEnabled/expectDeleted 决定快照层面的确认条件
function pendingEntryFor(command: ControllerCommand): Omit<PendingTarget, "expiresAt" | "commandId"> | null {
  switch (command.kind) {
    case "set_enabled":
    case "target_enabled": {
      const enabled = command.enabled !== false;
      return { kind: command.kind, label: enabled ? "启用中" : "停用中", expectEnabled: enabled };
    }
    case "delete_target":
      return { kind: command.kind, label: "删除中", expectDeleted: true };
    case "reset_target_state":
    case "reset_target":
      return { kind: command.kind, label: "重置中" };
    case "upsert_target":
    case "save_target":
      return { kind: command.kind, label: "保存中" };
    default:
      return null; // request 等命令走命令日志跟踪,不锁目标行
  }
}

export function sendCommand(command: ControllerCommand) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    pushMessage("控制台未连接,命令未发送", "bad");
    toast("控制台未连接,命令未发送", "bad");
    notify();
    return false;
  }

  // mutating 命令必须带 commandId(协议红线);客户端生成以便精确匹配回包
  const commandId = command.commandId || command.id || makeCommandId();
  const outgoing: ControllerCommand = { ...command, commandId, id: commandId };
  socket.send(JSON.stringify({ type: "command", command: outgoing }));

  if (outgoing.targetId) {
    const entry = pendingEntryFor(outgoing);
    // 只有目标已存在于快照时才挂转圈(新建目标没有可标记的行,由 toast 反馈)
    const exists = (app.snapshot?.targets || []).some((target) => target.id === outgoing.targetId);
    if (entry && exists) {
      markPendingTarget(outgoing.targetId, { ...entry, commandId });
    }
  }

  notify();
  return true;
}
