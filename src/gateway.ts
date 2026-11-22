/**
 * 认端点、取密钥、读额度。三件事都只碰本机与网关:
 *
 * - 端点是部署根下 `providers/<名>/config.json` 里 `kind === "opencode"` 的那几条。部署根取
 *   `CORTICO_HOME`,没有时取部署目录的父目录。
 * - 密钥按端点自己声明的变量名取:进程环境优先,其次该端点目录的 `.env`。这与供应商模块的规则
 *   一致,所以在这里不需要用户再输一次。
 * - 额度读 `<网关根>/go/v1/usage`。只有 Go 订阅有额度窗口,按量计费的端点(含按量 URL)跳过。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const USER_AGENT = 'cortico-world-opencode-quota/0.3.0';

/** 单次网关请求超时(毫秒)。 */
export const REQUEST_TIMEOUT_MS = 15_000;
/** 额度接口响应体字节上限(64 KiB),防异常大响应耗尽内存。 */
export const MAX_RESPONSE_BYTES = 64 * 1024;
/** 首次网络抖动后的重试等待(毫秒)。 */
const RETRY_DELAY_MS = 1_500;

export interface EndpointRef {
  /** 端点名,即 `providers/<名>/` 的目录名。 */
  name: string;
  /** 端点目录,`providers/<名>`。 */
  dir: string;
  /** 网关根,如 `https://opencode.ai/inference`;不是网关地址时为空串。 */
  root: string;
  /** 主密钥变量名,来自端点配置 `secret`;没有声明时为空串。 */
  secretName: string;
  /** 端点声明的全部密钥变量名(主 `secret` 在前,其次 `options.keys` 里的备用密钥名,去重)。 */
  secretNames?: string[];
}

export interface ResolvedKey {
  secretName: string;
  key: string | undefined;
}

export interface WindowState {
  status: 'ok' | 'rate-limited';
  percent: number;
  resetsAt: string;
}

export interface Usage {
  rolling: WindowState;
  weekly: WindowState;
  monthly: WindowState;
}

const MARKER = '/inference';

/** 部署根下的共享端点目录。 */
export function providersDir(botDir: string): string {
  const home = process.env.CORTICO_HOME?.trim();
  return join(home || dirname(botDir), 'providers');
}

/**
 * 从端点地址取网关根;仅接受 http/https 且不含内嵌账号密码的 OpenCode 网关地址,其余返回空串。
 */
export function gatewayRoot(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return ''; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (url.username || url.password) return '';
  const at = url.pathname.indexOf(MARKER);
  if (at < 0) return '';
  return `${url.origin}${url.pathname.slice(0, at + MARKER.length)}`.replace(/\/+$/, '');
}

/**
 * 从端点 URL 推断计费账户类型:带 `/go` 为 Go 订阅,直接挂模型协议族路径(如 `/inference/openai/v1`)
 * 为 Console 按量余额;裸网关根返回 null(默认按 Go 处理)。
 */
export function billingHintOf(baseUrl: string): 'go' | 'balance' | null {
  if (!gatewayRoot(baseUrl)) return null;
  const path = baseUrl.slice(baseUrl.indexOf(MARKER));
  if (/(^|\/)go(\/|$)/.test(path)) return 'go';
  if (/\/(openai\/v1|anthropic\/v1|google\/v1beta|v1\/models)(\/|$|\?)/.test(path)) return 'balance';
  return null;
}

/** 端点目录里声明的 OpenCode Go 端点,按名字排序。 */
export function readEndpoints(botDir: string): EndpointRef[] {
  const dir = providersDir(botDir);
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const found: EndpointRef[] = [];
  for (const name of names.sort()) {
    const endpointDir = join(dir, name);
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(readFileSync(join(endpointDir, 'config.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (config.kind !== 'opencode') continue;
    const baseUrl = String(config.baseUrl ?? '');
    const root = gatewayRoot(baseUrl);
    if (!root) continue;
    // 额度窗口只对 Go 订阅有;显式按量计费或按量路径的端点跳过。
    const options = (config.options ?? {}) as Record<string, unknown>;
    const explicitBilling = typeof options.billing === 'string' ? options.billing.trim() : '';
    const billing = explicitBilling || billingHintOf(baseUrl) || 'go';
    if (billing === 'balance') continue;
    const primarySecret = typeof config.secret === 'string' ? config.secret.trim() : '';
    const extraListed = typeof options.keys === 'string' ? options.keys.split(/[;,\s]+/) : [];
    const secretNames = [...new Set([primarySecret, ...extraListed].map((item) => item.trim()).filter(Boolean))];
    found.push({
      name,
      dir: endpointDir,
      root,
      secretName: primarySecret,
      ...(secretNames.length ? { secretNames } : {}),
    });
  }
  return found;
}

/** 按变量名取密钥:进程环境优先,其次端点目录的 `.env`。 */
export function readSecret(dir: string, secretName: string): string | undefined {
  const name = secretName.trim();
  if (!name) return undefined;
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  if (!dir) return undefined;
  let text: string;
  try {
    text = readFileSync(join(dir, '.env'), 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 0 || trimmed.slice(0, at).trim() !== name) continue;
    const value = trimmed.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (value) return value;
  }
  return undefined;
}

/** 按名字取主密钥:进程环境优先,其次端点目录的 `.env`。 */
export function readKey(endpoint: EndpointRef): string | undefined {
  return readSecret(endpoint.dir, endpoint.secretName);
}

/** 读取端点声明的全部可用密钥:主密钥始终返回(缺值时为 undefined),备用密钥只返回实际读到值的。 */
export function readEndpointKeys(endpoint: EndpointRef): ResolvedKey[] {
  const names = endpoint.secretNames?.length
    ? endpoint.secretNames
    : (endpoint.secretName ? [endpoint.secretName] : []);
  if (!names.length) return [{ secretName: '', key: undefined }];
  const [first, ...extras] = names;
  const primary: ResolvedKey = { secretName: first!, key: readSecret(endpoint.dir, first!) };
  const resolvedExtras: ResolvedKey[] = [];
  for (const extraName of extras) {
    const key = readSecret(endpoint.dir, extraName);
    if (key) resolvedExtras.push({ secretName: extraName, key });
  }
  if (!primary.key && resolvedExtras.length) return resolvedExtras;
  return [primary, ...resolvedExtras];
}

/** 安全脱敏的密钥尾标:仅在密钥足够长时保留末 4 位,永不泄露完整密钥。 */
export function maskKeyHint(key: string | undefined): string | null {
  const trimmed = key?.trim() ?? '';
  if (trimmed.length < 8) return null;
  return `••••${trimmed.slice(-4)}`;
}

export function usageUrl(root: string): string {
  return `${root}/go/v1/usage`;
}

function windowOf(raw: unknown): WindowState {
  const row = raw as { status?: unknown; percent?: unknown; resetsAt?: unknown } | null;
  if (!row || (row.status !== 'ok' && row.status !== 'rate-limited')) throw new Error('额度窗口缺少状态');
  if (typeof row.percent !== 'number' || !Number.isFinite(row.percent) || row.percent < 0 || row.percent > 100)
    throw new Error('额度窗口缺少百分比');
  if (typeof row.resetsAt !== 'string' || !Number.isFinite(Date.parse(row.resetsAt)))
    throw new Error('额度窗口缺少重置时间');
  return { status: row.status, percent: row.percent, resetsAt: row.resetsAt };
}

export function parseUsage(raw: unknown): Usage {
  const body = raw as { usage?: Record<string, unknown> } | null;
  const usage = body?.usage;
  if (!usage || typeof usage !== 'object') throw new Error('额度回应里没有 usage');
  return { rolling: windowOf(usage.rolling), weekly: windowOf(usage.weekly), monthly: windowOf(usage.monthly) };
}

/** 流式限额读取响应正文,防止异常大响应占满内存。 */
async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`额度响应超过 ${maxBytes} 字节上限`);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`额度响应超过 ${maxBytes} 字节上限`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}

/** 解析 JSON 时不把原文(可能含回显密钥)拼进异常消息。 */
function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('网关返回了无法解析的 JSON');
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('请求已中止'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('请求已中止'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function attemptSignal(caller?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

/**
 * 禁止自动跳转(`redirect: 'error'`),避免 `x-api-key` 随 3xx 泄露到第三方源;
 * 每次请求带超时上限,首次网络抖动重试一次,仍失败才认。
 */
async function send(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { headers, redirect: 'error', signal: attemptSignal(signal) });
  } catch (error) {
    if (signal?.aborted) throw error;
    await abortableDelay(RETRY_DELAY_MS, signal);
    return await fetch(url, { headers, redirect: 'error', signal: attemptSignal(signal) });
  }
}

/**
 * 读一个端点的额度。密钥先按 `Authorization: Bearer` 发;被 401/403 拒时再试 `x-api-key`,因为
 * 网关的用量接口与推理接口不总是认同一个头。
 */
export async function readUsage(endpoint: EndpointRef, key: string | undefined, signal?: AbortSignal): Promise<Usage> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT, 'x-opencode-session': crypto.randomUUID() };
  const variants: Array<Record<string, string>> = key ? [{ Authorization: `Bearer ${key}` }, { 'x-api-key': key }] : [{}];
  let last: Error | null = null;
  for (const auth of variants) {
    const response = await send(usageUrl(endpoint.root), { ...headers, ...auth }, signal);
    const text = await readLimitedText(response, MAX_RESPONSE_BYTES);
    if (response.ok) return parseUsage(parseJsonSafe(text));
    const safeText = key ? text.replaceAll(key, '[redacted]') : text;
    const detail = safeText.trim().slice(0, 160);
    last = new Error(`${endpoint.name}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    if (!key || (response.status !== 401 && response.status !== 403)) break;
  }
  throw last ?? new Error(`${endpoint.name}: 没有发出请求`);
}
