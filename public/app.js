"use strict";

/**
 * ATLAS 需求规范化 · 前端流程
 *
 * 三个问题 → 每次提交调用 /api/normalize → 弹窗逐条确认
 * 确认弹窗底部固定三个动作：
 *   1. 拒绝全部，重新提问（清空本题所有已选与 AI 结果）
 *   2. 保留已选，重新提问（保留已选条目，回到输入）
 *   3. 保留已选，继续（提交本题，进入下一问）
 *
 * 已选条目在本题后续任何一次提问中都会重新出现在选项里。
 */

(() => {
  const STORAGE_PREFIX = "atlas.requirement-intake.v2";
  const GLOBAL_KEY = "__REQUIREMENT_PAYLOAD__";
  const SCHEMA_VERSION = "atlas.requirement-baseline/v2";
  const QUESTION_ORDER = ["product_type", "hard_constraints", "parts"];
  const MAX_INPUT = 2000;
  /** 本应用写在 localStorage 里的键都以它开头，关闭页面 / 退出登录时整片清掉 */
  const CACHE_PREFIX = "atlas.";
  /** 标签页存活标记：刷新时 sessionStorage 还在 → 不清缓存；关闭后重开 → 清缓存 */
  const SESSION_FLAG = "atlasSessionAlive";
  /** 标签页心跳键（故意不用 atlas. 前缀，避免被当成业务缓存统计） */
  const TAB_PREFIX = "atlasTab:";
  const TAB_TTL_MS = 12_000;

  const state = {
    config: null,
    data: null,
    identity: null,
    products: [],
    namingName: "",
    gate: { code: "", phase: "input", exists: false, productCount: 0, busy: false, error: "" },
    busy: false,
    error: "",
    modal: null,
    renderedQuestion: null,
    resetArmed: false,
    resetTimer: 0,
    toastTimer: 0,
  };

  const $ = (selector) => document.querySelector(selector);

  function storageKey() {
    return state.identity?.code ? `${STORAGE_PREFIX}.${state.identity.code}` : STORAGE_PREFIX;
  }

  /** 清掉本应用写进 localStorage 的全部缓存（关闭页面、退出登录时调用） */
  function clearLocalCache() {
    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && key.startsWith(CACHE_PREFIX)) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }

  /* ---- 标签页存活检测：刷新保留缓存，关闭后重开才清 ---- */

  function tabStampKey(id) {
    return `${TAB_PREFIX}${id}`;
  }

  /** 同一个标签页里保持不变；关闭标签页后 sessionStorage 清空，会生成新 id */
  function currentTabId() {
    try {
      let id = sessionStorage.getItem(`${SESSION_FLAG}.id`);
      if (!id) {
        id = `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
        sessionStorage.setItem(`${SESSION_FLAG}.id`, id);
      }
      return id;
    } catch {
      return `tab${Date.now().toString(36)}`;
    }
  }

  function touchTab(id) {
    try {
      localStorage.setItem(tabStampKey(id), String(Date.now()));
    } catch {
      /* 存储不可用时忽略 */
    }
  }

  /** 除自己之外，12 秒内还有别的标签页在心跳吗 */
  function otherTabsAlive(id) {
    const now = Date.now();
    const alive = [];
    try {
      const stale = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(TAB_PREFIX)) continue;
        const stamp = Number(localStorage.getItem(key));
        const tabId = key.slice(TAB_PREFIX.length);
        if (!Number.isFinite(stamp) || now - stamp > TAB_TTL_MS) {
          stale.push(key);
          continue;
        }
        if (tabId !== id) alive.push(tabId);
      }
      for (const key of stale) localStorage.removeItem(key);
    } catch {
      /* 存储不可用时按“没有其他标签页”处理 */
    }
    return alive;
  }

  /** 注册心跳与 pagehide 清理：关闭标签页时把自己的存活标记摘掉（bfcache 返回时重新挂上） */
  function startTabHeartbeat(id) {
    let timer = 0;
    const beat = () => touchTab(id);
    const start = () => {
      beat();
      clearInterval(timer);
      timer = setInterval(beat, 3000);
    };
    const stop = () => {
      clearInterval(timer);
      timer = 0;
      try {
        localStorage.removeItem(tabStampKey(id));
      } catch {
        /* ignore */
      }
    };
    start();
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) start();
    });
  }

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                         */
  /* ------------------------------------------------------------------ */

  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function uuid() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
      const value = (Math.random() * 16) | 0;
      return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
    });
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function formatClock(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.hidden = false;
    node.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      node.classList.remove("show");
      setTimeout(() => {
        node.hidden = true;
      }, 200);
    }, 2200);
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  function blankQuestion() {
    return {
      status: "idle",
      rounds: 0,
      text: "",
      reply: "",
      items: [],
      selectedKeys: [],
      result: null,
      meta: null,
      warnings: [],
      completedAt: null,
    };
  }

  function freshData() {
    return {
      schemaVersion: SCHEMA_VERSION,
      projectId: uuid(),
      createdAt: nowIso(),
      completedAt: null,
      currentIndex: 0,
      questions: Object.fromEntries(QUESTION_ORDER.map((id) => [id, blankQuestion()])),
      payload: null,
      saved: null,
    };
  }

  function loadData() {
    const base = freshData();
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(storageKey()) || "null");
    } catch {
      stored = null;
    }
    if (!stored || typeof stored !== "object" || stored.schemaVersion !== SCHEMA_VERSION) return base;

    const merged = {
      ...base,
      ...stored,
      questions: { ...base.questions },
    };
    for (const id of QUESTION_ORDER) {
      merged.questions[id] = { ...blankQuestion(), ...(stored.questions?.[id] || {}) };
      const question = merged.questions[id];
      question.selectedKeys = Array.isArray(question.selectedKeys)
        ? question.selectedKeys.filter((key) => question.items.some((item) => item.key === key))
        : [];
    }
    merged.payload = stored.payload || null;
    syncIndex(merged);
    return merged;
  }

  function saveData() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(state.data));
    } catch {
      toast("本地存储失败：浏览器可能禁用了 localStorage。");
    }
    if (state.data.payload) {
      globalThis[GLOBAL_KEY] = state.data.payload;
    }
  }

  function syncIndex(data = state.data) {
    const index = QUESTION_ORDER.findIndex((id) => data.questions[id].status !== "done");
    data.currentIndex = index === -1 ? QUESTION_ORDER.length : index;
    return data.currentIndex;
  }

  function allDone(data = state.data) {
    return QUESTION_ORDER.every((id) => data.questions[id].status === "done");
  }

  function currentQuestionId() {
    return QUESTION_ORDER[state.data.currentIndex] ?? null;
  }

  function questionMeta(id) {
    return state.config?.questions.find((item) => item.id === id) ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* API                                                                 */
  /* ------------------------------------------------------------------ */

  async function apiNormalize(payload) {
    const response = await fetch("/api/normalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok || !body?.ok) {
      const message = body?.message || `请求失败（HTTP ${response.status}）`;
      const error = new Error(message);
      error.code = body?.code || "HTTP_ERROR";
      error.requestId = body?.requestId;
      throw error;
    }
    return body;
  }

  async function apiFetch(path, options = {}) {
    const { body, ...rest } = options;
    const response = await fetch(path, {
      ...rest,
      headers:
        body === undefined
          ? { Accept: "application/json" }
          : { "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || data?.ok === false) {
      const error = new Error(data?.message || `请求失败（HTTP ${response.status}）`);
      error.code = data?.code || "HTTP_ERROR";
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function buildContext(questionId) {
    const context = {};
    const product = state.data.questions.product_type;
    const productItem = product.items.find((item) => product.selectedKeys.includes(item.key));
    if (productItem && questionId !== "product_type") {
      context.productType = { presetId: productItem.presetId, name: productItem.name };
    }
    if (questionId === "parts") {
      const constraints = state.data.questions.hard_constraints;
      const selected = constraints.items.filter((item) => constraints.selectedKeys.includes(item.key));
      if (selected.length > 0) {
        context.constraints = selected.map((item) => ({ display: item.display }));
      }
    }
    return Object.keys(context).length > 0 ? context : null;
  }

  function buildCarryOver(question) {
    return question.items
      .filter((item) => question.selectedKeys.includes(item.key))
      .map((item) => ({ key: item.key, label: itemLabel(item) }));
  }

  function itemLabel(item) {
    if (item.display) return item.display;
    if (item.name && item.code) return `${item.code} ${item.name}`;
    return item.name || item.key;
  }

  /* ------------------------------------------------------------------ */
  /* Merging                                                             */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* Q3 预设零件模型（L1 整机 / L2 模块 / L3 零件 + 覆盖规则）            */
  /* ------------------------------------------------------------------ */

  function partsModel() {
    const type = state.config?.table1?.productTypes?.[0];
    if (!type || !Array.isArray(type.modules)) return null;
    return { type, modules: type.modules };
  }

  /** 表1 的完整条目（L1 + 7 个 L2 + 28 个 L3），按表1 顺序 */
  function buildPartsItems() {
    const model = partsModel();
    if (!model) return [];
    const items = [
      {
        key: model.type.id,
        code: model.type.id,
        name: model.type.name,
        level: "L1",
        levelName: levelNameOf("L1"),
        qty: 1,
        unit: "pcs",
        material: "",
        spec: "",
        parentCode: "",
        note: "",
        description: model.type.description || "",
      },
    ];
    model.modules.forEach((module, index) => {
      const children = Array.isArray(module.parts) ? module.parts : [];
      items.push({
        key: module.code,
        code: module.code,
        name: module.name,
        level: "L2",
        levelName: levelNameOf("L2"),
        qty: 1,
        unit: "pcs",
        material: "",
        spec: "",
        parentCode: model.type.id,
        note: "",
        description: module.description || "",
        moduleCode: module.code,
        order: index + 1,
        partCount: children.length,
      });
      for (const part of children) {
        items.push({
          key: part.code,
          code: part.code,
          name: part.name,
          level: "L3",
          levelName: levelNameOf("L3"),
          qty: part.qty,
          unit: part.unit || "pcs",
          material: part.material || "",
          spec: part.spec || "",
          parentCode: module.code,
          note: part.note || "",
          description: part.description || "",
          moduleCode: module.code,
          moduleName: module.name,
        });
      }
    });
    return items;
  }

  /**
   * 选择归一化：L1 必选；同一模块内 L2 与 L3 二选一；
   * 出现任何一个 L3 就补齐该模块全部 L3（L3 不允许缺项）。
   */
  function normalizePartSelection(keys) {
    const model = partsModel();
    if (!model) return [...keys];
    const set = new Set(keys);
    set.add(model.type.id);
    for (const module of model.modules) {
      const children = (module.parts || []).map((part) => part.code);
      const exploded = children.some((code) => set.has(code));
      if (exploded) {
        set.delete(module.code);
        for (const code of children) set.add(code);
      } else {
        set.add(module.code);
        for (const code of children) set.delete(code);
      }
    }
    return [...set];
  }

  /** 弹窗 / 只读页里真正显示的行：L3 只在所属模块未选中时出现 */
  function partsVisibleItems(question) {
    if (question.legacy) return question.items;
    return question.items.filter(
      (item) => item.level !== "L3" || !question.selectedKeys.includes(item.moduleCode),
    );
  }

  /**
   * 把新一轮 AI 结果与本题历史条目合并：
   *   - 以 key 去重；
   *   - 之前已选中的条目，即使本轮没有返回，也追加进列表并保持选中；
   *   - 新条目按本题默认策略初始化（Q1 主类型 / Q2 不选 / Q3 用 AI 的勾选集合）；
   *   - 已知条目沿用用户上一轮的选择，不被默认值覆盖。
   */
  function mergeResult(id, question, result) {
    const previousItems = Array.isArray(question.items) ? question.items : [];
    const previousSelected = new Set(question.selectedKeys || []);
    const previousByKey = new Map(previousItems.map((item) => [item.key, item]));

    const merged = [];
    const seen = new Set();

    for (const item of result.items) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      merged.push({ ...item, carried: false, known: previousByKey.has(item.key) });
    }

    for (const item of previousItems) {
      if (seen.has(item.key)) continue;
      if (!previousSelected.has(item.key)) continue;
      seen.add(item.key);
      merged.push({ ...item, carried: true, known: true });
    }

    let keys;
    if (result.selectionMode === "single") {
      const kept = [...previousSelected].find((key) => seen.has(key));
      keys = kept ? [kept] : result.items[0] ? [result.items[0].key] : [];
    } else if (Array.isArray(result.selectedKeys) && result.selectedKeys.length > 0) {
      const next = new Set(result.selectedKeys.filter((key) => seen.has(key)));
      for (const key of previousSelected) if (seen.has(key)) next.add(key);
      keys = [...next];
    } else {
      const next = new Set();
      for (const item of merged) {
        if (previousSelected.has(item.key)) next.add(item.key);
        else if (!previousByKey.has(item.key) && result.defaultSelection === "all") {
          next.add(item.key);
        }
      }
      keys = [...next];
    }

    question.items = merged;
    question.selectedKeys = id === "parts" ? normalizePartSelection(keys) : keys;
    question.result = result;
    question.reply = result.reply ?? question.reply;
    question.meta = result.meta ?? question.meta;
    question.warnings = result.warnings ?? [];
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function render() {
    renderTopbar();
    const authed = Boolean(state.identity);
    $("#identityStage").hidden = authed;
    $("#stepper").hidden = !authed;
    $("#stage").hidden = !authed;
    $("#myBtn").hidden = !authed;
    $("#resetBtn").hidden = !authed;
    if (!authed) {
      renderGate();
      return;
    }
    // 登录后清掉身份码面板，避免隐藏的输入框被误当成"已回到入口"
    $("#identityStage").replaceChildren();
    renderStepper();
    renderStage();
  }

  function renderTopbar() {
    const badge = $("#modeBadge");
    const ai = state.config?.ai;
    const tableLink = $("#tableLink");
    const myButton = $("#myBtn");

    if (myButton) {
      myButton.title = state.identity
        ? `我的 · ${state.identity.code}（${state.identity.folder}）`
        : "我的：身份码与历史产品";
    }

    if (tableLink && state.config?.table1) {
      const table = state.config.table1;
      const moduleCount = (table.productTypes?.[0]?.modules || []).length;
      const partCount = (table.productTypes?.[0]?.modules || []).reduce(
        (sum, module) => sum + (module.parts || []).length,
        0,
      );
      tableLink.textContent =
        moduleCount > 0
          ? `表1 v${table.version} · ${moduleCount} 个模块 / ${partCount} 个零件 ↗`
          : `表1 v${table.version} · ${table.productTypes.length} 个预设类型 ↗`;
      tableLink.title = `${table.name}（更新于 ${table.updatedAt}）· 打开表1 全文`;
    }

    if (!ai) {
      badge.textContent = "AI 未连接";
      badge.classList.remove("live", "error");
      badge.title = "";
      return;
    }

    if (ai.configError) {
      const fileLabel = String(ai.configFile || "ai-config.env").split(/[\\/]/).pop();
      badge.textContent = `配置错误 · 检查 ${fileLabel}`;
      badge.title = `${ai.configError}\n配置文件：${ai.configFile}`;
      badge.classList.remove("live");
      badge.classList.add("error");
      return;
    }

    const live = ai.mode === "live";
    const label = ai.providerLabel || ai.provider || "API";
    badge.textContent = live ? `${label} · ${ai.model}` : "MOCK · 本地预设函数";
    badge.title = live
      ? `${label} · ${ai.model}${ai.endpointHost ? `\n接口 ${ai.endpointHost}` : ""}\n配置 ${ai.configFile}`
      : ai.mockReason;
    badge.classList.toggle("live", live);
    badge.classList.remove("error");
  }

  function renderStepper() {
    const nav = $("#stepper");
    nav.replaceChildren();
    QUESTION_ORDER.forEach((id, index) => {
      const question = state.data.questions[id];
      const meta = questionMeta(id);
      const done = question.status === "done";
      const current = !done && index === state.data.currentIndex;
      const stateLabel = done ? "已确认" : current ? (question.status === "active" ? "进行中" : "待输入") : "未开始";
      const button = h(
        "button",
        {
          type: "button",
          class: `step${done ? " done" : ""}${current ? " current" : ""}`,
          disabled: !done,
          "aria-label": `${meta?.title || id}：${stateLabel}`,
          onclick: () => {
            if (done) openReviewModal(id);
          },
        },
        h("span", { class: "step-dot", "aria-hidden": "true", text: done ? "✓" : String(index + 1) }),
        h(
          "span",
          { class: "step-meta" },
          h("span", { class: "step-title", text: meta?.title || id }),
          h("span", { class: "step-state", text: stateLabel }),
        ),
      );
      nav.append(button);
    });
  }

  function renderStage() {
    const complete = allDone();
    const saved = Boolean(state.data.saved);

    $("#questionCard").hidden = complete;
    $("#namingCard").hidden = !complete || saved;
    $("#summaryCard").hidden = !complete || !saved;

    if (complete) {
      if (saved) renderSummary();
      else renderNaming();
      return;
    }
    renderQuestion();
  }

  function renderQuestion() {
    const id = currentQuestionId();
    const meta = questionMeta(id);
    const question = state.data.questions[id];

    $("#questionEyebrow").textContent = meta ? `${meta.eyebrow}` : id;
    $("#questionTitle").textContent = meta?.title || id;
    $("#questionPrompt").textContent = meta?.prompt || "";
    $("#helper").textContent = meta?.helper || "";

    const examples = $("#examples");
    examples.replaceChildren();
    for (const example of meta?.examples || []) {
      examples.append(
        h("button", {
          type: "button",
          class: "example-chip",
          text: example,
          onclick: () => {
            const input = $("#answerInput");
            input.value = example;
            input.dispatchEvent(new Event("input"));
            input.focus();
          },
        }),
      );
    }

    const input = $("#answerInput");
    input.placeholder = meta?.placeholder || "";
    if (state.renderedQuestion !== id) {
      input.value = question.text || "";
      state.renderedQuestion = id;
    }

    const status = $("#questionStatus");
    status.textContent = question.status === "done" ? "已完成" : question.status === "active" ? "进行中" : "待输入";
    status.className = `q-status${question.status === "done" ? " done" : question.status === "active" ? " active" : ""}`;

    $("#reopenBtn").hidden = question.items.length === 0 || !question.reply;
    $("#charCount").textContent = `${input.value.length} / ${MAX_INPUT}`;

    const errorBox = $("#errorBox");
    if (state.error) {
      errorBox.hidden = false;
      errorBox.textContent = state.error;
    } else {
      errorBox.hidden = true;
      errorBox.textContent = "";
    }

    const submit = $("#submitBtn");
    submit.disabled = state.busy;
    submit.classList.toggle("busy", state.busy);
    submit.querySelector(".btn-label").textContent = state.busy ? "AI 规范化中…" : "交给 AI 规范化";
  }

  /* ------------------------------------------------------------------ */
  /* Submit                                                              */
  /* ------------------------------------------------------------------ */

  async function submitAnswer() {
    if (state.busy) return;
    const id = currentQuestionId();
    if (!id) return;
    const question = state.data.questions[id];
    const input = $("#answerInput");
    const text = input.value.trim();

    state.error = "";
    if (text.length < 2) {
      state.error = "请多描述一点，至少输入 2 个字符。";
      renderQuestion();
      input.focus();
      return;
    }
    if (text.length > MAX_INPUT) {
      state.error = `单次输入不能超过 ${MAX_INPUT} 个字符。`;
      renderQuestion();
      return;
    }
    if (!state.config) {
      state.error = "配置尚未加载完成，请刷新页面。";
      renderQuestion();
      return;
    }

    state.busy = true;
    renderQuestion();

    try {
      const payload = {
        questionId: id,
        text,
        context: buildContext(id),
        carryOver: buildCarryOver(question),
      };
      const response = await apiNormalize(payload);

      question.rounds += 1;
      question.text = text;
      question.status = "active";
      mergeResult(id, question, {
        ...response.result,
        reply: response.reply,
        meta: {
          mode: response.mode,
          provider: response.provider,
          model: response.model,
          functionName: response.functionName,
          latencyMs: response.latencyMs,
          attempts: response.attempts,
          replySource: response.replySource,
          requestId: response.requestId,
        },
        warnings: response.warnings || [],
      });
      state.error = "";
      saveData();
      render();
      openConfirmModal(id);
    } catch (error) {
      state.error = error.message || "AI 规范化失败，请稍后重试。";
      renderQuestion();
    } finally {
      state.busy = false;
      renderQuestion();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Confirm modal                                                       */
  /* ------------------------------------------------------------------ */

  function openConfirmModal(id) {
    const question = state.data.questions[id];
    if (!question.reply || question.items.length === 0) return;
    const meta = questionMeta(id);
    const isParts = id === "parts" && !question.legacy;
    const isSingle = question.result?.selectionMode === "single";

    const itemsNode = h("ul", { class: isParts ? "req-list parts-list" : "req-list" });
    const counter = h("span", { class: "counter" });
    const continueButton = h("button", {
      type: "button",
      class: "primary-button",
      text: "保留已选，继续",
      dataset: { action: "keep-continue" },
    });

    const hint = h("p", { class: "foot-hint" });

    function visibleCounts() {
      let total = 0;
      let selected = 0;
      for (const card of itemsNode.children) {
        if (card.hidden) continue;
        total += 1;
        if (question.selectedKeys.includes(card.dataset.key)) selected += 1;
      }
      return { total, selected };
    }

    function refresh() {
      for (const card of itemsNode.children) {
        const item = card._item;
        const on = question.selectedKeys.includes(item.key);
        const hidden =
          isParts && item.level === "L3" && question.selectedKeys.includes(item.moduleCode);
        const locked = isParts && (item.level === "L1" || item.level === "L3");
        card.hidden = hidden;
        card.classList.toggle("selected", on);
        card.classList.toggle("is-locked", Boolean(locked));
        card.setAttribute("aria-checked", on ? "true" : "false");
        card.setAttribute("aria-disabled", locked ? "true" : "false");
        const lock = card.querySelector(".req-lock");
        if (lock) lock.hidden = !locked;
      }

      const { total, selected } = visibleCounts();
      counter.replaceChildren(
        document.createTextNode("已选 "),
        h("strong", { text: String(selected) }),
        document.createTextNode(` / ${total}`),
      );
      continueButton.disabled = isParts ? false : isSingle ? selected !== 1 : selected < 1;
      hint.textContent = isParts
        ? "L1 整机固定包含、不可取消；取消任何 L2 会立刻展开它的 4 个 L3 并锁定为已选，重新勾选 L2 即收回。"
        : isSingle
          ? "商品类型只能保留 1 个；未选中的候选不会写入最终 JSON。"
          : "只有被选中的条目会写入最终 JSON；虚线边框表示来自上一次提问且已被选中的条目。";
    }

    function togglePart(key) {
      const model = partsModel();
      if (!model || key === model.type.id) return;
      const module = model.modules.find((entry) => entry.code === key);
      if (!module) return; // L3 已锁定，点击无效
      const children = (module.parts || []).map((part) => part.code);
      const next = new Set(question.selectedKeys);
      if (next.has(key)) {
        next.delete(key);
        for (const code of children) next.add(code);
      } else {
        for (const code of children) next.delete(code);
        next.add(key);
      }
      question.selectedKeys = normalizePartSelection([...next]);
      saveData();
      refresh();
    }

    function toggle(key) {
      if (isParts) {
        togglePart(key);
        return;
      }
      const index = question.selectedKeys.indexOf(key);
      if (isSingle) {
        if (index === -1) question.selectedKeys = [key];
      } else if (index === -1) {
        question.selectedKeys.push(key);
      } else {
        question.selectedKeys.splice(index, 1);
      }
      saveData();
      refresh();
    }

    for (const item of question.items) {
      const selected = question.selectedKeys.includes(item.key);
      const card = h("li", {
        class: isParts ? `req-card lvl-${String(item.level).replace(/^l/i, "")}` : "req-card",
        role: isSingle ? "radio" : "checkbox",
        tabindex: "0",
        "aria-checked": selected ? "true" : "false",
        dataset: { key: item.key },
        onclick: () => toggle(item.key),
        onkeydown: (event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            toggle(item.key);
          }
        },
      });
      card._item = item;
      card.append(
        h("span", { class: "req-check", "aria-hidden": "true" }),
        h("div", { class: "req-main" }, ...cardBody(id, item)),
      );
      const tag = cardTag(id, item);
      const lock =
        isParts && (item.level === "L1" || item.level === "L3")
          ? h("span", { class: "req-lock", text: item.level === "L1" ? "固定" : "锁定" })
          : null;
      if (isParts && (tag || lock)) {
        const box = tag ?? h("div", { class: "req-tags" });
        if (lock) box.append(lock);
        card.append(box);
      } else if (tag) {
        card.append(tag);
      }
      card.classList.toggle("selected", selected);
      card.classList.toggle("carried", Boolean(item.carried));
      itemsNode.append(card);
    }

    const replyText = h("p", { class: "reply-text", text: question.reply });

    const windowEl = h(
      "div",
      {
        class: "modal-window",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "modalTitle",
        "aria-describedby": "modalReply",
      },
      h(
        "header",
        { class: "modal-head" },
        h(
          "div",
          {},
          h("span", { class: "modal-kicker", text: `${meta?.eyebrow || id} · 第 ${question.rounds} 轮规范化` }),
          h("h2", { id: "modalTitle", text: meta?.title || id }),
        ),
        h(
          "span",
          { class: "fn-badge", title: "本次 AI 输出经过的预设函数" },
          h("code", { text: question.meta?.functionName || meta?.functionName || "" }),
        ),
      ),
      h(
        "div",
        { class: "modal-body" },
        h(
          "section",
          { class: "reply-block" },
          h("span", { class: "section-label", text: "AI 回复 · 原文" }),
          replyText,
        ),
        h(
          "section",
          { class: "items-block" },
          h(
            "div",
            { class: "items-head" },
            h("span", {
              class: "section-label",
              text: isParts ? "逐条确认 · 点击模块展开 / 收回零件" : "逐条确认 · 点击卡片切换",
            }),
            counter,
          ),
          h("p", {
            class: "items-hint",
            text: isParts
              ? "L1 固定；同一模块的 L2 与 L3 二选一；L3 一旦展开就锁定为已选，保证每个零件都有归属。"
              : "边框高亮 = 已选中；只有选中的条目会进入最终结果。",
          }),
          itemsNode,
        ),
      ),
      h(
        "footer",
        { class: "modal-foot" },
        h(
          "div",
          { class: "foot-actions" },
          h("button", {
            type: "button",
            class: "danger-ghost",
            text: "拒绝全部，重新提问",
            dataset: { action: "reject-all" },
            onclick: () => actOnModal(id, "reject"),
          }),
          h("button", {
            type: "button",
            class: "secondary-button",
            text: "保留已选，重新提问",
            dataset: { action: "keep-retry" },
            onclick: () => actOnModal(id, "retry"),
          }),
          continueButton,
        ),
        hint,
      ),
    );

    continueButton.addEventListener("click", () => actOnModal(id, "continue"));

    const backdrop = h("div", { class: "modal-backdrop" }, windowEl);
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) actOnModal(id, "retry");
    });

    state.lastFocus = document.activeElement;
    $("#modalRoot").replaceChildren(backdrop);
    document.body.classList.add("modal-open");
    state.modal = { id, element: backdrop, window: windowEl };

    refresh();
    const first = itemsNode.querySelector(".req-card") || continueButton;
    first.focus();

    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        actOnModal(id, "retry");
        return;
      }
      if (event.key === "Tab") trapFocus(event, windowEl);
    };
    windowEl.addEventListener("keydown", onKeydown);
    state.modal.onKeydown = onKeydown;
  }

  function trapFocus(event, container) {
    const focusable = [
      ...container.querySelectorAll(
        'button:not([disabled]), [tabindex="0"], textarea, input, select, a[href]',
      ),
    ].filter((node) => node.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function cardBody(id, item) {
    if (id === "product_type") {
      return [
        h(
          "div",
          { class: "req-title" },
          h("span", { text: item.name }),
          h("span", { class: "req-code", text: item.code }),
        ),
        h("div", { class: "req-sub", text: item.fit }),
      ];
    }
    if (id === "hard_constraints") {
      const parts = [
        h(
          "div",
          { class: "req-title" },
          h("span", { text: item.name }),
          h("span", { class: "req-value", text: item.display }),
        ),
        h("div", {
          class: "req-sub",
          text: `${item.dimensionName} · 验证方式：${item.verification || "人工复核"}`,
        }),
      ];
      if (item.sourceText) {
        parts.push(h("div", { class: "req-source", text: `「${item.sourceText}」` }));
      }
      return parts;
    }
    if (item.level === "L1") {
      return [
        h(
          "div",
          { class: "req-title" },
          h("span", { text: item.name }),
          h("span", { class: "req-code", text: item.code }),
        ),
        h("div", { class: "req-sub", text: "整机 · 固定包含，不覆盖下级模块与零件" }),
      ];
    }
    if (item.level === "L2") {
      const order = Number.isFinite(item.order) ? String(item.order).padStart(2, "0") : "";
      return [
        h(
          "div",
          { class: "req-title" },
          order ? h("span", { class: "req-index", text: order }) : null,
          h("span", { text: item.name }),
          h("span", { class: "req-code", text: item.code }),
        ),
        h("div", {
          class: "req-sub",
          text: `${item.partCount ?? 0} 个零件 · ${item.description || item.levelName || "整模块"}`,
        }),
      ];
    }
    const meta = [`×${item.qty}${item.unit === "pcs" ? "" : ` ${item.unit}`}`];
    if (item.description) meta.push(item.description);
    if (item.material) meta.push(item.material);
    if (item.spec) meta.push(item.spec);
    const body = [
      h(
        "div",
        { class: "req-title" },
        h("span", { text: item.name }),
        h("span", { class: "req-code", text: item.code }),
      ),
      h("div", { class: "req-sub", text: meta.join(" · ") }),
    ];
    if (item.note) body.push(h("div", { class: "req-source", text: item.note }));
    return body;
  }

  function cardTag(id, item) {
    if (id === "product_type") {
      return h("span", { class: "req-tag", text: item.category || "预设类型" });
    }
    if (id === "hard_constraints") {
      const soft = item.priority === "should";
      const tag = h("span", {
        class: `req-tag${soft ? " soft" : " accent"}`,
        text: soft ? "软约束" : "硬约束",
      });
      return tag;
    }
    const tags = [h("span", { class: "req-tag", text: item.level })];
    if (item.carried) tags.push(h("span", { class: "req-tag carried", text: "上次已选" }));
    return h("div", { class: "req-tags" }, ...tags);
  }

  function actOnModal(id, action) {
    const question = state.data.questions[id];
    if (action === "reject") {
      question.selectedKeys = [];
      question.items = [];
      question.reply = "";
      question.text = "";
      question.result = null;
      question.meta = null;
      question.warnings = [];
      question.status = "idle";
    } else if (action === "retry") {
      question.status = question.selectedKeys.length > 0 ? "active" : "idle";
    } else if (action === "continue") {
      if (id === "parts" && !question.legacy) {
        question.selectedKeys = normalizePartSelection(question.selectedKeys);
      }
      if (question.selectedKeys.length < 1) return;
      question.status = "done";
      question.completedAt = nowIso();
      state.data.currentIndex = Math.min(QUESTION_ORDER.indexOf(id) + 1, QUESTION_ORDER.length);
    }

    closeModal();
    saveData();

    if (action === "continue" && allDone()) {
      finalize();
      return;
    }

    render();
    if (action !== "continue") {
      state.renderedQuestion = null;
      renderQuestion();
      const input = $("#answerInput");
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }

  function closeModal() {
    if (!state.modal) return;
    const modal = state.modal;
    if (modal.onKeydown) modal.window.removeEventListener("keydown", modal.onKeydown);
    modal.element.remove();
    document.body.classList.remove("modal-open");
    state.modal = null;
    if (state.lastFocus?.isConnected) state.lastFocus.focus();
  }

  /* ------------------------------------------------------------------ */
  /* Review modal (read-only)                                            */
  /* ------------------------------------------------------------------ */

  function openReviewModal(id) {
    const question = state.data.questions[id];
    const meta = questionMeta(id);
    const isSingle = question.result?.selectionMode === "single";
    const isParts = id === "parts" && !question.legacy;
    const reviewItems = isParts ? partsVisibleItems(question) : question.items;
    const shownSelected = reviewItems.filter((item) =>
      question.selectedKeys.includes(item.key),
    ).length;

    const itemsNode = h("ul", { class: isParts ? "req-list parts-list" : "req-list" });
    for (const item of reviewItems) {
      const selected = question.selectedKeys.includes(item.key);
      const card = h("li", {
        class: `req-card${selected ? " selected" : ""}${isParts ? ` lvl-${String(item.level).replace(/^l/i, "")}` : ""}`,
        role: isSingle ? "radio" : "checkbox",
        "aria-checked": selected ? "true" : "false",
        "aria-disabled": "true",
      });
      card.append(
        h("span", { class: "req-check", "aria-hidden": "true" }),
        h("div", { class: "req-main" }, ...cardBody(id, item)),
      );
      const tag = cardTag(id, item);
      if (tag) card.append(tag);
      itemsNode.append(card);
    }

    const windowEl = h(
      "div",
      {
        class: "modal-window",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "reviewTitle",
      },
      h(
        "header",
        { class: "modal-head" },
        h(
          "div",
          {},
          h("span", { class: "modal-kicker", text: "CONFIRMED / 只读" }),
          h("h2", { id: "reviewTitle", text: meta?.title || id }),
        ),
        h("span", { class: "fn-badge" }, h("code", { text: question.meta?.functionName || "" })),
      ),
      h(
        "div",
        { class: "modal-body" },
        h("p", {
          class: "review-banner",
          text: `本题已在 ${formatClock(question.completedAt)} 确认：保留 ${shownSelected} / ${reviewItems.length} 条。以下为只读记录。`,
        }),
        h(
          "section",
          { class: "reply-block" },
          h("span", { class: "section-label", text: "AI 回复 · 原文" }),
          h("p", { class: "reply-text", text: question.reply }),
        ),
        itemsNode,
      ),
      h(
        "footer",
        { class: "modal-foot" },
        h(
          "div",
          { class: "foot-actions" },
          h("button", {
            type: "button",
            class: "secondary-button",
            text: "关闭",
            onclick: closeModal,
          }),
        ),
      ),
    );

    const backdrop = h("div", { class: "modal-backdrop" }, windowEl);
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) closeModal();
    });

    state.lastFocus = document.activeElement;
    $("#modalRoot").replaceChildren(backdrop);
    document.body.classList.add("modal-open");
    state.modal = { id, element: backdrop, window: windowEl };

    windowEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
      }
      if (event.key === "Tab") trapFocus(event, windowEl);
    });
    windowEl.querySelector("button")?.focus();
  }

  /* ------------------------------------------------------------------ */
  /* Identity gate                                                       */
  /* ------------------------------------------------------------------ */

  function renderGate() {
    const stage = $("#identityStage");
    const gate = state.gate;

    const input = h("input", {
      type: "text",
      id: "identityInput",
      class: "identity-input",
      maxlength: "32",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "例如 alice",
      value: gate.code,
    });
    input.addEventListener("input", (event) => {
      state.gate.code = event.target.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (state.gate.phase === "input") checkIdentityCode();
      else confirmIdentity();
    });

    const error = h("p", {
      class: "error-box",
      role: "alert",
      hidden: !gate.error,
      text: gate.error,
    });

    let actions;
    if (gate.phase === "input") {
      actions = h(
        "div",
        { class: "gate-actions" },
        h("button", {
          type: "button",
          class: "primary-button",
          id: "gateNextBtn",
          text: gate.busy ? "检查中…" : "继续",
          disabled: gate.busy,
          onclick: checkIdentityCode,
        }),
      );
    } else {
      actions = h(
        "div",
        { class: "gate-confirm" },
        h("p", {
          class: "gate-question",
          text: gate.exists
            ? `身份码「${gate.code}」已存在，包含 ${gate.productCount} 个已保存产品。是否登录？`
            : `未找到身份码「${gate.code}」，是否创建？`,
        }),
        h(
          "div",
          { class: "gate-actions" },
          h("button", {
            type: "button",
            class: "primary-button",
            id: "gateConfirmBtn",
            text: gate.busy ? "处理中…" : gate.exists ? "登录" : "创建",
            disabled: gate.busy,
            onclick: confirmIdentity,
          }),
          h("button", {
            type: "button",
            class: "secondary-button",
            text: "换一个",
            onclick: () => {
              state.gate = { ...state.gate, phase: "input", error: "", exists: false };
              renderGate();
            },
          }),
        ),
      );
    }

    stage.replaceChildren(
      h(
        "div",
        { class: "gate-head" },
        h("span", { class: "q-eyebrow", text: "IDENTITY / 身份码" }),
        h("span", { class: "q-status", text: "未登录" }),
      ),
      h("h2", { id: "gateTitle", text: "先确认你是谁" }),
      h("p", {
        class: "q-prompt",
        text: "每个身份码对应本地一个固定文件夹，产品 JSON 会存到那里；保存过的产品可以在右上角「我的」里打开。",
      }),
      h(
        "div",
        { class: "identity-row" },
        h("span", { class: "identity-label", text: "身份码" }),
        input,
      ),
      h("p", { class: "helper", text: "2–32 位字母、数字、下划线、短横线或中文，不区分大小写。" }),
      error,
      actions,
      h("p", {
        class: "gate-note",
        text: "刷新页面或退出登录会清空本次进度；已保存的产品不受影响。",
      }),
      h("p", {
        class: "gate-note",
        text: `本地存储目录：${state.config?.storage?.dataFolder ?? "data"}（每个身份码一个子文件夹）`,
      }),
    );

    if (gate.phase === "input") {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  async function checkIdentityCode() {
    const code = state.gate.code.trim();
    if (code.length < 2) {
      state.gate = { ...state.gate, error: "身份码至少 2 个字符。" };
      renderGate();
      return;
    }
    state.gate = { ...state.gate, busy: true, error: "" };
    renderGate();
    try {
      const data = await apiFetch("/api/identity/check", { method: "POST", body: { code } });
      state.gate = {
        ...state.gate,
        busy: false,
        phase: "confirm",
        exists: Boolean(data.exists),
        productCount: data.productCount ?? 0,
        code: data.code,
      };
      renderGate();
    } catch (error) {
      state.gate = { ...state.gate, busy: false, error: error.message };
      renderGate();
    }
  }

  async function confirmIdentity() {
    const gate = state.gate;
    state.gate = { ...gate, busy: true, error: "" };
    renderGate();
    try {
      const data = await apiFetch("/api/identity/login", {
        method: "POST",
        body: { code: gate.code.trim(), create: !gate.exists },
      });
      await enterIdentity(data);
    } catch (error) {
      state.gate = { ...state.gate, busy: false, error: error.message };
      renderGate();
    }
  }

  async function enterIdentity(info) {
    state.identity = {
      code: info.code,
      folder: info.folder,
      productCount: info.productCount ?? 0,
      nextUntitled: info.nextUntitled ?? 1,
    };
    state.gate = {
      code: info.code,
      phase: "input",
      exists: false,
      productCount: 0,
      busy: false,
      error: "",
    };
    state.namingName = "";
    state.data = loadData();
    state.renderedQuestion = null;
    render();
    if (allDone() && !state.data.saved) {
      await refreshProducts();
      render();
    }
    toast(info.created ? `已创建身份码 ${info.code}` : `已登录 ${info.code}`);
    if (!allDone()) $("#answerInput")?.focus();
  }

  async function switchIdentity() {
    closeModal();
    try {
      await apiFetch("/api/identity/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    clearLocalCache();
    state.identity = null;
    state.products = [];
    state.namingName = "";
    state.data = freshData();
    state.renderedQuestion = null;
    state.gate = { code: "", phase: "input", exists: false, productCount: 0, busy: false, error: "" };
    delete globalThis[GLOBAL_KEY];
    render();
    toast("已退出登录，本次进度已清空。");
  }

  /* ------------------------------------------------------------------ */
  /* Naming & saving                                                     */
  /* ------------------------------------------------------------------ */

  async function refreshProducts() {
    if (!state.identity) return;
    try {
      const data = await apiFetch("/api/products");
      state.products = Array.isArray(data.items) ? data.items : [];
      state.identity.productCount = state.products.length;
      state.identity.nextUntitled = data.nextUntitled ?? state.identity.nextUntitled ?? 1;
    } catch {
      /* 历史列表不可用时不影响主流程 */
    }
  }

  function suggestedName() {
    return `untitled${state.identity?.nextUntitled ?? 1}`;
  }

  function renderNaming() {
    const card = $("#namingCard");
    const value = state.namingName || suggestedName();

    const input = h("input", {
      type: "text",
      id: "productNameInput",
      class: "identity-input naming-input",
      maxlength: "60",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "产品名称",
      value,
    });
    input.addEventListener("input", () => {
      state.namingName = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveCurrentProduct(input.value);
      }
    });

    card.replaceChildren(
      h(
        "div",
        { class: "summary-head" },
        h(
          "div",
          {},
          h("span", { class: "kicker", text: "NAME & SAVE" }),
          h("h2", { id: "namingTitle", text: "给这份拆解起个名字" }),
          h("p", {
            text: "三个问题已确认。默认名从 untitled1 顺延，保存后可以在右上角「我的」里随时打开。",
          }),
        ),
      ),
      h(
        "div",
        { class: "naming-row" },
        h("span", { class: "identity-label", text: "产品名称" }),
        input,
      ),
      h("p", {
        class: "helper",
        text: `保存位置：${state.identity?.folder ?? "data"}/<名称>.json`,
      }),
      h("p", { class: "error-box", id: "namingError", role: "alert", hidden: true }),
      h(
        "div",
        { class: "naming-actions" },
        h("button", {
          type: "button",
          class: "primary-button",
          id: "saveProductBtn",
          text: "保存到我的",
          onclick: () => saveCurrentProduct(input.value),
        }),
        h("button", {
          type: "button",
          class: "secondary-button",
          text: "暂不保存，只看 JSON",
          onclick: skipSave,
        }),
      ),
    );

    setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 30);
  }

  function showNamingError(message) {
    const node = $("#namingError");
    if (!node) {
      toast(message);
      return;
    }
    node.textContent = message;
    node.hidden = false;
  }

  function skipSave() {
    state.data.saved = { status: "skipped" };
    saveData();
    render();
    toast("已跳过保存，JSON 仍保存在这个页面里。");
  }

  async function saveCurrentProduct(rawName) {
    const name = String(rawName || "").trim();
    if (!name) {
      showNamingError("请先填写产品名称。");
      return;
    }
    const button = $("#saveProductBtn");
    if (button) {
      button.disabled = true;
      button.textContent = "保存中…";
    }
    try {
      const payload = state.data.payload ?? buildPayload();
      const data = await apiFetch("/api/products", { method: "POST", body: { name, payload } });
      state.data.saved = {
        status: "saved",
        name: data.name,
        file: data.file,
        savedAt: data.savedAt,
        path: data.path,
      };
      state.namingName = "";
      if (state.identity) {
        state.identity.nextUntitled = data.nextUntitled ?? state.identity.nextUntitled;
        state.identity.productCount += 1;
      }
      saveData();
      render();
      toast(`已保存：${data.name}`);
    } catch (error) {
      if (button) {
        button.disabled = false;
        button.textContent = "保存到我的";
      }
      showNamingError(error.message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* My panel / history                                                  */
  /* ------------------------------------------------------------------ */

  async function openMyModal() {
    if (!state.identity) return;
    await refreshProducts();
    const identity = state.identity;
    const items = state.products;

    const list = h("ul", { class: "product-list" });
    if (items.length === 0) {
      list.append(
        h("li", { class: "product-empty", text: "还没有保存过的产品。完成三个问题后可以命名保存。" }),
      );
    }
    for (const item of items) {
      list.append(
        h(
          "li",
          {},
          h(
            "button",
            { type: "button", class: "product-row", onclick: () => loadProduct(item.file) },
            h(
              "span",
              { class: "product-main" },
              h("span", { class: "product-name", text: item.name }),
              h("span", {
                class: "product-meta",
                text: `${formatClock(item.savedAt)} · ${item.counts.parts} 个零件${item.bomLevel ? ` · ${item.bomLevel}` : ""}`,
              }),
            ),
            h("span", { class: "product-open", text: "打开" }),
          ),
        ),
      );
    }

    const windowEl = h(
      "div",
      {
        class: "modal-window my-window",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "myTitle",
      },
      h(
        "header",
        { class: "modal-head" },
        h(
          "div",
          {},
          h("span", { class: "modal-kicker", text: "MY WORKSPACE" }),
          h("h2", { id: "myTitle", text: "我的" }),
        ),
        h("span", { class: "fn-badge" }, h("code", { text: identity.code })),
      ),
      h(
        "div",
        { class: "modal-body" },
        h(
          "section",
          { class: "identity-summary" },
          h(
            "div",
            { class: "identity-fact" },
            h("span", { class: "section-label", text: "身份码" }),
            h("strong", { text: identity.code }),
          ),
          h(
            "div",
            { class: "identity-fact" },
            h("span", { class: "section-label", text: "本地文件夹" }),
            h("code", { text: identity.folder }),
          ),
          h(
            "div",
            { class: "identity-fact" },
            h("span", { class: "section-label", text: "已保存" }),
            h("strong", { text: `${items.length} 个产品` }),
          ),
        ),
        h(
          "section",
          { class: "history-block" },
          h(
            "div",
            { class: "items-head" },
            h("span", { class: "section-label", text: "历史产品" }),
            h("span", { class: "counter", text: `${items.length} 项` }),
          ),
          list,
        ),
      ),
      h(
        "footer",
        { class: "modal-foot" },
        h(
          "div",
          { class: "foot-actions" },
          h("button", { type: "button", class: "danger-ghost", text: "退出登录", onclick: switchIdentity }),
          h("button", { type: "button", class: "secondary-button", text: "关闭", onclick: closeModal }),
        ),
      ),
    );

    const backdrop = h("div", { class: "modal-backdrop" }, windowEl);
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) closeModal();
    });

    state.lastFocus = document.activeElement;
    $("#modalRoot").replaceChildren(backdrop);
    document.body.classList.add("modal-open");
    state.modal = { id: "my", element: backdrop, window: windowEl };

    windowEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
      }
      if (event.key === "Tab") trapFocus(event, windowEl);
    });
    windowEl.querySelector("button")?.focus();
  }

  async function loadProduct(file) {
    try {
      const data = await apiFetch(`/api/products/${encodeURIComponent(file)}`);
      const payload = data.payload;
      restoreFromPayload(payload, {
        file: data.file,
        name: payload?.projectName || file.replace(/\.json$/i, ""),
        savedAt: payload?.savedAt || null,
        path: payload?.storage
          ? `${state.config?.storage?.dataFolder ?? "data"}/${payload.storage.folder}/${payload.storage.file}`
          : `${state.identity?.code ?? ""}/${file}`,
      });
      closeModal();
      render();
      toast(`已打开 ${state.data.saved.name}`);
    } catch (error) {
      toast(error.message);
    }
  }

  function dimensionNameOf(id) {
    return (
      state.config?.table1?.constraintDimensions?.find((item) => item.id === id)?.name || "其他约束"
    );
  }

  function levelNameOf(id) {
    return state.config?.table1?.bomLevels?.find((item) => item.id === id)?.name || id;
  }

  function restoreFromPayload(payload, saved) {
    const data = freshData();
    data.projectId = payload?.projectId || data.projectId;
    data.createdAt = payload?.createdAt || data.createdAt;
    data.completedAt = payload?.completedAt || nowIso();
    data.saved = { status: "saved", ...saved };

    const result = payload?.result || {};
    const replies = new Map((payload?.questions || []).map((item) => [item.id, item.reply]));

    const product = result.productType;
    if (product) {
      const item = {
        key: product.presetId,
        presetId: product.presetId,
        code: product.code,
        name: product.name,
        category: product.category,
        fit: product.fit,
        description: "",
        defaultBomLevel: result.bomLevel,
      };
      data.questions.product_type = {
        ...blankQuestion(),
        status: "done",
        rounds: 1,
        reply: replies.get("product_type") || "（来自历史记录）",
        items: [item],
        selectedKeys: [item.key],
        result: { selectionMode: "single", defaultSelection: "primary", items: [item] },
        completedAt: data.completedAt,
      };
    }

    const constraints = Array.isArray(result.constraints) ? result.constraints : [];
    const constraintItems = constraints.map((item) => ({
      ...item,
      key: item.key || `c:${item.dimension}:${item.operator}:${item.value}:${item.unit}`,
      dimensionName: dimensionNameOf(item.dimension),
      operatorLabel: item.operator,
      priorityLabel: item.priority === "should" ? "软约束" : "硬约束",
    }));
    data.questions.hard_constraints = {
      ...blankQuestion(),
      status: "done",
      rounds: 1,
      reply: replies.get("hard_constraints") || "（来自历史记录）",
      items: constraintItems,
      selectedKeys: constraintItems.map((item) => item.key),
      result: { selectionMode: "multiple", defaultSelection: "none", items: constraintItems },
      completedAt: data.completedAt,
    };

    const savedParts = Array.isArray(result.parts) ? result.parts : [];
    const presetItems = buildPartsItems();
    const presetCodes = new Set(presetItems.map((item) => item.key));
    const legacy =
      presetItems.length === 0 || savedParts.some((item) => !presetCodes.has(item.code));

    let partItems;
    let partKeys;
    if (legacy) {
      partItems = savedParts.map((item) => ({
        ...item,
        key: item.code,
        level: item.level || "L3",
        levelName: levelNameOf(item.level),
      }));
      partKeys = partItems.map((item) => item.key);
    } else {
      partItems = presetItems;
      partKeys = normalizePartSelection(savedParts.map((item) => item.code));
    }

    data.questions.parts = {
      ...blankQuestion(),
      status: "done",
      rounds: 1,
      reply: replies.get("parts") || "（来自历史记录）",
      items: partItems,
      selectedKeys: partKeys,
      legacy,
      result: {
        selectionMode: "multiple",
        defaultSelection: "custom",
        selectedKeys: partKeys,
        items: partItems,
        bomLevel: result.bomLevel,
        bomLevelName: result.bomLevelName,
      },
      completedAt: data.completedAt,
    };

    data.payload = payload || null;
    syncIndex(data);
    state.data = data;
    state.renderedQuestion = null;
    saveData();
    if (payload) globalThis[GLOBAL_KEY] = payload;
  }

  /* ------------------------------------------------------------------ */
  /* Payload & summary                                                   */
  /* ------------------------------------------------------------------ */

  function selectedItems(id) {
    const question = state.data.questions[id];
    return question.items.filter((item) => question.selectedKeys.includes(item.key));
  }

  function buildPayload() {
    const product = selectedItems("product_type")[0] ?? null;
    const constraints = selectedItems("hard_constraints");
    const parts = selectedItems("parts");
    const bomLevel = parts.some((item) => item.level === "L3") ? "L3" : parts.length > 0 ? "L2" : null;

    return {
      schemaVersion: SCHEMA_VERSION,
      projectId: state.data.projectId,
      createdAt: state.data.createdAt,
      completedAt: state.data.completedAt,
      status: "complete",
      source: {
        app: "requirement-intake-v2",
        tableId: state.config?.table1.id ?? null,
        tableVersion: state.config?.table1.version ?? null,
      },
      result: {
        productType: product
          ? {
              presetId: product.presetId,
              code: product.code,
              name: product.name,
              category: product.category,
              fit: product.fit,
            }
          : null,
        constraints: constraints.map((item) => ({
          key: item.key,
          dimension: item.dimension,
          name: item.name,
          operator: item.operator,
          value: item.value,
          unit: item.unit,
          display: item.display,
          priority: item.priority,
          verification: item.verification,
          sourceText: item.sourceText,
        })),
        parts: parts.map((item) => ({
          code: item.code,
          name: item.name,
          level: item.level,
          qty: item.qty,
          unit: item.unit,
          material: item.material,
          spec: item.spec,
          parentCode: item.parentCode,
          note: item.note,
        })),
        bomLevel,
        bomLevelName: bomLevel ? levelNameOf(bomLevel) : null,
      },
      counts: {
        productType: product ? 1 : 0,
        constraints: constraints.length,
        parts: parts.length,
      },
      questions: QUESTION_ORDER.map((id) => {
        const question = state.data.questions[id];
        return {
          id,
          functionName: question.meta?.functionName ?? questionMeta(id)?.functionName ?? null,
          status: question.status,
          rounds: question.rounds,
          confirmedAt: question.completedAt,
          selectedCount: question.selectedKeys.length,
          itemCount: question.items.length,
          reply: question.reply,
          mode: question.meta?.mode ?? null,
          model: question.meta?.model ?? null,
        };
      }),
      handoff: {
        target: "next-page",
        note: "由需求规范化页面生成，点击「进入下一阶段」时经 POST /api/handoff 写入交接文件，下一页面按 next.html?handoff=<令牌> 读回。",
      },
    };
  }

  async function finalize() {
    state.data.completedAt = nowIso();
    state.data.payload = buildPayload();
    state.data.saved = null;
    saveData();
    render();
    await refreshProducts();
    render();
    toast("三个问题已全部确认，先给它起个名字。");
  }

  function renderSummary() {
    const payload = state.data.payload ?? buildPayload();
    state.data.payload = payload;
    globalThis[GLOBAL_KEY] = payload;

    const result = payload.result;
    const card = $("#summaryCard");
    const jsonText = JSON.stringify(payload, null, 2);

    const constraintChips = h("div", { class: "chips" });
    for (const item of result.constraints) {
      constraintChips.append(
        h(
          "span",
          { class: "chip" },
          h("span", { class: "chip-dim", text: item.name }),
          item.display,
        ),
      );
    }

    const partsRows = result.parts.map((item) =>
      h(
        "tr",
        { class: `part-row lvl-${String(item.level).replace(/^l/i, "")}` },
        h("td", { class: "code", text: item.code }),
        h("td", { text: item.name }),
        h("td", {}, h("span", { class: "level-pill", text: item.level })),
        h("td", { text: `×${item.qty}${item.unit === "pcs" ? "" : ` ${item.unit}`}` }),
        h("td", { text: item.material || "—" }),
        h("td", { text: item.spec || "—" }),
      ),
    );

    card.replaceChildren(
      h(
        "div",
        { class: "summary-head" },
        h(
          "div",
          {},
          h("span", { class: "kicker", text: "HANDOFF READY" }),
          h("h2", { id: "summaryTitle", text: "三个问题已全部确认" }),
          h("p", {
            text: `完成于 ${formatClock(state.data.completedAt)} · 结果已写入页面，供下一步读取。`,
          }),
          state.data.saved?.status === "saved"
            ? h(
                "p",
                { class: "saved-line" },
                "产品 ",
                h("strong", { text: state.data.saved.name }),
                " · 已保存到 ",
                h("code", { text: state.data.saved.path }),
              )
            : h("p", { class: "saved-line", text: "尚未保存到「我的」。" }),
        ),
        h(
          "div",
          { class: "summary-actions" },
          h("button", {
            type: "button",
            class: "secondary-button",
            text: state.data.saved?.status === "saved" ? "打开我的" : "保存到我的",
            onclick: () => {
              if (state.data.saved?.status === "saved") {
                openMyModal();
              } else {
                state.data.saved = null;
                saveData();
                render();
              }
            },
          }),
          h("button", {
            type: "button",
            class: "secondary-button",
            text: "复制 JSON",
            onclick: async () => {
              const ok = await copyText(jsonText);
              toast(ok ? "已复制完整 JSON。" : "复制失败，请手动选择文本。");
            },
          }),
          h("button", {
            type: "button",
            class: "primary-button",
            id: "handoffBtn",
            text: "进入下一阶段",
            onclick: (event) => openHandoff(event.currentTarget, payload),
          }),
        ),
      ),
      h(
        "div",
        { class: "stats" },
        h(
          "div",
          { class: "stat" },
          h("span", { class: "stat-label", text: "商品类型" }),
          h("span", { class: "stat-value", text: result.productType?.name ?? "未确认" }),
        ),
        h(
          "div",
          { class: "stat" },
          h("span", { class: "stat-label", text: "硬性约束" }),
          h("span", { class: "stat-value" }, String(result.constraints.length), h("small", { text: "条" })),
        ),
        h(
          "div",
          { class: "stat" },
          h("span", { class: "stat-label", text: "拆解零件" }),
          h("span", { class: "stat-value" }, String(result.parts.length), h("small", { text: "项" })),
        ),
        h(
          "div",
          { class: "stat" },
          h("span", { class: "stat-label", text: "拆解层级" }),
          h(
            "span",
            { class: "stat-value" },
            result.bomLevel ?? "—",
            h("small", { text: result.bomLevelName ?? "" }),
          ),
        ),
      ),
      h(
        "section",
        { class: "result-section" },
        h("h3", {}, "商品类型", h("span", { class: "count", text: result.productType?.code ?? "" })),
        h("p", {
          class: "q-prompt",
          text: result.productType
            ? `${result.productType.name} · ${result.productType.category}`
            : "未选择",
        }),
      ),
      h(
        "section",
        { class: "result-section" },
        h("h3", {}, "约束集合", h("span", { class: "count", text: `${result.constraints.length} 条` })),
        constraintChips,
      ),
      h(
        "section",
        { class: "result-section" },
        h(
          "h3",
          {},
          "零件集合",
          h("span", { class: "count", text: `${result.bomLevel ?? ""} · ${result.parts.length} 项` }),
        ),
        h(
          "table",
          { class: "parts-table" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { text: "编号" }),
              h("th", { text: "名称" }),
              h("th", { text: "层级" }),
              h("th", { text: "用量" }),
              h("th", { text: "材料" }),
              h("th", { text: "规格" }),
            ),
          ),
          h("tbody", {}, ...partsRows),
        ),
      ),
      h(
        "section",
        { class: "result-section" },
        h(
          "details",
          { class: "json-block" },
          h("summary", { text: "查看完整 JSON（交给下一个页面的载荷）" }),
          h("pre", { class: "json-code", id: "jsonPreview", text: jsonText }),
        ),
        h(
          "p",
          { class: "handoff-note" },
          "点击「进入下一阶段」会把这份 JSON 经 ",
          h("code", { text: "POST /api/handoff" }),
          " 交给下一页面，再跳转到 ",
          h("code", { text: "next.html?handoff=…" }),
          "；下一页面凭令牌读回同一份内容。",
        ),
      ),
    );
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

  /**
   * 把整份 JSON 交给下一页面：
   * POST /api/handoff → 服务端落盘并返回令牌 → 跳转 next.html?handoff=<令牌>
   */
  async function openHandoff(button, payload) {
    if (button.disabled) return;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "正在交接…";
    try {
      const name =
        state.data.saved?.status === "saved" ? state.data.saved.name : state.namingName || "";
      const response = await fetch("/api/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, payload }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.id) {
        throw new Error(data.message || `交接失败（HTTP ${response.status}）。`);
      }
      location.assign(data.url || `./next.html?handoff=${data.id}`);
    } catch (error) {
      button.disabled = false;
      button.textContent = label;
      toast(error?.message || "交接失败，请重试。");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Reset                                                               */
  /* ------------------------------------------------------------------ */

  function armReset() {
    const button = $("#resetBtn");
    if (!state.resetArmed) {
      state.resetArmed = true;
      button.classList.add("armed");
      button.textContent = "确认重置？";
      clearTimeout(state.resetTimer);
      state.resetTimer = setTimeout(() => {
        state.resetArmed = false;
        button.classList.remove("armed");
        button.textContent = "重置";
      }, 3200);
      return;
    }
    clearTimeout(state.resetTimer);
    state.resetArmed = false;
    button.classList.remove("armed");
    button.textContent = "重置";
    state.data = freshData();
    state.namingName = "";
    state.renderedQuestion = null;
    state.error = "";
    try {
      localStorage.removeItem(storageKey());
    } catch {
      /* ignore */
    }
    delete globalThis[GLOBAL_KEY];
    render();
    toast("已重置，三个问题从头开始。");
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    $("#submitBtn").addEventListener("click", submitAnswer);
    $("#resetBtn").addEventListener("click", armReset);
    $("#myBtn").addEventListener("click", openMyModal);
    $("#reopenBtn").addEventListener("click", () => {
      const id = currentQuestionId();
      if (id) openConfirmModal(id);
    });
    $("#answerInput").addEventListener("input", (event) => {
      $("#charCount").textContent = `${event.target.value.length} / ${MAX_INPUT}`;
    });
    $("#answerInput").addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        submitAnswer();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.modal) {
        // 弹窗内已单独处理，这里兜底
      }
    });
  }

  async function loadConfig() {
    try {
      const response = await fetch("/api/config", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.config = await response.json();
    } catch (error) {
      state.config = null;
      state.error = `无法加载配置：${error.message}。请确认服务已启动。`;
    }
  }

  async function endSession() {
    try {
      await apiFetch("/api/identity/logout", { method: "POST" });
    } catch {
      /* 服务未启动时也要能显示身份码入口 */
    }
  }

  /** 刷新 / 同标签页恢复：沿用服务端会话与本地进度 */
  async function resumeSession() {
    let info = null;
    try {
      const data = await apiFetch("/api/identity");
      if (data.authenticated) {
        info = {
          code: data.code,
          folder: data.folder,
          productCount: data.productCount ?? 0,
          nextUntitled: data.nextUntitled ?? 1,
        };
      }
    } catch (error) {
      state.error = `无法恢复登录状态：${error.message}`;
    }

    if (!info) {
      state.identity = null;
      state.data = freshData();
      syncIndex();
      render();
      return;
    }

    state.identity = info;
    state.data = loadData();
    syncIndex();
    render();
    await refreshProducts();
    render();
    toast(`已恢复 ${info.code} 的进度`);
  }

  async function init() {
    bindEvents();
    const tab = currentTabId();

    // sessionStorage 在同一标签页刷新时保留，关闭标签页后清空
    let continuation = false;
    try {
      continuation = sessionStorage.getItem(SESSION_FLAG) === "1";
      sessionStorage.setItem(SESSION_FLAG, "1");
    } catch {
      continuation = false;
    }

    await loadConfig();

    // 刷新、或同一浏览器还有别的标签页在跑：保留缓存与会话
    if (continuation || otherTabsAlive(tab).length > 0) {
      await resumeSession();
      startTabHeartbeat(tab);
      return;
    }

    // 关闭后重新打开：清掉缓存与登录态，回到身份码输入
    clearLocalCache();
    await endSession();
    state.identity = null;
    state.data = freshData();
    syncIndex();
    render();
    startTabHeartbeat(tab);
  }

  init();
})();
