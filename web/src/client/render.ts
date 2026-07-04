// 渲染层：保持"全量重渲染"模型——每次状态变化把各动态区域整体重建
//（静态骨架与输入框在 index.html 里，不参与重建，搜索框因此不丢焦点）。
import type { StoredCommand, TargetSnapshot } from "../shared/protocol";
import { defaultDisplayName } from "../shared/summary";
import { app, itemAsset, subscribe, targetPending } from "./state";
import type { ViewId } from "./state";
import { asNumber, el, formatAmount, formatExact, formatTime, must, text } from "./dom";
import { sendCommand } from "./ws";
import { openTargetDialog } from "./target-editor";

// ---- 通用小部件 ------------------------------------------------------------

function statusClass(status: unknown): string {
  const value = text(status, "").toUpperCase();
  if (value === "ERROR") return "bad";
  if (value === "WAITING") return "warn";
  if (value === "SATISFIED" || value === "REQUESTED") return "good";
  return "";
}

const STATUS_LABELS: Record<string, string> = {
  ERROR: "错误",
  WAITING: "等待",
  SATISFIED: "已满足",
  REQUESTED: "已下单",
  DISABLED: "已停用",
  NEW: "初始化",
};

function statusLabel(status: unknown): string {
  const value = text(status, "").toUpperCase();
  return STATUS_LABELS[value] || text(status);
}

const COMMAND_KIND_LABELS: Record<string, string> = {
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

function commandKindLabel(kind: unknown): string {
  const value = text(kind, "");
  return COMMAND_KIND_LABELS[value] || value || "-";
}

function pill(label: string, tone: string) {
  return el("span", { className: `pill ${tone}`.trim(), text: label });
}

function pendingPill(label: string) {
  return el("span", { className: "pill pending" }, [
    el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
    label,
  ]);
}

// enabled 是权威配置;status 字段由 decide 循环滞后一拍重算——显示层以
// enabled 优先,消灭"刚停用的目标短暂显示已满足"的窗口。
function effectiveTargetStatus(target: TargetSnapshot): string {
  const status = text(target.status, "NEW").toUpperCase();
  if (target.enabled === false) return "DISABLED";
  if (status === "DISABLED") return "NEW";
  return status;
}

// 目标状态胶囊:有在途命令时显示转圈(不改写快照,乐观预测已移除)
function targetStatusPill(target: TargetSnapshot) {
  const pending = targetPending(target.id);
  if (pending) return pendingPill(pending.label);
  const status = effectiveTargetStatus(target);
  return pill(statusLabel(status), statusClass(status));
}

export function itemName(itemId: string | undefined | null): string {
  if (!itemId) return "-";
  const asset = itemAsset(itemId);
  return (asset && asset.name) || defaultDisplayName(itemId);
}

function itemIcon(itemId: string | undefined | null, size: "s" | "m" | "l" = "m"): HTMLElement {
  const asset = itemAsset(itemId || undefined);
  if (asset?.icon) {
    const img = el("img", { className: `itemIcon ${size}`, attrs: { alt: "", loading: "lazy" } });
    img.src = asset.icon;
    return img;
  }
  return el("span", {
    className: `itemIcon missing ${size}`,
    text: text(itemId, "?").slice(0, 1).toUpperCase(),
  });
}

function productLabel(target: TargetSnapshot): string {
  const product = target.products && target.products[0];
  return product ? itemName(product.item) : text(target.id);
}

function recipeLine(entries: TargetSnapshot["inputs"]): string {
  if (!entries || entries.length === 0) return "-";
  return entries.map((entry) => `${itemName(entry.item)} ×${entry.count || 1}`).join("、");
}

function firstNeededInput(target: TargetSnapshot) {
  const needed = target.neededInputItems || {};
  const input = (target.inputs || []).find((entry) => asNumber(needed[entry.item]) > 0);
  if (!input) return null;
  return {
    item: input.item,
    count: Math.max(1, Math.min(64, Math.floor(asNumber(needed[input.item])))),
  };
}

function emptyState(title: string, hints: string[] = []) {
  return el("div", { className: "emptyState" }, [
    el("p", { className: "emptyTitle", text: title }),
    ...hints.map((hint) => el("p", { className: "emptyHint", text: hint })),
  ]);
}

// ---- 侧边栏:能量核 + 网络状态 ---------------------------------------------

function renderSidebar() {
  const bridge = app.bridge || {};
  const network = app.snapshot?.network || {};
  const online = Boolean(bridge.connected);

  const core = must<HTMLElement>("#energyCore");
  core.classList.toggle("online", online);
  core.classList.toggle("offline", !online);

  must<HTMLElement>("#coreState").textContent = online ? "网络在线" : "网络离线";
  must<HTMLElement>("#coreDetail").textContent = online
    ? `${text(bridge.clientId, "控制器")} · 最后通信 ${formatTime(bridge.lastSeenAt)}`
    : app.uiConnected
      ? "等待游戏内桥接连接"
      : "正在连接控制台服务…";

  const rows: [string, string, string][] = [
    ["存储总线", network.ready ? "在线" : "离线", network.ready ? "good" : "bad"],
    ["库存条目", String(asNumber(network.stockEntries)), ""],
    ["桥接协议", text(bridge.protocol), ""],
  ];
  must<HTMLElement>("#coreStats").replaceChildren(
    ...rows.map(([label, value, tone]) =>
      el("div", { className: "coreStat" }, [
        el("span", { className: "coreStatLabel", text: label }),
        el("span", { className: `coreStatValue ${tone}`.trim(), text: value }),
      ])
    )
  );

  // 导航徽标：自动维持显示目标数,命令日志显示未完成命令数
  const summary = app.snapshot?.summary || {};
  const badgeTargets = must<HTMLElement>("#navBadgeTargets");
  badgeTargets.textContent = String(asNumber(summary.total));
  badgeTargets.hidden = asNumber(summary.total) === 0;

  // 命令徽标只数还在等控制器回包的命令(sent);成功/失败都算已定型
  const activeCommands = (app.commands || []).filter(
    (command) => text(command.status, "").toLowerCase() === "sent"
  ).length;
  const badgeCommands = must<HTMLElement>("#navBadgeCommands");
  badgeCommands.textContent = String(activeCommands);
  badgeCommands.hidden = activeCommands === 0;
}

// ---- 总览 -------------------------------------------------------------------

function metricCard(label: string, value: string, tone = "") {
  return el("div", { className: `metric ${tone}`.trim() }, [
    el("span", { className: "metricLabel", text: label }),
    el("strong", { className: "metricValue", text: value }),
  ]);
}

function renderOverview() {
  const summary = app.snapshot?.summary || {};
  const network = app.snapshot?.network || {};

  must<HTMLElement>("#overviewMetrics").replaceChildren(
    metricCard("维持目标", String(asNumber(summary.total))),
    metricCard("已启用", String(asNumber(summary.enabled))),
    metricCard("已下单", String(asNumber(summary.requested)), asNumber(summary.requested) > 0 ? "accent" : ""),
    metricCard("等待中", String(asNumber(summary.waiting)), asNumber(summary.waiting) > 0 ? "warn" : ""),
    metricCard("错误", String(asNumber(summary.error)), asNumber(summary.error) > 0 ? "bad" : ""),
    metricCard("库存条目", String(asNumber(network.stockEntries)))
  );

  // 目标健康列表(紧凑)
  const targets = app.snapshot?.targets || [];
  const list = must<HTMLElement>("#overviewTargets");
  if (targets.length === 0) {
    list.replaceChildren(emptyState("还没有维持目标", ["到「自动维持」页新建第一个目标,网络就会自动补货。"]));
  } else {
    list.replaceChildren(
      ...targets.map((target) => {
        const product = target.products && target.products[0];
        const row = el("div", { className: "miniTarget" }, [
          itemIcon(product?.item || target.id, "s"),
          el("div", { className: "miniTargetName" }, [
            el("strong", { text: productLabel(target) }),
            el("span", { className: "muted", text: text(target.message, "") }),
          ]),
          el("span", { className: "miniTargetCount mono", text: `${formatExact(asNumber(target.productCount))} / ${formatExact(asNumber(target.targetCount))}` }),
          targetStatusPill(target),
        ]);
        return row;
      })
    );
  }

  // 最近命令(前 8 条)
  const commands = (app.commands || []).slice(0, 8);
  const commandsHost = must<HTMLElement>("#overviewCommands");
  if (commands.length === 0) {
    commandsHost.replaceChildren(emptyState("暂无命令记录"));
  } else {
    commandsHost.replaceChildren(...commands.map((command) => commandRow(command, true)));
  }

  // 消息日志
  const messagesHost = must<HTMLElement>("#overviewMessages");
  if (app.messages.length === 0) {
    messagesHost.replaceChildren(emptyState("暂无消息"));
  } else {
    messagesHost.replaceChildren(
      ...app.messages.map((message) =>
        el("div", { className: `message ${message.tone}` }, [
          el("span", { className: "mono muted", text: new Date(message.time).toLocaleTimeString("zh-CN", { hour12: false }) }),
          el("span", { text: message.text }),
        ])
      )
    );
  }
}

// ---- 物品终端 ---------------------------------------------------------------

type StockEntry = { item: string; count: number; name: string };

function stockEntries(): StockEntry[] | null {
  const counts = app.snapshot?.stockCounts;
  if (!counts) return null;
  return Object.entries(counts).map(([item, count]) => ({
    item,
    count: asNumber(count),
    name: itemName(item),
  }));
}

function renderTerminal() {
  const entries = stockEntries();
  const grid = must<HTMLElement>("#terminalGrid");
  const meta = must<HTMLElement>("#terminalMeta");
  const network = app.snapshot?.network || {};

  if (!entries) {
    meta.textContent = "";
    grid.replaceChildren(
      emptyState("快照未包含全网库存", [
        "控制器当前只上报库存条目数,未上报每种物品的数量。",
        "开启方法:编辑 computer/0/apps/me_controller/bridge.db,把 includeStock 设为 true;桥接下次重连时自动生效。",
        `当前网络共 ${asNumber(network.stockEntries)} 种库存条目(仅计数)。`,
      ])
    );
    return;
  }

  const query = app.terminalQuery.trim().toLowerCase();
  let filtered = entries;
  if (query) {
    filtered = entries.filter((entry) => {
      const asset = itemAsset(entry.item);
      return (
        entry.item.toLowerCase().includes(query) ||
        entry.name.toLowerCase().includes(query) ||
        (asset?.englishName || "").toLowerCase().includes(query)
      );
    });
  }

  filtered.sort((a, b) =>
    app.terminalSort === "name" ? a.name.localeCompare(b.name, "zh-CN") : b.count - a.count || a.name.localeCompare(b.name, "zh-CN")
  );

  meta.textContent = query
    ? `${filtered.length} / ${entries.length} 种物品 · 更新于 ${formatTime(network.lastStockReadAt)}`
    : `${entries.length} 种物品 · 更新于 ${formatTime(network.lastStockReadAt)}`;

  if (filtered.length === 0) {
    grid.replaceChildren(emptyState("没有匹配的物品", ["换个关键词试试,支持中文名、英文名和物品 ID。"]));
    return;
  }

  grid.replaceChildren(
    ...filtered.map((entry) =>
      el(
        "div",
        {
          className: "slot",
          title: `${entry.name}\n${entry.item}\n数量:${formatExact(entry.count)}`,
        },
        [itemIcon(entry.item, "l"), el("span", { className: "slotCount mono", text: formatAmount(entry.count) })]
      )
    )
  );
}

// ---- 自动维持 ---------------------------------------------------------------

function targetActions(target: TargetSnapshot): HTMLElement {
  const pending = targetPending(target.id);
  const locked = Boolean(pending);
  const needed = firstNeededInput(target);

  const toggle = el("button", {
    className: "ghost",
    text: target.enabled ? "停用" : "启用",
    onClick: () => sendCommand({ kind: "set_enabled", targetId: target.id, enabled: !target.enabled }),
  });
  toggle.disabled = locked;

  const edit = el("button", { className: "ghost", text: "编辑", onClick: () => openTargetDialog(target) });
  edit.disabled = locked;

  const reset = el("button", {
    className: "ghost",
    text: "重置",
    title: "清空该目标的承诺跟踪状态",
    onClick: () => sendCommand({ kind: "reset_target_state", targetId: target.id }),
  });
  reset.disabled = locked;

  const request = el("button", {
    className: "ghost",
    text: "请求",
    title: needed ? `请求 ${itemName(needed.item)} ×${needed.count}` : "当前没有缺料",
    onClick: () => {
      if (!needed) return;
      sendCommand({ kind: "request", targetId: target.id, item: needed.item, count: needed.count });
    },
  });
  request.disabled = locked || !needed;

  const remove = el("button", {
    className: "ghost danger",
    text: "删除",
    onClick: () => {
      if (!confirm(`删除目标「${productLabel(target)}」?`)) return;
      sendCommand({ kind: "delete_target", targetId: target.id });
    },
  });
  remove.disabled = locked;

  return el("div", { className: "rowActions" }, [toggle, edit, reset, request, remove]);
}

function renderTargets() {
  const targets = app.snapshot?.targets || [];
  const body = must<HTMLElement>("#targetsBody");

  if (targets.length === 0) {
    const row = el("tr", {}, [el("td", { attrs: { colspan: "7" } }, [emptyState("暂无维持目标", ["点右上角「新增目标」,填一条产物配方即可开始。"])])]);
    body.replaceChildren(row);
    return;
  }

  body.replaceChildren(
    ...targets.map((target) => {
      const product = target.products && target.products[0];
      const productId = product?.item;
      const have = asNumber(target.productCount);
      const want = asNumber(target.targetCount);
      const pct = want > 0 ? Math.min(100, Math.round((have / want) * 100)) : 0;

      const bar = el("div", { className: "stockBar" }, [
        el("div", { className: `stockBarFill ${statusClass(effectiveTargetStatus(target))}`.trim() }),
      ]);
      (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;

      return el("tr", {}, [
        el("td", {}, [targetStatusPill(target)]),
        el("td", {}, [
          el("div", { className: "itemCell" }, [
            itemIcon(productId || target.id, "m"),
            el("div", { className: "targetName" }, [
              el("strong", { text: productLabel(target) }),
              el("span", { className: "mono", text: text(productId || target.id) }),
              el("span", { title: recipeLine(target.inputs), text: `配方:${recipeLine(target.inputs)}` }),
            ]),
          ]),
        ]),
        el("td", {}, [
          el("div", { className: "stockCell" }, [
            el("span", { className: "mono", text: `${formatExact(have)} / ${formatExact(want)}` }),
            bar,
          ]),
        ]),
        el("td", { className: "mono", text: String(asNumber(target.neededInputs)) }),
        el("td", { className: "mono", text: String(asNumber(target.promisedInputs)) }),
        el("td", { className: "mono", text: text(target.address) }),
        el("td", {}, [targetActions(target)]),
      ]);
    })
  );
}

// ---- 命令日志 ---------------------------------------------------------------

// 命令状态按"执行结果"呈现:sent = 还没等到控制器回包(执行中,15 秒无回包
// 视为无响应);acknowledged/synced = Lua 执行成功后才回包,即"成功";
// failed = 执行失败,附带控制器返回的错误文本。
function commandStatusPill(command: StoredCommand) {
  const status = text(command.status, "").toLowerCase();
  if (status === "sent") {
    const age = Date.now() - asNumber(command.createdAt);
    return age > 15_000 ? pill("无响应", "warn") : pendingPill("执行中");
  }
  if (status === "failed") return pill("失败", "bad");
  if (status === "acknowledged" || status === "synced" || status === "done") return pill("成功", "good");
  return pill(text(command.status), "");
}

function commandErrorText(command: StoredCommand): string | null {
  if (text(command.status, "").toLowerCase() !== "failed") return null;
  const response = command.response;
  if (typeof response === "string" && response.trim()) return response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const error = (response as { error?: unknown }).error;
    if (error !== undefined && error !== null && error !== "") return String(error);
  }
  return "控制器未返回错误详情";
}

function commandRow(command: StoredCommand, compact = false): HTMLElement {
  const request = (command.request && typeof command.request === "object" && !Array.isArray(command.request)
    ? command.request
    : {}) as { kind?: string; targetId?: string; item?: string; count?: number };
  const id = command.commandId || "";
  const kind = commandKindLabel(command.kind || request.kind);
  const detailParts: string[] = [];
  if (request.targetId) detailParts.push(`目标 ${request.targetId}`);
  if (request.item) detailParts.push(`${itemName(request.item)} ×${asNumber(request.count) || 1}`);
  const errorText = commandErrorText(command);

  const children: (Node | string | null)[] = [
    el("span", { className: "mono muted", text: formatTime(command.createdAt) }),
    el("div", { className: "commandMain" }, [
      el("strong", { text: kind }),
      detailParts.length > 0 ? el("span", { className: "muted", text: detailParts.join(" · ") }) : null,
      errorText ? el("span", { className: "commandError", title: errorText, text: errorText }) : null,
      compact ? null : el("span", { className: "mono muted commandId", text: id }),
    ]),
    commandStatusPill(command),
  ];
  return el("div", { className: "listItem", title: id }, children);
}

function renderCommands() {
  const commands = app.commands || [];
  must<HTMLElement>("#commandCount").textContent = String(commands.length);
  const host = must<HTMLElement>("#commandsList");
  if (commands.length === 0) {
    host.replaceChildren(emptyState("暂无命令", ["在「自动维持」页操作目标,命令会出现在这里并跟踪到完成。"]));
    return;
  }
  host.replaceChildren(...commands.map((command) => commandRow(command)));
}

// ---- 视图切换 + 主渲染 --------------------------------------------------------

const VIEWS: ViewId[] = ["overview", "terminal", "targets", "crafting", "patterns", "commands"];

function renderActiveView() {
  for (const view of VIEWS) {
    const section = document.querySelector<HTMLElement>(`#view-${view}`);
    if (section) section.hidden = view !== app.view;
    const link = document.querySelector<HTMLElement>(`#nav-${view}`);
    if (link) link.classList.toggle("active", view === app.view);
  }

  switch (app.view) {
    case "overview":
      renderOverview();
      break;
    case "terminal":
      renderTerminal();
      break;
    case "targets":
      renderTargets();
      break;
    case "commands":
      renderCommands();
      break;
    default:
      break; // crafting/patterns 是静态占位视图
  }
}

export function render() {
  renderSidebar();
  renderActiveView();
}

export function startRendering() {
  subscribe(render);
  render();
}
