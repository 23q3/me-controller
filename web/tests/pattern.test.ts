// 样板(配方)清洗的行为锁定。
// 语义对齐 Lua recipes_store:样板 = 配方唯一权威(输入/输出/地址),条目不携带
// targetCount(那是目标侧库存策略);目标经 recipeId 引用样板。
import { describe, expect, test } from "bun:test";
import { sanitizeRecipeForController, sanitizeTargetForController } from "../src/shared/target-fields";
import { sanitizeCommandForController } from "../src/shared/commands";
import type { ControllerCommand } from "../src/shared/protocol";

type AnyRecord = Record<string, any>;

const RAW_RECIPE: AnyRecord = {
  id: "create_brass_ingot",
  name: "Brass Ingot",
  address: "mixer",
  products: [
    { item: "create:brass_ingot", count: 2, targetCount: 8192, label: "Brass Ingot" },
    { item: "create:andesite_alloy", count: 1, targetCount: 0 },
  ],
  inputs: [
    { item: "minecraft:copper_ingot", count: 1 },
    { item: "create:zinc_ingot", count: 1 },
  ],
  // 混进来的运行时/目标侧字段必须被白名单挡掉
  status: "WAITING",
  targetCount: 8192,
  priority: 90,
};

describe("样板清洗 sanitizeRecipeForController", () => {
  test("白名单字段保留,目标侧/运行时字段剥除", () => {
    const recipe = sanitizeRecipeForController(RAW_RECIPE) as AnyRecord;
    expect(recipe.id).toBe("create_brass_ingot");
    expect(recipe.address).toBe("mixer");
    expect(recipe.products).toHaveLength(2);
    expect(recipe.inputs).toHaveLength(2);
    expect(recipe.status).toBeUndefined();
    expect(recipe.targetCount).toBeUndefined();
    expect(recipe.priority).toBeUndefined();
  });

  test("条目上的 targetCount 一并剥除(目标侧策略不入样板)", () => {
    const recipe = sanitizeRecipeForController(RAW_RECIPE) as AnyRecord;
    for (const entry of [...recipe.products, ...recipe.inputs]) {
      expect(entry.targetCount).toBeUndefined();
    }
  });

  test("自动生成形态的 name/label 剥除,手工名保留并写回主产物", () => {
    const generated = sanitizeRecipeForController(RAW_RECIPE) as AnyRecord;
    // "Brass Ingot" 是 defaultDisplayName 自动生成形态
    expect(generated.name).toBeUndefined();
    expect(generated.products[0].label).toBeUndefined();

    const manual = sanitizeRecipeForController({ ...RAW_RECIPE, name: "我的黄铜" }) as AnyRecord;
    expect(manual.name).toBe("我的黄铜");
    expect(manual.products[0].label).toBe("我的黄铜");
  });
});

describe("样板命令清洗 sanitizeCommandForController", () => {
  test("upsert_recipe 走样板清洗", () => {
    const command = sanitizeCommandForController({
      kind: "upsert_recipe",
      recipeId: "create_brass_ingot",
      recipe: RAW_RECIPE,
    } as unknown as ControllerCommand);
    const recipe = command.recipe as AnyRecord;
    expect(recipe.priority).toBeUndefined();
    expect(recipe.products[0].targetCount).toBeUndefined();
  });

  test("request_recipe/delete_recipe 原样返回", () => {
    const order: ControllerCommand = { kind: "request_recipe", recipeId: "x", batches: 3 };
    expect(sanitizeCommandForController(order)).toBe(order);
  });
});

describe("目标清洗携带样板引用", () => {
  test("recipeId 原样通过目标清洗", () => {
    const target = sanitizeTargetForController({
      id: "create_brass_ingot",
      recipeId: "create_brass_ingot",
      enabled: true,
      address: "mixer",
      products: [{ item: "create:brass_ingot", count: 2, targetCount: 8192 }],
      inputs: [{ item: "minecraft:copper_ingot", count: 1 }],
    }) as AnyRecord;
    expect(target.recipeId).toBe("create_brass_ingot");
    // 目标条目的 targetCount 是库存策略,必须保留
    expect(target.products[0].targetCount).toBe(8192);
  });
});
