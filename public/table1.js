/**
 * 表1 查看页
 *
 * 直接渲染 /api/table1（即 presets/table1.json 原文），
 * 不复制一份数据，避免文档与实际生效的表脱节。
 */

(function () {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "href") node.href = value;
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function chips(items, tone) {
    const row = el("div", { class: "chip-row" });
    for (const item of items || []) row.append(el("span", { class: `chip${tone ? ` ${tone}` : ""}`, text: item }));
    return row;
  }

  async function load() {
    const response = await fetch("/api/table1", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || data.ok !== true || !data.table1) throw new Error("表1 数据格式不正确");
    return data;
  }

  function section(id, title, kicker, ...children) {
    return el(
      "section",
      { class: "doc-section", id },
      el(
        "header",
        { class: "doc-section-head" },
        el("p", { class: "doc-kicker", text: kicker }),
        el("h2", { text: title }),
      ),
      ...children,
    );
  }

  function renderTypes(table1, levelNameOf) {
    const grid = el("div", { class: "pt-grid" });
    for (const type of table1.productTypes) {
      const bench = (type.benchmarkHints || []).slice(0, 3);
      grid.append(
        el(
          "article",
          { class: "pt-card" },
          el(
            "header",
            { class: "pt-head" },
            el("span", { class: "pt-code", text: type.code }),
            el("h3", { class: "pt-name", text: type.name }),
            el("span", { class: "pt-cat", text: type.category }),
          ),
          el("p", { class: "pt-desc", text: type.description }),
          chips(type.keywords),
          el(
            "footer",
            { class: "pt-foot" },
            el("span", { class: "pt-meta", text: `默认拆解 ${type.defaultBomLevel} · ${levelNameOf(type.defaultBomLevel)}` }),
            bench.length > 0 ? el("span", { class: "pt-meta", text: `对标 ${bench.join(" / ")}` }) : null,
          ),
        ),
      );
    }
    return grid;
  }

  function renderModules(table1) {
    const body = el("tbody");
    for (const type of table1.productTypes) {
      for (const module of type.modules || []) {
        const parts = module.parts || [];
        body.append(
          el(
            "tr",
            {},
            el(
              "td",
              {},
              el("strong", { text: module.name }),
              module.description ? el("div", { class: "part-desc", text: module.description }) : null,
            ),
            el("td", {}, el("code", { text: module.code })),
            el("td", { text: String(parts.length) }),
            el(
              "td",
              {},
              el(
                "ul",
                { class: "part-list" },
                ...parts.map((part) =>
                  el(
                    "li",
                    {},
                    el("code", { text: part.code }),
                    el("span", { text: ` ${part.name} ×${part.qty}` }),
                    part.description ? el("span", { class: "part-hint", text: ` — ${part.description}` }) : null,
                  ),
                ),
              ),
            ),
          ),
        );
      }
    }
    return el(
      "div",
      { class: "table-scroll" },
      el(
        "table",
        { class: "doc-table" },
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", { text: "L2 模块" }),
            el("th", { text: "code" }),
            el("th", { text: "L3 数量" }),
            el("th", { text: "L3 零件（code · 名称 ×用量）" }),
          ),
        ),
        body,
      ),
    );
  }

  function renderFormat(table1) {
    const raw = table1.$comment;
    const lines = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    if (lines.length === 0) return el("p", { class: "doc-note", text: "本表没有附加格式说明。" });
    return el(
      "ol",
      { class: "format-list" },
      ...lines.map((line) => el("li", { text: String(line) })),
    );
  }

  function renderLevels(table1) {
    const list = el("div", { class: "level-list" });
    for (const level of table1.bomLevels) {
      list.append(
        el(
          "article",
          { class: "level-card" },
          el(
            "div",
            { class: "level-head" },
            el("span", { class: "level-id", text: level.id }),
            el("span", { class: "level-name", text: level.name }),
            el("span", { class: "level-code", text: level.code }),
          ),
          el("p", { class: "level-desc", text: level.description }),
          el(
            "dl",
            { class: "level-grid" },
            el("div", {}, el("dt", { text: "拆解范围" }), el("dd", { text: level.scope })),
            el("div", {}, el("dt", { text: "包含" }), el("dd", {}, chips(level.inclusions, "ok"))),
            el("div", {}, el("dt", { text: "不展开" }), el("dd", {}, chips(level.exclusions, "off"))),
            el("div", {}, el("dt", { text: "适用场景" }), el("dd", { text: level.bestFor })),
          ),
        ),
      );
    }
    return list;
  }

  function renderDimensions(table1) {
    const body = el("tbody");
    for (const dimension of table1.constraintDimensions) {
      body.append(
        el(
          "tr",
          {},
          el("td", {}, el("strong", { text: dimension.name })),
          el("td", {}, el("code", { text: dimension.id })),
          el("td", { text: dimension.unit || "—" }),
          el("td", { text: (dimension.examples || []).join(" / ") || "—" }),
          el("td", { text: dimension.verification || "—" }),
        ),
      );
    }
    return el(
      "div",
      { class: "table-scroll" },
      el(
        "table",
        { class: "doc-table" },
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", { text: "维度" }),
            el("th", { text: "id" }),
            el("th", { text: "单位" }),
            el("th", { text: "示例" }),
            el("th", { text: "验证方式" }),
          ),
        ),
        body,
      ),
    );
  }

  function renderFunctions(contract, questions) {
    const titleById = new Map((questions || []).map((question) => [question.id, question.title]));
    const body = el("tbody");
    for (const fn of contract.functions) {
      body.append(
        el(
          "tr",
          {},
          el("td", {}, el("code", { text: fn.name })),
          el("td", { text: `Q · ${titleById.get(fn.questionId) || fn.questionId}` }),
          el("td", { text: fn.output }),
          el("td", { text: String(fn.maxItems) }),
        ),
      );
    }
    return el(
      "div",
      { class: "table-scroll" },
      el(
        "table",
        { class: "doc-table" },
        el(
          "thead",
          {},
          el("tr", {}, el("th", { text: "预设函数" }), el("th", { text: "对应问题" }), el("th", { text: "输出" }), el("th", { text: "条目上限" })),
        ),
        body,
      ),
    );
  }

  function renderNav(items) {
    const nav = $("#docNav");
    for (const item of items) nav.append(el("a", { href: `#${item.id}`, text: item.label }));
  }

  function render(data) {
    const { table1, contract, questions } = data;
    const levelNameOf = (id) => table1.bomLevels.find((level) => level.id === id)?.name || id;
    const modules = table1.productTypes.flatMap((type) => type.modules || []);
    const parts = modules.flatMap((module) => module.parts || []);

    $("#docMeta").textContent =
      `表1 v${table1.version} · 更新于 ${table1.updatedAt} · ` +
      `${table1.productTypes.length} 个商品类型 / ${modules.length} 个模块 / ${parts.length} 个零件 / ` +
      `${table1.bomLevels.length} 个拆解层级。AI 只能从这张表里选 code，不能自造。`;
    $("#docFooterMeta").textContent = `${table1.name} · v${table1.version} · ${table1.updatedAt}`;
    document.title = `${table1.name} · v${table1.version}`;

    renderNav([
      { id: "types", label: `商品类型 ${table1.productTypes.length}` },
      { id: "modules", label: `模块与零件 ${modules.length}/${parts.length}` },
      { id: "levels", label: `拆解层级 ${table1.bomLevels.length}` },
      { id: "dimensions", label: `约束维度 ${table1.constraintDimensions.length}` },
      { id: "functions", label: "预设函数" },
      { id: "format", label: "格式与编码" },
    ]);

    const body = $("#docBody");
    body.replaceChildren(
      section(
        "types",
        "商品类型",
        "PRODUCT TYPES · AI 只能选这里列出的 id",
        renderTypes(table1, levelNameOf),
      ),
      section(
        "modules",
        "模块与零件",
        "L2 MODULES / L3 PARTS · 编码前缀即可读出层级",
        renderModules(table1),
      ),
      section(
        "levels",
        "拆解层级",
        "BOM LEVELS · 原材料拆到哪一层",
        renderLevels(table1),
      ),
      section(
        "dimensions",
        "约束维度",
        "CONSTRAINT DIMENSIONS · 硬约束的归类口径",
        renderDimensions(table1),
      ),
      section(
        "functions",
        "预设函数",
        "PRESET FUNCTIONS · AI 输出进入系统的唯一通道",
        renderFunctions(contract, questions),
      ),
      section(
        "format",
        "格式与编码",
        "FORMAT · 表1 自身的字段与选择规则",
        renderFormat(table1),
      ),
      table1.note ? el("p", { class: "doc-note", text: table1.note }) : null,
    );
  }

  load()
    .then(render)
    .catch((error) => {
      $("#docBody").replaceChildren(
        el("p", { class: "doc-error", text: `读取表1失败：${error.message}。请确认服务仍在运行，然后刷新本页。` }),
      );
      $("#docMeta").textContent = "表1 未能加载。";
    });
})();
