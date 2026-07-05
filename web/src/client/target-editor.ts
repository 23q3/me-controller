// 目标编辑器:<dialog> 表单。目标 = 样板引用 + 库存策略——配方内容(产物/
// 原料/工序地址)完全由样板控制,这里只选样板、填每个产物的目标库存与
// 调度参数;数值配置字段由 TARGET_NUMBER_FIELDS 描述符驱动生成。
// 语义与 Lua 对齐:products[1] 为主产物(目标库存缺省 2048),其余为副产物
// (缺省 0,不驱动生产);保存 payload 仍携带解析后的 products/inputs/address,
// Lua upsertTarget 会以样板为准再覆写一遍。
import type { ControllerCommand, RecipeEntry, RecipeSnapshot, TargetSnapshot } from "../shared/protocol";
import { TARGET_CONFIG_KEYS, TARGET_DEFAULTS, TARGET_NUMBER_FIELDS } from "../shared/target-fields";
import { app } from "./state";
import { el, must, text, toast } from "./dom";
import { itemIcon, itemName } from "./render";
import { sendCommand } from "./ws";

type StockRow = {
  item: string;
  input: HTMLInputElement;
};

type EditorRefs = {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  title: HTMLElement;
  editingId: HTMLInputElement;
  enabled: HTMLInputElement;
  recipeSelect: HTMLSelectElement;
  recipeMeta: HTMLElement;
  stocksHost: HTMLElement;
  noRecipesHint: HTMLElement;
  editorBody: HTMLElement;
  id: HTMLInputElement;
  numbers: Map<string, HTMLInputElement>;
  saveBtn: HTMLButtonElement;
  deleteBtn: HTMLButtonElement;
};

let refs: EditorRefs | null = null;
let stockRows: StockRow[] = [];

function recipes(): RecipeSnapshot[] {
  return app.snapshot?.recipes || [];
}

function findRecipe(recipeId: string): RecipeSnapshot | null {
  return recipes().find((recipe) => recipe.id === recipeId) || null;
}

function recipeDisplayName(recipe: RecipeSnapshot): string {
  const product = recipe.products && recipe.products[0];
  return text(recipe.name, "") || (product ? itemName(product.item) : recipe.id);
}

function entriesLine(entries: RecipeEntry[] | undefined): string {
  if (!entries || entries.length === 0) return "-";
  return entries.map((entry) => `${itemName(entry.item)} ×${entry.count || 1}`).join("、");
}

// ---- 样板选择与联动 -----------------------------------------------------------

// 目标既有的每产物目标库存(按物品),换样板时同物品的设置得以保留
function existingTargetCounts(target: TargetSnapshot | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of target?.products || []) {
    if (entry.targetCount !== undefined) counts[entry.item] = entry.targetCount;
  }
  return counts;
}

// 选中样板后重建:配方摘要 + 每产物目标库存行
function renderRecipeDetails(target: TargetSnapshot | null) {
  if (!refs) return;
  const recipe = findRecipe(refs.recipeSelect.value);
  stockRows = [];

  if (!recipe) {
    refs.recipeMeta.textContent = "";
    refs.stocksHost.replaceChildren();
    return;
  }

  refs.recipeMeta.replaceChildren(
    el("span", { text: `原料:${entriesLine(recipe.inputs)}` }),
    el("span", { text: `产出:${entriesLine(recipe.products)}` }),
    el("span", { className: "mono", text: `地址:${text(recipe.address, TARGET_DEFAULTS.address)}` })
  );

  const previous = existingTargetCounts(target);
  refs.stocksHost.replaceChildren(
    ...(recipe.products || []).map((entry, index) => {
      const primary = index === 0;
      const fallback = primary ? TARGET_DEFAULTS.targetCount : 0;
      const input = el("input", {
        className: "stockTargetInput",
        attrs: { type: "number", step: "1", min: "0", placeholder: primary ? String(fallback) : "0(副产物)" },
      });
      const known = previous[entry.item];
      if (known !== undefined) input.value = String(known);
      else if (primary) input.value = String(fallback);
      input.title = primary
        ? "网络中要维持的库存量"
        : "0 = 副产物,不驱动生产;设为正数则按共产物维持";
      stockRows.push({ item: entry.item, input });

      const badge = el("span", { className: `recipeBadge${primary ? " primary" : ""}`, text: primary ? "主产物" : "副产物" });
      return el("div", { className: "stockTargetRow" }, [
        itemIcon(entry.item, "s"),
        el("div", { className: "stockTargetName" }, [
          el("span", { text: itemName(entry.item) }),
          el("span", { className: "mono muted", text: entry.item }),
        ]),
        badge,
        input,
      ]);
    })
  );
}

function fillRecipeOptions(selectedId: string | undefined) {
  if (!refs) return;
  const list = recipes();
  refs.recipeSelect.replaceChildren(
    ...list.map((recipe) => {
      const option = el("option", {
        text: `${recipeDisplayName(recipe)} @${text(recipe.address, "-")}`,
      }) as HTMLOptionElement;
      option.value = recipe.id;
      return option;
    })
  );
  if (selectedId && list.some((recipe) => recipe.id === selectedId)) {
    refs.recipeSelect.value = selectedId;
  }
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

  const recipeSelect = el("select", { attrs: { name: "recipeId" } }) as HTMLSelectElement;
  const recipeField = el("label", { className: "field" }, [el("span", { text: "样板(配方)" }), recipeSelect]);
  const recipeMeta = el("div", { className: "recipePreview mono" });

  const stocksHost = el("div", { className: "stockTargetRows" });
  const stocksSection = el("div", { className: "recipeSection" }, [
    el("div", { className: "stockTargetHead" }, [
      el("span", { className: "recipeSectionTitle", text: "目标库存", title: "每个产物在网络中要维持的数量;副产物 0 = 只入账不驱动" }),
      el("span", { className: "recipeColLabel", text: "维持数量" }),
    ]),
    stocksHost,
  ]);

  const noRecipesHint = el("div", { className: "emptyState" }, [
    el("p", { className: "emptyTitle", text: "还没有样板" }),
    el("p", { className: "emptyHint", text: "目标只引用样板;先到「样板管理」创建配方(输入、产出、工序地址)。" }),
    el("button", {
      className: "primary",
      text: "去样板管理",
      attrs: { type: "button" },
      onClick: () => {
        closeTargetDialog();
        location.hash = "#/patterns";
      },
    }),
  ]);
  noRecipesHint.hidden = true;

  const basicNumbers: HTMLElement[] = [];
  const advancedNumbers: HTMLElement[] = [];
  for (const field of TARGET_NUMBER_FIELDS) {
    const { wrap, input } = numberInput(field.key, field.label, field.min);
    numbers.set(field.key, input);
    (field.group === "basic" ? basicNumbers : advancedNumbers).push(wrap);
  }

  const id = el("input", { attrs: { placeholder: "自动生成", name: "id" } });

  const advanced = el("details", { className: "advancedFields" }, [
    el("summary", { text: "高级设置" }),
    el("label", { className: "field" }, [el("span", { text: "内部 ID" }), id]),
    el("div", { className: "fieldGrid" }, advancedNumbers),
  ]);

  const editorBody = el("div", { className: "targetEditorBody" }, [
    enabledLine,
    el("div", { className: "fieldGrid two" }, [recipeField, ...basicNumbers]),
    recipeMeta,
    stocksSection,
    advanced,
  ]);

  fieldsHost.replaceChildren(editingId, noRecipesHint, editorBody);

  return {
    dialog,
    form,
    title: must<HTMLElement>("#targetDialogTitle"),
    editingId,
    enabled,
    recipeSelect,
    recipeMeta,
    stocksHost,
    noRecipesHint,
    editorBody,
    id,
    numbers,
    saveBtn: must<HTMLButtonElement>("#saveTargetBtn"),
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
  const hasRecipes = recipes().length > 0;

  refs.title.textContent = isEdit ? "编辑目标" : "新增目标";
  refs.editingId.value = target ? target.id : "";
  refs.id.value = target ? target.id : "";
  refs.enabled.checked = target ? target.enabled !== false : TARGET_DEFAULTS.enabled;

  // 没有样板时整个编辑器让位给引导(所有合成操作均使用配方)
  refs.noRecipesHint.hidden = hasRecipes;
  refs.editorBody.hidden = !hasRecipes;
  refs.saveBtn.disabled = !hasRecipes;

  if (hasRecipes) {
    fillRecipeOptions(target?.recipeId || recipes()[0]?.id);
    renderRecipeDetails(target);
    refs.recipeSelect.onchange = () => renderRecipeDetails(target);
  }

  for (const field of TARGET_NUMBER_FIELDS) {
    const input = refs.numbers.get(field.key);
    if (!input) continue;
    const value = source[field.key];
    input.value = String(value !== undefined && value !== null ? value : fieldDefault(field.key));
  }

  refs.deleteBtn.hidden = !isEdit;

  if (refs.dialog.showModal) refs.dialog.showModal();
  else refs.dialog.setAttribute("open", "open");
}

export function closeTargetDialog() {
  if (!refs) return;
  if (refs.dialog.close) refs.dialog.close();
  else refs.dialog.removeAttribute("open");
}

function targetIdFromRecipe(recipe: RecipeSnapshot): string {
  const value = text(recipe.products?.[0]?.item || recipe.id, "").toLowerCase();
  const id = value.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  return id || "target";
}

function targetFromForm(): Record<string, unknown> {
  if (!refs) throw new Error("编辑器尚未初始化");
  const recipe = findRecipe(refs.recipeSelect.value);
  if (!recipe) throw new Error("请选择样板");

  const base = editableTargetBase(findTarget(refs.editingId.value));

  // 配方内容取自样板;每产物目标库存取自本表单(留空按位置化默认:主产
  // 2048/副产 0)。Lua upsertTarget 会以样板为准再覆写一遍,这里的副本只为
  // 老控制器兼容与命令日志可读。
  const stockByItem = new Map(stockRows.map((row) => [row.item, row.input] as const));
  const products = (recipe.products || []).map((entry, index) => {
    const primary = index === 0;
    const input = stockByItem.get(entry.item);
    const raw = input ? input.value.trim() : "";
    const fallback = primary ? TARGET_DEFAULTS.targetCount : 0;
    const targetCount = raw === "" ? fallback : Number(raw);
    if (!Number.isFinite(targetCount) || targetCount < 0) {
      throw new Error(`产物「${itemName(entry.item)}」的目标库存无效`);
    }
    const result: RecipeEntry = { item: entry.item, count: entry.count ?? 1, targetCount: Math.floor(targetCount) };
    if (entry.label) result.label = entry.label;
    return result;
  });
  const inputs = (recipe.inputs || []).map((entry) => {
    const result: RecipeEntry = { item: entry.item, count: entry.count ?? 1 };
    if (entry.label) result.label = entry.label;
    return result;
  });
  if (products.length === 0) throw new Error("样板没有产物,先到样板管理补全");

  const result: Record<string, unknown> = {
    ...base,
    id: refs.id.value.trim() || targetIdFromRecipe(recipe),
    enabled: refs.enabled.checked,
    recipeId: recipe.id,
    address: text(recipe.address, TARGET_DEFAULTS.address),
    products,
    inputs,
    targetCount: products[0]!.targetCount,
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
