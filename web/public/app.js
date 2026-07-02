const state = {
  bridge: { connected: false },
  snapshot: null,
  commands: [],
  items: {},
  pendingTargets: {},
  socket: null,
};

const el = {
  subtitle: document.querySelector("#subtitle"),
  addTargetBtn: document.querySelector("#addTargetBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  targetsBody: document.querySelector("#targetsBody"),
  commandsList: document.querySelector("#commandsList"),
  commandCount: document.querySelector("#commandCount"),
  networkStatus: document.querySelector("#networkStatus"),
  bridgeStatus: document.querySelector("#bridgeStatus"),
  bridgeClient: document.querySelector("#bridgeClient"),
  bridgeProtocol: document.querySelector("#bridgeProtocol"),
  bridgeSeen: document.querySelector("#bridgeSeen"),
  messages: document.querySelector("#messages"),
  mTotal: document.querySelector("#mTotal"),
  mEnabled: document.querySelector("#mEnabled"),
  mRequested: document.querySelector("#mRequested"),
  mWaiting: document.querySelector("#mWaiting"),
  mError: document.querySelector("#mError"),
  mStock: document.querySelector("#mStock"),
  targetDialog: document.querySelector("#targetDialog"),
  targetForm: document.querySelector("#targetForm"),
  targetDialogTitle: document.querySelector("#targetDialogTitle"),
  closeTargetDialogBtn: document.querySelector("#closeTargetDialogBtn"),
  cancelTargetBtn: document.querySelector("#cancelTargetBtn"),
  deleteTargetBtn: document.querySelector("#deleteTargetBtn"),
  editingTargetId: document.querySelector("#editingTargetId"),
  targetIdInput: document.querySelector("#targetIdInput"),
  targetNameInput: document.querySelector("#targetNameInput"),
  targetEnabledInput: document.querySelector("#targetEnabledInput"),
  targetAddressInput: document.querySelector("#targetAddressInput"),
  targetPriorityInput: document.querySelector("#targetPriorityInput"),
  targetProductsInput: document.querySelector("#targetProductsInput"),
  targetInputsInput: document.querySelector("#targetInputsInput"),
  requestCooldownInput: document.querySelector("#requestCooldownInput"),
  minImmediateRequestInput: document.querySelector("#minImmediateRequestInput"),
  delayedRequestInput: document.querySelector("#delayedRequestInput"),
  promiseTtlInput: document.querySelector("#promiseTtlInput"),
  maxOutstandingInput: document.querySelector("#maxOutstandingInput"),
  maxRequestPerCycleInput: document.querySelector("#maxRequestPerCycleInput"),
  deficitConfirmScansInput: document.querySelector("#deficitConfirmScansInput"),
  deficitConfirmSecondsInput: document.querySelector("#deficitConfirmSecondsInput"),
  stockDropConfirmScansInput: document.querySelector("#stockDropConfirmScansInput"),
  stockDropConfirmSecondsInput: document.querySelector("#stockDropConfirmSecondsInput"),
};

const TARGET_DEFAULTS = {
  enabled: true,
  address: "press",
  priority: 100,
  targetCount: 2048,
  requestCooldownSeconds: 5,
  minImmediateRequest: 64,
  delayedRequestSeconds: 20,
  promiseTtlSeconds: 90,
  maxOutstandingInputs: 1024,
  maxRequestPerCycle: 576,
  deficitConfirmScans: 3,
  deficitConfirmSeconds: 2,
  stockDropConfirmScans: 3,
  stockDropConfirmSeconds: 2,
};

const TARGET_CONFIG_KEYS = [
  "id",
  "enabled",
  "address",
  "priority",
  "products",
  "inputs",
  "productItem",
  "productLabel",
  "targetCount",
  "inputItem",
  "inputLabel",
  "requestCooldownSeconds",
  "minImmediateRequest",
  "delayedRequestSeconds",
  "promiseTtlSeconds",
  "maxOutstandingInputs",
  "maxRequestPerCycle",
  "deficitConfirmScans",
  "deficitConfirmSeconds",
  "stockDropConfirmScans",
  "stockDropConfirmSeconds",
];

function text(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function escapeHtml(value) {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberField(input, fallback, minimum) {
  const value = Number(input.value);
  const number = Number.isFinite(value) ? value : fallback;
  if (minimum !== undefined) return Math.max(minimum, number);
  return number;
}

function fieldValue(target, key) {
  if (target && target[key] !== undefined && target[key] !== null) return target[key];
  return TARGET_DEFAULTS[key];
}

function defaultDisplayName(itemId) {
  const value = text(itemId, "");
  const rawName = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
  const words = rawName
    .replace(/[_\-./]+/g, " ")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return value || "Item";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

function targetIdFromItem(itemId) {
  const value = text(itemId, "").toLowerCase();
  const id = value.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  return id || "target";
}

function formatTime(value) {
  if (!value) return "-";
  const ms = value > 10_000_000_000 ? value : value * 1000;
  return new Date(ms).toLocaleTimeString();
}

function statusClass(status) {
  const value = text(status, "").toUpperCase();
  if (value === "ERROR" || value === "FAILED") return "bad";
  if (value === "WAITING" || value === "SENT" || value === "ACKNOWLEDGED") return "warn";
  if (value === "SATISFIED" || value === "REQUESTED" || value === "DONE" || value === "SYNCED") return "good";
  return "";
}

function statusLabel(status) {
  const value = text(status, "").toUpperCase();
  const labels = {
    ERROR: "错误",
    WAITING: "等待",
    SATISFIED: "已满足",
    REQUESTED: "已下单",
    DISABLED: "已停用",
    NEW: "初始化",
    SENT: "已发送",
    ACKNOWLEDGED: "已确认",
    SYNCED: "已同步",
    DONE: "完成",
    FAILED: "失败",
  };
  return labels[value] || text(status);
}

function commandKindLabel(kind) {
  const value = text(kind, "");
  const labels = {
    request: "请求物品",
    set_enabled: "启停目标",
    target_enabled: "启停目标",
    reset_target_state: "重置状态",
    reset_target: "重置状态",
    delete_target: "删除目标",
    upsert_target: "保存目标",
    save_target: "保存目标",
    snapshot: "读取快照",
    ping: "心跳",
  };
  return labels[value] || value || "-";
}

function itemAsset(itemId) {
  return state.items[itemId] || null;
}

function itemName(itemId) {
  return (itemAsset(itemId) && itemAsset(itemId).name) || text(itemId);
}

function itemIconHtml(itemId) {
  const asset = itemAsset(itemId);
  if (asset && asset.icon) {
    return `<img class="itemIcon" src="${escapeHtml(asset.icon)}" alt="" loading="lazy" />`;
  }
  return `<span class="itemIcon missing">${escapeHtml(text(itemId, "?").slice(0, 1).toUpperCase())}</span>`;
}

function productLabel(target) {
  const product = target.products && target.products[0];
  return product ? itemName(product.item) : text(target.id);
}

function recipeLine(entries) {
  if (!entries || entries.length === 0) return "-";
  return entries.map((entry) => `${itemName(entry.item)} x${entry.count || 1}`).join(", ");
}

function entriesToText(entries, isProduct) {
  return (entries || [])
    .map((entry) => {
      let value = `${entry.item}=${entry.count || 1}`;
      if (isProduct) value += `@${entry.targetCount ?? 0}`;
      return value;
    })
    .join(", ");
}

function parseRecipeEntries(value, isProduct) {
  const entries = [];
  for (const rawToken of text(value, "").split(",")) {
    let token = rawToken.trim();
    if (!token) continue;

    let targetCount;
    if (isProduct && token.includes("@")) {
      const parts = token.split("@");
      token = parts[0].trim();
      targetCount = Number(parts[1]);
      if (!Number.isFinite(targetCount) || targetCount < 0) throw new Error(`目标库存无效：${rawToken}`);
    }

    let item = token;
    let count = 1;
    if (token.includes("=")) {
      const parts = token.split("=");
      item = parts[0].trim();
      count = Number(parts[1]);
    }

    if (!item) throw new Error(`缺少物品 ID：${rawToken}`);
    if (!Number.isFinite(count) || count <= 0) throw new Error(`配方数量无效：${rawToken}`);

    const entry = { item, count };
    if (isProduct && targetCount !== undefined) entry.targetCount = targetCount;
    entries.push(entry);
  }

  if (entries.length === 0) throw new Error(isProduct ? "至少需要一个产物" : "至少需要一个输入");
  return entries;
}

function manualLabel(label, item) {
  const value = text(label, "").trim();
  if (!value || value === item || value === defaultDisplayName(item) || value === itemName(item)) return null;
  return value;
}

function preserveEntryLabels(entries, previousEntries) {
  return entries.map((entry) => {
    const previous = (previousEntries || []).find((item) => item.item === entry.item);
    const label = manualLabel(previous && previous.label, entry.item);
    return label ? { ...entry, label } : entry;
  });
}

function recomputeSummary() {
  if (!state.snapshot) return;
  const targets = state.snapshot.targets || [];
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

  state.snapshot.summary = summary;
}

function optimisticTarget(raw) {
  const products = raw.products || [];
  const firstProduct = products[0] || {};
  return {
    id: raw.id || firstProduct.item || "target",
    enabled: raw.enabled !== false,
    address: raw.address || "press",
    priority: Number(raw.priority || 100),
    products,
    inputs: raw.inputs || [],
    status: raw.enabled === false ? "DISABLED" : "NEW",
    message: "等待控制器确认",
    productCount: 0,
    targetCount: Number(firstProduct.targetCount || 0),
    neededInputs: 0,
    promisedInputs: 0,
  };
}

function ensureSnapshot() {
  if (!state.snapshot) {
    state.snapshot = {
      network: { ready: false, stockEntries: 0 },
      summary: {},
      targets: [],
      commands: [],
    };
  }
  if (!state.snapshot.targets) state.snapshot.targets = [];
  return state.snapshot;
}

function markPendingTarget(targetId, patch) {
  if (!targetId) return;
  state.pendingTargets[targetId] = {
    ...patch,
    expiresAt: Date.now() + 8000,
  };
}

function applyPendingTargets() {
  if (!state.snapshot || !state.snapshot.targets) return;
  const now = Date.now();

  for (const [targetId, pending] of Object.entries(state.pendingTargets)) {
    const target = state.snapshot.targets.find((item) => item.id === targetId);
    if (!target || pending.expiresAt < now) {
      delete state.pendingTargets[targetId];
      continue;
    }

    if (pending.enabled !== undefined && target.enabled === pending.enabled) {
      delete state.pendingTargets[targetId];
      continue;
    }

    if (pending.enabled !== undefined) {
      target.enabled = pending.enabled;
      target.status = pending.enabled ? "NEW" : "DISABLED";
    }
    if (pending.message) target.message = pending.message;
  }

  recomputeSummary();
}

function targetPending(targetId) {
  const pending = state.pendingTargets[targetId];
  if (!pending) return false;
  if (pending.expiresAt < Date.now()) {
    delete state.pendingTargets[targetId];
    return false;
  }
  return true;
}

function applyLocalCommand(command) {
  const snapshot = ensureSnapshot();
  const targets = snapshot.targets;

  if ((command.kind === "set_enabled" || command.kind === "target_enabled") && command.targetId) {
    const target = targets.find((item) => item.id === command.targetId);
    const enabled = command.enabled !== false;
    markPendingTarget(command.targetId, {
      enabled,
      message: enabled ? "已发送启用命令" : "已发送停用命令",
    });
    if (target) {
      target.enabled = enabled;
      target.status = enabled ? "NEW" : "DISABLED";
      target.message = enabled ? "已发送启用命令" : "已发送停用命令";
    }
  } else if (command.kind === "delete_target" && command.targetId) {
    snapshot.targets = targets.filter((item) => item.id !== command.targetId);
  } else if ((command.kind === "upsert_target" || command.kind === "save_target") && command.target) {
    const next = optimisticTarget(command.target);
    const targetId = command.targetId || next.id;
    const index = targets.findIndex((item) => item.id === targetId);
    if (index >= 0) targets[index] = { ...targets[index], ...next };
    else targets.push(next);
  } else if ((command.kind === "reset_target_state" || command.kind === "reset_target") && command.targetId) {
    const target = targets.find((item) => item.id === command.targetId);
    if (target) {
      target.promisedInputs = 0;
      target.promisedInputItems = {};
      target.message = "已发送重置命令";
    }
  }

  recomputeSummary();
  render();
}

function firstNeededInput(target) {
  const needed = target.neededInputItems || {};
  const input = (target.inputs || []).find((entry) => number(needed[entry.item]) > 0);
  if (!input) return null;
  return {
    item: input.item,
    count: Math.max(1, Math.min(64, Math.floor(number(needed[input.item])))),
  };
}

function findTarget(targetId) {
  const targets = (state.snapshot && state.snapshot.targets) || [];
  return targets.find((target) => target.id === targetId) || null;
}

function firstProductItemFromText(value) {
  try {
    const products = parseRecipeEntries(value, true);
    return products[0] && products[0].item;
  } catch {
    return "";
  }
}

function primaryManualLabel(target) {
  const product = target && target.products && target.products[0];
  const item = product && product.item;
  if (!item) return "";
  return manualLabel(product.label, item) || manualLabel(target.productLabel, item) || "";
}

function updateTargetPlaceholders() {
  const item = firstProductItemFromText(el.targetProductsInput.value);
  el.targetNameInput.placeholder = item ? defaultDisplayName(item) : "自动生成";
  el.targetIdInput.placeholder = item ? targetIdFromItem(item) : "自动生成";
}

function editableTargetBase(target) {
  const base = {};
  if (!target) return base;
  for (const key of TARGET_CONFIG_KEYS) {
    if (target[key] !== undefined) base[key] = target[key];
  }
  return base;
}

function openTargetDialog(target) {
  const isEdit = Boolean(target);
  el.targetDialogTitle.textContent = isEdit ? "编辑目标" : "新增目标";
  el.editingTargetId.value = target ? target.id : "";
  el.targetIdInput.value = target ? target.id : "";
  el.targetNameInput.value = target ? primaryManualLabel(target) : "";
  el.targetEnabledInput.checked = target ? target.enabled !== false : TARGET_DEFAULTS.enabled;
  el.targetAddressInput.value = target ? target.address || TARGET_DEFAULTS.address : TARGET_DEFAULTS.address;
  el.targetPriorityInput.value = String(fieldValue(target, "priority"));
  el.targetProductsInput.value = target ? entriesToText(target.products || [], true) : "";
  el.targetInputsInput.value = target ? entriesToText(target.inputs || [], false) : "";
  el.requestCooldownInput.value = String(fieldValue(target, "requestCooldownSeconds"));
  el.minImmediateRequestInput.value = String(fieldValue(target, "minImmediateRequest"));
  el.delayedRequestInput.value = String(fieldValue(target, "delayedRequestSeconds"));
  el.promiseTtlInput.value = String(fieldValue(target, "promiseTtlSeconds"));
  el.maxOutstandingInput.value = String(fieldValue(target, "maxOutstandingInputs"));
  el.maxRequestPerCycleInput.value = String(fieldValue(target, "maxRequestPerCycle"));
  el.deficitConfirmScansInput.value = String(fieldValue(target, "deficitConfirmScans"));
  el.deficitConfirmSecondsInput.value = String(fieldValue(target, "deficitConfirmSeconds"));
  el.stockDropConfirmScansInput.value = String(fieldValue(target, "stockDropConfirmScans"));
  el.stockDropConfirmSecondsInput.value = String(fieldValue(target, "stockDropConfirmSeconds"));
  el.deleteTargetBtn.hidden = !isEdit;
  updateTargetPlaceholders();

  if (el.targetDialog.showModal) el.targetDialog.showModal();
  else el.targetDialog.setAttribute("open", "open");
}

function closeTargetDialog() {
  if (el.targetDialog.close) el.targetDialog.close();
  else el.targetDialog.removeAttribute("open");
}

function targetFromForm() {
  const base = editableTargetBase(findTarget(el.editingTargetId.value));
  const products = preserveEntryLabels(parseRecipeEntries(el.targetProductsInput.value, true), base.products);
  const inputs = preserveEntryLabels(parseRecipeEntries(el.targetInputsInput.value, false), base.inputs);
  const firstProduct = products[0];
  const firstInput = inputs[0];
  const productName = manualLabel(el.targetNameInput.value, firstProduct.item);
  if (productName) firstProduct.label = productName;
  else delete firstProduct.label;
  const productLabel = productName || firstProduct.item;
  const inputLabel = firstInput.label || manualLabel(base.inputLabel, firstInput.item) || firstInput.item;
  return {
    ...base,
    id: el.targetIdInput.value.trim() || targetIdFromItem(firstProduct.item),
    enabled: el.targetEnabledInput.checked,
    address: el.targetAddressInput.value.trim() || TARGET_DEFAULTS.address,
    priority: numberField(el.targetPriorityInput, TARGET_DEFAULTS.priority, 0),
    products,
    inputs,
    productItem: firstProduct.item,
    productLabel,
    targetCount: firstProduct.targetCount ?? TARGET_DEFAULTS.targetCount,
    inputItem: firstInput.item,
    inputLabel,
    requestCooldownSeconds: numberField(el.requestCooldownInput, TARGET_DEFAULTS.requestCooldownSeconds, 0),
    minImmediateRequest: numberField(el.minImmediateRequestInput, TARGET_DEFAULTS.minImmediateRequest, 1),
    delayedRequestSeconds: numberField(el.delayedRequestInput, TARGET_DEFAULTS.delayedRequestSeconds, 0),
    promiseTtlSeconds: numberField(el.promiseTtlInput, TARGET_DEFAULTS.promiseTtlSeconds, 1),
    maxOutstandingInputs: numberField(el.maxOutstandingInput, TARGET_DEFAULTS.maxOutstandingInputs, 1),
    maxRequestPerCycle: numberField(el.maxRequestPerCycleInput, TARGET_DEFAULTS.maxRequestPerCycle, 1),
    deficitConfirmScans: numberField(el.deficitConfirmScansInput, TARGET_DEFAULTS.deficitConfirmScans, 1),
    deficitConfirmSeconds: numberField(el.deficitConfirmSecondsInput, TARGET_DEFAULTS.deficitConfirmSeconds, 0),
    stockDropConfirmScans: numberField(el.stockDropConfirmScansInput, TARGET_DEFAULTS.stockDropConfirmScans, 1),
    stockDropConfirmSeconds: numberField(el.stockDropConfirmSecondsInput, TARGET_DEFAULTS.stockDropConfirmSeconds, 0),
  };
}

function addMessage(message) {
  const node = document.createElement("div");
  node.className = "message";
  node.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  el.messages.prepend(node);
  while (el.messages.children.length > 8) el.messages.lastElementChild.remove();
}

function sendCommand(command, options = {}) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    addMessage("UI WebSocket 未连接");
    return;
  }
  state.socket.send(JSON.stringify({ type: "command", command }));
  if (options.optimistic !== false) applyLocalCommand(command);
}

function renderMetrics() {
  const summary = (state.snapshot && state.snapshot.summary) || {};
  const network = (state.snapshot && state.snapshot.network) || {};
  el.mTotal.textContent = number(summary.total);
  el.mEnabled.textContent = number(summary.enabled);
  el.mRequested.textContent = number(summary.requested);
  el.mWaiting.textContent = number(summary.waiting);
  el.mError.textContent = number(summary.error);
  el.mStock.textContent = number(network.stockEntries);
}

function renderBridge() {
  const bridge = state.bridge || {};
  const network = (state.snapshot && state.snapshot.network) || {};

  el.subtitle.textContent = bridge.connected ? "桥接在线" : "桥接未连接";
  el.bridgeStatus.textContent = bridge.connected ? "在线" : "离线";
  el.bridgeStatus.className = `pill ${bridge.connected ? "good" : "bad"}`;
  el.bridgeClient.textContent = text(bridge.clientId);
  el.bridgeProtocol.textContent = text(bridge.protocol);
  el.bridgeSeen.textContent = formatTime(bridge.lastSeenAt);

  el.networkStatus.textContent = network.ready ? "在线" : "离线";
  el.networkStatus.className = `pill ${network.ready ? "good" : "bad"}`;
}

function renderTargets() {
  const targets = (state.snapshot && state.snapshot.targets) || [];
  el.targetsBody.innerHTML = "";

  if (targets.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "empty";
    cell.textContent = "暂无目标";
    row.append(cell);
    el.targetsBody.append(row);
    return;
  }

  for (const target of targets) {
    const row = document.createElement("tr");
    const needed = firstNeededInput(target);

    const product = target.products && target.products[0];
    const productId = product && product.item;

    row.innerHTML = `
      <td><span class="pill ${statusClass(target.status)}">${escapeHtml(statusLabel(target.status))}</span></td>
      <td>
        <div class="itemCell">
          ${itemIconHtml(productId || target.id)}
          <div class="targetName">
            <strong>${escapeHtml(productLabel(target))}</strong>
            <span>${escapeHtml(productId || target.id)}</span>
            <span>${escapeHtml(recipeLine(target.inputs))}</span>
          </div>
        </div>
      </td>
      <td>${number(target.productCount)} / ${number(target.targetCount)}</td>
      <td>${number(target.neededInputs)}</td>
      <td>${number(target.promisedInputs)}</td>
      <td class="mono">${escapeHtml(target.address)}</td>
      <td></td>
    `;

    const actions = document.createElement("div");
    actions.className = "rowActions";

    const toggle = document.createElement("button");
    toggle.type = "button";
    const pending = targetPending(target.id);
    toggle.textContent = pending ? "同步中" : target.enabled ? "停用" : "启用";
    toggle.disabled = pending;
    toggle.onclick = () => sendCommand({ kind: "set_enabled", targetId: target.id, enabled: !target.enabled });

    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "重置";
    reset.onclick = () => sendCommand({ kind: "reset_target_state", targetId: target.id });

    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "编辑";
    edit.onclick = () => openTargetDialog(target);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除";
    remove.className = "danger";
    remove.onclick = () => {
      if (!confirm(`删除目标「${productLabel(target)}」？`)) return;
      sendCommand({ kind: "delete_target", targetId: target.id });
    };

    const request = document.createElement("button");
    request.type = "button";
    request.textContent = "请求";
    request.disabled = !needed;
    request.onclick = () => {
      if (!needed) return;
      sendCommand({
        kind: "request",
        targetId: target.id,
        item: needed.item,
        count: needed.count,
      });
    };

    actions.append(toggle, edit, reset, request, remove);
    row.lastElementChild.append(actions);
    el.targetsBody.append(row);
  }
}

function renderCommands() {
  const commands = state.commands || [];
  el.commandCount.textContent = commands.length;
  el.commandsList.innerHTML = "";

  if (commands.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无命令";
    el.commandsList.append(empty);
    return;
  }

  for (const command of commands.slice(0, 30)) {
    const node = document.createElement("div");
    node.className = "listItem";
    const request = command.request || {};
    const id = command.commandId || command.id;
    node.innerHTML = `
      <span class="mono">${formatTime(command.createdAt)}</span>
      <span>${escapeHtml(commandKindLabel(command.kind || request.kind))} <span class="muted mono">${escapeHtml(id)}</span></span>
      <span class="pill ${statusClass(command.status)}">${escapeHtml(statusLabel(command.status))}</span>
    `;
    el.commandsList.append(node);
  }
}

function render() {
  renderMetrics();
  renderBridge();
  renderTargets();
  renderCommands();
}

async function loadInitialState() {
  const response = await fetch("/api/status");
  const payload = await response.json();
  if (payload.type === "state") {
    state.bridge = payload.bridge || state.bridge;
    state.snapshot = payload.snapshot || null;
    state.commands = payload.commands || [];
    applyPendingTargets();
    render();
  }
}

async function loadItems() {
  const response = await fetch("/api/items");
  const payload = await response.json();
  state.items = payload.items || {};
  addMessage(`已加载 ${Object.keys(state.items).length} 个物品索引`);
  render();
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ui`);
  state.socket = socket;

  socket.onopen = () => {
    addMessage("UI 已连接");
    socket.send(JSON.stringify({ type: "refresh" }));
  };

  socket.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "state") {
      state.bridge = payload.bridge || state.bridge;
      state.snapshot = payload.snapshot || null;
      state.commands = payload.commands || [];
      applyPendingTargets();
      render();
    } else if (payload.type === "command_accepted") {
      addMessage(payload.ok ? "命令已提交" : text(payload.response && payload.response.error, "命令提交失败"));
      if (!payload.ok) loadInitialState().catch((error) => addMessage(error.message));
    } else if (payload.type === "command_result") {
      addMessage(payload.ok ? "控制器已确认命令" : text(payload.response && payload.response.error, "控制器执行失败"));
      if (!payload.ok) loadInitialState().catch((error) => addMessage(error.message));
    } else if (payload.type === "error") {
      addMessage(payload.error || "Error");
    }
  };

  socket.onclose = () => {
    state.bridge = { ...state.bridge, connected: false };
    render();
    addMessage("UI 已断开");
    setTimeout(connect, 1500);
  };
}

el.refreshBtn.onclick = () => {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: "refresh" }));
  } else {
    loadInitialState();
  }
};

el.addTargetBtn.onclick = () => openTargetDialog(null);
el.closeTargetDialogBtn.onclick = closeTargetDialog;
el.cancelTargetBtn.onclick = closeTargetDialog;
el.targetProductsInput.addEventListener("input", updateTargetPlaceholders);

el.targetForm.onsubmit = (event) => {
  event.preventDefault();
  try {
    const target = targetFromForm();
    const previousId = el.editingTargetId.value || target.id;
    sendCommand({
      kind: "upsert_target",
      targetId: previousId,
      target,
    });
    closeTargetDialog();
  } catch (error) {
    addMessage(error instanceof Error ? error.message : String(error));
  }
};

el.deleteTargetBtn.onclick = () => {
  const targetId = el.editingTargetId.value;
  const target = findTarget(targetId);
  if (!targetId || !target) return;
  if (!confirm(`删除目标「${productLabel(target)}」？`)) return;
  sendCommand({ kind: "delete_target", targetId });
  closeTargetDialog();
};

loadInitialState().catch((error) => addMessage(error.message));
loadItems().catch((error) => addMessage(`物品索引加载失败：${error.message}`));
connect();
