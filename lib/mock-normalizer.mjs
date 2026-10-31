/**
 * 本地模拟规范化器（无 API Key 时的 fallback）
 *
 * 与真实 AI 保持同一契约：返回 { reply, payload }。
 *   reply   —— 面向用户的自然语言，前端原样展示；
 *   payload —— 送给预设函数校验的结构化 JSON。
 */

import { table1, productTypesById } from "./table1.mjs";

/* ------------------------------------------------------------------ */
/* Q1 商品类型                                                          */
/* ------------------------------------------------------------------ */

function scoreTypes(text) {
  const lower = text.toLowerCase();
  return table1.productTypes
    .map((type) => {
      let score = 0;
      const hits = [];
      for (const keyword of type.keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          score += Math.min(6, Math.max(2, keyword.length));
          hits.push(keyword);
        }
      }
      if (lower.includes(type.name.toLowerCase())) score += 8;
      return { type, score, hits };
    })
    .sort((a, b) => b.score - a.score || a.type.code.localeCompare(b.type.code));
}

function buildProductTypeReply(primary, alternates, score) {
  const lines = [];
  if (score > 0) {
    lines.push(
      `我把你的描述归到了表1的「${primary.type.name}」（${primary.type.code}，${primary.type.category}）。`,
    );
    lines.push(
      `依据是你提到了「${primary.hits.slice(0, 3).join("」「")}」，与这个预设类型的定义一致。`,
    );
  } else {
    lines.push(`你的描述里没有出现表1 预设类型的明确关键词，我按「${primary.type.name}」处理。`);
    lines.push(
      "表1 目前只有「h3 手持云台」一种预设；如果实际是别的品类，后续在 table1.json 新增类型后，候选会自动出现。",
    );
  }
  if (alternates.length > 0) {
    lines.push(
      `另外 ${alternates.length} 个候选是「${alternates.map((item) => item.type.name).join("」「")}」，如果更贴近你的项目，可以在下面改选。`,
    );
  }
  lines.push("请确认商品类型；同一时间只能选中一个。");
  return lines.join("\n");
}

function mockProductType(text) {
  const ranked = scoreTypes(text);
  const primary = ranked[0];
  const alternates = ranked.slice(1, 3).filter((entry) => entry.score > 0 || ranked[0].score === 0);
  const candidates = [primary, ...alternates].map((entry, index) => ({
    presetId: entry.type.id,
    fit:
      entry.hits.length > 0
        ? `匹配关键词：${entry.hits.slice(0, 4).join("、")}；${entry.type.description}`
        : "未匹配到明确关键词；表1 目前只有 h3，先按它归入，需要人工确认。",
    confidence: index === 0 ? (primary.score > 0 ? 0.86 : 0.42) : Math.max(0.2, 0.55 - index * 0.15),
  }));

  const payload = {
    summary: `按表1归入「${primary.type.name}」，提供 ${candidates.length} 个候选供单选确认。`,
    candidates,
    missing:
      primary.score > 0
        ? []
        : ["描述中缺少明确的品类关键词，请补充商品形态或用途后重新归类。"],
    confidence: candidates[0].confidence,
  };

  return { reply: buildProductTypeReply(primary, alternates, primary.score), payload };
}

/* ------------------------------------------------------------------ */
/* Q2 硬性约束                                                          */
/* ------------------------------------------------------------------ */

function clauses(text) {
  return text
    .split(/[。；;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function findClause(text, index) {
  const source = clauses(text);
  let cursor = 0;
  for (const clause of source) {
    const position = text.indexOf(clause, cursor);
    if (position >= 0 && index >= position && index <= position + clause.length) return clause;
    if (position >= 0) cursor = position + clause.length;
  }
  return text.slice(0, 120);
}

function priorityOf(clause) {
  return /最好|尽量|优先|希望|倾向于/.test(clause) ? "should" : "must";
}

function unitLabel(unit) {
  return unit ? ` ${unit}` : "";
}

const EXTRACTORS = [
  {
    dimension: "weight",
    regex: /(?:整机|机身|重量|不超过|不大于|控制在|小于|低于|≤)[^。；;\n]{0,14}?(\d+(?:\.\d+)?)\s*(kg|公斤|千克|g|克)/i,
    build: (m) => {
      const value = Number(m[1]);
      const unit = /kg|公斤|千克/i.test(m[2]) ? "kg" : "g";
      return { operator: "<=", value: String(value), unit };
    },
  },
  {
    dimension: "budget",
    regex: /(?:成本|预算|BOM|售价)[^。；;\n]{0,16}?(\d+(?:\.\d+)?)\s*(万元|万|元|块)?/i,
    build: (m) => ({ operator: "<=", value: String(m[1]), unit: /万/.test(m[2] || "") ? "万元" : "CNY" }),
  },
  {
    dimension: "ingress",
    regex: /IP\s?(\d{2})/i,
    build: (m) => ({ operator: "=", value: `IP${m[1]}`, unit: "" }),
  },
  {
    dimension: "lead_time",
    regex: /(?:交期|交付|工期|周期)[^。；;\n]{0,10}?(\d+)\s*(天|周|日)/,
    build: (m) => ({ operator: "<=", value: String(m[1]), unit: m[2] === "周" ? "周" : "day" }),
  },
  {
    dimension: "payload",
    regex: /(?:负载|承重)[^。；;\n]{0,12}?(\d+(?:\.\d+)?)\s*(kg|公斤|g|克)/i,
    build: (m) => ({ operator: ">=", value: String(m[1]), unit: /kg|公斤/i.test(m[2]) ? "kg" : "g" }),
  },
  {
    dimension: "runtime",
    regex: /(?:续航|工作时间|使用时间)[^。；;\n]{0,12}?(\d+(?:\.\d+)?)\s*(小时|h|分钟)/i,
    build: (m) => ({ operator: ">=", value: String(m[1]), unit: /分钟/.test(m[2]) ? "分钟" : "h" }),
  },
  {
    dimension: "temperature",
    regex: /(-?\d+)\s*(?:~|-|–|至)\s*(-?\d+)\s*°?\s*C/i,
    build: (m) => ({ operator: "range", value: `${m[1]}~${m[2]}`, unit: "°C" }),
  },
  {
    dimension: "certification",
    regex: /\b(CE|FCC|RoHS|CCC|3C|UL)\b/gi,
    build: (m) => ({ operator: "in", value: m[1].toUpperCase(), unit: "" }),
    collect: true,
  },
  {
    dimension: "interface",
    regex: /\b(USB-?C|HDMI|Type-?C|Lightning|Wi-?Fi|蓝牙)\b/gi,
    build: (m) => ({ operator: "in", value: m[1], unit: "" }),
  },
  {
    dimension: "material",
    regex: /(6061|7075|铝合金|碳纤维|不锈钢|钛合金|ABS|聚碳酸酯)/i,
    build: (m) => ({ operator: "=", value: m[1], unit: "" }),
  },
  {
    dimension: "reliability",
    regex: /(?:寿命|次数)[^。；;\n]{0,10}?(\d[\d,]*)\s*次/,
    build: (m) => ({ operator: ">=", value: m[1].replaceAll(",", ""), unit: "次" }),
  },
  {
    dimension: "dimensions",
    regex: /(\d+(?:\.\d+)?)\s*[×x*]\s*(\d+(?:\.\d+)?)\s*[×x*]\s*(\d+(?:\.\d+)?)\s*mm/i,
    build: (m) => ({ operator: "<=", value: `${m[1]}×${m[2]}×${m[3]}`, unit: "mm" }),
  },
];

function mockHardConstraints(text) {
  if (/没有(额外)?(硬性)?约束|无(额外)?(硬性)?约束/.test(text)) {
    return {
      reply:
        "你说这一轮没有额外的硬性约束，所以我只保留了一条「无额外硬性约束」作为占位。\n如果后面想起重量、成本或交期要求，可以重新提问。",
      payload: {
        summary: "用户声明没有额外硬性约束，输出单条占位约束。",
        constraints: [
          {
            dimension: "none",
            name: "无额外硬性约束",
            operator: "=",
            value: "无",
            unit: "",
            priority: "must",
            sourceText: "没有额外硬性约束",
            verification: "人工确认",
          },
        ],
        missing: [],
        confidence: 0.9,
      },
    };
  }

  const found = [];
  const seen = new Set();

  for (const extractor of EXTRACTORS) {
    const flags = extractor.regex.flags.includes("g") ? extractor.regex.flags : `${extractor.regex.flags}g`;
    const regex = new RegExp(extractor.regex.source, flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      const clause = findClause(text, match.index);
      const built = extractor.build(match);
      const key = `${extractor.dimension}|${built.value}|${built.unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const meta = table1.constraintDimensions.find((item) => item.id === extractor.dimension);
      found.push({
        dimension: extractor.dimension,
        name: meta?.name || extractor.dimension,
        operator: built.operator,
        value: built.value,
        unit: built.unit,
        priority: priorityOf(clause),
        sourceText: clause.slice(0, 120),
        verification: meta?.verification || "人工复核",
        display: `${meta?.name || extractor.dimension} ${built.operator === ">=" ? "≥" : built.operator === "<=" ? "≤" : ""} ${built.value}${unitLabel(built.unit)}`.replace(/\s+/g, " ").trim(),
      });
      if (found.length >= 12) break;
    }
    if (found.length >= 12) break;
  }

  if (found.length === 0) {
    found.push({
      dimension: "custom",
      name: "其他约束",
      operator: "custom",
      value: text.slice(0, 100),
      unit: "",
      priority: "must",
      sourceText: text.slice(0, 120),
      verification: "人工复核",
      display: "其他约束：需要人工拆分",
    });
  }

  const hard = found.filter((item) => item.priority === "must");
  const soft = found.filter((item) => item.priority === "should");
  const lines = [`我从你的描述里拆出了 ${found.length} 条约束，硬约束 ${hard.length} 条${soft.length ? `、软约束 ${soft.length} 条` : ""}。`];
  for (const item of found.slice(0, 6)) {
    lines.push(`· ${item.display}（${item.priority === "must" ? "硬约束" : "软约束"}）`);
  }
  if (found.length > 6) lines.push(`· 其余 ${found.length - 6} 条见下方清单。`);
  lines.push("默认没有勾选任何一条，请逐条确认需要生效的约束；不需要的保持未选即可。");

  return {
    reply: lines.join("\n"),
    payload: {
      summary: `共提取 ${found.length} 条约束，其中硬约束 ${hard.length} 条、软约束 ${soft.length} 条。`,
      constraints: found.map(({ display, ...rest }) => rest),
      missing: [],
      confidence: 0.82,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Q3 零件拆解                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Q3 零件拆解（只从表1 预设中选择，不再有独立零件库）                   */
/* ------------------------------------------------------------------ */

const MODULE_HIT = (text, module) => {
  const lower = text.toLowerCase();
  if (lower.includes(String(module.name).toLowerCase())) return true;
  return (module.keywords ?? []).some((keyword) => lower.includes(String(keyword).toLowerCase()));
};

function detectDepth(text) {
  if (/模块级|整模块|组件|总成|L2|先按模块|方案估算/i.test(text)) return "L2";
  if (/零件级|零部件|询价|打样|L3|拆开|展开/i.test(text)) return "L3";
  return "";
}

function mockParts(text, context = {}) {
  const type = productTypesById.get(context.productType?.presetId) || table1.productTypes[0];
  const modules = type.modules ?? [];
  const depth = detectDepth(text);
  const mentioned = modules.filter((module) => MODULE_HIT(text, module));

  const explode = new Set();
  if (mentioned.length > 0) {
    for (const module of mentioned) explode.add(module.code);
  } else if (depth === "L3") {
    for (const module of modules) explode.add(module.code);
  }

  const parts = [{ code: type.id, note: "" }];
  const moduleLines = [];
  for (const module of modules) {
    if (explode.has(module.code)) {
      for (const item of module.parts ?? []) parts.push({ code: item.code, note: "" });
      moduleLines.push(`${module.name} → 拆到 ${(module.parts ?? []).length} 个零件`);
    } else {
      parts.push({ code: module.code, note: "" });
      moduleLines.push(`${module.name} → 整模块`);
    }
  }

  const exploded = explode.size;
  const level = exploded > 0 ? "L3" : "L2";
  const levelName = table1.bomLevels.find((entry) => entry.id === level)?.name ?? level;

  const lines = [
    `我按表1 的「${level} · ${levelName}」给「${type.name}」做了选择：${type.name} 下共 ${modules.length} 个模块，其中 ${exploded} 个拆到零件、${modules.length - exploded} 个按整模块，合计 ${parts.length} 个条目。`,
    ...moduleLines.map((line) => `· ${line}`),
    "在弹窗里取消某个模块的勾选，它的 4 个零件会立刻展开并锁定为已选；重新勾选模块，零件立刻收回。",
    "整机 h3 固定包含、不可取消，也不覆盖下级；因此每个 L3 零件一定有归属，不会出现悬空零件。",
    "当前表1 只到 L3，材料与工艺级（L4）暂时停用。",
  ];

  return {
    reply: lines.join("\n"),
    payload: {
      summary: `${type.name}：${modules.length} 个模块中 ${exploded} 个拆到零件，共 ${parts.length} 个条目，覆盖完整。`,
      bomLevel: level,
      parts,
      missing: [],
      confidence: 0.82,
    },
  };
}

export function mockNormalize(questionId, text, context = {}) {
  if (questionId === "product_type") return mockProductType(text);
  if (questionId === "hard_constraints") return mockHardConstraints(text);
  if (questionId === "parts") return mockParts(text, context);
  throw new Error(`Unknown question: ${questionId}`);
}
