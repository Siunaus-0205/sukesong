/**
 * 预设函数契约（Preset Function Contract）
 *
 * 本文件是 AI 与系统之间唯一的接口面：
 *   - AI 只能通过 function calling 调用这里声明的三个函数；
 *   - 函数参数必须是严格 JSON Schema；
 *   - 服务端必须逐字段校验、归一化后才允许进入前端确认流程。
 *
 * 三个函数对应三个问题：
 *   Q1 submit_product_type      -> 商品类型候选（单选，来自表1 productTypes）
 *   Q2 submit_hard_constraints  -> 硬性约束集合（多选，默认不选）
 *   Q3 submit_parts             -> 从表1 预设模块/零件中选择（L1 固定、L2/L3 二选一、L3 全覆盖）
 */

import {
  LEVELS,
  bomLevelsById,
  constraintDimensionsById,
  getBomLevel,
  getConstraintDimension,
  getProductType,
  moduleList,
  modulesByCode,
  partList,
  partsByCode,
  partsOfModule,
  productTypesById,
  rootItemOf,
  table1Meta,
} from "./table1.mjs";

export class PresetContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PresetContractError";
    this.code = code;
    this.details = details;
  }
}

export const FUNCTION_NAMES = {
  product_type: "submit_product_type",
  hard_constraints: "submit_hard_constraints",
  parts: "submit_parts",
};

export const QUESTION_IDS = Object.keys(FUNCTION_NAMES);

const LIMITS = {
  product_type: 3,
  hard_constraints: 16,
  parts: 80,
};

const OPERATORS = ["<=", ">=", "=", "range", "in", "custom"];
const PRIORITIES = ["must", "should"];

const FUNCTION_DEFINITIONS = {
  product_type: {
    description:
      "把用户对商品的自然语言描述归入表1的预设商品类型。返回 1 个主类型（排在第一位）和最多 2 个备选类型。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "candidates", "missing", "confidence"],
      properties: {
        summary: { type: "string", description: "一句话说明归类依据，30–80 字。" },
        candidates: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["presetId", "fit", "confidence"],
            properties: {
              presetId: {
                type: "string",
                description: "表1 productTypes 中的 id，必须存在，不能自造。",
              },
              fit: { type: "string", description: "该类型与用户描述匹配的理由，20–120 字。" },
              confidence: { type: "number", description: "0–1 的匹配置信度。" },
            },
          },
        },
        missing: {
          type: "array",
          maxItems: 8,
          items: { type: "string" },
          description: "无法从用户输入确定、需要人工补充的信息；没有则返回空数组。",
        },
        confidence: { type: "number", description: "本次归类整体置信度，0–1。" },
      },
    },
  },
  hard_constraints: {
    description:
      "把用户描述中所有硬性/软性约束拆成可独立确认的条目，返回完整约束集合。不得编造用户没说的数值。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "constraints", "missing", "confidence"],
      properties: {
        summary: { type: "string", description: "一句话概括本组约束，30–80 字。" },
        constraints: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "dimension",
              "name",
              "operator",
              "value",
              "unit",
              "priority",
              "sourceText",
              "verification",
            ],
            properties: {
              dimension: {
                type: "string",
                description: "表1 constraintDimensions 的 id；无法归类用 custom。",
              },
              name: { type: "string", description: "约束的可读名称，例如“整机重量”。" },
              operator: {
                type: "string",
                enum: OPERATORS,
                description: "比较方式：<= >= = range in custom。",
              },
              value: { type: "string", description: "约束值，例如“800”“0-40”“CE, FCC”。" },
              unit: { type: "string", description: "单位；无单位时为空字符串。" },
              priority: { type: "string", enum: PRIORITIES, description: "must=硬约束，should=软约束。" },
              sourceText: { type: "string", description: "支撑该条约束的用户原话片段，不得改写。" },
              verification: { type: "string", description: "可执行的验证方式。" },
            },
          },
        },
        missing: { type: "array", maxItems: 8, items: { type: "string" } },
        confidence: { type: "number" },
      },
    },
  },
  parts: {
    description:
      "从表1 的预设模块/零件里做选择，输出覆盖完整的 BOM。L1 固定为 h3；每个模块可以整选（h3-cam），也可以拆到它的 4 个零件（h3-cam-01…04）；同一模块不得同时选模块和零件；每个 L3 零件都必须被覆盖。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "bomLevel", "parts", "missing", "confidence"],
      properties: {
        summary: { type: "string", description: "一句话说明哪些模块整选、哪些拆到零件。" },
        bomLevel: {
          type: "string",
          enum: LEVELS,
          description: "本次拆解的最深层级：全部整选模块为 L2，出现零件则为 L3。",
        },
        parts: {
          type: "array",
          minItems: 1,
          maxItems: 80,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["code", "note"],
            properties: {
              code: {
                type: "string",
                description:
                  "表1 中的 code，原样复制：h3（整机）/ h3-cam（模块）/ h3-cam-01（零件）。禁止自造、缩写或改写。",
              },
              note: {
                type: "string",
                description:
                  "补充备注（用户明确指定的材料、标准件/定制件等）；没有则空字符串。不得编造规格。",
              },
            },
          },
        },
        missing: { type: "array", maxItems: 8, items: { type: "string" } },
        confidence: { type: "number" },
      },
    },
  },
};

export function functionNameFor(questionId) {
  return FUNCTION_NAMES[questionId];
}

export function buildToolDefinition(questionId) {
  const definition = FUNCTION_DEFINITIONS[questionId];
  if (!definition) throw new Error(`Unknown question: ${questionId}`);
  return {
    type: "function",
    function: {
      name: functionNameFor(questionId),
      description: definition.description,
      strict: true,
      parameters: definition.parameters,
    },
  };
}

export function buildMockToolCall(questionId, payload) {
  return {
    id: "call_mock_0001",
    type: "function",
    function: {
      name: functionNameFor(questionId),
      arguments: JSON.stringify(payload),
    },
  };
}

export function extractToolCall(message, questionId) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const expected = functionNameFor(questionId);
  const match =
    calls.find((call) => call?.type === "function" && call?.function?.name === expected) ?? calls[0];
  if (!match || match.type !== "function") {
    throw new PresetContractError(
      "AI_NO_FUNCTION_CALL",
      "AI 只返回了自然语言，没有调用预设函数。",
    );
  }
  return match;
}

export function parseToolCall(questionId, toolCall, rawText) {
  if (!toolCall || toolCall.type !== "function" || !toolCall.function) {
    throw new PresetContractError("AI_NO_FUNCTION_CALL", "AI 没有通过预设函数返回结果。");
  }
  const { name, arguments: args } = toolCall.function;
  const expected = functionNameFor(questionId);
  if (name !== expected) {
    throw new PresetContractError(
      "AI_WRONG_FUNCTION",
      `AI 调用了 ${name}，本问题只允许 ${expected}。`,
      { expected, received: name },
    );
  }

  let payload;
  try {
    payload = typeof args === "string" ? JSON.parse(args) : args;
  } catch {
    throw new PresetContractError("AI_BAD_JSON", "预设函数参数不是合法 JSON。");
  }
  return normalizeFunctionPayload(questionId, payload, rawText);
}

/* ------------------------------------------------------------------ */
/* 文本与基础字段清洗                                                   */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, field, maxLength, { allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (allowEmpty) return "";
    throw new PresetContractError("AI_OUTPUT_INVALID", `AI 函数结果缺少字段：${field}`);
  }
  if (typeof value !== "string") {
    throw new PresetContractError("AI_OUTPUT_INVALID", `AI 函数字段 ${field} 必须是字符串`);
  }
  const text = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  if (!allowEmpty && !text) {
    throw new PresetContractError("AI_OUTPUT_INVALID", `AI 函数字段 ${field} 不能为空`);
  }
  if (text.length > maxLength) {
    throw new PresetContractError(
      "AI_OUTPUT_INVALID",
      `AI 函数字段 ${field} 超过 ${maxLength} 字，请精简后重试`,
    );
  }
  return text;
}

function cleanCommon(payload) {
  if (!isPlainObject(payload)) {
    throw new PresetContractError("AI_OUTPUT_INVALID", "AI 函数参数必须是 JSON 对象。");
  }
  const summary = cleanText(payload.summary, "summary", 200);
  const missingRaw = payload.missing ?? [];
  if (!Array.isArray(missingRaw) || missingRaw.length > 8) {
    throw new PresetContractError("AI_OUTPUT_INVALID", "missing 必须是最多 8 项的数组。");
  }
  const seen = new Set();
  const missing = [];
  for (const entry of missingRaw) {
    const text = cleanText(entry, "missing[]", 240, { allowEmpty: true });
    if (!text || seen.has(text)) continue;
    seen.add(text);
    missing.push(text);
  }
  const confidenceRaw = payload.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) {
    throw new PresetContractError("AI_OUTPUT_INVALID", "confidence 必须是 0–1 的数字。");
  }
  return { summary, missing, confidence: clamp01(confidenceRaw) };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

function formatNumber(value) {
  return String(Math.round(value * 1000) / 1000);
}

function parseNumeric(value) {
  const cleaned = String(value).replaceAll(",", "").trim();
  return /^-?\d+(?:\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
}

/* ------------------------------------------------------------------ */
/* Q1 商品类型                                                          */
/* ------------------------------------------------------------------ */

function normalizeProductType(payload) {
  const common = cleanCommon(payload);
  const raw = payload.candidates;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PresetContractError("AI_OUTPUT_INVALID", "candidates 至少需要 1 个商品类型。");
  }
  if (raw.length > LIMITS.product_type) {
    throw new PresetContractError("AI_OUTPUT_INVALID", `candidates 最多 ${LIMITS.product_type} 个。`);
  }

  const seen = new Set();
  const items = [];
  const warnings = [];

  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      throw new PresetContractError("AI_OUTPUT_INVALID", "candidates 的每一项必须是对象。");
    }
    const presetId = cleanText(entry.presetId, "candidates[].presetId", 64);
    const preset = getProductType(presetId);
    if (!preset) {
      warnings.push(`AI 返回了表1中不存在的商品类型 ${presetId}，已跳过。`);
      continue;
    }
    if (seen.has(presetId)) continue;
    seen.add(presetId);
    const fit = cleanText(entry.fit, "candidates[].fit", 240);
    const confidenceRaw = entry.confidence;
    if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) {
      throw new PresetContractError("AI_OUTPUT_INVALID", "candidates[].confidence 必须是数字。");
    }
    items.push({
      key: presetId,
      presetId,
      code: preset.code,
      name: preset.name,
      category: preset.category,
      description: preset.description,
      defaultBomLevel: preset.defaultBomLevel,
      fit,
      confidence: clamp01(confidenceRaw),
    });
  }

  if (items.length === 0) {
    throw new PresetContractError("AI_OUTPUT_INVALID", "没有任何 candidates 能对应表1中的商品类型。");
  }

  return {
    result: {
      questionId: "product_type",
      functionName: FUNCTION_NAMES.product_type,
      summary: common.summary,
      confidence: common.confidence,
      missing: common.missing,
      selectionMode: "single",
      defaultSelection: "primary",
      items,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Q2 硬性约束                                                          */
/* ------------------------------------------------------------------ */

const DIMENSION_ALIASES = new Map([
  ["weight", "weight"],
  ["重量", "weight"],
  ["dimension", "dimensions"],
  ["尺寸", "dimensions"],
  ["cost", "budget"],
  ["budget", "budget"],
  ["成本", "budget"],
  ["price", "budget"],
  ["load", "payload"],
  ["payload", "payload"],
  ["负载", "payload"],
  ["battery", "runtime"],
  ["endurance", "runtime"],
  ["续航", "runtime"],
  ["waterproof", "ingress"],
  ["ip", "ingress"],
  ["防护", "ingress"],
  ["防水", "ingress"],
  ["temp", "temperature"],
  ["温度", "temperature"],
  ["cert", "certification"],
  ["认证", "certification"],
  ["delivery", "lead_time"],
  ["交期", "lead_time"],
  ["lead_time", "lead_time"],
  ["port", "interface"],
  ["接口", "interface"],
  ["compat", "compatibility"],
  ["兼容", "compatibility"],
  ["material", "material"],
  ["材料", "material"],
  ["lifetime", "reliability"],
  ["寿命", "reliability"],
  ["可靠性", "reliability"],
]);

function normalizeDimension(raw) {
  const value = cleanText(raw, "constraints[].dimension", 40).toLowerCase();
  const mapped = DIMENSION_ALIASES.get(value) ?? value;
  if (constraintDimensionsById.has(mapped)) return mapped;
  return "custom";
}

function normalizeConstraintValue(dimension, rawValue, rawUnit) {
  const value = cleanText(rawValue, "constraints[].value", 120).replace(/^(≤|<=|≥|>=|<|>|=)\s*/, "");
  let unit = cleanText(rawUnit ?? "", "constraints[].unit", 40, { allowEmpty: true });
  const meta = getConstraintDimension(dimension);
  const canonicalUnit = meta?.unit || "";
  const lowerUnit = unit.toLowerCase();
  const numeric = parseNumeric(value);

  if (dimension === "weight" && numeric !== null) {
    if (["kg", "千克", "公斤"].includes(lowerUnit)) {
      return { value: formatNumber(numeric * 1000), unit: "g" };
    }
    if (["g", "克", ""].includes(lowerUnit)) return { value: formatNumber(numeric), unit: "g" };
  } else if (dimension === "payload" && numeric !== null) {
    if (["g", "克"].includes(lowerUnit)) return { value: formatNumber(numeric / 1000), unit: "kg" };
    if (["kg", "千克", "公斤", ""].includes(lowerUnit)) {
      return { value: formatNumber(numeric), unit: "kg" };
    }
  } else if (dimension === "budget" && numeric !== null) {
    if (["元", "cny", "rmb", ""].includes(lowerUnit)) return { value: formatNumber(numeric), unit: "CNY" };
    if (["万元", "万"].includes(lowerUnit)) return { value: formatNumber(numeric * 10000), unit: "CNY" };
  } else if (dimension === "lead_time" && numeric !== null) {
    if (["天", "day", "days", ""].includes(lowerUnit)) return { value: formatNumber(numeric), unit: "day" };
    if (["周", "week", "weeks"].includes(lowerUnit)) {
      return { value: formatNumber(numeric * 7), unit: "day" };
    }
  } else if (dimension === "runtime" && numeric !== null) {
    if (["h", "小时", "hour", "hours", ""].includes(lowerUnit)) {
      return { value: formatNumber(numeric), unit: "h" };
    }
    if (["min", "分钟"].includes(lowerUnit)) return { value: formatNumber(numeric / 60), unit: "h" };
  } else if (dimension === "temperature" && numeric !== null) {
    if (["°c", "c", "摄氏度"].includes(lowerUnit)) return { value: formatNumber(numeric), unit: "°C" };
  }

  return { value, unit: unit || canonicalUnit };
}

const PRIORITY_LABELS = { must: "硬约束", should: "软约束" };
const OPERATOR_LABELS = { "<=": "≤", ">=": "≥", "=": "=", range: "区间", in: "属于", custom: "" };

function constraintDisplay(item) {
  const operator = OPERATOR_LABELS[item.operator] ?? item.operator;
  if (item.operator === "custom") return item.value;
  const suffix = item.unit ? ` ${item.unit}` : "";
  if (item.operator === "in") return `${operator} ${item.value}`;
  return `${operator} ${item.value}${suffix}`.trim();
}

function normalizeHardConstraints(payload) {
  const common = cleanCommon(payload);
  const raw = payload.constraints;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PresetContractError("AI_OUTPUT_INVALID", "constraints 至少需要 1 条约束。");
  }
  if (raw.length > LIMITS.hard_constraints) {
    throw new PresetContractError(
      "AI_OUTPUT_INVALID",
      `constraints 最多 ${LIMITS.hard_constraints} 条。`,
    );
  }

  const seen = new Set();
  const items = [];
  const warnings = [];
  let repaired = 0;

  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      throw new PresetContractError("AI_OUTPUT_INVALID", "constraints 的每一项必须是对象。");
    }
    const dimension = normalizeDimension(entry.dimension);
    const meta = getConstraintDimension(dimension);
    let name = cleanText(entry.name, "constraints[].name", 80, { allowEmpty: true });
    if (!name) name = meta?.name || "其他约束";

    const operatorRaw = cleanText(entry.operator, "constraints[].operator", 20).toLowerCase();
    const operator = OPERATORS.includes(operatorRaw) ? operatorRaw : "custom";
    if (operatorRaw !== operator) repaired += 1;

    const priorityRaw = cleanText(entry.priority, "constraints[].priority", 12).toLowerCase();
    const priority = PRIORITIES.includes(priorityRaw) ? priorityRaw : "must";
    if (priorityRaw !== priority) repaired += 1;

    const { value, unit } = normalizeConstraintValue(dimension, entry.value, entry.unit);
    if (!value) {
      throw new PresetContractError("AI_OUTPUT_INVALID", "constraints[].value 不能为空。");
    }
    const sourceText = cleanText(entry.sourceText, "constraints[].sourceText", 240, { allowEmpty: true });
    const verification = cleanText(entry.verification, "constraints[].verification", 120, {
      allowEmpty: true,
    });

    const key = `c:${dimension}:${operator}:${value}:${unit}`.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`重复约束已合并：${name} ${value}${unit ? ` ${unit}` : ""}`);
      continue;
    }
    seen.add(key);

    const item = {
      key,
      dimension,
      dimensionName: meta?.name || "其他约束",
      name,
      operator,
      operatorLabel: OPERATOR_LABELS[operator],
      value,
      unit,
      display: "",
      priority,
      priorityLabel: PRIORITY_LABELS[priority],
      sourceText,
      verification: verification || meta?.verification || "人工复核",
    };
    item.display = constraintDisplay(item);
    items.push(item);
  }

  if (items.length === 0) {
    throw new PresetContractError("AI_OUTPUT_INVALID", "去重后没有任何有效约束。");
  }
  if (repaired > 0) warnings.push(`已修正 ${repaired} 个不规范的枚举字段。`);

  return {
    result: {
      questionId: "hard_constraints",
      functionName: FUNCTION_NAMES.hard_constraints,
      summary: common.summary,
      confidence: common.confidence,
      missing: common.missing,
      selectionMode: "multiple",
      defaultSelection: "none",
      items,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Q3 零件集合                                                          */
/* ------------------------------------------------------------------ */

const ROOT = rootItemOf();

/** 表1 的 code 全部小写连字符（h3-cam-01），这里只做轻清洗，不改变编码语义 */
function normalizeCode(raw, index) {
  const code = cleanText(raw, "parts[].code", 40)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!code) {
    throw new PresetContractError("AI_OUTPUT_INVALID", `parts[${index}].code 清洗后为空。`);
  }
  if (!/^[a-z0-9]/.test(code)) {
    throw new PresetContractError("AI_OUTPUT_INVALID", `parts[${index}].code 必须以字母或数字开头。`);
  }
  return code;
}

function isKnownCode(code) {
  return partsByCode.has(code) || modulesByCode.has(code) || code === ROOT.code;
}

/**
 * 把 AI 的勾选集合归一成合法选择：
 *   - L1 永远包含，且不覆盖下级；
 *   - 模块与它的零件同时出现时保留零件（不允许上下重合）；
 *   - 只选了模块的部分零件时补齐其余零件（L3 不允许缺项）；
 *   - 完全没被提及的模块按整模块纳入（保证 L3 全覆盖）。
 */
function resolveSelection(requested, warnings) {
  const selected = new Set([ROOT.code]);
  let conflicts = 0;
  let completed = 0;
  let autoModules = 0;

  for (const module of moduleList) {
    const children = partsOfModule(module.code);
    const moduleOn = requested.has(module.code);
    const picked = children.filter((code) => requested.has(code));

    if (moduleOn && picked.length > 0) {
      conflicts += 1;
      warnings.push(`模块 ${module.code}（${module.name}）与它的零件同时被选中，已按“不上下重合”只保留零件。`);
    }

    if (picked.length > 0) {
      if (picked.length < children.length) {
        completed += children.length - picked.length;
        warnings.push(`模块 ${module.code}（${module.name}）缺 ${children.length - picked.length} 个零件，已按“L3 全覆盖”补齐。`);
      }
      for (const code of children) selected.add(code);
    } else {
      if (!moduleOn) autoModules += 1;
      selected.add(module.code);
    }
  }

  if (completed > 0) warnings.push(`共补齐 ${completed} 个未覆盖的 L3 零件。`);
  if (autoModules > 0) warnings.push(`有 ${autoModules} 个模块未被提及，已按整模块纳入，保证 L3 全覆盖。`);
  return selected;
}

/** 按表1 顺序生成完整条目（L1 + 每个模块的 L2 或它的 4 个 L3） */
function buildPresetItems(notes) {
  const items = [
    {
      key: ROOT.code,
      code: ROOT.code,
      name: ROOT.name,
      level: "L1",
      levelName: bomLevelsById.get("L1")?.name || "L1",
      qty: ROOT.qty,
      unit: ROOT.unit,
      material: "",
      spec: "",
      parentCode: "",
      note: notes.get(ROOT.code) || "",
      description: ROOT.description,
    },
  ];

  for (const [moduleIndex, module] of moduleList.entries()) {
    items.push({
      key: module.code,
      code: module.code,
      name: module.name,
      level: "L2",
      levelName: bomLevelsById.get("L2")?.name || "L2",
      qty: 1,
      unit: "pcs",
      material: "",
      spec: "",
      parentCode: ROOT.code,
      note: notes.get(module.code) || "",
      description: module.description,
      moduleCode: module.code,
      order: moduleIndex + 1,
      partCount: partsOfModule(module.code).length,
    });
    for (const code of partsOfModule(module.code)) {
      const part = partsByCode.get(code);
      items.push({
        key: code,
        code,
        name: part.name,
        level: "L3",
        levelName: bomLevelsById.get("L3")?.name || "L3",
        qty: part.qty,
        unit: part.unit,
        material: part.material || "",
        spec: part.spec || "",
        parentCode: module.code,
        note: notes.get(code) || part.note || "",
        description: part.description,
        moduleCode: module.code,
        moduleName: module.name,
      });
    }
  }

  return items;
}

function normalizeParts(payload) {
  const common = cleanCommon(payload);
  const levelRaw = cleanText(payload.bomLevel, "bomLevel", 8).toUpperCase();
  if (!LEVELS.includes(levelRaw)) {
    throw new PresetContractError("AI_OUTPUT_INVALID", `bomLevel 必须是 ${LEVELS.join(" / ")}。`);
  }

  const raw = payload.parts;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PresetContractError("AI_OUTPUT_INVALID", "parts 至少需要 1 个条目。");
  }
  if (raw.length > LIMITS.parts) {
    throw new PresetContractError("AI_OUTPUT_INVALID", `parts 最多 ${LIMITS.parts} 个。`);
  }

  const warnings = [];
  const requested = new Set();
  const notes = new Map();
  const unknown = [];

  for (const [index, entry] of raw.entries()) {
    if (!isPlainObject(entry)) {
      throw new PresetContractError("AI_OUTPUT_INVALID", "parts 的每一项必须是对象。");
    }
    const code = normalizeCode(entry.code, index);
    const note = cleanText(entry.note, "parts[].note", 120, { allowEmpty: true });
    if (!isKnownCode(code)) {
      unknown.push(code);
      continue;
    }
    requested.add(code);
    if (note) notes.set(code, note);
  }

  if (unknown.length > 0) {
    const preview = unknown.slice(0, 6).join("、");
    warnings.push(
      `已忽略 ${unknown.length} 个不在表1 预设中的编码：${preview}${unknown.length > 6 ? " 等" : ""}。`,
    );
  }
  if (requested.size === 0) {
    throw new PresetContractError(
      "AI_OUTPUT_INVALID",
      "AI 给出的编码都不在表1 预设中，只能从表1 的 modules / parts 里选择 code。",
    );
  }

  const selected = resolveSelection(requested, warnings);
  const items = buildPresetItems(notes);
  const bomLevel = items.some((item) => selected.has(item.code) && item.level === "L3") ? "L3" : "L2";
  const bomLevelMeta = bomLevelsById.get(bomLevel);

  return {
    result: {
      questionId: "parts",
      functionName: FUNCTION_NAMES.parts,
      summary: common.summary,
      confidence: common.confidence,
      missing: common.missing,
      selectionMode: "multiple",
      defaultSelection: "custom",
      presetBased: true,
      bomLevel,
      bomLevelName: bomLevelMeta?.name || bomLevel,
      bomLevelScope: bomLevelMeta?.scope || "",
      selectedKeys: items.filter((item) => selected.has(item.code)).map((item) => item.code),
      items,
    },
    warnings,
  };
}

export function normalizeFunctionPayload(questionId, payload, rawText = "") {
  if (!isPlainObject(payload)) {
    throw new PresetContractError("AI_OUTPUT_INVALID", "AI 函数参数必须是 JSON 对象。");
  }
  let parsed;
  if (questionId === "product_type") parsed = normalizeProductType(payload);
  else if (questionId === "hard_constraints") parsed = normalizeHardConstraints(payload);
  else if (questionId === "parts") parsed = normalizeParts(payload);
  else throw new PresetContractError("AI_UNKNOWN_QUESTION", `未知问题：${questionId}`);

  const result = parsed.result;
  result.rawText = typeof rawText === "string" ? rawText.slice(0, 4000) : "";
  result.stats = {
    itemCount: result.items.length,
    uniqueKeys: new Set(result.items.map((item) => item.key)).size,
    ...(result.bomLevel ? { bomLevel: result.bomLevel } : {}),
  };
  return { result, warnings: parsed.warnings };
}

export const contractSummary = {
  version: "2.0.0",
  functions: QUESTION_IDS.map((questionId) => ({
    questionId,
    name: FUNCTION_NAMES[questionId],
    output: questionId === "parts" ? "零件集合（code 唯一，默认全选）" : questionId === "hard_constraints" ? "约束集合" : "商品类型候选（单选）",
    maxItems: LIMITS[questionId],
  })),
  tableVersion: table1Meta.version,
  productTypeCount: productTypesById.size,
};
