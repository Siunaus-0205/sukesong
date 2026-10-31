/**
 * 身份码与产品存储（本地文件系统）
 *
 * 目录结构（默认在项目根目录的 data/，可用 ATLAS_DATA_DIR 覆盖）：
 *
 *   data/
 *     <身份码>/
 *       identity.json      身份元数据（创建时间、最近登录）
 *       untitled1.json     一个产品一份 JSON（正文 + 保存信息）
 *
 * 身份码只作为目录名使用，因此必须严格校验，避免路径穿越。
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CODE_PATTERN = /^[\p{L}\p{N}_-]{2,32}$/u;
const FILE_PATTERN = /^[^\\/:*?"<>|\u0000-\u001f]{1,120}\.json$/;
const IDENTITY_FILE = "identity.json";
const MAX_PRODUCT_BYTES = 512 * 1024;

const RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export class IdentityError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "IdentityError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function dataRoot() {
  const override = String(process.env.ATLAS_DATA_DIR ?? "").trim();
  if (override) return isAbsolute(override) ? resolve(override) : resolve(PROJECT_ROOT, override);
  return resolve(PROJECT_ROOT, "data");
}

export function projectRelative(absolutePath) {
  const rel = relative(PROJECT_ROOT, absolutePath).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : absolutePath;
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 身份码 → 规范化目录名；非法时抛 400 */
export function normalizeCode(raw) {
  const value = String(raw ?? "")
    .normalize("NFC")
    .trim()
    .toLowerCase();
  if (!CODE_PATTERN.test(value)) {
    throw new IdentityError(
      400,
      "INVALID_IDENTITY_CODE",
      "身份码需为 2–32 位字母、数字、下划线、短横线或中文，不能包含空格与符号。",
    );
  }
  if (RESERVED_NAMES.has(value)) {
    throw new IdentityError(400, "INVALID_IDENTITY_CODE", "该身份码是系统保留名称，请换一个。");
  }
  return value;
}

export function identityDir(code) {
  return join(dataRoot(), code);
}

function productPath(code, file) {
  const dir = identityDir(code);
  if (file === IDENTITY_FILE || !FILE_PATTERN.test(file)) {
    throw new IdentityError(400, "INVALID_FILE_NAME", "产品文件名不合法。");
  }
  const target = join(dir, file);
  const rel = relative(dir, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new IdentityError(400, "INVALID_FILE_NAME", "产品文件名不合法。");
  }
  return target;
}

function fileStem(file) {
  return file.replace(/\.json$/i, "");
}

function cleanBaseName(raw) {
  let value = String(raw ?? "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 60)
    .trim();
  if (!value) value = "untitled";
  if (RESERVED_NAMES.has(value.toLowerCase())) value = `_${value}`;
  return value;
}

/** untitled1、untitled2 …… 取下一个 */
function nextUntitledFrom(files) {
  let max = 0;
  for (const file of files) {
    const match = fileStem(file).match(/^untitled(\d+)$/i);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

async function readJsonFile(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

async function writeJsonFile(path, data) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

async function listJsonFiles(code) {
  const dir = identityDir(code);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.name)
    .filter((name) => name !== IDENTITY_FILE);
}

/** 统计身份码是否存在、已有产品数与下一个默认名 */
export async function checkIdentity(rawCode) {
  const code = normalizeCode(rawCode);
  const dir = identityDir(code);
  const exists = await isDirectory(dir);
  const files = exists ? await listJsonFiles(code) : [];
  return {
    code,
    exists,
    folder: projectRelative(dir),
    absoluteFolder: dir,
    productCount: files.length,
    nextUntitled: nextUntitledFrom(files),
  };
}

/** 登录或创建。create=false 且不存在 → 404；create=true 且已存在 → 409 */
export async function loginIdentity(rawCode, { create = false } = {}) {
  const code = normalizeCode(rawCode);
  const dir = identityDir(code);
  const exists = await isDirectory(dir);

  if (!exists && !create) {
    throw new IdentityError(404, "IDENTITY_NOT_FOUND", "身份码不存在，请确认后再试。");
  }
  if (exists && create) {
    throw new IdentityError(409, "IDENTITY_EXISTS", "身份码已存在，请改为登录。");
  }

  const now = new Date().toISOString();
  const identityPath = join(dir, IDENTITY_FILE);

  if (!exists) {
    await mkdir(dir, { recursive: true });
    await writeJsonFile(identityPath, { code, createdAt: now, lastSeenAt: now });
  } else {
    let meta = {};
    try {
      meta = await readJsonFile(identityPath);
    } catch {
      meta = {};
    }
    await writeJsonFile(identityPath, {
      code,
      createdAt: meta.createdAt || now,
      lastSeenAt: now,
    });
  }

  const files = await listJsonFiles(code);
  return {
    code,
    created: !exists,
    folder: projectRelative(dir),
    absoluteFolder: dir,
    productCount: files.length,
    nextUntitled: nextUntitledFrom(files),
  };
}

/** 历史产品列表（新的在前） */
export async function listProducts(code) {
  const dir = identityDir(code);
  const files = await listJsonFiles(code);
  const items = [];

  for (const file of files) {
    const full = join(dir, file);
    try {
      const stats = await stat(full);
      const data = await readJsonFile(full);
      const counts = data?.counts ?? {};
      items.push({
        file,
        name: String(data?.projectName || fileStem(file)).slice(0, 80),
        savedAt: typeof data?.savedAt === "string" ? data.savedAt : null,
        productType: data?.result?.productType?.name ?? null,
        bomLevel: data?.result?.bomLevel ?? null,
        counts: {
          productType: Number(counts.productType) || 0,
          constraints: Number(counts.constraints) || 0,
          parts: Number(counts.parts) || 0,
        },
        bytes: stats.size,
      });
    } catch {
      // 跳过损坏文件，不影响其余历史记录
    }
  }

  items.sort((a, b) => String(b.savedAt ?? "").localeCompare(String(a.savedAt ?? "")));
  return { items, nextUntitled: nextUntitledFrom(files) };
}

/** 读取单个产品 JSON */
export async function readProduct(code, file) {
  const target = productPath(code, file);
  let data;
  try {
    data = await readJsonFile(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new IdentityError(404, "PRODUCT_NOT_FOUND", "产品不存在，可能已被删除。");
    }
    throw new IdentityError(422, "PRODUCT_UNREADABLE", "产品文件无法解析。");
  }
  return { file, payload: data };
}

async function pickFreeFile(dir, base) {
  for (let index = 1; index <= 999; index += 1) {
    const file = index === 1 ? `${base}.json` : `${base}-${index}.json`;
    try {
      await stat(join(dir, file));
    } catch {
      return file;
    }
  }
  throw new IdentityError(409, "TOO_MANY_FILES", "同名产品过多，请换一个名字。");
}

/** 保存产品到身份码目录 */
export async function saveProduct(code, { name, payload }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new IdentityError(400, "INVALID_PAYLOAD", "产品内容必须是 JSON 对象。");
  }
  if (!payload.result || typeof payload.result !== "object") {
    throw new IdentityError(400, "INVALID_PAYLOAD", "产品内容缺少 result 字段。");
  }
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_PRODUCT_BYTES) {
    throw new IdentityError(413, "PAYLOAD_TOO_LARGE", "产品内容过大，无法保存。");
  }

  const dir = identityDir(code);
  if (!(await isDirectory(dir))) {
    throw new IdentityError(401, "IDENTITY_REQUIRED", "请先登录身份码。");
  }

  const displayName = cleanBaseName(name);
  const file = await pickFreeFile(dir, displayName);
  const savedAt = new Date().toISOString();
  const record = {
    ...payload,
    projectName: displayName,
    savedAt,
    savedBy: code,
    storage: { folder: code, file },
  };

  const target = join(dir, file);
  await writeJsonFile(target, record);

  return {
    file,
    name: displayName,
    savedAt,
    folder: projectRelative(dir),
    path: `${projectRelative(dir)}/${file}`,
    nextUntitled: nextUntitledFrom(await listJsonFiles(code)),
  };
}

/** 删除产品（保留给后续扩展，当前 UI 未使用） */
export async function deleteProduct(code, file) {
  const target = productPath(code, file);
  try {
    await stat(target);
  } catch {
    throw new IdentityError(404, "PRODUCT_NOT_FOUND", "产品不存在。");
  }
  await rm(target, { force: true });
  return { file };
}
