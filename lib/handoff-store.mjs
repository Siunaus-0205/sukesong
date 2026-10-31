/**
 * 需求交接：把第一页产出的整份 JSON 交给下一页面
 *
 * 流程：
 *   1. 第一页 POST /api/handoff，服务端把 JSON 写进 data/.handoff/<token>.json
 *   2. 浏览器跳到 /next.html?handoff=<token>
 *   3. 下一页面 GET /api/handoff/<token> 读回同一份 JSON
 *
 * 令牌是 32 位十六进制随机数，并且只有生成它的身份码（同一个 Cookie 会话）
 * 才能读回，避免链接被转发后泄露需求内容。令牌 12 小时后过期。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { dataRoot } from "./identity-store.mjs";

export const HANDOFF_TTL_MS = 12 * 60 * 60 * 1000;

const MAX_BYTES = 600 * 1024;
const ID_PATTERN = /^[a-f0-9]{32}$/;

export class HandoffError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "HandoffError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 交接文件目录（data/.handoff/，与身份码目录分开，不污染「我的」列表） */
export function handoffDir() {
  return join(dataRoot(), ".handoff");
}

export function handoffUrl(id) {
  return `/next.html?handoff=${id}`;
}

function cleanName(raw) {
  const value = String(raw ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return value || "未命名需求";
}

async function writeRecord(file, record) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

/** 顺手清掉过期的交接文件；失败不影响本次请求 */
async function pruneExpired(directory, now) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const target = join(directory, entry.name);
        try {
          const info = await stat(target);
          if (now - info.mtimeMs > HANDOFF_TTL_MS) await unlink(target);
        } catch {
          /* 并发删除时忽略 */
        }
      }),
  );
}

/** 定期清理过期交接文件（服务端定时器调用） */
export async function pruneHandoffs(now = Date.now()) {
  await pruneExpired(handoffDir(), now);
}

/** 第一页调用：写入交接文件，返回令牌与下一页面地址 */
export async function createHandoff(code, { name, payload } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HandoffError(400, "INVALID_PAYLOAD", "交接内容必须是 JSON 对象。");
  }
  if (!payload.result || typeof payload.result !== "object") {
    throw new HandoffError(400, "INVALID_PAYLOAD", "交接内容缺少 result 字段。");
  }

  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (bytes > MAX_BYTES) {
    throw new HandoffError(413, "PAYLOAD_TOO_LARGE", "需求内容过大，无法交接。");
  }

  const directory = handoffDir();
  await mkdir(directory, { recursive: true });
  const now = Date.now();
  await pruneExpired(directory, now);

  const id = randomUUID().replace(/-/g, "");
  const createdAt = new Date(now).toISOString();
  const displayName = cleanName(name);
  const record = {
    id,
    code,
    name: displayName,
    createdAt,
    expiresAt: new Date(now + HANDOFF_TTL_MS).toISOString(),
    bytes,
    payload,
  };
  await writeRecord(join(directory, `${id}.json`), record);

  return {
    id,
    name: displayName,
    createdAt,
    expiresAt: record.expiresAt,
    bytes,
    url: handoffUrl(id),
  };
}

/** 下一页面调用：凭令牌读回交接内容 */
export async function readHandoff(code, rawId) {
  const id = String(rawId ?? "").trim();
  if (!ID_PATTERN.test(id)) {
    throw new HandoffError(400, "INVALID_HANDOFF_ID", "交接令牌不合法。");
  }

  const target = join(handoffDir(), `${id}.json`);
  let record;
  try {
    record = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new HandoffError(404, "HANDOFF_NOT_FOUND", "交接不存在，可能已经过期。");
    }
    throw new HandoffError(422, "HANDOFF_UNREADABLE", "交接文件无法解析，请回到需求页重试。");
  }

  if (!record || record.code !== code) {
    throw new HandoffError(404, "HANDOFF_NOT_FOUND", "交接不存在，可能已经过期。");
  }

  if (!(Date.parse(record.expiresAt) > Date.now())) {
    await rm(target, { force: true });
    throw new HandoffError(410, "HANDOFF_EXPIRED", "交接已过期，请回到需求页重新进入下一阶段。");
  }

  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    bytes: record.bytes,
    payload: record.payload,
  };
}
