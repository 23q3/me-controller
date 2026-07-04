// Lua /bridge 会话：报文形状（me_controller.bridge.v1）不变。
import type { ServerWebSocket } from "bun";
import type { BridgeEnvelope, JsonValue } from "../shared/protocol";
import { broadcast, now, recordEvent, state, stateEnvelope, store } from "./state";
import type { SocketData } from "./state";

export function bridgeOpen(socket: ServerWebSocket<SocketData>) {
  if (state.bridgeSocket && state.bridgeSocket !== socket) state.bridgeSocket.close(4000, "replaced");
  state.bridgeSocket = socket;
  state.bridgeState = {
    connected: true,
    connectedAt: now(),
    lastSeenAt: now(),
  };
  recordEvent("bridge_connected", { time: now() });
  broadcast(stateEnvelope());
}

export function bridgeClose(socket: ServerWebSocket<SocketData>) {
  if (state.bridgeSocket !== socket) return;
  state.bridgeSocket = null;
  state.bridgeState = {
    ...state.bridgeState,
    connected: false,
    lastSeenAt: now(),
  };
  recordEvent("bridge_disconnected", { time: now() });
  broadcast(stateEnvelope());
}

export function handleBridgeMessage(socket: ServerWebSocket<SocketData>, envelope: BridgeEnvelope) {
  state.bridgeState = {
    ...state.bridgeState,
    connected: true,
    clientId: envelope.clientId || state.bridgeState.clientId,
    lastSeenAt: now(),
  };

  if (envelope.type === "hello") {
    state.bridgeState.protocol = envelope.protocol;
    recordEvent("bridge_hello", envelope as unknown as JsonValue);
    broadcast(stateEnvelope());
    return;
  }

  if (envelope.type === "snapshot" || envelope.type === "heartbeat") {
    if (envelope.snapshot) {
      state.latestSnapshot = envelope.snapshot;
      store.saveSnapshot(envelope.snapshot);
      store.syncAcknowledgedCommands();
    }
    broadcast(stateEnvelope());
    return;
  }

  if (envelope.type === "command_result") {
    if (envelope.commandId) {
      store.acknowledgeCommand(envelope.commandId, envelope.ok === true, (envelope.response ?? null) as JsonValue);
    }
    recordEvent("command_result", envelope as unknown as JsonValue);
    broadcast({
      type: "command_result",
      commandId: envelope.commandId,
      ok: envelope.ok === true,
      response: (envelope.response ?? null) as JsonValue,
    });
    broadcast(stateEnvelope());
    return;
  }

  if (envelope.type === "error") {
    recordEvent("bridge_error", envelope as unknown as JsonValue);
    broadcast({ type: "error", error: envelope.error || "bridge error" });
  }
}
