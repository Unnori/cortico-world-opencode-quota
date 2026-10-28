/**
 * 认端点、取密钥、读额度。三件事都只碰本机与网关:
 *
 * - 端点是部署根下 `providers/<名>/config.json` 里 `kind === "opencode"` 的那几条。部署根取
 *   `CORTICO_HOME`,没有时取部署目录的父目录。
 * - 密钥按端点自己声明的变量名取:进程环境优先,其次该端点目录的 `.env`。这与供应商模块的规则
 *   一致,所以在这里不需要用户再输一次。
 * - 额度读 `<网关根>/go/v1/usage`。只有 Go 订阅有额度窗口,按量计费的端点跳过。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const USER_AGENT = 'cortico-world-opencode-quota/0.2.1';

export interface EndpointRef {
  /** 端点名,即 `providers/<名>/` 的目录名。 */
  name: string;
  /** 端点目录,`providers/<名>`。 */
  dir: string;
  /** 网关根,如 `https://opencode.ai/inference`;不是网关地址时为空串。 */
  root: string;
  /** 密钥变量名,来自端点配置;没有声明时为空串。 */
  secretName: string;
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

/** 从端点地址取网关根;不是 OpenCode 网关时返回空串。 */
export function gatewayRoot(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return ''; }
  const at = url.pathname.indexOf(MARKER);
  if (at < 0) return '';
  return `${url.origin}${url.pathname.slice(0, at + MARKER.length)}`.replace(/\/+$/, '');
}

/** 端点目录里声明的 OpenCode 端点,按名字排序。 */
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
    // 额度窗口只对 Go 订阅有;按量计费的端点没有可读的东西。
    const options = (config.options ?? {}) as Record<string, unknown>;
    if (options.billing === 'balance') continue;
    const root = gatewayRoot(String(config.baseUrl ?? ''));
    if (!root) continue;
    found.push({
      name,
      dir: endpointDir,
      root,
      secretName: typeof config.secret === 'string' ? config.secret : '',
    });
  }
  return found;
}

/** 按名字取密钥:进程环境优先,其次端点目录的 `.env`。 */
export function readKey(endpoint: EndpointRef): string | undefined {
  if (!endpoint.secretName) return undefined;
  const fromEnv = process.env[endpoint.secretName]?.trim();
  if (fromEnv) return fromEnv;
  let text: string;
  try {
    text = readFileSync(join(endpoint.dir, '.env'), 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 0 || trimmed.slice(0, at).trim() !== endpoint.secretName) continue;
    const value = trimmed.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value) return value;
  }
  return undefined;
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

/**
 * 读一个端点的额度。密钥先按 `Authorization: Bearer` 发;被 401/403 拒时再试 `x-api-key`,因为
 * 网关的用量接口与推理接口不总是认同一个头。
 */
export async function readUsage(endpoint: EndpointRef, key: string | undefined, signal?: AbortSignal): Promise<Usage> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT, 'x-opencode-session': crypto.randomUUID() };
  const variants: Array<Record<string, string>> = key ? [{ Authorization: `Bearer ${key}` }, { 'x-api-key': key }] : [{}];
  let last: Error | null = null;
  for (const auth of variants) {
    const response = await fetch(usageUrl(endpoint.root), { headers: { ...headers, ...auth }, ...(signal ? { signal } : {}) });
    const text = await response.text();
    if (response.ok) return parseUsage(JSON.parse(text));
    const detail = text.trim().slice(0, 160);
    last = new Error(`${endpoint.name}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    if (!key || (response.status !== 401 && response.status !== 403)) break;
  }
  throw last ?? new Error(`${endpoint.name}: 没有发出请求`);
}
