// HTTP API 路由。
import { ensureAssetIndex } from "./assets";
import type { ControllerCommand } from "../shared/protocol";
import { dispatchCommand, stateEnvelope } from "./state";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function handleApi(req: Request, url: URL) {
  if (url.pathname === "/api/status" && req.method === "GET") {
    return jsonResponse(stateEnvelope());
  }

  if (url.pathname === "/api/items" && req.method === "GET") {
    return jsonResponse(await ensureAssetIndex());
  }

  if (url.pathname === "/api/commands" && req.method === "POST") {
    let body: ControllerCommand;
    try {
      body = (await req.json()) as ControllerCommand;
    } catch {
      return jsonResponse({ ok: false, error: "invalid json" }, 400);
    }
    if (!body || typeof body.kind !== "string") {
      return jsonResponse({ ok: false, error: "command.kind is required" }, 400);
    }
    const result = dispatchCommand(body);
    return jsonResponse(result.response, result.status);
  }

  return new Response("Not Found", { status: 404 });
}
