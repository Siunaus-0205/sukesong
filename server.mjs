import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { AiServiceError, getPublicAiConfig, normalizeRequirements } from "./lib/ai.mjs";
import { HandoffError, createHandoff, pruneHandoffs, readHandoff } from "./lib/handoff-store.mjs";
import {
  IdentityError,
  checkIdentity,
  dataRoot,
  identityDir,
  listProducts,
  loginIdentity,
  projectRelative,
  readProduct,
  saveProduct,
} from "./lib/identity-store.mjs";
import { PresetContractError, contractSummary } from "./lib/preset-functions.mjs";
import { getQuestion, publicQuestions, table1, table1Meta } from "./lib/table1.mjs";

const PROJECT_ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(PROJECT_ROOT, "public");
const MAX_BODY_BYTES = 128 * 1024;
const MAX_PRODUCT_BODY_BYTES = 640 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const SESSION_COOKIE = "atlas_identity";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function loadDotEnv() {
  const envPath = resolve(PROJECT_ROOT, ".env");
  let source;
  try {
    source = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function securityHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  };
}

function sendJson(response, status, payload, requestId) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...securityHeaders("application/json; charset=utf-8"),
    "Content-Length": Buffer.byteLength(body),
    ...(requestId ? { "X-Request-Id": requestId } : {}),
  });
  response.end(body);
}

function sendText(response, status, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    ...securityHeaders(contentType),
    "Content-Length": Buffer.byteLength(text),
  });
  response.end(text);
}

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json。");
  }
  return new Promise((resolvePromise, reject) => {
    let total = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new HttpError(413, "BODY_TOO_LARGE", "请求体过大。"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (total === 0) {
        reject(new HttpError(400, "EMPTY_BODY", "请求体不能为空。"));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        resolvePromise(parsed);
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "请求体不是合法 JSON 对象。"));
      }
    });
    request.on("error", () => reject(new HttpError(400, "REQUEST_ERROR", "读取请求失败。")));
  });
}

const rateBuckets = new Map();

/** 走 Cloudflare Tunnel 时所有连接都来自 127.0.0.1，按 CF 头区分真实访客 */
function clientAddress(request) {
  const viaCloudflare = String(request.headers["cf-connecting-ip"] || "").trim();
  if (viaCloudflare) return viaCloudflare.slice(0, 64);
  return request.socket.remoteAddress || "unknown";
}

function checkRateLimit(request) {
  const now = Date.now();
  const key = clientAddress(request);
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt > RATE_LIMIT_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    throw new HttpError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试。", {
      retryAfterSeconds: Math.ceil((bucket.startedAt + RATE_LIMIT_WINDOW_MS - now) / 1000),
    });
  }
}

/* ------------------------------------------------------------------ */
/* 身份码会话（内存 Session + HttpOnly Cookie）                          */
/* ------------------------------------------------------------------ */

const sessions = new Map();

function readCookie(request, name) {
  const raw = String(request.headers.cookie || "");
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function currentSession(request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function requireSession(request) {
  const session = currentSession(request);
  if (!session) throw new HttpError(401, "IDENTITY_REQUIRED", "请先输入身份码。");
  return session;
}

function issueSession(response, code) {
  const token = randomUUID();
  sessions.set(token, { code, expiresAt: Date.now() + SESSION_TTL_MS });
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  );
}

function clearSession(response, request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) sessions.delete(token);
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

function identityPayload(result) {
  return {
    code: result.code,
    folder: result.folder,
    productCount: result.productCount,
    nextUntitled: result.nextUntitled,
    ...(result.exists === undefined ? {} : { exists: result.exists }),
    ...(result.created === undefined ? {} : { created: result.created }),
  };
}

async function handleIdentityCheck(request, response, requestId) {
  checkRateLimit(request);
  const body = await readJsonBody(request);
  const result = await checkIdentity(body.code);
  sendJson(response, 200, { ok: true, requestId, ...identityPayload(result) }, requestId);
}

async function handleIdentityLogin(request, response, requestId) {
  checkRateLimit(request);
  const body = await readJsonBody(request);
  const result = await loginIdentity(body.code, { create: body.create === true });
  issueSession(response, result.code);
  sendJson(response, 200, { ok: true, requestId, ...identityPayload(result) }, requestId);
}

async function handleProductList(request, response, requestId) {
  const session = requireSession(request);
  const { items, nextUntitled } = await listProducts(session.code);
  sendJson(
    response,
    200,
    {
      ok: true,
      requestId,
      code: session.code,
      folder: projectRelative(identityDir(session.code)),
      items,
      nextUntitled,
    },
    requestId,
  );
}

async function handleProductSave(request, response, requestId) {
  const session = requireSession(request);
  checkRateLimit(request);
  const body = await readJsonBody(request, MAX_PRODUCT_BODY_BYTES);
  const saved = await saveProduct(session.code, { name: body.name, payload: body.payload });
  sendJson(response, 200, { ok: true, requestId, code: session.code, ...saved }, requestId);
}

async function handleProductRead(request, response, requestId, file) {
  const session = requireSession(request);
  const result = await readProduct(session.code, file);
  sendJson(response, 200, { ok: true, requestId, code: session.code, ...result }, requestId);
}

/* ------------------------------------------------------------------ */
/* 需求交接：第一页 → 下一页面                                          */
/* ------------------------------------------------------------------ */

async function handleHandoffCreate(request, response, requestId) {
  const session = requireSession(request);
  checkRateLimit(request);
  const body = await readJsonBody(request, MAX_PRODUCT_BODY_BYTES);
  const handoff = await createHandoff(session.code, { name: body.name, payload: body.payload });
  sendJson(response, 200, { ok: true, requestId, code: session.code, ...handoff }, requestId);
}

async function handleHandoffRead(request, response, requestId, id) {
  const session = requireSession(request);
  const handoff = await readHandoff(session.code, id);
  sendJson(response, 200, { ok: true, requestId, code: session.code, ...handoff }, requestId);
}

function normalizeContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const result = {};
  if (context.productType && typeof context.productType === "object") {
    result.productType = {
      presetId: String(context.productType.presetId || "").slice(0, 64),
      name: String(context.productType.name || "").slice(0, 80),
    };
  }
  if (Array.isArray(context.constraints)) {
    result.constraints = context.constraints.slice(0, 20).map((item) => ({
      display: String(item?.display || item?.name || "").slice(0, 160),
    }));
  }
  return result;
}

function normalizeCarryOver(carryOver) {
  if (!Array.isArray(carryOver)) return [];
  return carryOver.slice(0, 80).map((item) => ({
    key: String(item?.key || "").slice(0, 64),
    label: String(item?.label || "").slice(0, 160),
  }));
}

function publicConfig() {
  return {
    ok: true,
    app: {
      name: "ATLAS Requirement Intake v2.1",
      version: "2.1.0",
      schemaVersion: "atlas.requirement-baseline/v2",
    },
    table1: {
      id: table1.id,
      name: table1.name,
      version: table1.version,
      updatedAt: table1.updatedAt,
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
            unit: part.unit || "pcs",
            material: part.material || "",
            spec: part.spec || "",
            note: part.note || "",
            description: part.description,
          })),
        })),
      })),
      bomLevels: table1.bomLevels,
      constraintDimensions: table1.constraintDimensions.map((dimension) => ({
        id: dimension.id,
        name: dimension.name,
        unit: dimension.unit,
      })),
    },
    questions: publicQuestions(),
    ai: getPublicAiConfig(),
    contract: contractSummary,
    storage: {
      dataFolder: projectRelative(dataRoot()),
      identityFolderTemplate: `${projectRelative(dataRoot())}/<身份码>/`,
      maxNameLength: 60,
    },
    limits: { maxInputChars: 2000, minInputChars: 2, rateLimitPerMinute: RATE_LIMIT_MAX },
  };
}

async function handleNormalize(request, response, requestId) {
  checkRateLimit(request);
  const body = await readJsonBody(request);

  const questionId = typeof body.questionId === "string" ? body.questionId.trim() : "";
  const question = getQuestion(questionId);
  if (!question) {
    throw new HttpError(400, "UNKNOWN_QUESTION", "questionId 不在预设问题列表中。", {
      allowed: publicQuestions().map((item) => item.id),
    });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length < 2) {
    throw new HttpError(400, "INPUT_TOO_SHORT", "请多描述一点，至少输入 2 个字符。");
  }
  if (text.length > 2000) {
    throw new HttpError(400, "INPUT_TOO_LONG", "单次输入不能超过 2000 个字符。");
  }

  const context = normalizeContext(body.context);
  const carryOver = normalizeCarryOver(body.carryOver);
  const startedAt = Date.now();
  const normalized = await normalizeRequirements({ questionId, text, context, carryOver });

  sendJson(
    response,
    200,
    {
      ok: true,
      requestId,
      questionId,
      functionName: normalized.meta.functionName,
      mode: normalized.meta.mode,
      provider: normalized.meta.provider,
      model: normalized.meta.model,
      latencyMs: normalized.meta.latencyMs,
      attempts: normalized.meta.attempts,
      replySource: normalized.meta.replySource,
      usage: normalized.meta.usage,
      tableVersion: table1Meta.version,
      reply: normalized.reply,
      result: normalized.result,
      warnings: normalized.warnings,
      serverElapsedMs: Date.now() - startedAt,
    },
    requestId,
  );
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, "http://localhost");
  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    sendText(response, 400, "Bad Request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const candidate = resolve(PUBLIC_DIR, `.${pathname}`);
  const relativePath = relative(PUBLIC_DIR, candidate);
  if (
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    relativePath.split(sep).includes("..")
  ) {
    sendText(response, 403, "Forbidden");
    return;
  }

  let stats;
  try {
    stats = statSync(candidate);
  } catch {
    sendText(response, 404, "Not Found");
    return;
  }
  if (!stats.isFile()) {
    sendText(response, 404, "Not Found");
    return;
  }

  const contentType = MIME_TYPES[extname(candidate).toLowerCase()] || "application/octet-stream";
  const content = await readFile(candidate);
  // 本地工具：始终让浏览器回源，避免改完前端却看到 5 分钟前的旧文件
  const cacheControl = "no-cache";
  response.writeHead(200, {
    ...securityHeaders(contentType),
    "Cache-Control": cacheControl,
    "Content-Length": content.length,
  });
  if (request.method === "HEAD") response.end();
  else response.end(content);
}

function handleError(response, error, requestId) {
  const known =
    error instanceof HttpError ||
    error instanceof PresetContractError ||
    error instanceof AiServiceError ||
    error instanceof HandoffError ||
    error instanceof IdentityError;

  if (known) {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof PresetContractError
          ? 422
          : error.status;
    sendJson(
      response,
      status,
      {
        ok: false,
        requestId,
        code: error.code,
        message: error.message,
        details: error.details ?? {},
      },
      requestId,
    );
    return;
  }

  console.error(`[${requestId}] unhandled`, error);
  sendJson(
    response,
    500,
    {
      ok: false,
      requestId,
      code: "INTERNAL_ERROR",
      message: "服务内部错误，请稍后重试。",
      details: {},
    },
    requestId,
  );
}

const server = createServer(async (request, response) => {
  const requestId = randomUUID();
  const requestUrl = new URL(request.url || "/", "http://localhost");
  try {
    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, requestId, time: new Date().toISOString() }, requestId);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/config") {
      sendJson(response, 200, publicConfig(), requestId);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/table1") {
      sendJson(
        response,
        200,
        {
          ok: true,
          requestId,
          table1,
          questions: publicQuestions(),
          contract: contractSummary,
        },
        requestId,
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/identity") {
      const session = currentSession(request);
      if (!session) {
        sendJson(response, 200, { ok: true, requestId, authenticated: false }, requestId);
        return;
      }
      const info = await checkIdentity(session.code);
      sendJson(
        response,
        200,
        { ok: true, requestId, authenticated: true, ...identityPayload(info) },
        requestId,
      );
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/identity/check") {
      await handleIdentityCheck(request, response, requestId);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/identity/login") {
      await handleIdentityLogin(request, response, requestId);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/identity/logout") {
      clearSession(response, request);
      sendJson(response, 200, { ok: true, requestId }, requestId);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/products") {
      await handleProductList(request, response, requestId);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/products") {
      await handleProductSave(request, response, requestId);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname.startsWith("/api/products/")) {
      let file;
      try {
        file = decodeURIComponent(requestUrl.pathname.slice("/api/products/".length));
      } catch {
        throw new HttpError(400, "INVALID_FILE_NAME", "产品文件名不合法。");
      }
      await handleProductRead(request, response, requestId, file);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/normalize") {
      await handleNormalize(request, response, requestId);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/handoff") {
      await handleHandoffCreate(request, response, requestId);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname.startsWith("/api/handoff/")) {
      let id;
      try {
        id = decodeURIComponent(requestUrl.pathname.slice("/api/handoff/".length));
      } catch {
        throw new HttpError(400, "INVALID_HANDOFF_ID", "交接令牌不合法。");
      }
      await handleHandoffRead(request, response, requestId, id);
      return;
    }
    if (requestUrl.pathname.startsWith("/api/")) {
      throw new HttpError(404, "API_NOT_FOUND", "接口不存在。");
    }
    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(request, response);
      return;
    }
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "请求方法不支持。");
  } catch (error) {
    handleError(response, error, requestId);
  }
});

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT) || 43125;

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n端口 ${port} 已被占用。`);
    console.error(`换一个端口再启动，例如：set PORT=43126 && node server.mjs`);
    process.exit(1);
  }
  console.error("服务器启动失败：", error);
  process.exit(1);
});

server.listen(port, host, () => {
  const ai = getPublicAiConfig();
  console.log("ATLAS Requirement Intake v2.1");
  console.log(`  URL     http://${host}:${port}`);
  console.log(`  Config  ${ai.configFile}${ai.configured ? "" : "（未填写 API Key）"}`);
  console.log(
    `  AI mode ${
      ai.mode === "live"
        ? `live · ${ai.providerLabel} · ${ai.model} @ ${ai.endpointHost}`
        : "mock · 本地预设函数"
    }`,
  );
  console.log(`  Table1  ${table1Meta.name} v${table1Meta.version}`);
  console.log(`  Data    ${projectRelative(dataRoot())}`);
  if (ai.mode === "mock") console.log(`  Note    ${ai.mockReason}`);
  if (ai.configError) console.log(`  Config! ${ai.configError}`);
  console.log("  Hint    在 ai-config.env 填 AI_API_KEY / AI_BASE_URL / AI_MODEL 后刷新页面即可联网（无需重启）");
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.startedAt > RATE_LIMIT_WINDOW_MS * 2) rateBuckets.delete(key);
  }
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  pruneHandoffs(now).catch((error) => console.error("[handoff] prune failed", error));
}, 5 * 60_000);
cleanupTimer.unref();

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
