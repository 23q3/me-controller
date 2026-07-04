// 服务端可变状态单例：最新快照 + 乐观层 + bridge 连接态 + UI 广播。
import type { ServerWebSocket } from "bun";
import { Store } from "./store";
import { getItemAsset } from "./assets";
import { sanitizeCommandForController } from "../shared/commands";import type { BridgeState, ControllerCommand, ControllerSnapshot, JsonValue, UiEnvelope } from "../shared/protocol";

export type SocketData = {
  role: "bridge" | "ui";
};

export const store = new Store();
export const uiClients = new Set<ServerWebSocket<SocketData>>();

export const state = {
  bridgeSocket: null as ServerWebSocket<SocketData> | null,
  bridgeState: { connected: false } as BridgeState,
  latestSnapshot: store.latestSnapshot() as ControllerSnapshot | null,
};

export function now() {
  return Date.now();
}

export function commandId() {
  return `web_${now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function sendJson(socket: ServerWebSocket<SocketData>, value: unknown) {
  socket.send(JSON.stringify(value));
}

export function stateEnvelope(): UiEnvelope {
  return {
    type: "state",
    bridge: state.bridgeState,
    snapshot: state.latestSnapshot,
    commands: store.recentCommands(50),
  };
}

export function broadcast(value: UiEnvelope) {
  const text = JSON.stringify(value);
  for (const client of uiClients) {
    client.send(text);
  }
}

export function recordEvent(kind: string, payload: JsonValue) {
  store.saveEvent(kind, payload);
}

function resolveAssetName(itemId: string) {
  return getItemAsset(itemId)?.name;
}

export function dispatchCommand(command: ControllerCommand) {
  if (!state.bridgeSocket || !state.bridgeState.connected) {
    return {
      ok: false,
      status: 409,
      response: { ok: false, error: "bridge is not connected" },
    };
  }

  const cleanCommand = sanitizeCommandForController(command, resolveAssetName);
  const id = cleanCommand.commandId || cleanCommand.id || commandId();
  const outgoing: ControllerCommand = {
    ...cleanCommand,
    commandId: id,
    id,
    source: cleanCommand.source || "web",
  };

  store.createCommand(id, outgoing);
  // 乐观层已移除:latestSnapshot 只反映 Lua 权威快照。bridge.lua 执行完命令会
  // 立即回发新快照,广播这里只为让命令列表即时出现在 UI。
  state.bridgeSocket.send(
    JSON.stringify({
      type: "command",
      commandId: id,
      command: outgoing,
    })
  );
  broadcast(stateEnvelope());
  return {
    ok: true,
    status: 202,
    response: { ok: true, commandId: id },
  };
}
