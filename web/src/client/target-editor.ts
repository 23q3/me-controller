// 目标编辑器:<dialog> 表单,数值配置字段完全由 TARGET_NUMBER_FIELDS 描述符
// 驱动生成(替代原 app.js 手写 20 个字段的 open/read)。
// 配方文本格式与 Lua items.lua 的 parseRecipeEntries 语义对齐:
//   产物  item=每批产出@目标库存   输入  item=每批消耗
import type { ControllerCommand, RecipeEntry, TargetSnapshot } from "../shared/protocol";
import { defaultDisplayName } from "../shared/summary";
import { TARGET_CONFIG_KEYS, TARGET_DEFAULTS, TARGET_NUMBER_FIELDS } from "../shared/target-fields";
import { app } from "./state";
import { el, must, text, toast } from "./dom";
import { itemName } from "./render";
import { sendCommand } from "./ws";

type EditorRefs = {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  title: HTMLElement;
  editingId: HTMLInputElement;
  enabled: HTMLInputElement;
  address: HTMLInputElement;
  products: HTMLInputElement;
  name: HTMLInputElement;
  inputs: HTMLInputElement;
  id: HTMLInputElement;
  numbers: Map<string, HTMLInputElement>;
  deleteBtn: HTMLButtonElement;
};

let refs: EditorRefs | null = null;

// ---- 配方文本 <-> RecipeEntry[](逐字移植自 app.js,语义与 Lua 对齐) ----------

export function parseRecipeEntries(value: string, isProduct: boolean): RecipeEntry[] {
  const entries: RecipeEntry[] = [];
  for (const rawToken of text(value, "").split(",")) {
    let token = rawToken.trim();
    if (!token) continue;

    let targetCount: number | undefined;
    if (isProduct && token.includes("@")) {
      const parts = token.split("@");
      token = (parts[0] ?? "").trim();
      targetCount = Number(parts[1]);
      if (!Number.isFinite(targetCount) || targetCount < 0) throw new Error(`目标库存无效:${rawToken}`);
    }

    let item = token;
    let count = 1;
    if (token.includes("=")) {
      const parts = token.split("=");
      item = (parts[0] ?? "").trim();
      count = Number(parts[1]);
    }

    if (!item) throw new Error(`缺少物品 ID:${rawToken}`);
    if (!Number.isFinite(count) || count <= 0) throw new Error(`配方数量无效:${rawToken}`);

    const entry: RecipeEntry = { item, count };
    if (isProduct && targetCount !== undefined) entry.targetCount = targetCount;
    entries.push(entry);
  }

  if (entries.length === 0) throw new Error(isProduct ? "至少需要一个产物" : "至少需要一个输入");
  return entries;
}

function entriesToText(entries: RecipeEntry[] | undefined, isProduct: boolean): string {
  return (entries || [])
    .map((entry) => {
      let value = `${entry.item}=${entry.count || 1}`;
      if (isProduct) value += `@${entry.targetCount ?? 0}`;
      return value;
    })
    .join(", ");
}

function manualLabel(label: unknown, item: string): string | null {
  const value = text(label, "").trim();
  if (!value || value === item || value === defaultDisplayName(item) || value === itemName(item)) return null;
  return value;
}

function preserveEntryLabels(entries: RecipeEntry[], previousEntries: RecipeEntry[] | undefined): RecipeEntry[] {
  return entries.map((entry) => {
    const previous = (previousEntries || []).find((item) => item.item === entry.item);
    const label = manualLabel(previous?.label, entry.item);
    return label ? { ...entry, label } : entry;
  });
}

function targetIdFromItem(itemId: string): string {
  const value = text(itemId, "").toLowerCase();
  const id = value.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  return id || "target";
}

function firstProductItemFromText(value: string): string {
  try {
    const products = parseRecipeEntries(value, true);
    return products[0]?.item ?? "";
  } catch {
    return "";
  }
}

function primaryManualLabel(target: TargetSnapshot): string {
  const product = target.products && target.products[0];
  const item = product?.item;
  if (!item) return "";
  return manualLabel(product?.label, item) || manualLabel((target as { productLabel?: string }).productLabel, item) || "";
}

// ---- 表单生成(一次性,描述符驱动) -------------------------------------------

function numberInput(key: string, label: string, min: number): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = el("input", { attrs: { type: "number", min: String(min), step: "1", name: key } });
  const wrap = el("label", { className: "field" }, [el("span", { text: label }), input]);
  return { wrap, input };
}

function buildForm(): EditorRefs {
  const dialog = must<HTMLDialogElement>("#targetDialog");
  const form = must<HTMLFormElement>("#targetForm");
  const fieldsHost = must<HTMLElement>("#targetFields");
  const numbers = new Map<string, HTMLInputElement>();

  const editingId = el("input", { attrs: { type: "hidden" } });

  const enabled = el("input", { attrs: { type: "checkbox" } });
  enabled.checked = true;
  const enabledLine = el("label", { className: "checkboxLine" }, [enabled, el("span", { text: "启用该目标" })]);

  const address = el("input", { attrs: { required: "", placeholder: TARGET_DEFAULTS.address, name: "address" } });
  const addressField = el("label", { className: "field" }, [el("span", { text: "工序地址" }), address]);

  const basicNumbers: HTMLElement[] = [];
  const advancedNumbers: HTMLElement[] = [];
  for (const field of TARGET_NUMBER_FIELDS) {
    const { wrap, input } = numberInput(field.key, field.label, field.min);
    numbers.set(field.key, input);
    (field.group === "basic" ? basicNumbers : advancedNumbers).push(wrap);
  }

  const products = el("input", {
    attrs: { required: "", placeholder: "create:iron_sheet=1@2048", name: "products" },
  });
  const name = el("input", { attrs: { placeholder: "自动生成", name: "displayName" } });
  const inputs = el("input", {
    attrs: { required: "", placeholder: "minecraft:iron_ingot=1", name: "inputs" },
  });
  const id = el("input", { attrs: { placeholder: "自动生成", name: "id" } });

  const advanced = el("details", { className: "advancedFields" }, [
    el("summary", { text: "高级设置" }),
    el("label", { className: "field" }, [el("span", { text: "内部 ID" }), id]),
    el("div", { className: "fieldGrid" }, advancedNumbers),
  ]);

  fieldsHost.replaceChildren(
    editingId,
    enabledLine,
    el("div", { className: "fieldGrid two" }, [addressField, ...basicNumbers]),
    el("label", { className: "field" }, [el("span", { text: "产物(物品ID=每批产出@目标库存,逗号分隔)" }), products]),
    el("label", { className: "field" }, [el("span", { text: "显示名称(可选)" }), name]),
    el("label", { className: "field" }, [el("span", { text: "输入(物品ID=每批消耗,逗号分隔)" }), inputs]),
    advanced
  );

  products.addEventListener("input", () => {
    const item = firstProductItemFromText(products.value);
    name.placeholder = item ? defaultDisplayName(item) : "自动生成";
    id.placeholder = item ? targetIdFromItem(item) : "自动生成";
  });

  return {
    dialog,
    form,
    title: must<HTMLElement>("#targetDialogTitle"),
    editingId,
    enabled,
    address,
    products,
    name,
    inputs,
    id,
    numbers,
    deleteBtn: must<HTMLButtonElement>("#deleteTargetBtn"),
  };
}

// ---- 读写表单 ----------------------------------------------------------------

function fieldDefault(key: string): number {
  return (TARGET_DEFAULTS as Record<string, number | string | boolean>)[key] as number;
}

function numberFieldValue(input: HTMLInputElement, fallback: number, minimum: number): number {
  const value = Number(input.value);
  const result = Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, result);
}

function findTarget(targetId: string): TargetSnapshot | null {
  const targets = app.snapshot?.targets || [];
  return targets.find((target) => target.id === targetId) || null;
}

function editableTargetBase(target: TargetSnapshot | null): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (!target) return base;
  const source = target as unknown as Record<string, unknown>;
  for (const key of TARGET_CONFIG_KEYS) {
    if (source[key] !== undefined) base[key] = source[key];
  }
  return base;
}

export function openTargetDialog(target: TargetSnapshot | null) {
  if (!refs) refs = buildForm();
  const isEdit = Boolean(target);
  const source = (target || {}) as unknown as Record<string, unknown>;

  refs.title.textContent = isEdit ? "编辑目标" : "新增目标";
  refs.editingId.value = target ? target.id : "";
  refs.id.value = target ? target.id : "";
  refs.name.value = target ? primaryManualLabel(target) : "";
  refs.enabled.checked = target ? target.enabled !== false : TARGET_DEFAULTS.enabled;
  refs.address.value = target ? text(target.address, TARGET_DEFAULTS.address) : TARGET_DEFAULTS.address;
  refs.products.value = target ? entriesToText(target.products, true) : "";
  refs.inputs.value = target ? entriesToText(target.inputs, false) : "";

  for (const field of TARGET_NUMBER_FIELDS) {
    const input = refs.numbers.get(field.key);
    if (!input) continue;
    const value = source[field.key];
    input.value = String(value !== undefined && value !== null ? value : fieldDefault(field.key));
  }

  refs.products.dispatchEvent(new Event("input"));
  refs.deleteBtn.hidden = !isEdit;

  if (refs.dialog.showModal) refs.dialog.showModal();
  else refs.dialog.setAttribute("open", "open");
}

export function closeTargetDialog() {
  if (!refs) return;
  if (refs.dialog.close) refs.dialog.close();
  else refs.dialog.removeAttribute("open");
}

function targetFromForm(): Record<string, unknown> {
  if (!refs) throw new Error("编辑器尚未初始化");
  const base = editableTargetBase(findTarget(refs.editingId.value));
  const products = preserveEntryLabels(parseRecipeEntries(refs.products.value, true), base.products as RecipeEntry[] | undefined);
  const inputs = preserveEntryLabels(parseRecipeEntries(refs.inputs.value, false), base.inputs as RecipeEntry[] | undefined);
  const firstProduct = products[0]!;
  const firstInput = inputs[0]!;

  const productName = manualLabel(refs.name.value, firstProduct.item);
  if (productName) firstProduct.label = productName;
  else delete firstProduct.label;
  const productLabelValue = productName || firstProduct.item;
  const inputLabel = firstInput.label || manualLabel(base.inputLabel, firstInput.item) || firstInput.item;

  const result: Record<string, unknown> = {
    ...base,
    id: refs.id.value.trim() || targetIdFromItem(firstProduct.item),
    enabled: refs.enabled.checked,
    address: refs.address.value.trim() || TARGET_DEFAULTS.address,
    products,
    inputs,
    productItem: firstProduct.item,
    productLabel: productLabelValue,
    targetCount: firstProduct.targetCount ?? TARGET_DEFAULTS.targetCount,
    inputItem: firstInput.item,
    inputLabel,
  };

  for (const field of TARGET_NUMBER_FIELDS) {
    const input = refs.numbers.get(field.key);
    if (!input) continue;
    result[field.key] = numberFieldValue(input, fieldDefault(field.key), field.min);
  }

  return result;
}

export function wireTargetEditor() {
  if (!refs) refs = buildForm();
  const { form, dialog, deleteBtn } = refs;

  must<HTMLButtonElement>("#closeTargetDialogBtn").addEventListener("click", closeTargetDialog);
  must<HTMLButtonElement>("#cancelTargetBtn").addEventListener("click", closeTargetDialog);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const target = targetFromForm();
      const previousId = refs!.editingId.value || (target.id as string);
      sendCommand({ kind: "upsert_target", targetId: previousId, target } as unknown as ControllerCommand);
      toast("目标已保存,等待控制器确认", "good");
      closeTargetDialog();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "bad");
    }
  });

  deleteBtn.addEventListener("click", () => {
    const targetId = refs!.editingId.value;
    const target = findTarget(targetId);
    if (!targetId || !target) return;
    const product = target.products && target.products[0];
    if (!confirm(`删除目标「${product ? itemName(product.item) : targetId}」?`)) return;
    sendCommand({ kind: "delete_target", targetId });
    closeTargetDialog();
  });

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeTargetDialog();
  });
}
