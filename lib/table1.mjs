/**
 * 表1 读取与索引
 *
 * 表1 结构（v2）：
 *   productTypes[]        L1 整机（目前只有 h3 手持云台）
 *     └ modules[]         L2 模块（h3-cam …）
 *         └ parts[]       L3 零件（h3-cam-01 …）
 *   bomLevels[]           层级定义（L1–L3，L4 已停用）
 *   constraintDimensions[] 约束维度
 *
 * 选择规则由 preset-functions.mjs 与前端 app.js 共同实现：
 *   - L1 永远包含且不覆盖下级；
 *   - 同一模块内 L2 与 L3 二选一；
 *   - 每个 L3 必须被覆盖（选中其 L2，或直接选中该 L3）。
 */

import { readFileSync } from "node:fs";

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

export const table1 = readJson("../presets/table1.json");
export const questionsDoc = readJson("../presets/questions.json");

export const questions = questionsDoc.questions;
export const questionsById = new Map(questions.map((question) => [question.id, question]));
export const productTypesById = new Map(table1.productTypes.map((type) => [type.id, type]));
export const bomLevelsById = new Map(table1.bomLevels.map((level) => [level.id, level]));
export const constraintDimensionsById = new Map(
  table1.constraintDimensions.map((dimension) => [dimension.id, dimension]),
);

/** 每层允许的层级 id（L4 停用后自动只剩 L1–L3） */
export const LEVELS = table1.bomLevels.map((level) => level.id);

function buildModuleIndex() {
  const modules = [];
  const parts = [];
  for (const type of table1.productTypes) {
    for (const module of type.modules ?? []) {
      modules.push({
        ...module,
        typeId: type.id,
        typeName: type.name,
        level: "L2",
        parentCode: type.id,
        partCount: (module.parts ?? []).length,
      });
      for (const part of module.parts ?? []) {
        parts.push({
          ...part,
          level: "L3",
          unit: part.unit || "pcs",
          material: part.material || "",
          spec: part.spec || "",
          note: part.note || "",
          typeId: type.id,
          moduleCode: module.code,
          moduleName: module.name,
          parentCode: module.code,
        });
      }
    }
  }
  return { modules, parts };
}

const index = buildModuleIndex();

/** 所有 L2 模块（含所属类型与零件数） */
export const moduleList = index.modules;
/** 所有 L3 零件（含所属模块信息，parentCode = 模块 code） */
export const partList = index.parts;

export const modulesByCode = new Map(moduleList.map((module) => [module.code, module]));
export const partsByCode = new Map(partList.map((part) => [part.code, part]));

export function getQuestion(questionId) {
  return questionsById.get(questionId) ?? null;
}

export function getProductType(typeId) {
  return productTypesById.get(typeId) ?? null;
}

export function getBomLevel(levelId) {
  return bomLevelsById.get(levelId) ?? null;
}

export function getConstraintDimension(dimensionId) {
  return constraintDimensionsById.get(dimensionId) ?? null;
}

export function getModule(moduleCode) {
  return modulesByCode.get(moduleCode) ?? null;
}

export function getPart(partCode) {
  return partsByCode.get(partCode) ?? null;
}

/** 某个模块下的全部 L3 零件 code */
export function partsOfModule(moduleCode) {
  return partList.filter((part) => part.moduleCode === moduleCode).map((part) => part.code);
}

/** 商品的 L1 根条目（h3 整机） */
export function rootItemOf(typeId) {
  const type = productTypesById.get(typeId) ?? table1.productTypes[0];
  return {
    code: type.id,
    name: type.name,
    level: "L1",
    levelName: bomLevelsById.get("L1")?.name || "L1",
    qty: 1,
    unit: "pcs",
    material: "",
    spec: "",
    parentCode: "",
    note: "",
    description: type.description || "",
  };
}

export const table1Meta = {
  id: table1.id,
  name: table1.name,
  version: table1.version,
  updatedAt: table1.updatedAt,
  productTypeCount: table1.productTypes.length,
  bomLevelCount: table1.bomLevels.length,
  moduleCount: moduleList.length,
  partCount: partList.length,
};

export function publicQuestions() {
  return questions.map((question) => ({
    id: question.id,
    index: question.index,
    functionName: question.functionName,
    eyebrow: question.eyebrow,
    title: question.title,
    prompt: question.prompt,
    placeholder: question.placeholder,
    helper: question.helper,
    examples: question.examples,
  }));
}

/**
 * 注入 prompt 的精简版：只保留 AI 选 code 需要的字段。
 * 不加 $comment / benchmarkDimensions，避免浪费 token。
 */
export function compactTableForPrompt() {
  return {
    id: table1.id,
    name: table1.name,
    version: table1.version,
    productTypes: table1.productTypes.map((type) => ({
      id: type.id,
      code: type.code,
      name: type.name,
      category: type.category,
      description: type.description,
      keywords: type.keywords,
      defaultBomLevel: type.defaultBomLevel,
      modules: (type.modules ?? []).map((module) => ({
        code: module.code,
        name: module.name,
        description: module.description,
        keywords: module.keywords,
        parts: (module.parts ?? []).map((part) => ({
          code: part.code,
          name: part.name,
          qty: part.qty,
          description: part.description,
          keywords: part.keywords,
        })),
      })),
    })),
    bomLevels: table1.bomLevels.map((level) => ({
      id: level.id,
      name: level.name,
      description: level.description,
      scope: level.scope,
      inclusions: level.inclusions,
      exclusions: level.exclusions,
      bestFor: level.bestFor,
    })),
    constraintDimensions: table1.constraintDimensions.map((dimension) => ({
      id: dimension.id,
      name: dimension.name,
      unit: dimension.unit,
      examples: dimension.examples,
    })),
  };
}
