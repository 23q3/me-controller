// /ui WebSocket 会话：断线后固定 1.5 秒重连（保留原 app.js 的 backoff 行为）。
// 乐观更新走 shared/commands.applyCommandToSnapshot 单实现——
// 它只是会被下一份控制器快照覆盖的预览，Lua 侧才是权威。
import type { ControllerCommand, UiEnvelope } from "../shared/protocol";
import { applyCommandToSnapshot } from "../shared/commands";
import { app, applyPendingTargets, markPendingTarget, notify, pushMessage } from "./state";
import { text, toast } from "./dom";
import { fetchStatus } from "./api";

let socket: WebSocket | null = null;

export async function reloadStatus() {
  const payload = await fetchStatus();
  if (payload.type === "state") {
    app.bridge = payload.bridge || app.bridge;
    app.snapshot = payload.snapshot || null;
    app.commands = payload.commands || [];
    applyPendingTargets();
    notify();
  }
}

function reloadAfterFailure() {
  reloadStatus().catch((error) => pushMessage(error instanceof Error ? error.message : String(error), "bad"));
}

function handleEnvelope(payload: UiEnvelope) {
  if (payload.type === "state") {
    app.bridge = payload.bridge || app.bridge;
    app.snapshot = payload.snapshot || null;
    app.commands = payload.commands || [];
    applyPendingTargets();
    notify();
    return;
  }

  if (payload.type === "command_accepted") {
    if (payload.ok) {
      pushMessage("命令已提交", "info");
    } else {
      const message = text(
        payload.response && typeof payload.response === "object" && !Array.isArray(payload.response)
          ? (payload.response as { error?: string }).error
          : undefined,
        "命令提交失败"
      );
      pushMessage(message, "bad");
      toast(message, "bad");
      reloadAfterFailure();
    }
    notify();
    return;
  }

  if (payload.type === "command_result") {
    if (payload.ok) {
      pushMessage("控制器已确认命令", "good");
    } else {
      const message = text(
        payload.response && typeof payload.response === "object" && !Array.isArray(payload.response)
          ? (payload.response as { error?: string }).error
          : undefined,
        "控制器执行失败"
      );
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
    pushMessage("控制台连接断开，1.5 秒后重连", "bad");
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

export function sendCommand(command: ControllerCommand, options: { optimistic?: boolean } = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    pushMessage("控制台未连接，命令未发送", "bad");
    toast("控制台未连接，命令未发送", "bad");
    notify();
    return false;
  }

  socket.send(JSON.stringify({ type: "command", command }));

  if (options.optimistic !== false) {
    if ((command.kind === "set_enabled" || command.kind === "target_enabled") && command.targetId) {
      const enabled = command.enabled !== false;
      markPendingTarget(command.targetId, {
        enabled,
        message: enabled ? "已发送启用命令" : "已发送停用命令",
      });
    }
    // 桥接还没送来过快照时也要能预览新增目标（原 app.js ensureSnapshot 行为）
    if (!app.snapshot) {
      app.snapshot = { network: { ready: false, stockEntries: 0 }, summary: {}, targets: [], commands: [] };
    }
    app.snapshot = applyCommandToSnapshot(app.snapshot, command);
    notify();
  }
  return true;
}
