// 浏览器 /ui 会话与消息处理。
import type { ServerWebSocket } from "bun";
import type { ControllerCommand } from "../shared/protocol";
import { dispatchCommand, sendJson, stateEnvelope, uiClients } from "./state";
import type { SocketData } from "./state";

export function uiOpen(socket: ServerWebSocket<SocketData>) {
  uiClients.add(socket);
  sendJson(socket, stateEnvelope());
}

export function uiClose(socket: ServerWebSocket<SocketData>) {
  uiClients.delete(socket);
}

export function handleUiMessage(socket: ServerWebSocket<SocketData>, message: unknown) {
  if (typeof message !== "object" || message === null) {
    sendJson(socket, { type: "error", error: "invalid message" });
    return;
  }

  const envelope = message as { type?: string; command?: ControllerCommand };
  if (envelope.type === "command" && envelope.command) {
    const result = dispatchCommand(envelope.command);
    sendJson(socket, {
      type: "command_accepted",
      ok: result.ok,
      response: result.response,
    });
    return;
  }

  if (envelope.type === "refresh") {
    sendJson(socket, stateEnvelope());
    return;
  }

  sendJson(socket, { type: "error", error: "unknown ui message" });
}
