import { extname, join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";
import { getAssetIndex, getItemAsset } from "./assets";
import { Store } from "./store";
import type {
  BridgeEnvelope,
  BridgeState,
  ControllerCommand,
  ControllerSnapshot,
  JsonValue,
  UiEnvelope,
} from "./protocol";

type SocketData = {
  role: "bridge" | "ui";
};

const PORT = Number(Bun.env.PORT || 8787);
const PUBLIC_DIR = join(import.meta.dir, "..", "..", "public");
const store = new Store();
const uiClients = new Set<ServerWebSocket<SocketData>>();

let bridgeSocket: ServerWebSocket<SocketData> | null = null;
let bridgeState: BridgeState = { connected: false };
let latestSnapshot: ControllerSnapshot | null = store.latestSnapshot();

type JsonRecord = { [key: string]: JsonValue };

const RUNTIME_TARGET_FIELDS = [
  "status",
  "message",
  "productCount",
  "productCounts",
  "inputCount",
  "inputCounts",
  "baseTargetCount",
  "dependencyDemand",
  "deficitProducts",
  "desiredBatches",
  "neededBatches",
  "neededInputs",
  "neededInputItems",
  "promisedInputs",
  "promisedInputItems",
  "promisedBatches",
  "promisedProducts",
  "nextExpiry",
  "lastChangedAt",
];

function now() {
  return Date.now();
}

function commandId() {
  return `web_${now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function readJson(text: string): unknown {
  if (!text) return null;
  return JSON.parse(text);
}

function sendJson(socket: ServerWebSocket<SocketData>, value: unknown) {
  socket.send(JSON.stringify(value));
}

function stateEnvelope(): UiEnvelope {
  return {
    type: "state",
    bridge: bridgeState,
    snapshot: latestSnapshot,
    commands: store.recentCommands(50),
  };
}

function broadcast(value: UiEnvelope) {
  const text = JSON.stringify(value);
  for (const client of uiClients) {
    client.send(text);
  }
}

function recordEvent(kind: string, payload: JsonValue) {
  store.saveEvent(kind, payload);
}

function primaryProduct(target: Record<string, unknown>) {
  const products = Array.isArray(target.products) ? target.products : [];
  return products[0] as Record<string, unknown> | undefined;
}

function targetDisplayId(target: Record<string, unknown>) {
  return String(target.id || (primaryProduct(target)?.item ?? "target"));
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: JsonValue | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function defaultDisplayName(itemId: string) {
  const rawName = itemId.includes(":") ? itemId.slice(itemId.lastIndexOf(":") + 1) : itemId;
  const words = rawName
    .replace(/[_\-./]+/g, " ")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return itemId || "Item";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

function manualDisplayLabel(value: JsonValue | undefined, itemId: string) {
  const label = stringValue(value);
  const assetName = getItemAsset(itemId)?.name;
  if (!label || label === itemId || label === assetName || label === defaultDisplayName(itemId)) return null;
  return label;
}

function recipeEntryItem(entry: JsonRecord) {
  return stringValue(entry.item) || stringValue(entry.name) || stringValue(entry.itemId);
}

function sanitizeRecipeEntry(value: JsonValue) {
  if (!isJsonRecord(value)) return value;
  const entry: JsonRecord = { ...value };
  const item = recipeEntryItem(entry);
  if (item) {
    entry.item = item;
    const label = manualDisplayLabel(entry.label ?? entry.displayName, item);
    if (label) entry.label = label;
    else delete entry.label;
  }
  return entry;
}

function sanitizeRecipeEntries(value: JsonValue | undefined): JsonValue | undefined {
  if (Array.isArray(value)) return value.map((entry) => sanitizeRecipeEntry(entry));
  if (isJsonRecord(value)) return sanitizeRecipeEntry(value);
  return value;
}

function firstRecipeItem(value: JsonValue | undefined) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isJsonRecord(entry)) continue;
      const item = recipeEntryItem(entry);
      if (item) return item;
    }
    return null;
  }

  if (isJsonRecord(value)) return recipeEntryItem(value);
  return null;
}

function firstRecipeLabel(value: JsonValue | undefined) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isJsonRecord(entry)) continue;
      const label = stringValue(entry.label);
      if (label) return label;
    }
    return null;
  }

  if (isJsonRecord(value)) return stringValue(value.label);
  return null;
}

function setFirstRecipeLabel(value: JsonValue | undefined, label: string) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isJsonRecord(entry)) continue;
      if (!stringValue(entry.label)) entry.label = label;
      return;
    }
  } else if (isJsonRecord(value) && !stringValue(value.label)) {
    value.label = label;
  }
}

function sanitizeTargetForController(rawTarget: JsonValue) {
  if (!isJsonRecord(rawTarget)) return rawTarget;

  const target: JsonRecord = { ...rawTarget };
  for (const field of RUNTIME_TARGET_FIELDS) delete target[field];

  const products = sanitizeRecipeEntries(target.products ?? target.outputs);
  const inputs = sanitizeRecipeEntries(target.inputs ?? target.ingredients);
  if (products !== undefined) target.products = products;
  if (inputs !== undefined) target.inputs = inputs;

  const productItem = firstRecipeItem(products) || stringValue(target.productItem);
  if (productItem) {
    const productLabel =
      firstRecipeLabel(products) || manualDisplayLabel(target.productLabel, productItem) || defaultDisplayName(productItem);
    target.productItem = productItem;
    target.productLabel = productLabel;
    setFirstRecipeLabel(products, productLabel);
  }

  const inputItem = firstRecipeItem(inputs) || stringValue(target.inputItem);
  if (inputItem) {
    const inputLabel =
      firstRecipeLabel(inputs) || manualDisplayLabel(target.inputLabel, inputItem) || defaultDisplayName(inputItem);
    target.inputItem = inputItem;
    target.inputLabel = inputLabel;
    setFirstRecipeLabel(inputs, inputLabel);
  }

  if (Array.isArray(target.inputs) && target.inputs.length > 0) delete target.inputPerProduct;

  return target;
}

function sanitizeCommandForController(command: ControllerCommand): ControllerCommand {
  if ((command.kind !== "upsert_target" && command.kind !== "save_target") || command.target === undefined) {
    return command;
  }

  return {
    ...command,
    target: sanitizeTargetForController(command.target),
  };
}

function recomputeSummary(snapshot: ControllerSnapshot) {
  const targets = snapshot.targets || [];
  const summary = {
    total: targets.length,
    enabled: 0,
    requested: 0,
    waiting: 0,
    error: 0,
    satisfied: 0,
    disabled: 0,
  };

  for (const target of targets) {
    if (target.enabled) summary.enabled += 1;
    if (target.status === "REQUESTED") summary.requested += 1;
    else if (target.status === "WAITING") summary.waiting += 1;
    else if (target.status === "ERROR") summary.error += 1;
    else if (target.status === "SATISFIED") summary.satisfied += 1;
    else if (target.status === "DISABLED") summary.disabled += 1;
  }

  snapshot.summary = summary;
}

function optimisticTargetFromCommandTarget(raw: unknown) {
  const target = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const products = Array.isArray(target.products) ? target.products : [];
  const firstProduct = products[0] as Record<string, unknown> | undefined;
  const id = targetDisplayId(target);
  return {
    id,
    enabled: target.enabled !== false,
    address: String(target.address || "press"),
    priority: Number(target.priority || 100),
    products: products as never[],
    inputs: (Array.isArray(target.inputs) ? target.inputs : []) as never[],
    status: target.enabled === false ? "DISABLED" : "NEW",
    message: "等待下一次控制器快照确认",
    productCount: 0,
    targetCount: Number(firstProduct?.targetCount || 0),
    neededInputs: 0,
    promisedInputs: 0,
  };
}

function applyOptimisticCommand(command: ControllerCommand) {
  if (!latestSnapshot) return;
  latestSnapshot = JSON.parse(JSON.stringify(latestSnapshot)) as ControllerSnapshot;
  const targets = latestSnapshot.targets || [];
  latestSnapshot.targets = targets;

  if ((command.kind === "set_enabled" || command.kind === "target_enabled") && command.targetId) {
    const target = targets.find((item) => item.id === command.targetId);
    if (target) {
      target.enabled = command.enabled !== false;
      target.status = target.enabled ? "NEW" : "DISABLED";
      target.message = target.enabled ? "已发送启用命令，等待确认" : "已发送停用命令，等待确认";
    }
  } else if (command.kind === "delete_target" && command.targetId) {
    latestSnapshot.targets = targets.filter((item) => item.id !== command.targetId);
  } else if ((command.kind === "upsert_target" || command.kind === "save_target") && command.target) {
    const next = optimisticTargetFromCommandTarget(command.target);
    const targetId = command.targetId || next.id;
    const index = targets.findIndex((item) => item.id === targetId);
    if (index >= 0) targets[index] = { ...targets[index], ...next };
    else targets.push(next);
  } else if ((command.kind === "reset_target_state" || command.kind === "reset_target") && command.targetId) {
    const target = targets.find((item) => item.id === command.targetId);
    if (target) {
      target.promisedInputs = 0;
      target.promisedInputItems = {};
      target.message = "已发送重置命令，等待确认";
    }
  }

  recomputeSummary(latestSnapshot);
}

function dispatchCommand(command: ControllerCommand) {
  if (!bridgeSocket || !bridgeState.connected) {
    return {
      ok: false,
      status: 409,
      response: { ok: false, error: "bridge is not connected" },
    };
  }

  const cleanCommand = sanitizeCommandForController(command);
  const id = cleanCommand.commandId || cleanCommand.id || commandId();
  const outgoing: ControllerCommand = {
    ...cleanCommand,
    commandId: id,
    id,
    source: cleanCommand.source || "web",
  };

  store.createCommand(id, outgoing);
  applyOptimisticCommand(outgoing);
  bridgeSocket.send(
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

function handleBridgeMessage(socket: ServerWebSocket<SocketData>, envelope: BridgeEnvelope) {
  bridgeState = {
    ...bridgeState,
    connected: true,
    clientId: envelope.clientId || bridgeState.clientId,
    lastSeenAt: now(),
  };

  if (envelope.type === "hello") {
    bridgeState.protocol = envelope.protocol;
    recordEvent("bridge_hello", envelope as unknown as JsonValue);
    broadcast(stateEnvelope());
    return;
  }

  if (envelope.type === "snapshot" || envelope.type === "heartbeat") {
    if (envelope.snapshot) {
      latestSnapshot = envelope.snapshot;
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

function handleUiMessage(socket: ServerWebSocket<SocketData>, message: unknown) {
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

function contentType(path: string) {
  const ext = extname(path);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function staticResponse(url: URL) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const path = join(PUBLIC_DIR, relative);
  if (!path.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });

  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not Found", { status: 404 });
  return new Response(file, { headers: { "content-type": contentType(path) } });
}

async function handleApi(req: Request, url: URL) {
  if (url.pathname === "/api/status" && req.method === "GET") {
    return jsonResponse(stateEnvelope());
  }

  if (url.pathname === "/api/items" && req.method === "GET") {
    return jsonResponse(getAssetIndex());
  }

  if (url.pathname.startsWith("/api/items/") && req.method === "GET") {
    const id = decodeURIComponent(url.pathname.slice("/api/items/".length));
    const item = getItemAsset(id);
    return item ? jsonResponse(item) : jsonResponse({ ok: false, error: "item not found" }, 404);
  }

  if (url.pathname === "/api/commands" && req.method === "POST") {
    const body = (await req.json()) as ControllerCommand;
    if (!body || typeof body.kind !== "string") {
      return jsonResponse({ ok: false, error: "command.kind is required" }, 400);
    }
    const result = dispatchCommand(body);
    return jsonResponse(result.response, result.status);
  }

  return new Response("Not Found", { status: 404 });
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
      if (socket.data.role === "bridge") {
        if (bridgeSocket && bridgeSocket !== socket) bridgeSocket.close(4000, "replaced");
        bridgeSocket = socket;
        bridgeState = {
          connected: true,
          connectedAt: now(),
          lastSeenAt: now(),
        };
        recordEvent("bridge_connected", { time: now() });
        broadcast(stateEnvelope());
        return;
      }

      uiClients.add(socket);
      sendJson(socket, stateEnvelope());
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
      if (socket.data.role === "bridge" && bridgeSocket === socket) {
        bridgeSocket = null;
        bridgeState = {
          ...bridgeState,
          connected: false,
          lastSeenAt: now(),
        };
        recordEvent("bridge_disconnected", { time: now() });
        broadcast(stateEnvelope());
        return;
      }

      uiClients.delete(socket);
    },
  },
});

console.log(`ME Controller web listening on http://localhost:${PORT}`);
