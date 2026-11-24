/**
 * OpenCode 额度网关客户端:校验网关地址、组装 `/go/v1/usage`、安全发请求并解析三个窗口。
 * 本模块不读取文件系统、不访问其他供应商目录、不直接碰环境变量;密钥一律由 World 经框架 `ctx.secret()` 传入。
 */

export const USER_AGENT = 'cortico-world-opencode-quota/0.3.1';

/** 单次网关请求超时(毫秒)。 */
export const REQUEST_TIMEOUT_MS = 15_000;
/** 额度接口响应体字节上限(64 KiB),防异常大响应耗尽内存。 */
export const MAX_RESPONSE_BYTES = 64 * 1024;
/** 首次网络抖动后的重试等待(毫秒)。 */
const RETRY_DELAY_MS = 1_500;

export interface QuotaTarget {
  /** 展示名(用于错误提示)。 */
  name: string;
  /** 规范化后的网关根,如 `https://opencode.ai/inference`。 */
  root: string;
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

/**
 * 规范化 OpenCode 网关根:仅接受 http/https 且不含内嵌账号密码的地址,并截断至 `/inference`;
 * 不符合条件时返回空串。
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

/** 安全脱敏的密钥尾标:仅在密钥足够长时保留末 4 位,短密钥全打码,永不泄露完整密钥。 */
export function maskKeyHint(key: string | undefined): string | null {
  const trimmed = key?.trim() ?? '';
  if (!trimmed) return null;
  if (trimmed.length < 8) return '••••';
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
 * 读取一把密钥对应的额度。先按 `Authorization: Bearer` 发;被 401/403 拒时再试 `x-api-key`,
 * 因为网关的用量接口与推理接口不总是认同一个头。
 */
export async function readUsage(target: QuotaTarget, key: string | undefined, signal?: AbortSignal): Promise<Usage> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT, 'x-opencode-session': crypto.randomUUID() };
  const variants: Array<Record<string, string>> = key ? [{ Authorization: `Bearer ${key}` }, { 'x-api-key': key }] : [{}];
  let last: Error | null = null;
  for (const auth of variants) {
    const response = await send(usageUrl(target.root), { ...headers, ...auth }, signal);
    const text = await readLimitedText(response, MAX_RESPONSE_BYTES);
    if (response.ok) return parseUsage(parseJsonSafe(text));
    const safeText = key ? text.replaceAll(key, '[redacted]') : text;
    const detail = safeText.trim().slice(0, 160);
    last = new Error(`${target.name}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    if (!key || (response.status !== 401 && response.status !== 403)) break;
  }
  throw last ?? new Error(`${target.name}: 没有发出请求`);
}
