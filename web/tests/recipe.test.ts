// 多原料/多产物(副产物)目标清洗的行为锁定。
// 语义对齐 Lua targets_store:products[1] 为主产物,legacy 标量同步到首条;
// 副产物 targetCount 由调用方显式给出(编辑器缺省 0),清洗层不得改写。
import { describe, expect, test } from "bun:test";
import { sanitizeTargetForController } from "../src/shared/target-fields";

type AnyTarget = Record<string, any>;

const MULTI_TARGET = {
  id: "create_brass_ingot",
  enabled: true,
  address: "mixer",
  priority: 90,
  products: [
    { item: "create:brass_ingot", count: 2, targetCount: 8192 },
    { item: "create:andesite_alloy", count: 1, targetCount: 0 },
  ],
  inputs: [
    { item: "minecraft:copper_ingot", count: 1 },
    { item: "create:zinc_ingot", count: 1 },
  ],
  inputPerProduct: 1,
  status: "WAITING",
  message: "runtime field",
  productCounts: { "create:brass_ingot": 4820 },
  neededInputItems: { "minecraft:copper_ingot": 10 },
};

describe("多原料/多产物目标清洗", () => {
  test("多条目原样通过,legacy 标量同步到首条", () => {
    const target = sanitizeTargetForController(MULTI_TARGET) as AnyTarget;

    expect(target.products).toHaveLength(2);
    expect(target.inputs).toHaveLength(2);
    expect(target.products[0].item).toBe("create:brass_ingot");
    expect(target.products[0].targetCount).toBe(8192);
    expect(target.productItem).toBe("create:brass_ingot");
    expect(target.inputItem).toBe("minecraft:copper_ingot");
  });

  test("副产物 targetCount=0 不被改写(0 = 不驱动生产)", () => {
    const target = sanitizeTargetForController(MULTI_TARGET) as AnyTarget;
    expect(target.products[1].item).toBe("create:andesite_alloy");
    expect(target.products[1].targetCount).toBe(0);
  });

  test("inputs 数组在场时剥掉 inputPerProduct(交 Lua 按配方重推)", () => {
    const target = sanitizeTargetForController(MULTI_TARGET) as AnyTarget;
    expect(target.inputPerProduct).toBeUndefined();
  });

  test("运行时字段全部剥除", () => {
    const target = sanitizeTargetForController(MULTI_TARGET) as AnyTarget;
    expect(target.status).toBeUndefined();
    expect(target.message).toBeUndefined();
    expect(target.productCounts).toBeUndefined();
    expect(target.neededInputItems).toBeUndefined();
  });

  test("自动生成的 label 被剥掉,手工 label 保留", () => {
    const target = sanitizeTargetForController({
      ...MULTI_TARGET,
      products: [
        { item: "create:brass_ingot", count: 2, targetCount: 8192, label: "我的黄铜" },
        { item: "create:andesite_alloy", count: 1, targetCount: 0, label: "Andesite Alloy" },
      ],
    }) as AnyTarget;

    expect(target.products[0].label).toBe("我的黄铜");
    // "Andesite Alloy" 是 defaultDisplayName 自动生成形态,应被剥除交显示层推导
    expect(target.products[1].label).toBeUndefined();
  });
});
