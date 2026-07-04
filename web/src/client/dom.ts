// DOM 元素助手与格式化 —— 全部输出经 textContent/属性赋值，天然无注入面
//（替代原 app.js 的 innerHTML 拼接 + escapeHtml）。

type ElProps = {
  className?: string;
  text?: string;
  title?: string;
  html?: undefined; // 防误用：本项目禁止 innerHTML
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
  onClick?: (event: MouseEvent) => void;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: (Node | string | null | undefined)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title !== undefined) node.title = props.title;
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) node.setAttribute(key, value);
  }
  if (props.dataset) {
    for (const [key, value] of Object.entries(props.dataset)) node.dataset[key] = value;
  }
  if (props.onClick) node.addEventListener("click", props.onClick as EventListener);
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

export function must<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`缺少页面元素：${selector}`);
  return node;
}

export function text(value: unknown, fallback = "-"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

export function asNumber(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatTime(value: number | undefined | null): string {
  if (!value) return "-";
  const ms = value > 10_000_000_000 ? value : value * 1000;
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

// AE2 终端式数量缩写：槽位角标空间有限，≥1 万起缩写；title 里始终给精确值
export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.floor(value));
}

export function formatExact(value: number): string {
  return Math.floor(asNumber(value)).toLocaleString("zh-CN");
}

// 轻量提示条：命令反馈即时可见，不打断操作；同时由调用方写入总览的消息日志
let toastHost: HTMLElement | null = null;

export function toast(message: string, tone: "info" | "good" | "bad" = "info") {
  if (!toastHost) toastHost = must<HTMLElement>("#toasts");
  const node = el("div", { className: `toast ${tone}`, text: message });
  toastHost.append(node);
  while (toastHost.children.length > 5) toastHost.firstElementChild?.remove();
  setTimeout(() => {
    node.classList.add("fading");
    setTimeout(() => node.remove(), 400);
  }, 4000);
}
