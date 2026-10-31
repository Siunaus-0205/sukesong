"use strict";

/**
 * 第二页 · 方案配置与对比
 *
 * 入口：next.html?handoff=<令牌>（正式）或 next.html?demo=1（本地演示）
 * 数据：public/data/h3-parts.json（28 个零件类型 × 4 个型号）
 *
 * 结构：
 *   - 左栏：用户自配器。从系统推荐复制或从零开始，创建用户自配 1/2/3…
 *   - 中栏：对比矩阵。列 = 系统推荐 + 用户自配；行 = 模块 / 零件类型；
 *           格子 = 该方案选中的零件名，悬停显示核心参数。
 *   - 右栏：零件详情 + 模型占位。
 *
 * 只有所有用户自配方案都填满 28 个零件类型，"开始对比"才可用。
 */

(() => {
  const DEMO = new URLSearchParams(location.search).get("demo") === "1";
  const TOKEN = (new URLSearchParams(location.search).get("handoff") || "").trim();
  const STORAGE_PREFIX = "atlas.stage2";
  // 与 next.css 的 68px / 160px 保持一致：方案少时铺满，方案多时横向滚动。
  const TYPE_COL_WIDTH = 68;
  const SCHEME_COL_WIDTH = 160;

  const state = {
    payload: null,
    library: null,
    modules: [],
    partTypes: new Map(),
    variants: new Map(),
    system: new Map(),
    heroConstraints: [],
    schemes: [],
    schemeSeq: 0,
    activeSchemeId: null,
    expandedType: null,
    inspected: null,
    compareMode: false,
    tab: "compare",
    storageKey: "",
    handoffName: "",
    resetArmed: false,
    resetTimer: 0,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "style") node.style.cssText = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, value === true ? "" : String(value));
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  function fmtMoney(value) {
    return `¥ ${Math.round(Number(value) || 0).toLocaleString("zh-CN")}`;
  }

  function fmtWeight(value) {
    const number = Math.round((Number(value) || 0) * 10) / 10;
    return `${number.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} g`;
  }

  function fmtLead(value) {
    return `${Number(value) || 0} 天`;
  }

  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.hidden = false;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      node.classList.remove("show");
      setTimeout(() => {
        node.hidden = true;
      }, 200);
    }, 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    }
  }

  class BootError extends Error {
    constructor(title, message, retry = true) {
      super(message);
      this.title = title;
      this.retry = retry;
    }
  }

  async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    try {
      const [tableData, library, handoff] = await Promise.all([
        fetchJson("/api/table1").catch(() => null),
        fetchJson("./data/h3-parts.json"),
        loadPayload(),
      ]);
      init(library, handoff, tableData);
      renderAll();
      switchTab(state.tab);
    } catch (error) {
      const known = error instanceof BootError;
      showBootError(
        known ? error.title : "第二页加载失败",
        known ? error.message : error?.message || "未知错误",
        known ? error.retry : true,
      );
    }
  }

  async function loadPayload() {
    if (DEMO) {
      const payload = await fetchJson("./data/demo-requirement.json");
      return { payload, name: payload.projectName || "" };
    }
    if (!TOKEN) {
      throw new BootError(
        "没有交接令牌",
        "本页需要从第一页点击「进入下一阶段」进入；直接打开时拿不到需求数据。",
        false,
      );
    }
    const response = await fetch(`/api/handoff/${encodeURIComponent(TOKEN)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        throw new BootError(
          "登录已失效",
          "交接内容只对生成它的身份码开放。请回到第一页重新登录，再点一次「进入下一阶段」。",
          false,
        );
      }
      if (response.status === 404 || response.status === 410) {
        throw new BootError(
          "交接已过期或不存在",
          data.message || "请回到第一页重新进入下一阶段。",
          false,
        );
      }
      throw new BootError(
        "交接读取失败",
        `${data.message || "服务返回错误"}（HTTP ${response.status}）`,
      );
    }
    return { payload: data.payload, name: data.name || "" };
  }

  function init(library, handoff, tableData) {
    const payload = handoff.payload;
    state.library = library;
    state.payload = payload;
    state.handoffName = handoff.name || "";
    globalThis.__STAGE2_PAYLOAD__ = payload;

    const libraryParts = new Map();
    for (const module of library.modules || []) {
      for (const part of module.parts || []) libraryParts.set(part.code, part);
    }

    const tableType =
      (tableData?.table1?.productTypes || []).find((type) => type.id === library.productType) ||
      (tableData?.table1?.productTypes || [])[0];
    const tableModules = tableType?.modules?.length ? tableType.modules : library.modules || [];

    state.modules = tableModules.map((module, index) => ({
      ...module,
      index: module.index || index + 1,
      parts: (module.parts || [])
        .map((part) => {
          const source = libraryParts.get(part.code) || part;
          return {
            ...part,
            variants: source.variants || [],
            baselineVariantId: source.baselineVariantId,
          };
        })
        .filter((part) => (part.variants || []).length > 0),
    }));

    for (const module of state.modules) {
      for (const part of module.parts) {
        const type = {
          ...part,
          moduleCode: module.code,
          moduleName: module.name,
          moduleIndex: module.index,
        };
        state.partTypes.set(type.code, type);
        for (const variant of type.variants || []) {
          state.variants.set(variant.id, {
            ...variant,
            typeCode: type.code,
            typeName: type.name,
            qty: type.qty,
            moduleCode: module.code,
            moduleName: module.name,
          });
        }
      }
    }

    state.system = new Map(
      [...state.partTypes.keys()].map((code) => [code, state.partTypes.get(code).baselineVariantId]),
    );
    state.storageKey = `${STORAGE_PREFIX}.${DEMO ? "demo" : TOKEN.slice(0, 16)}`;
    state.inspected = defaultInspection();
    restoreState();
  }

  function defaultInspection() {
    const first = state.partTypes.values().next().value;
    if (!first) return null;
    return { variantId: first.baselineVariantId, schemeId: "system" };
  }

  function restoreState() {
    try {
      const raw = sessionStorage.getItem(state.storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return;

      if (Array.isArray(saved.schemes)) {
        state.schemes = saved.schemes
          .filter(
            (scheme) =>
              scheme &&
              typeof scheme.id === "string" &&
              typeof scheme.name === "string" &&
              scheme.id !== "system",
          )
          .map((scheme) => ({
            id: scheme.id,
            name: scheme.name,
            mode: scheme.mode === "system" ? "system" : "zero",
            parts: sanitizeParts(scheme.parts),
          }));
      }

      state.schemeSeq = Math.max(Number(saved.schemeSeq) || 0, state.schemes.length);
      renumberSchemes();
      state.activeSchemeId = state.schemes.some((scheme) => scheme.id === saved.activeSchemeId)
        ? saved.activeSchemeId
        : state.schemes[0]?.id ?? null;
      state.compareMode = Boolean(saved.compareMode) && canCompare();
      if (saved.expandedType && state.partTypes.has(saved.expandedType)) {
        state.expandedType = saved.expandedType;
      }
      if (
        state.inspected?.schemeId !== "system" &&
        !state.schemes.some((scheme) => scheme.id === state.inspected?.schemeId)
      ) {
        state.inspected = defaultInspection();
      }
    } catch {
      /* 会话存储不可用时忽略 */
    }
  }

  function sanitizeParts(raw) {
    const parts = {};
    if (!raw || typeof raw !== "object") return parts;
    for (const [typeCode, variantId] of Object.entries(raw)) {
      if (!state.partTypes.has(typeCode)) continue;
      const variant = state.variants.get(variantId);
      if (!variant || variant.typeCode !== typeCode) continue;
      parts[typeCode] = variantId;
    }
    return parts;
  }

  function saveState() {
    try {
      sessionStorage.setItem(
        state.storageKey,
        JSON.stringify({
          schemes: state.schemes,
          schemeSeq: state.schemeSeq,
          activeSchemeId: state.activeSchemeId,
          compareMode: state.compareMode,
          expandedType: state.expandedType,
        }),
      );
    } catch {
      /* 忽略 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 状态查询                                                            */
  /* ------------------------------------------------------------------ */

  function activeScheme() {
    return state.schemes.find((scheme) => scheme.id === state.activeSchemeId) ?? null;
  }

  function schemeById(id) {
    return state.schemes.find((scheme) => scheme.id === id) ?? null;
  }

  // 列名永远按当前顺序从 1 开始顺连；删除中间方案后不留空号。
  function renumberSchemes() {
    state.schemes.forEach((scheme, index) => {
      scheme.name = `用户自配${index + 1}`;
    });
  }

  function totalPartTypes() {
    return state.partTypes.size;
  }

  function countSelected(parts) {
    let count = 0;
    for (const code of state.partTypes.keys()) {
      if (variantIdOf(parts, code)) count += 1;
    }
    return count;
  }

  function variantIdOf(parts, typeCode) {
    if (!parts) return null;
    if (parts instanceof Map) return parts.get(typeCode) || null;
    return parts[typeCode] || null;
  }

  function isComplete(scheme) {
    return countSelected(scheme?.parts) === totalPartTypes();
  }

  function canCompare() {
    return state.schemes.length > 0 && state.schemes.every(isComplete);
  }

  function totalsFor(parts) {
    let price = 0;
    let weight = 0;
    let lead = 0;
    let count = 0;
    const entries = parts instanceof Map ? parts.entries() : Object.entries(parts || {});
    for (const [typeCode, variantId] of entries) {
      const variant = state.variants.get(variantId);
      if (!variant || variant.typeCode !== typeCode) continue;
      count += 1;
      price += variant.price * variant.qty;
      weight += variant.weight * variant.qty;
      lead = Math.max(lead, variant.leadTime);
    }
    return { price, weight, lead, count };
  }

  function diffForType(typeCode) {
    const ids = new Set();
    const systemVariant = state.system.get(typeCode);
    if (systemVariant) ids.add(systemVariant);
    for (const scheme of state.schemes) {
      const variant = scheme.parts[typeCode];
      if (variant) ids.add(variant);
    }
    return ids.size > 1;
  }

  function diffCount() {
    let count = 0;
    for (const code of state.partTypes.keys()) {
      if (diffForType(code)) count += 1;
    }
    return count;
  }

  /* ------------------------------------------------------------------ */
  /* 约束校验                                                            */
  /* ------------------------------------------------------------------ */

  function normalizeOperator(raw) {
    const value = String(raw ?? "").trim();
    const map = {
      "≤": "<=",
      "≦": "<=",
      "≥": ">=",
      "≧": ">=",
      "＜": "<",
      "＞": ">",
      "＝": "=",
      "==": "=",
      "=<": "<=",
      "=>": ">=",
      "不超过": "<=",
      "最多": "<=",
      "小于等于": "<=",
      "不少于": ">=",
      "至少": ">=",
      "大于等于": ">=",
      "低于": "<",
      "小于": "<",
      "高于": ">",
      "大于": ">",
      "等于": "=",
    };
    if (map[value]) return map[value];
    return ["<=", ">=", "<", ">", "="].includes(value) ? value : null;
  }

  function parseNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function compareNumber(actual, operator, target) {
    switch (operator) {
      case "<=":
        return actual <= target;
      case ">=":
        return actual >= target;
      case "<":
        return actual < target;
      case ">":
        return actual > target;
      case "=":
        return actual === target;
      default:
        return false;
    }
  }

  function constraintTarget(constraint) {
    const dimension = String(constraint.dimension || "").toLowerCase();
    const raw = parseNumber(constraint.value);
    if (raw === null) return null;
    const unit = String(constraint.unit || "").toLowerCase();

    if (dimension === "weight") {
      const factor =
        unit.includes("kg") || unit.includes("千克") || unit.includes("公斤")
          ? 1000
          : unit.includes("mg")
            ? 0.001
            : 1;
      return { value: raw * factor, text: `${raw} ${constraint.unit || "g"}` };
    }
    if (dimension === "budget" || dimension === "cost") {
      const factor = unit.includes("万") ? 10000 : unit.includes("千") ? 1000 : 1;
      return { value: raw * factor, text: `${raw} ${constraint.unit || "CNY"}` };
    }
    if (["lead_time", "leadtime", "delivery"].includes(dimension)) {
      const factor =
        unit.includes("周") || unit.includes("week")
          ? 7
          : unit.includes("月") || unit.includes("month")
            ? 30
            : 1;
      return { value: raw * factor, text: `${raw} ${constraint.unit || "day"}` };
    }
    return null;
  }

  function operatorSymbol(raw) {
    const operator = normalizeOperator(raw);
    const symbols = { "<=": "≤", ">=": "≥", "<": "<", ">": ">", "=": "=" };
    return symbols[operator] || String(raw ?? "").trim();
  }

  function unitLabel(raw) {
    const unit = String(raw || "").trim();
    if (!unit) return "";
    if (unit.toLowerCase() === "cny" || unit === "元") return "元";
    if (unit.toLowerCase() === "day" || unit === "天") return "天";
    return unit;
  }

  function displayOf(constraint) {
    const name = constraint.name ? String(constraint.name) : constraintLabel(constraint);
    const operator = operatorSymbol(constraint.operator);
    const value = constraint.value ?? "";
    if (name && operator && value !== "") {
      const unit = unitLabel(constraint.unit);
      return `${name} ${operator} ${value}${unit ? ` ${unit}` : ""}`;
    }
    if (constraint.display) return String(constraint.display);
    return `${name} ${constraint.operator || ""} ${value}${constraint.unit || ""}`;
  }

  function constraintLabel(constraint) {
    const dimension = String(constraint.dimension || "").toLowerCase();
    const labels = {
      weight: "整机重量",
      budget: "BOM 成本",
      cost: "BOM 成本",
      lead_time: "交付周期",
      leadtime: "交付周期",
      delivery: "交付周期",
      ingress: "防护等级",
    };
    return constraint.name || labels[dimension] || "硬约束";
  }

  function evaluateConstraint(constraint, totals) {
    const dimension = String(constraint.dimension || "").toLowerCase();
    const operator = normalizeOperator(constraint.operator);
    const target = constraintTarget(constraint);

    if (dimension === "none") return { supported: false, skipped: true };
    if (!["weight", "budget", "cost", "lead_time", "leadtime", "delivery"].includes(dimension)) {
      return {
        supported: false,
        display: displayOf(constraint),
        reason: "该维度暂不支持自动校验，需人工确认",
      };
    }
    if (!operator || !target) {
      return { supported: false, display: displayOf(constraint), reason: "无法解析数值或运算符" };
    }

    let actual;
    let actualText;
    if (dimension === "weight") {
      actual = totals.weight;
      actualText = fmtWeight(actual);
    } else if (dimension === "budget" || dimension === "cost") {
      actual = totals.price;
      actualText = fmtMoney(actual);
    } else if (["lead_time", "leadtime", "delivery"].includes(dimension)) {
      actual = totals.lead;
      actualText = fmtLead(actual);
    } else {
      return { supported: false, display: displayOf(constraint), reason: "维度暂不支持自动校验" };
    }

    return {
      supported: true,
      ok: compareNumber(actual, operator, target.value),
      display: displayOf(constraint),
      actualText,
      targetText: target.text,
    };
  }

  function evaluateConstraints(totals) {
    const constraints = state.payload?.result?.constraints || [];
    const violations = [];
    const unsupported = [];
    let checked = 0;
    let total = 0;

    for (const constraint of constraints) {
      if (String(constraint.dimension || "").toLowerCase() === "none") continue;
      total += 1;
      const result = evaluateConstraint(constraint, totals);
      if (!result.supported) {
        if (!result.skipped) unsupported.push(result.display || displayOf(constraint));
        continue;
      }
      checked += 1;
      if (!result.ok) {
        violations.push({
          display: result.display,
          actualText: result.actualText,
          targetText: result.targetText,
        });
      }
    }

    return { violations, unsupported, checked, total };
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：顶部 / 左栏 / 中栏 / 右栏                                      */
  /* ------------------------------------------------------------------ */

  function renderAll() {
    hideTooltip();
    renderHeroConstraints();
    renderProject();
    renderActiveBar();
    renderTree();
    renderMatrix();
    renderInspector();
    renderCompareState();
    saveState();
  }

  // 把第一页的硬约束直接放到标题位置；每一条都可悬停 / 聚焦查看条件与基线状态。
  function renderHeroConstraints() {
    const host = $("#heroConstraints");
    if (!host) return;
    const constraints = (state.payload?.result?.constraints || []).filter(
      (constraint) => String(constraint.dimension || "").toLowerCase() !== "none",
    );
    state.heroConstraints = constraints;
    host.replaceChildren();
    host.classList.toggle("is-empty", constraints.length === 0);

    if (constraints.length === 0) {
      host.textContent = "本需求未设置硬约束";
      return;
    }

    const nodes = [];
    constraints.forEach((constraint, index) => {
      nodes.push(
        h("span", {
          class: "s2-constraint-phrase",
          tabindex: "0",
          "data-constraint-index": String(index),
          text: displayOf(constraint),
        }),
      );
      if (index < constraints.length - 1) {
        nodes.push(h("span", { class: "s2-constraint-sep", "aria-hidden": "true", text: "·" }));
      }
    });
    host.append(...nodes);
  }

  function renderProject() {
    const product = state.payload?.result?.productType;
    const name =
      state.handoffName || state.payload?.projectName || product?.name || "未命名需求";
    const constraints = state.payload?.result?.constraints || [];

    $("#projectName").textContent = name;
    $("#projectMeta").textContent = `${product?.code || "h3"} · ${constraints.length} 条硬约束${
      DEMO ? " · 演示数据" : ""
    }`;
    document.title = `${name} · ATLAS 方案配置`;
  }

  function renderActiveBar() {
    const bar = $("#activeBar");
    const active = activeScheme();
    if (!active) {
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }

    const done = countSelected(active.parts);
    const clear = h("button", { type: "button", text: "清空当前方案" });
    clear.addEventListener("click", () => {
      active.parts = {};
      state.compareMode = false;
      renderAll();
      toast(`已清空 ${active.name}。`);
    });

    bar.hidden = false;
    bar.replaceChildren(
      h("span", { text: "正在编辑" }),
      h("strong", { text: active.name }),
      h("span", { class: "s2-active-progress", text: `${done}/${totalPartTypes()}` }),
      clear,
    );
  }

  function renderTree() {
    const tree = $("#partTree");
    const active = activeScheme();
    tree.replaceChildren();

    for (const module of state.modules) {
      const section = h("section", { class: "s2-module" });
      let moduleDone = 0;
      for (const part of module.parts) {
        if (active?.parts[part.code]) moduleDone += 1;
      }

      section.append(
        h(
          "header",
          { class: "s2-module-head" },
          h("span", {
            class: "s2-module-index",
            text: String(module.index || 0).padStart(2, "0"),
          }),
          h("strong", { text: module.name }),
          h("span", {
            class: "s2-module-progress",
            text: `${moduleDone}/${module.parts.length}`,
          }),
        ),
      );

      for (const part of module.parts) {
        const type = state.partTypes.get(part.code);
        const selectedId = active?.parts[part.code] || null;
        const selected = selectedId ? state.variants.get(selectedId) : null;
        const expanded = state.expandedType === part.code;

        const toggle = h("button", {
          type: "button",
          class: `s2-type-toggle${expanded ? " expanded" : ""}`,
          "data-type-toggle": part.code,
          "aria-expanded": String(expanded),
        });
        toggle.append(
          h("span", { class: "s2-type-name", text: part.name }),
          h("span", {
            class: `s2-type-current${selected ? " filled" : ""}`,
            text: selected ? selected.name : "未选择",
          }),
          h("span", { class: "s2-type-chevron", text: "›" }),
        );
        section.append(toggle);

        if (expanded) {
          const list = h("div", { class: "s2-variants" });
          for (const variant of type.variants) {
            const isSelected = selectedId === variant.id;
            const card = h("div", {
              class: `s2-variant${isSelected ? " selected" : ""}`,
              "data-variant-id": variant.id,
            });
            const main = h("button", {
              type: "button",
              class: "s2-variant-main",
              "data-inspect-variant": variant.id,
            });
            main.append(
              h(
                "span",
                { class: "s2-variant-name" },
                h("span", { class: "s2-tier", text: variant.tier }),
                variant.name,
              ),
              h("span", {
                class: "s2-variant-meta",
                text: `¥${variant.price.toLocaleString("zh-CN")} · ${variant.weight} g · ${variant.leadTime} 天`,
              }),
            );
            const add = h("button", {
              type: "button",
              class: "s2-add",
              "data-add-variant": variant.id,
              "data-add-type": type.code,
              "data-selected": isSelected ? "1" : "0",
              text: isSelected ? "取消" : "加入",
            });
            card.append(main, add);
            list.append(card);
          }
          section.append(list);
        }
      }

      tree.append(section);
    }

    $("#treeSummary").textContent = `${totalPartTypes()} 个零件类型 · ${state.schemes.length} 个用户方案`;
  }

  function warnBadge(violations) {
    const tip = `不满足硬条件：${violations.map((item) => item.display).join("；")}`;
    return h("span", { class: "s2-warn", "data-tip": tip, text: "!" });
  }

  function allColumns() {
    const columns = [];
    const systemTotal = totalsFor(state.system);
    columns.push({
      id: "system",
      name: "系统推荐",
      system: true,
      parts: state.system,
      complete: true,
      total: systemTotal,
      check: evaluateConstraints(systemTotal),
    });

    for (const scheme of state.schemes) {
      const complete = isComplete(scheme);
      const total = totalsFor(scheme.parts);
      columns.push({
        id: scheme.id,
        name: scheme.name,
        system: false,
        parts: scheme.parts,
        complete,
        total,
        check: complete
          ? evaluateConstraints(total)
          : { violations: [], unsupported: [], checked: 0, total: 0 },
      });
    }
    return columns;
  }

  function renderMatrix() {
    const table = $("#matrix");
    const columns = allColumns();
    table.classList.toggle("compare", state.compareMode);
    table.style.width = `max(100%, ${
      TYPE_COL_WIDTH + columns.length * SCHEME_COL_WIDTH
    }px)`;
    table.replaceChildren();

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.append(
      h(
        "th",
        { class: "s2-corner", scope: "col" },
        h("span", { class: "s2-corner-label", text: "PARTS" }),
        h("span", { class: "s2-corner-hint", text: "零件类型" }),
      ),
    );

    for (const column of columns) {
      headRow.append(buildColumnHeader(column));
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    for (const module of state.modules) {
      const moduleRow = document.createElement("tr");
      moduleRow.className = "module-row";
      const moduleCell = h("th", { colspan: String(columns.length + 1) });
      moduleCell.append(
        h("span", { text: String(module.index || 0).padStart(2, "0") }),
        module.name,
      );
      moduleRow.append(moduleCell);
      tbody.append(moduleRow);

      for (const part of module.parts) {
        const row = document.createElement("tr");
        const typeCell = h("th", {
          class: "s2-type",
          scope: "row",
          title: `${part.name} · ${part.code} ×${part.qty}`,
        });
        typeCell.append(
          h(
            "span",
            { class: "s2-type-name", text: part.name },
            Number(part.qty) > 1
              ? h("em", { class: "s2-type-qty", text: `×${part.qty}` })
              : null,
          ),
        );
        row.append(typeCell);

        const isDiff = state.compareMode && diffForType(part.code);
        for (const column of columns) {
          const variantId = variantIdOf(column.parts, part.code);
          const variant = variantId ? state.variants.get(variantId) : null;
          const cell = h("td", {
            class: `s2-cell${column.system ? " is-system" : " editable"}${
              isDiff ? " is-diff" : ""
            }`,
            "data-type-code": part.code,
            "data-scheme-id": column.id,
            ...(variantId ? { "data-variant-id": variantId } : {}),
          });
          if (variant) {
            cell.append(h("span", { class: "s2-cell-name", text: variant.name }));
          } else {
            cell.append(h("span", { class: "s2-cell-empty", text: "未选择" }));
          }
          cell.addEventListener("click", () => {
            if (column.system) {
              if (variantId) inspectVariant(variantId, "system");
              return;
            }
            openTypeForScheme(column.id, part.code);
          });
          row.append(cell);
        }
        tbody.append(row);
      }
    }
    table.append(tbody);

    const tfoot = document.createElement("tfoot");
    const footRow = document.createElement("tr");
    footRow.append(h("th", { scope: "row", title: "合计 / 硬条件", text: "合计" }));
    for (const column of columns) {
      const cell = h("td", { class: column.system ? "is-system" : "" });
      if (column.complete) {
        cell.append(
          h("strong", {
            text: `${fmtMoney(column.total.price)} · ${fmtWeight(column.total.weight)}`,
          }),
          h("span", {
            text: `${fmtLead(column.total.lead)} · ${
              column.check.violations.length
                ? `不满足 ${column.check.violations.length} 条`
                : "硬条件通过"
            }`,
          }),
        );
      } else {
        cell.append(
          h("strong", { text: "—" }),
          h("span", { text: `未完成 ${countSelected(column.parts)}/${totalPartTypes()}` }),
        );
      }
      footRow.append(cell);
    }
    tfoot.append(footRow);
    table.append(tfoot);
  }

  function buildColumnHeader(column) {
    const th = h("th", {
      class: `s2-col${column.system ? " is-system" : ""}${
        column.id === state.activeSchemeId ? " is-active" : ""
      }`,
      scope: "col",
    });

    const title = h("div", { class: "s2-col-title" });
    title.append(h("span", { text: column.name }));
    if (column.system) {
      title.append(h("span", { class: "s2-lock", text: "只读" }));
    } else {
      const remove = h("button", {
        type: "button",
        class: "s2-remove",
        "data-remove-scheme": column.id,
        "aria-label": `删除 ${column.name}`,
        text: "×",
      });
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        removeScheme(column.id);
      });
      title.append(remove);
      th.addEventListener("click", () => selectScheme(column.id));
    }

    if (column.check.violations.length > 0) {
      title.append(warnBadge(column.check.violations));
    }

    const meta = h("div", { class: "s2-col-meta" });
    if (column.complete) {
      meta.append(
        h("span", { class: "s2-money", text: fmtMoney(column.total.price) }),
        " · ",
        fmtWeight(column.total.weight),
      );
    } else {
      meta.textContent = `${countSelected(column.parts)}/${totalPartTypes()} · 未完成`;
    }

    const done = countSelected(column.parts);
    const progress = h(
      "div",
      { class: `s2-col-progress${column.complete ? "" : " incomplete"}` },
      h("i", { style: `width:${Math.round((done / totalPartTypes()) * 100)}%` }),
    );

    th.append(title, meta, progress);
    return th;
  }

  function cubeSvg() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 32 32");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m16 3 12 7v13l-12 7-12-7V10zM4 10l12 7 12-7M16 17v13M10 6.5l12 7");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.2");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }

  function renderInspector() {
    const inspector = $("#inspector");
    const inspected = state.inspected;
    const variant = inspected ? state.variants.get(inspected.variantId) : null;

    if (!variant) {
      inspector.replaceChildren(
        h(
          "div",
          { class: "s2-inspector-empty" },
          h("strong", { text: "选择一个零件" }),
          h("span", {
            text: "从左侧展开零件类型，或点击对比表里的格子，查看核心参数与示意模型位。",
          }),
        ),
      );
      return;
    }

    const type = state.partTypes.get(variant.typeCode);

    const head = h("div", { class: "s2-inspector-head" });
    head.append(
      h("span", { class: "kicker", text: "PART DETAIL" }),
      h("h2", { text: variant.name }),
      h("span", { class: "s2-inspector-code", text: `${type.code} / ${variant.id}` }),
    );

    const badges = h("div", { class: "s2-inspector-badges" });
    badges.append(
      h("span", { class: "s2-chip accent", text: variant.tier }),
      h("span", { class: "s2-chip", text: type.moduleName }),
      h("span", { class: "s2-chip", text: `${variant.risk}风险` }),
    );

    const modelSlot = h(
      "div",
      { class: "s2-model-slot", "aria-label": "示意模型占位" },
      cubeSvg(),
      h("strong", { text: "示意模型 · 位已预留" }),
      h("small", { text: "MODEL SLOT / PENDING" }),
    );

    const details = h("dl", { class: "s2-detail-list" });
    const rows = [
      ["所属模块", type.moduleName],
      ["零件类型", type.name],
      ["用量", `×${type.qty}`],
      ["材料 / 类型", variant.material || "—"],
      ["关键规格", variant.spec || "—"],
      ["原型单价", fmtMoney(variant.price)],
      ["单件重量", fmtWeight(variant.weight)],
      ["采购周期", fmtLead(variant.leadTime)],
      ["风险", `${variant.risk}风险`],
      ["责任人", variant.owner || "—"],
    ];
    for (const [label, value] of rows) {
      details.append(
        h("div", { class: "s2-detail-row" }, h("dt", { text: label }), h("dd", { text: value })),
      );
    }

    const action = h("button", { type: "button", class: "primary-button s2-inspector-action" });
    const active = activeScheme();

    if (inspected.schemeId === "system") {
      action.disabled = true;
      action.textContent = "系统推荐不可修改";
    } else if (!active) {
      action.disabled = true;
      action.textContent = "先创建一个用户自配方案";
    } else if (active.parts[variant.typeCode] === variant.id) {
      action.textContent = `从 ${active.name} 移除`;
      action.addEventListener("click", () => removeVariant(variant.typeCode));
    } else {
      action.textContent = `加入 ${active.name}`;
      action.addEventListener("click", () => addVariant(variant.typeCode, variant.id));
    }

    inspector.replaceChildren(
      head,
      badges,
      modelSlot,
      details,
      h("p", { class: "s2-desc", text: variant.description || "" }),
      action,
    );
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：对比门槛与结果                                                */
  /* ------------------------------------------------------------------ */

  function renderCompareState() {
    const button = $("#compareBtn");
    const hint = $("#compareHint");
    const summary = $("#compareSummary");
    const incomplete = state.schemes.filter((scheme) => !isComplete(scheme));

    hint.classList.remove("warn");

    if (state.schemes.length === 0) {
      button.disabled = true;
      button.textContent = "开始对比";
      hint.textContent = "先创建一个用户自配方案";
    } else if (incomplete.length > 0) {
      const missing = incomplete.reduce(
        (total, scheme) => total + (totalPartTypes() - countSelected(scheme.parts)),
        0,
      );
      button.disabled = true;
      button.textContent = "开始对比";
      hint.classList.add("warn");
      hint.textContent = `还有 ${missing} 个零件未填：${incomplete
        .map((scheme) => scheme.name)
        .join("、")}`;
    } else {
      button.disabled = false;
      button.textContent = state.compareMode ? "重新对比" : "开始对比";
      hint.textContent = state.compareMode ? "对比已刷新" : "所有用户方案已填满，可以开始对比";
    }

    if (!state.compareMode || !canCompare()) {
      summary.hidden = true;
      summary.replaceChildren();
      return;
    }

    summary.hidden = false;
    const columns = allColumns();
    const unsupported = [...new Set(columns.flatMap((column) => column.check.unsupported))];

    const head = h(
      "div",
      { class: "s2-summary-head" },
      h("strong", { text: "对比结果" }),
      h("span", {
        text: `${columns.length} 个方案 · 差异零件 ${diffCount()} 项`,
      }),
    );

    const grid = h("div", { class: "s2-summary-grid" });
    for (const column of columns) {
      const card = h("article", {
        class: `s2-summary-card${column.system ? " is-system" : ""}${
          column.check.violations.length ? " has-violation" : ""
        }`,
      });
      const cardHead = h("header");
      cardHead.append(
        h("strong", { text: column.name }),
        h("small", { text: column.system ? "系统基线" : "用户自配" }),
      );
      if (column.check.violations.length > 0) {
        cardHead.append(warnBadge(column.check.violations));
      }
      card.append(cardHead);
      card.append(
        summaryLine("BOM 成本", fmtMoney(column.total.price)),
        summaryLine("整机重量", fmtWeight(column.total.weight)),
        summaryLine("最长交期", fmtLead(column.total.lead)),
      );

      if (column.check.violations.length > 0) {
        const list = h("ul", { class: "s2-summary-violations" });
        for (const violation of column.check.violations) {
          list.append(
            h("li", {
              text: `${violation.display}（当前 ${violation.actualText}）`,
            }),
          );
        }
        card.append(list);
      } else {
        card.append(
          h("p", {
            class: "s2-summary-ok",
            text:
              column.check.total === 0
                ? "未设置硬性约束"
                : column.check.checked === 0
                  ? "硬条件需人工确认"
                  : `硬条件通过（已校验 ${column.check.checked} 条）`,
          }),
        );
      }
      grid.append(card);
    }

    summary.replaceChildren(head, grid);
    if (unsupported.length > 0) {
      summary.append(
        h("p", {
          class: "s2-summary-note",
          text: `未能从零件数据自动校验：${unsupported.join("、")}（需人工确认）`,
        }),
      );
    }
  }

  function summaryLine(label, value) {
    return h(
      "div",
      { class: "s2-summary-line" },
      h("span", { text: label }),
      h("b", { text: value }),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 操作                                                                */
  /* ------------------------------------------------------------------ */

  function createScheme(mode) {
    state.schemeSeq += 1;
    const id = `u${Date.now().toString(36)}${state.schemeSeq}`;
    const parts = {};
    if (mode === "system") {
      for (const [typeCode, variantId] of state.system) parts[typeCode] = variantId;
    }

    const scheme = {
      id,
      name: "",
      mode,
      parts,
    };
    state.schemes.push(scheme);
    renumberSchemes();
    state.activeSchemeId = id;
    state.compareMode = false;
    state.expandedType = mode === "zero" ? [...state.partTypes.keys()][0] ?? null : null;

    const firstType = [...state.partTypes.values()][0];
    state.inspected = firstType
      ? {
          variantId: parts[firstType.code] || firstType.baselineVariantId,
          schemeId: id,
        }
      : null;

    renderAll();
    if (mode === "system") {
      toast(`已从系统推荐创建 ${scheme.name}，可以逐项替换。`);
    } else {
      toast(`已创建 ${scheme.name}，从左侧逐项加入零件。`);
    }
    scrollMatrixToEnd();
  }

  function addVariant(typeCode, variantId) {
    const active = activeScheme();
    if (!active) {
      toast("先创建一个用户自配方案。");
      return;
    }
    const variant = state.variants.get(variantId);
    if (!variant || variant.typeCode !== typeCode) return;

    active.parts[typeCode] = variantId;
    state.inspected = { variantId, schemeId: active.id };
    state.compareMode = false;
    renderAll();
    toast(`已加入 ${active.name}：${variant.name}`);
  }

  function removeVariant(typeCode) {
    const active = activeScheme();
    if (!active || !active.parts[typeCode]) {
      toast("该零件还没有加入当前方案。");
      return;
    }
    const type = state.partTypes.get(typeCode);
    delete active.parts[typeCode];
    state.compareMode = false;
    state.inspected = {
      variantId: type?.baselineVariantId,
      schemeId: active.id,
    };
    renderAll();
    toast(`已从 ${active.name} 移除 ${type?.name || "零件"}。`);
  }

  function selectScheme(id) {
    if (!schemeById(id)) return;
    state.activeSchemeId = id;
    renderAll();
  }

  function removeScheme(id) {
    const index = state.schemes.findIndex((scheme) => scheme.id === id);
    if (index === -1) return;
    const [removed] = state.schemes.splice(index, 1);
    renumberSchemes();
    if (state.activeSchemeId === id) {
      state.activeSchemeId = state.schemes[index]?.id ?? state.schemes[index - 1]?.id ?? null;
    }
    if (state.inspected?.schemeId === id) state.inspected = defaultInspection();
    state.compareMode = false;
    renderAll();
    toast(`已删除 ${removed.name}。`);
  }

  function openTypeForScheme(schemeId, typeCode) {
    const scheme = schemeById(schemeId);
    if (!scheme) return;
    state.activeSchemeId = schemeId;
    state.expandedType = typeCode;
    const selected = scheme.parts[typeCode];
    const type = state.partTypes.get(typeCode);
    state.inspected = {
      variantId: selected || type?.baselineVariantId,
      schemeId,
    };
    renderAll();
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-type-toggle="${typeCode}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function inspectVariant(variantId, schemeId) {
    const variant = state.variants.get(variantId);
    if (!variant) return;
    if (schemeId && schemeId !== "system" && schemeById(schemeId)) {
      state.activeSchemeId = schemeId;
    }
    state.inspected = { variantId, schemeId: schemeId || "system" };
    renderActiveBar();
    renderMatrix();
    renderInspector();
    saveState();
  }

  function resetSchemes() {
    if (state.schemes.length === 0 && !state.compareMode) {
      toast("当前没有用户自配方案。");
      return;
    }
    state.schemes = [];
    state.schemeSeq = 0;
    state.activeSchemeId = null;
    state.expandedType = null;
    state.compareMode = false;
    state.inspected = defaultInspection();
    try {
      sessionStorage.removeItem(state.storageKey);
    } catch {
      /* ignore */
    }
    renderAll();
    toast("已清空用户自配方案。");
  }

  function armReset() {
    const button = $("#resetBtn");
    if (!state.resetArmed) {
      state.resetArmed = true;
      button.textContent = "再点一次确认";
      button.classList.add("armed");
      clearTimeout(state.resetTimer);
      state.resetTimer = setTimeout(() => {
        state.resetArmed = false;
        button.textContent = "重置自配";
        button.classList.remove("armed");
      }, 3200);
      return;
    }
    clearTimeout(state.resetTimer);
    state.resetArmed = false;
    button.textContent = "重置自配";
    button.classList.remove("armed");
    resetSchemes();
  }

  function scrollMatrixToEnd() {
    const scroll = $("#matrixScroll");
    if (!scroll) return;
    requestAnimationFrame(() => {
      scroll.scrollLeft = scroll.scrollWidth;
    });
  }

  /* ------------------------------------------------------------------ */
  /* 标签页 / 接口占位                                                   */
  /* ------------------------------------------------------------------ */

  window.STAGE2_HOOKS = window.STAGE2_HOOKS || {
    explode: { status: "pending", mount: null },
    risk: { status: "pending", mount: null },
    team: { status: "pending", mount: null },
  };

  function switchTab(id) {
    state.tab = id;
    for (const button of $$(".s2-tab")) {
      const active = button.dataset.tab === id;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    }
    for (const view of $$(".s2-view")) {
      view.hidden = view.id !== `view-${id}`;
    }
    if (id !== "compare") mountTab(id);
  }

  function mountTab(id) {
    const view = $(`#view-${id}`);
    const hook = window.STAGE2_HOOKS?.[id];
    if (!view || !hook || typeof hook.mount !== "function") return;
    try {
      hook.mount(view, buildHookContext());
    } catch (error) {
      console.error(`[stage2] ${id} mount failed`, error);
    }
  }

  function buildHookContext() {
    return {
      payload: state.payload,
      handoffName: state.handoffName,
      library: state.library,
      system: Object.fromEntries(state.system),
      schemes: state.schemes,
      totals: {
        system: totalsFor(state.system),
        users: state.schemes.map((scheme) => totalsFor(scheme.parts)),
      },
      helpers: {
        totalsFor,
        evaluateConstraints,
        isComplete,
        partTypes: state.partTypes,
        variants: state.variants,
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* 需求 JSON 弹窗                                                      */
  /* ------------------------------------------------------------------ */

  function openPayload() {
    $("#payloadJson").textContent = JSON.stringify(state.payload, null, 2);
    $("#payloadModal").hidden = false;
    document.body.classList.add("modal-open");
  }

  function closePayload() {
    $("#payloadModal").hidden = true;
    document.body.classList.remove("modal-open");
  }

  /* ------------------------------------------------------------------ */
  /* 错误 / 提示                                                         */
  /* ------------------------------------------------------------------ */

  function showBootError(title, message, retry) {
    $("#bootError").hidden = false;
    $("#bootErrorTitle").textContent = title;
    $("#bootErrorMessage").textContent = message;
    $("#bootRetryBtn").hidden = !retry;
    $("#view-compare").hidden = true;
    $(".s2-tabs").hidden = true;
    $(".s2-footnote").hidden = true;
  }

  /* ------------------------------------------------------------------ */
  /* 悬浮提示                                                            */
  /* ------------------------------------------------------------------ */

  const tooltip = $("#tooltip");
  let tooltipTarget = null;

  function showVariantTip(target, variant) {
    if (!variant) return;
    const list = h("dl");
    for (const param of (variant.params || []).slice(0, 5)) {
      list.append(h("dt", { text: param.label }), h("dd", { text: param.value }));
    }
    tooltip.replaceChildren(h("strong", { text: variant.name }), list);
    positionTooltip(target);
  }

  function showTextTip(target, text) {
    tooltip.replaceChildren(h("strong", { text: "硬条件未满足" }), h("div", { text }));
    positionTooltip(target);
  }

  function showConstraintTip(target, index) {
    const constraint = state.heroConstraints[index];
    if (!constraint) return;
    const result = evaluateConstraint(constraint, totalsFor(state.system));
    const list = h("dl");
    list.append(
      h("dt", { text: "条件" }),
      h("dd", { text: displayOf(constraint) }),
    );
    if (result.supported) {
      list.append(
        h("dt", { text: "系统推荐" }),
        h("dd", { text: result.actualText }),
        h("dt", { text: "判定" }),
        h("dd", { text: result.ok ? "达标" : "不达标" }),
      );
    } else {
      list.append(
        h("dt", { text: "系统推荐" }),
        h("dd", { text: "—" }),
        h("dt", { text: "校验" }),
        h("dd", { text: "需人工确认" }),
      );
    }

    const note = result.supported
      ? result.ok
        ? "系统基线满足该条件。"
        : "系统基线未达标，需要在自配方案里调整。"
      : result.reason || "该维度暂不支持自动校验，需人工确认。";
    const noteNode = h("div", {
      class: `s2-tooltip-warn${result.supported && result.ok ? " is-ok" : ""}`,
      text: note,
    });

    tooltip.replaceChildren(
      h("strong", { text: `${constraintLabel(constraint)} · 硬约束` }),
      list,
      noteNode,
    );
    positionTooltip(target);
  }

  function positionTooltip(target) {
    tooltip.hidden = false;
    const rect = target.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.top - tipRect.height - 8;
    if (top < 8) top = rect.bottom + 8;
    left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, left));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTooltip() {
    tooltip.hidden = true;
    tooltipTarget = null;
  }

  /* ------------------------------------------------------------------ */
  /* 事件                                                                */
  /* ------------------------------------------------------------------ */

  document.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-scheme]");
    if (remove) {
      event.stopPropagation();
      removeScheme(remove.dataset.removeScheme);
      return;
    }

    const toggle = event.target.closest("[data-type-toggle]");
    if (toggle) {
      state.expandedType =
        state.expandedType === toggle.dataset.typeToggle ? null : toggle.dataset.typeToggle;
      renderTree();
      saveState();
      return;
    }

    const add = event.target.closest("[data-add-variant]");
    if (add) {
      if (add.dataset.selected === "1") removeVariant(add.dataset.addType);
      else addVariant(add.dataset.addType, add.dataset.addVariant);
      return;
    }

    const inspect = event.target.closest("[data-inspect-variant]");
    if (inspect) {
      inspectVariant(inspect.dataset.inspectVariant, activeScheme()?.id || "system");
    }
  });

  document.addEventListener("mouseover", (event) => {
    const target = event.target.closest(
      "[data-tip], [data-variant-id], [data-constraint-index]",
    );
    if (!target) return;
    if (target === tooltipTarget) return;
    tooltipTarget = target;
    if (target.dataset.constraintIndex !== undefined) {
      showConstraintTip(target, Number(target.dataset.constraintIndex));
      return;
    }
    if (target.dataset.tip) {
      showTextTip(target, target.dataset.tip);
      return;
    }
    const variant = state.variants.get(target.dataset.variantId);
    if (variant) showVariantTip(target, variant);
  });

  document.addEventListener("mouseout", (event) => {
    const target = event.target.closest(
      "[data-tip], [data-variant-id], [data-constraint-index]",
    );
    if (!target) return;
    if (target.contains(event.relatedTarget)) return;
    hideTooltip();
  });

  document.addEventListener("focusin", (event) => {
    const target = event.target.closest("[data-constraint-index]");
    if (!target) return;
    tooltipTarget = target;
    showConstraintTip(target, Number(target.dataset.constraintIndex));
  });

  document.addEventListener("focusout", (event) => {
    if (event.target.closest("[data-constraint-index]")) hideTooltip();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("#payloadModal").hidden) closePayload();
      hideTooltip();
    }
  });

  window.addEventListener("resize", hideTooltip);

  $("#fromSystemBtn").addEventListener("click", () => createScheme("system"));
  $("#fromZeroBtn").addEventListener("click", () => createScheme("zero"));
  $("#compareBtn").addEventListener("click", () => {
    if (!canCompare()) return;
    state.compareMode = true;
    renderAll();
    toast("对比已生成，差异零件已高亮。");
  });
  $("#resetBtn").addEventListener("click", armReset);
  $("#payloadBtn").addEventListener("click", openPayload);
  $("#payloadJson").addEventListener("click", (event) => event.stopPropagation());
  $("#copyPayloadBtn").addEventListener("click", async () => {
    const ok = await copyText(JSON.stringify(state.payload, null, 2));
    toast(ok ? "已复制需求 JSON。" : "复制失败，请手动选择文本。");
  });
  $("#bootRetryBtn").addEventListener("click", () => location.reload());

  for (const closer of $$("[data-close]")) {
    closer.addEventListener("click", closePayload);
  }

  for (const tab of $$(".s2-tab")) {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  }

  boot();
})();
