/**
 * 联网 AI 配置读取
 *
 * 目标：用户只需要在项目根目录的 ai-config.env 里填 API Key 与 URL，
 * 保存后刷新页面即可切换为联网 AI —— 不需要重启进程、不需要改代码。
 *
 * 取值优先级（前者覆盖后者）：
 *   ai-config.env  >  .env  >  进程环境变量  >  内置默认值
 *
 * 采用"每次调用都重新读文件"的策略：文件只有几百字节，读取代价可以忽略，
 * 换来的是确定的热生效行为，不会出现改了文件却还在用旧配置的情况。
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_CONFIG_PATH = resolve(PROJECT_ROOT, "ai-config.env");
export const LEGACY_CONFIG_PATH = resolve(PROJECT_ROOT, ".env");

/** 每个配置项接受的文件键名（大小写不敏感，按顺序匹配） */
const KEYS = {
  apiKey: ["AI_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "API_KEY", "AI_KEY", "OPENAI_KEY"],
  baseURL: ["AI_BASE_URL", "AI_URL", "BASE_URL", "OPENAI_BASE_URL", "API_BASE_URL", "API_URL", "AI_ENDPOINT", "URL", "ENDPOINT"],
  model: ["AI_MODEL", "MODEL", "OPENAI_MODEL"],
  providerName: ["AI_PROVIDER_NAME", "PROVIDER_NAME", "PROVIDER"],
  mock: ["AI_MOCK"],
  timeoutMs: ["AI_TIMEOUT_MS"],
  temperature: ["AI_TEMPERATURE"],
};

function parseEnvSource(source) {
  const values = {};
  const text = String(source ?? "").replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("//")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toUpperCase();
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // 未加引号时，行内的 " # 注释" 一并去掉
      const commentAt = value.search(/\s[#;]/);
      if (commentAt > 0) value = value.slice(0, commentAt);
    }
    values[key] = value.trim();
  }
  return values;
}

function readConfigFile(path) {
  try {
    const stats = statSync(path);
    return {
      path,
      exists: true,
      values: parseEnvSource(readFileSync(path, "utf8")),
      mtimeMs: stats.mtimeMs,
      updatedAt: new Date(stats.mtimeMs).toISOString(),
      error: null,
    };
  } catch (error) {
    const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
    return {
      path,
      exists: false,
      values: {},
      mtimeMs: 0,
      updatedAt: null,
      error: missing ? null : `读取配置失败：${error?.message ?? error}`,
    };
  }
}

export function resolveConfigPath() {
  const override = String(process.env.AI_CONFIG_FILE ?? "").trim();
  if (!override) return DEFAULT_CONFIG_PATH;
  return isAbsolute(override) ? override : resolve(PROJECT_ROOT, override);
}

/**
 * 读取当前生效的配置。
 * values 中保留"显式写空"的键（例如 AI_API_KEY=），语义是"用户主动清空"。
 */
export function readAiConfig() {
  const primary = readConfigFile(resolveConfigPath());
  const legacy =
    primary.path === LEGACY_CONFIG_PATH ? null : readConfigFile(LEGACY_CONFIG_PATH);
  const values = { ...(legacy?.values ?? {}), ...primary.values };
  const active = primary.exists ? primary : legacy?.exists ? legacy : null;

  return {
    primary,
    legacy,
    values,
    file: relative(PROJECT_ROOT, primary.path).replace(/\\/g, "/"),
    activePath: active?.path ?? primary.path,
    activeFile: active ? relative(PROJECT_ROOT, active.path).replace(/\\/g, "/") : null,
    updatedAt: active?.updatedAt ?? null,
    readError: primary.error ?? legacy?.error ?? null,
  };
}

/** 从已合并的配置里取值：文件里出现过（含空值）就以文件为准，否则回退到环境变量 */
export function getSettingEntry(name) {
  const keys = KEYS[name];
  if (!keys) throw new Error(`Unknown AI setting: ${name}`);
  const merged = readAiConfig();
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(merged.values, key)) {
      return { key, value: merged.values[key], source: "file", file: merged.activeFile };
    }
  }
  for (const key of keys) {
    if (process.env[key] !== undefined) {
      return { key, value: String(process.env[key]), source: "env", file: null };
    }
  }
  return null;
}

export function getSetting(name) {
  return getSettingEntry(name)?.value;
}

/**
 * 归一化 AI 端点：补协议、去掉末尾斜杠、去掉误粘贴的 /chat/completions。
 * 返回 { url, host, error }；空输入返回 url=""（由调用方套默认值）。
 */
export function normalizeBaseURL(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return { url: "", host: "", error: null };
  value = value.replace(/\s+/g, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { url: "", host: "", error: "AI_BASE_URL 不是合法的 URL。" };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { url: "", host: "", error: "AI_BASE_URL 只支持 http / https。" };
  }
  if (!parsed.hostname) {
    return { url: "", host: "", error: "AI_BASE_URL 缺少域名。" };
  }

  let pathname = parsed.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/chat\/completions$/i, "");
  return { url: `${parsed.origin}${pathname}`, host: parsed.host, error: null };
}

/** 端点 → 可读的来源名，用于右上角徽标 */
export function providerLabelFor(baseURL, explicit) {
  const custom = String(explicit ?? "").trim();
  if (custom) return custom.slice(0, 32);

  let host = "";
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return "Custom API";
  }
  if (!host) return "Custom API";
  if (host.endsWith("deepseek.com")) return "DeepSeek";
  if (host.endsWith("openai.com")) return "OpenAI";
  if (host.includes("moonshot") || host.includes("kimi")) return "Kimi / Moonshot";
  if (host.includes("dashscope") || host.includes("aliyuncs")) return "通义千问";
  if (host.includes("volces") || host.includes("volcengine")) return "火山方舟";
  if (host.includes("siliconflow")) return "SiliconFlow";
  if (host.includes("zhipu") || host.includes("bigmodel")) return "智谱";
  if (host.includes("baichuan")) return "百川";
  if (host.includes("minimax")) return "MiniMax";
  if (host.includes("localhost") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return "Local API";
  }
  return host;
}

/** 没填模型时按端点猜一个常见默认值 */
export function defaultModelFor(baseURL) {
  let host = "";
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return "gpt-4o-mini";
  }
  if (host.includes("deepseek")) return "deepseek-chat";
  if (host.includes("moonshot") || host.includes("kimi")) return "moonshot-v1-8k";
  if (host.includes("dashscope") || host.includes("aliyuncs")) return "qwen-plus";
  return "gpt-4o-mini";
}
