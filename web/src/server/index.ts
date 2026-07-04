// bootstrap：env、Bun.serve、按路径/角色分发。业务逻辑在各模块。
import type { SocketData } from "./state";
import { sendJson } from "./state";
import { handleApi } from "./routes";
import { staticResponse } from "./static";
import { bridgeClose, bridgeOpen, handleBridgeMessage } from "./bridge-ws";
import { handleUiMessage, uiClose, uiOpen } from "./ui-ws";
import type { BridgeEnvelope } from "../shared/protocol";

const PORT = Number(Bun.env.PORT || 8787);

function readJson(text: string): unknown {
  if (!text) return null;
  return JSON.parse(text);
}

Bun.serve<SocketData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/bridge") {
      if (server.upgrade(req, { data: { role: "bridge" } })) return;
      return new Response("Upgrade failed", { status: 400 });
    }

    if (url.pathname === "/ui") {
      if (server.upgrade(req, { data: { role: "ui" } })) return;
      return new Response("Upgrade failed", { status: 400 });
    }

    if (url.pathname.startsWith("/api/")) return handleApi(req, url);
    return staticResponse(url);
  },
  websocket: {
    open(socket) {
      if (socket.data.role === "bridge") bridgeOpen(socket);
      else uiOpen(socket);
    },
    message(socket, raw) {
      try {
        const message = readJson(typeof raw === "string" ? raw : raw.toString());
        if (socket.data.role === "bridge") {
          handleBridgeMessage(socket, message as BridgeEnvelope);
        } else {
          handleUiMessage(socket, message);
        }
      } catch (error) {
        sendJson(socket, {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    close(socket) {
      if (socket.data.role === "bridge") bridgeClose(socket);
      else uiClose(socket);
    },
  },
});

console.log(`ME Controller web listening on http://localhost:${PORT}`);
