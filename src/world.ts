/**
 * OpenCode 额度 World:定时读取 OpenCode Go 订阅额度,按独立 API Key 去重合并,
 * 在面板展示实时进度与月度趋势预测,并将越线与重置事件按配置的低打扰规则(默认 piggyback)交给 bot。
 *
 * - 密钥完全由本 World 经框架 `ctx.storeSecret()` 写入本部署 `.env`、经 `ctx.secret()` 读取,
 *   不扫描其他供应商目录,不在 `config.json` 中存放明文密钥。
 * - 支持在面板内管理多把 API Key(新增 / 更换 / 改名 / 移除),也兼容直接在本部署 `.env`
 *   设置 `OPENCODE_QUOTA_API_KEY`;内容相同的多条密钥自动合并为单次请求与单张面板。
 * - 越线/重置判断使用内存基线,本地历史服务 `ocq_history` 与面板月度曲线预测。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, TriggerMode, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { Language } from 'cortico/core/language.ts';
import type { DeepPartial } from 'cortico/world.ts';
import {
  configuredRoot,
  DEFAULT_SECRET_NAME,
  ENV_NAME_RE,
  KEY_SECRET_PREFIX,
  MAX_RETAIN_DAYS,
  normalizeDisplayMode,
  normalizeKeySlots,
  normalizeRetainDays,
  normalizeTriggerMode,
  openCodeQuotaConfigGroups,
  WINDOWS,
  type DisplayMode,
  type KeySlot,
  type OpenCodeQuotaConfigSection,
  type Window,
} from './config.ts';
import {
  gatewayRoot,
  maskKeyHint,
  readUsage,
  type Usage,
  type WindowState,
} from './gateway.ts';
import { History, type SourceQuery } from './history.ts';
import { QUOTA_PANEL, type ManagedKeyInfo, type QuotaSnapshot, type SourceSnapshot } from './webui/protocol.ts';

const HISTORY_FILE = 'opencode-quota-history.jsonl';
/** 用量掉这么多才算窗口重置,避免把抖动当重置。 */
const RESET_DROP = 5;
/** 同一来源、同一窗口、同一类事件的最小间隔。 */
const EVENT_COOLDOWN_MS = 30 * 60_000;

function windowLabel(window: Window): string {
  return window === 'rolling' ? '5小时' : window === 'weekly' ? '每周' : '每月';
}

function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, Math.round((100 - usedPercent) * 10) / 10));
}

/** 全部工具的声明(极简纯中文);`describe` 与 `tools()` 共用同一份声明。 */
export function openCodeQuotaToolDecls(): ReadonlyArray<Omit<ToolDef, 'handler'>> {
  return [
    {
      name: 'ocq_read',
      description: '查 OpenCode 订阅额度：返回 5小时/周/月已用与剩余比例及重置倒计时。',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          endpoint: { type: 'string', description: '来源名，留空查全部。' },
        },
      },
    },
    {
      name: 'ocq_history',
      description: '查本地记录的近期额度峰值、最新已用/剩余值与月度日均消耗。',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          endpoint: { type: 'string', description: '来源名，留空查全部。' },
          days: { type: 'integer', minimum: 1, maximum: MAX_RETAIN_DAYS, description: '回看天数，默认按配置的本地保留天数。' },
        },
      },
    },
  ];
}

export const OPENCODE_QUOTA_TOOL_DECLS = openCodeQuotaToolDecls();

export interface OpenCodeQuotaOptions {
  cfg: OpenCodeQuotaConfigSection;
  timezone: string;
  dataDir: string;
  /** 经框架读取本部署 `.env` 或进程环境中的密钥;空串表示未配置。 */
  secret(name: string): string;
  /** 经框架写入本部署 `.env`(仅本人可读)并同步进程环境。 */
  storeSecret(name: string, value: string): void;
  /** 经框架将非敏感配置(如密钥槽位名与变量名列表)持久化到 `worlds.opencode-quota`。 */
  persist(patch: DeepPartial<OpenCodeQuotaConfigSection>): void;
}

/** 百分比 → 四态灯:绿充足、黄用了大半、红过告警线、灰已用完。 */
function lampState(percent: number, alertAt: number, status?: 'ok' | 'rate-limited'): 'online' | 'loading' | 'error' | 'offline' {
  if (percent >= 100 || status === 'rate-limited') return 'offline';
  if (percent >= alertAt) return 'error';
  if (percent >= Math.min(alertAt, 50)) return 'loading';
  return 'online';
}

/**
 * 对 API Key 本身做带域隔离的单向 SHA-256 截断指纹(16 位十六进制):
 * 不可逆、绝不落盘明文,且与展示名/网关地址解耦——同一把 Key 无论改名、移除重加还是更换网关代理都指向同一条历史。
 */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(`cortico-opencode-quota:key:v1\0${key.trim()}`).digest('hex').slice(0, 16);
}

/** 0.3.0 兼容指纹与运行时去重键:SHA-256(网关根 + 密钥),不在内存键或历史文件中保存明文密钥。 */
function sourceId(root: string, key: string | undefined, missingTag = ''): string {
  const payload = key ? `${root}\0key:${key}` : `${root}\0missing:${missingTag}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/** 一把独立密钥对应的来源(内容相同的多条槽位已去重合并)。 */
interface Source {
  id: string;
  keyFingerprint?: string;
  name: string;
  labels: string[];
  secrets: string[];
  keyHint: string | null;
  root: string;
  key: string | undefined;
}

type Previous = Map<string, { percent: number; resetsAt: string }>;

export class OpenCodeQuotaWorld implements World {
  readonly id = 'opencode-quota';

  private readonly history: History;
  private readonly previous: Previous = new Map();
  private readonly lastEventAt = new Map<string, number>();
  private readonly latest = new Map<string, Usage>();
  private readonly failures = new Map<string, string>();
  private readonly readAt = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopController: AbortController | null = null;
  private polling: Promise<void> | null = null;
  private host: WorldHost | null = null;

  constructor(private readonly opts: OpenCodeQuotaOptions) {
    this.history = new History(join(opts.dataDir, HISTORY_FILE), () => normalizeRetainDays(this.opts.cfg.retainDays));
  }

  /** 只提供稳定的来源列表,不往静态系统前缀里塞随分钟变化的时间戳与读数。 */
  envPromptVars(): Record<string, string> {
    const { sources } = this.resolveSources();
    const names = sources.filter((source) => Boolean(source.key)).map((source) => source.name);
    return {
      'opencode-quota.endpoints': names.length ? names.join('、') : '未配置（请在额度面板添加 OpenCode Go API Key）',
    };
  }

  tools(): ToolDef[] {
    const [read, history] = openCodeQuotaToolDecls();
    return [
      { ...read!, handler: (args) => this.readTool(args) },
      { ...history!, handler: (args) => this.historyTool(args) },
    ];
  }

  webUi(_language: Language): WorldWebUiDecl {
    return {
      lamps: this.lamps(),
      badges: this.badges(),
      panels: [
        {
          id: QUOTA_PANEL,
          title: '额度',
          description: '安全管理本 World 专用的 OpenCode Go 密钥,并按独立 Key 展示三个窗口的已用/剩余额度、重置倒计时与月度趋势预测。',
        },
      ],
      invoke: async (panel, method, args) => {
        if (panel !== QUOTA_PANEL) throw new Error(`未知面板：${panel}`);
        if (method === 'state') return this.snapshot();
        if (method === 'read') {
          await this.poll();
          return this.snapshot();
        }
        if (method === 'mode') {
          this.opts.cfg.displayMode = normalizeDisplayMode(args?.[0]);
          return this.snapshot();
        }
        if (method === 'addKey') return this.addKey(args?.[0], args?.[1]);
        if (method === 'updateKey') return this.updateKey(args?.[0], args?.[1], args?.[2]);
        if (method === 'removeKey') return this.removeKey(args?.[0]);
        throw new Error(`未知方法：${method}`);
      },
      config: openCodeQuotaConfigGroups(),
      storage: [
        {
          key: 'opencode-quota-history',
          label: 'OpenCode 额度历史',
          kind: 'disk',
          location: join(this.opts.dataDir, HISTORY_FILE),
          stat: () => `${this.history.count()} 条记录`,
          clear: () => {
            this.history.clear();
            return 'OpenCode 额度历史';
          },
        },
      ],
      promptDocs: [
        {
          key: 'worlds.opencode-quota.envPrompt',
          title: 'OpenCode 额度 · 环境提示词',
          description: '告诉 bot 什么时候调用额度工具、平时不要主动打扰。',
          path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
          role: 'envPrompt',
          vars: [
            { name: 'opencode-quota.endpoints', description: '当前监控的 OpenCode 来源列表。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopController?.abort();
    this.stopController = new AbortController();
    const minutes = Math.max(1, this.opts.cfg.pollMinutes);
    this.timer = setInterval(() => void this.poll(), minutes * 60_000);
    await this.poll();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopController?.abort();
    this.stopController = null;
    this.host = null;
  }

  /** 读取所有独立来源:并发调用自动复用在途任务,避免定时器与手动刷新重入发双倍请求。 */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    const task = this.runPoll().finally(() => {
      if (this.polling === task) this.polling = null;
    });
    this.polling = task;
    return task;
  }

  /** 等待在途轮询结束后立即再轮询一次(供增删改密钥后立即刷新实时额度)。 */
  private async pollFresh(): Promise<void> {
    if (this.polling) await this.polling.catch(() => {});
    await this.poll();
  }

  private async runPoll(): Promise<void> {
    const signal = this.stopController?.signal;
    const { sources } = this.resolveSources();
    this.pruneStale(sources);
    if (!sources.length) return;
    for (const source of sources) {
      if (signal?.aborted) return;
      if (!source.key) {
        const secretName = source.secrets[0] ?? DEFAULT_SECRET_NAME;
        this.failures.set(source.id, `未在部署 .env 中读到环境变量 ${secretName}，请在「管理密钥」中重新填写或移除`);
        continue;
      }
      try {
        const usage = await readUsage({ name: source.name, root: source.root }, source.key, signal);
        if (signal?.aborted) return;
        this.latest.set(source.id, usage);
        this.failures.delete(source.id);
        this.readAt.set(source.id, nowIso(this.opts.timezone));
        this.history.append({
          ts: new Date().toISOString(),
          endpoint: source.name,
          keyId: source.keyFingerprint ?? source.id,
          rolling: usage.rolling.percent,
          weekly: usage.weekly.percent,
          monthly: usage.monthly.percent,
          resets: { rolling: usage.rolling.resetsAt, weekly: usage.weekly.resetsAt, monthly: usage.monthly.resetsAt },
        });
        await this.report(source, usage);
      } catch (error) {
        if (signal?.aborted) return;
        const reason = error instanceof Error ? error.message : String(error);
        const first = !this.failures.has(source.id);
        this.failures.set(source.id, reason);
        // 保留最近一次有效读数(不 delete this.latest),让短暂抖动不会抹空面板与状态灯。
        if (first) {
          await this.push(
            'opencode-quota.unavailable',
            `OpenCode 额度读取失败（${source.name}）：${reason}`,
            `${source.id}:unavailable`,
            { trigger: 'piggyback', deliver: false },
          );
        }
      }
    }
  }

  /** 密钥移除或更换后清理已不在当前集合中的旧缓存。 */
  private pruneStale(sources: readonly Source[]): void {
    const active = new Set(sources.map((source) => source.id));
    for (const id of [...this.latest.keys()]) if (!active.has(id)) this.latest.delete(id);
    for (const id of [...this.failures.keys()]) if (!active.has(id)) this.failures.delete(id);
    for (const id of [...this.readAt.keys()]) if (!active.has(id)) this.readAt.delete(id);
    for (const key of [...this.previous.keys()]) {
      const id = key.slice(0, key.indexOf(':'));
      if (!active.has(id)) this.previous.delete(key);
    }
  }

  /** 越线与重置:只在状态变化时报一次,不重复报同一条线;投递规则按配置热读取(默认 piggyback)。 */
  private async report(source: Source, usage: Usage): Promise<void> {
    const threshold = this.opts.cfg.alertAt;
    const resetTrigger = normalizeTriggerMode(this.opts.cfg.resetTrigger, 'piggyback');
    const thresholdTrigger = normalizeTriggerMode(this.opts.cfg.thresholdTrigger, 'piggyback');
    for (const window of WINDOWS) {
      const state = usage[window];
      const key = `${source.id}:${window}`;
      const previous = this.previous.get(key);
      this.previous.set(key, { percent: state.percent, resetsAt: state.resetsAt });
      if (!previous) continue;
      // 窗口重置只认用量掉下来。空闲时 resetsAt 每分钟往后滑,拿它判断等于每次轮询都报一次重置。
      if (previous.percent - state.percent >= RESET_DROP) {
        await this.push(
          'opencode-quota.reset',
          `OpenCode 额度已重置（${source.name}）：${windowLabel(window)}窗口已刷新，当前已用 ${state.percent}%（剩 ${remainingPercent(state.percent)}%）。`,
          `${key}:reset`,
          { trigger: resetTrigger },
        );
        continue;
      }
      if (previous.percent < threshold && state.percent >= threshold) {
        const left = remainingPercent(state.percent);
        await this.push(
          'opencode-quota.threshold',
          `OpenCode 额度告警（${source.name}）：${windowLabel(window)}已用 ${state.percent}%（剩 ${left}%），已超过 ${threshold}% 告警线。`,
          `${key}:threshold`,
          { trigger: thresholdTrigger },
        );
      }
    }
  }

  /**
   * 落一条事件。`deliver: false` 只入库、不进 bot 上下文;越线与重置按 `notify`、冷却与配置投递规则推送。
   */
  private async push(
    type: 'opencode-quota.threshold' | 'opencode-quota.reset' | 'opencode-quota.unavailable',
    body: string,
    key: string,
    opts: { trigger: TriggerMode; deliver?: boolean },
  ): Promise<void> {
    if (!this.host) return;
    const deliver = opts.deliver ?? true;
    if (deliver && !this.opts.cfg.notify) return;
    const now = Date.now();
    if (now - (this.lastEventAt.get(key) ?? 0) < EVENT_COOLDOWN_MS) return;
    this.lastEventAt.set(key, now);
    await this.host.pushEvent({
      type,
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: body,
    }, deliver ? { trigger: opts.trigger } : { trigger: opts.trigger, deliver: false });
  }

  // ---------------------------------------------------------------------------
  // 密钥管理(全部经框架 ctx.storeSecret() / ctx.secret() / ctx.persist())
  // ---------------------------------------------------------------------------

  private validateKeyValue(raw: unknown): string {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || /\s/.test(value)) {
      throw new Error('API Key 不能为空，且不能包含空格或换行。');
    }
    return value;
  }

  private allocateSecretName(existing: readonly KeySlot[]): string {
    const used = new Set(existing.map((slot) => slot.secret));
    let maxIdx = 0;
    for (const slot of existing) {
      if (slot.secret.startsWith(KEY_SECRET_PREFIX)) {
        const parsed = Number.parseInt(slot.secret.slice(KEY_SECRET_PREFIX.length), 10);
        if (Number.isFinite(parsed) && parsed > maxIdx) maxIdx = parsed;
      }
    }
    for (let index = maxIdx + 1; index < maxIdx + 10_000; index += 1) {
      const candidate = `${KEY_SECRET_PREFIX}${index}`;
      if (used.has(candidate)) continue;
      if (!this.opts.secret(candidate).trim()) return candidate;
    }
    return `${KEY_SECRET_PREFIX}${Date.now()}`;
  }

  private async addKey(rawLabel: unknown, rawKey: unknown): Promise<QuotaSnapshot> {
    const key = this.validateKeyValue(rawKey);
    const { sources } = this.resolveSources();
    const dup = sources.find((source) => source.key === key);
    if (dup) {
      throw new Error(`这把 API Key 已在监控列表中（与「${dup.name}」相同），无需重复添加。`);
    }

    const nextKeys = normalizeKeySlots(this.opts.cfg.keys);
    // 若此前仅靠部署 .env 的默认变量 OPENCODE_QUOTA_API_KEY 运行,新增第二把时顺手纳入槽位列表以免丢失
    if (nextKeys.length === 0 && this.opts.secret(DEFAULT_SECRET_NAME).trim()) {
      nextKeys.push({ label: '默认 Key', secret: DEFAULT_SECRET_NAME });
    }

    const secretName = this.allocateSecretName(nextKeys);
    const labelInput = typeof rawLabel === 'string' ? rawLabel.trim().slice(0, 40) : '';
    const label = labelInput || (nextKeys.length === 0 ? '主 Key' : `Key ${nextKeys.length + 1}`);

    this.opts.storeSecret(secretName, key);
    this.opts.persist({ keys: [...nextKeys, { label, secret: secretName }] });
    await this.pollFresh();
    return this.snapshot();
  }

  private async updateKey(rawSecret: unknown, rawLabel: unknown, rawKey?: unknown): Promise<QuotaSnapshot> {
    const secretName = typeof rawSecret === 'string' ? rawSecret.trim() : '';
    if (!ENV_NAME_RE.test(secretName)) throw new Error('无效的密钥环境变量名。');

    const currentKeys = normalizeKeySlots(this.opts.cfg.keys);
    const index = currentKeys.findIndex((slot) => slot.secret === secretName);
    const isImplicitDefault = index < 0
      && currentKeys.length === 0
      && secretName === DEFAULT_SECRET_NAME
      && Boolean(this.opts.secret(DEFAULT_SECRET_NAME).trim());
    if (index < 0 && !isImplicitDefault) {
      throw new Error(`未找到密钥条目：${secretName}`);
    }

    const trimmedNewKey = typeof rawKey === 'string' ? rawKey.trim() : '';
    let keyChanged = false;
    if (trimmedNewKey) {
      const validated = this.validateKeyValue(trimmedNewKey);
      const { sources } = this.resolveSources();
      const dup = sources.find((source) => source.key === validated && !source.secrets.includes(secretName));
      if (dup) {
        throw new Error(`新密钥与「${dup.name}」重复，请勿重复配置同一把 Key。`);
      }
      this.opts.storeSecret(secretName, validated);
      keyChanged = true;
    }

    const labelInput = typeof rawLabel === 'string' ? rawLabel.trim().slice(0, 40) : '';
    if (isImplicitDefault) {
      if (labelInput && labelInput !== '默认 Key') {
        this.opts.persist({ keys: [{ label: labelInput, secret: DEFAULT_SECRET_NAME }] });
      }
    } else if (labelInput && labelInput !== currentKeys[index]!.label) {
      const updated = currentKeys.map((slot, i) => (i === index ? { ...slot, label: labelInput } : slot));
      this.opts.persist({ keys: updated });
    }

    if (keyChanged) {
      await this.pollFresh();
    } else {
      this.pruneStale(this.resolveSources().sources);
    }
    return this.snapshot();
  }

  private async removeKey(rawSecret: unknown): Promise<QuotaSnapshot> {
    const secretName = typeof rawSecret === 'string' ? rawSecret.trim() : '';
    if (!ENV_NAME_RE.test(secretName)) throw new Error('无效的密钥环境变量名。');

    const currentKeys = normalizeKeySlots(this.opts.cfg.keys);
    const remaining = currentKeys.filter((slot) => slot.secret !== secretName);
    if (remaining.length === currentKeys.length) {
      if (secretName === DEFAULT_SECRET_NAME && this.opts.secret(DEFAULT_SECRET_NAME).trim()) {
        throw new Error(`默认变量 ${DEFAULT_SECRET_NAME} 来自本部署 .env，请直接从 .env 文件删除该行。`);
      }
      throw new Error(`未找到密钥条目：${secretName}`);
    }

    this.opts.persist({ keys: remaining });
    this.pruneStale(this.resolveSources().sources);
    return this.snapshot();
  }

  // ---------------------------------------------------------------------------
  // 快照、徽标、四态灯与来源解析
  // ---------------------------------------------------------------------------

  /**
   * 构造某个来源的历史查询条件:
   * - 同时匹配 0.3.1 纯 Key 指纹与 0.3.0 旧指纹(同把 Key 改名、删后重加、换网关代理都不丢数据);
   * - 对升级前(0.1.x–0.2.x)无 keyId 的历史记录,结合月度重置锚点精准归属,避免老数据因名称变化不可见。
   */
  private historyQuery(source: Source, monthlyResetsAt: string | undefined, totalSources: number): SourceQuery {
    const keyIds = source.keyFingerprint ? [source.keyFingerprint, source.id] : [source.id];
    return {
      keyIds,
      endpoints: [source.name, ...source.labels.filter((label) => label !== source.name)],
      label: source.name,
      ...(monthlyResetsAt ? { monthlyResetsAt } : {}),
      ...(totalSources === 1 ? { singleSource: true } : {}),
    };
  }

  /** 面板与徽标共用:只报已经轮询到的值与本地历史月度趋势,不联网。 */
  snapshot(includeMonthly = true): QuotaSnapshot {
    const { gateway, managedKeys, sources } = this.resolveSources();
    const nowMs = Date.now();
    const totalSources = sources.length;
    return {
      alertAt: this.opts.cfg.alertAt,
      pollMinutes: this.opts.cfg.pollMinutes,
      retainDays: normalizeRetainDays(this.opts.cfg.retainDays),
      displayMode: normalizeDisplayMode(this.opts.cfg.displayMode),
      gateway,
      managedKeys,
      sources: sources.map((source) => {
        const windows = this.latest.get(source.id) ?? null;
        const monthly = includeMonthly && windows
          ? this.history.monthlySeries(
              this.historyQuery(source, windows.monthly.resetsAt, totalSources),
              windows.monthly.resetsAt,
              windows.monthly.percent,
              nowMs,
            )
          : null;
        return {
          name: source.name,
          labels: [...source.labels],
          secrets: [...source.secrets],
          keyHint: source.keyHint,
          gateway: source.root,
          readAt: this.readAt.get(source.id) ?? null,
          error: this.failures.get(source.id) ?? null,
          windows,
          monthly,
        };
      }),
    };
  }

  /** 跨多把 Key 找出每个窗口当前最紧的那条读数;单把 Key 时就是它自己。 */
  private tightestByWindow(sources: readonly SourceSnapshot[]): Record<Window, { sourceName: string; state: WindowState }> | null {
    const readable = sources.filter((source): source is SourceSnapshot & { windows: Record<Window, WindowState> } => source.windows !== null);
    if (!readable.length) return null;
    const out = {} as Record<Window, { sourceName: string; state: WindowState }>;
    for (const window of WINDOWS) {
      let picked = { sourceName: readable[0]!.name, state: readable[0]!.windows[window] };
      for (const source of readable.slice(1)) {
        const candidate = source.windows[window];
        const candidateScore = candidate.status === 'rate-limited' ? 101 : candidate.percent;
        const pickedScore = picked.state.status === 'rate-limited' ? 101 : picked.state.percent;
        if (candidateScore > pickedScore) picked = { sourceName: source.name, state: candidate };
      }
      out[window] = picked;
    }
    return out;
  }

  /** 页头三颗四态灯:绿充足、黄用了大半、红过告警线、灰已用完。 */
  private lamps(): WorldWebUiDecl['lamps'] {
    const snapshot = this.snapshot(false);
    const tightest = this.tightestByWindow(snapshot.sources);
    if (!tightest) return [];
    const multi = snapshot.sources.length > 1;
    const mode: DisplayMode = snapshot.displayMode;
    return WINDOWS.map((window) => {
      const { sourceName, state } = tightest[window];
      const left = remainingPercent(state.percent);
      const baseHint = mode === 'remaining'
        ? `剩余 ${left}% · 已用 ${state.percent}%`
        : `已用 ${state.percent}% · 剩余 ${left}%`;
      return {
        label: window === 'rolling' ? '每 5 小时' : window === 'weekly' ? '每周' : '每月',
        state: lampState(state.percent, snapshot.alertAt, state.status),
        hint: multi ? `${sourceName} · ${baseHint}` : baseHint,
      };
    });
  }

  /** World 页顶部的读数徽标:三个窗口各一个,多把独立 Key 时附一把 Key 计数徽标。 */
  private badges(): WorldWebUiDecl['badges'] {
    const snapshot = this.snapshot(false);
    const tightest = this.tightestByWindow(snapshot.sources);
    if (!tightest) return [{ label: '未读到', value: '—', tone: 'plain' }];
    const mode: DisplayMode = snapshot.displayMode;
    const items: NonNullable<WorldWebUiDecl['badges']> = WINDOWS.map((window) => {
      const { state } = tightest[window];
      const value = mode === 'remaining' ? `剩 ${remainingPercent(state.percent)}%` : `${state.percent}%`;
      return {
        label: window === 'rolling' ? '每 5 小时' : window === 'weekly' ? '每周' : '每月',
        value,
        tone: state.percent >= snapshot.alertAt || state.status === 'rate-limited' ? 'off' : 'on',
      };
    });
    if (snapshot.sources.length > 1) {
      items.push({ label: '独立 Key', value: String(snapshot.sources.length), tone: 'plain' });
    }
    return items;
  }

  /**
   * 仅从本 World 登记的密钥槽位(或默认变量 `OPENCODE_QUOTA_API_KEY`)经框架 `ctx.secret()` 解析来源,
   * 并按 `(网关根, 实际密钥)` 去重合并。
   */
  private resolveSources(): { gateway: string; managedKeys: ManagedKeyInfo[]; sources: Source[] } {
    const root = gatewayRoot(configuredRoot(this.opts.cfg));
    const slots = normalizeKeySlots(this.opts.cfg.keys);
    const managedKeys: ManagedKeyInfo[] = [];
    const groups = new Map<string, Source>();

    if (slots.length === 0) {
      const envKey = this.opts.secret(DEFAULT_SECRET_NAME).trim();
      if (envKey) {
        const hint = maskKeyHint(envKey);
        managedKeys.push({ label: '默认 Key', secret: DEFAULT_SECRET_NAME, keyHint: hint, envDefault: true });
        if (root) {
          const id = sourceId(root, envKey);
          groups.set(id, {
            id,
            keyFingerprint: keyFingerprint(envKey),
            name: '默认 Key',
            labels: ['默认 Key'],
            secrets: [DEFAULT_SECRET_NAME],
            keyHint: hint,
            root,
            key: envKey,
          });
        }
      }
      return { gateway: root, managedKeys, sources: [...groups.values()] };
    }

    for (const slot of slots) {
      const rawKey = this.opts.secret(slot.secret).trim();
      const key = rawKey || undefined;
      const hint = maskKeyHint(key);
      managedKeys.push({ label: slot.label, secret: slot.secret, keyHint: hint });
      if (!root) continue;
      const id = sourceId(root, key, slot.secret);
      const existing = groups.get(id);
      if (existing) {
        if (!existing.labels.includes(slot.label)) existing.labels.push(slot.label);
        if (!existing.secrets.includes(slot.secret)) existing.secrets.push(slot.secret);
        continue;
      }
      groups.set(id, {
        id,
        ...(key ? { keyFingerprint: keyFingerprint(key) } : {}),
        name: slot.label,
        labels: [slot.label],
        secrets: [slot.secret],
        keyHint: hint,
        root,
        key,
      });
    }
    return { gateway: root, managedKeys, sources: [...groups.values()] };
  }

  private async readTool(args: Record<string, unknown>): Promise<string> {
    const sources = this.select(args.endpoint);
    if (!sources.length) return this.emptyMessage(args.endpoint);
    const lines: string[] = ['OpenCode 订阅额度'];
    for (const source of sources) {
      if (!source.key) {
        const secretName = source.secrets[0] ?? DEFAULT_SECRET_NAME;
        lines.push(`${source.name}：未读到密钥（环境变量 ${secretName} 为空）`);
        continue;
      }
      try {
        const usage = await readUsage({ name: source.name, root: source.root }, source.key, this.stopController?.signal);
        this.latest.set(source.id, usage);
        this.failures.delete(source.id);
        this.readAt.set(source.id, nowIso(this.opts.timezone));
        lines.push(`${source.name}：${this.describe(usage)}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.failures.set(source.id, reason);
        lines.push(`${source.name}：读取失败（${reason}）`);
      }
    }
    return lines.join('\n');
  }

  private async historyTool(args: Record<string, unknown>): Promise<string> {
    const retain = normalizeRetainDays(this.opts.cfg.retainDays);
    const days = typeof args.days === 'number' ? Math.min(MAX_RETAIN_DAYS, Math.max(1, Math.floor(args.days))) : retain;
    const allSources = this.resolveSources().sources;
    const totalSources = allSources.length;
    const lines: string[] = [];
    for (const source of this.select(args.endpoint)) {
      const current = this.latest.get(source.id);
      const query = this.historyQuery(source, current?.monthly.resetsAt, totalSources);
      const trend = this.history.trend(query, days);
      if (!trend) continue;
      const latestRem = `${remainingPercent(trend.latest.rolling)}%/${remainingPercent(trend.latest.weekly)}%/${remainingPercent(trend.latest.monthly)}%`;
      const latestUsed = `${trend.latest.rolling}%/${trend.latest.weekly}%/${trend.latest.monthly}%`;
      const peakUsed = `${trend.peak.rolling}%/${trend.peak.weekly}%/${trend.peak.monthly}%`;
      const monthly = current
        ? this.history.monthlySeries(query, current.monthly.resetsAt, current.monthly.percent)
        : null;
      const pace = monthly && monthly.dailyRate > 0
        ? `，本月日均 ${monthly.dailyRate}%${monthly.projectedHitAt ? `（预计 ${formatCnDate(monthly.projectedHitAt)} 耗尽）` : ''}`
        : '';
      lines.push(
        `${source.name}：近 ${days} 天共 ${trend.samples} 条记录，峰值(5h/周/月) ${peakUsed}，最新已用 ${latestUsed}（剩 ${latestRem}）${pace}`,
      );
    }
    return lines.length ? lines.join('\n') : '暂无本地额度历史记录。';
  }

  private select(endpoint: unknown): Source[] {
    const { sources } = this.resolveSources();
    if (typeof endpoint !== 'string' || !endpoint.trim()) return sources;
    const name = endpoint.trim();
    return sources.filter((source) => source.name === name || source.labels.includes(name) || source.secrets.includes(name));
  }

  private emptyMessage(endpoint: unknown): string {
    if (typeof endpoint === 'string' && endpoint.trim()) return `没有名为 ${endpoint.trim()} 的监控来源。`;
    const root = gatewayRoot(configuredRoot(this.opts.cfg));
    if (!root) return '未配置有效的 OpenCode 网关地址，请在「配置」页签检查网关地址。';
    return '尚未配置 OpenCode Go API Key：请在「额度」面板中添加密钥（或在部署 .env 中设置 OPENCODE_QUOTA_API_KEY）。';
  }

  private describe(usage: Usage): string {
    return WINDOWS.map((window) => {
      const state = usage[window];
      const leftPct = remainingPercent(state.percent);
      const leftTime = duration(Math.max(0, Date.parse(state.resetsAt) - Date.now()));
      const limitNote = state.status === 'rate-limited' ? '，已达上限' : '';
      return `${windowLabel(window)} 已用 ${state.percent}%（剩 ${leftPct}%${limitNote}），${leftTime} 后重置`;
    }).join(' | ');
  }
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

function formatCnDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
