/**
 * OpenCode 额度 World:定时读取订阅额度,按独立 API Key 去重合并,在面板展示实时进度与月度趋势预测,
 * 并将越线与重置事件按配置的低打扰规则(默认 piggyback)交给 bot。
 *
 * - 有 OpenCode Go 供应商端点时,按(网关根 + 实际 Key)去重;手填密钥优先。
 * - 没有供应商端点时,只要配置里给了网关地址与手填密钥即可单独监控。
 * - 按量计费端点(含按量 URL)由 `readEndpoints` 自动跳过。
 * - 越线/重置判断使用内存基线,本地历史服务 `ocq_history` 与面板月度曲线预测。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, TriggerMode, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { Language } from 'cortico/core/language.ts';
import {
  configuredRoot,
  manualKey,
  MAX_RETAIN_DAYS,
  normalizeDisplayMode,
  normalizeRetainDays,
  normalizeTriggerMode,
  openCodeQuotaConfigGroups,
  WINDOWS,
  type DisplayMode,
  type OpenCodeQuotaConfigSection,
  type Window,
} from './config.ts';
import {
  gatewayRoot,
  maskKeyHint,
  readEndpointKeys,
  readEndpoints,
  readUsage,
  type EndpointRef,
  type Usage,
  type WindowState,
} from './gateway.ts';
import { History, type SourceQuery } from './history.ts';
import { QUOTA_PANEL, type QuotaSnapshot, type SourceSnapshot } from './webui/protocol.ts';

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
  botDir: string;
}

/** 百分比 → 四态灯:绿充足、黄用了大半、红过告警线、灰已用完。 */
function lampState(percent: number, alertAt: number, status?: 'ok' | 'rate-limited'): 'online' | 'loading' | 'error' | 'offline' {
  if (percent >= 100 || status === 'rate-limited') return 'offline';
  if (percent >= alertAt) return 'error';
  if (percent >= Math.min(alertAt, 50)) return 'loading';
  return 'online';
}

/** 用 SHA-256 为 (网关根, 密钥) 生成短指纹,不在内存键中保存明文密钥。 */
function sourceId(root: string, key: string | undefined): string {
  const payload = key ? `${root}\0key:${key}` : `${root}\0missing`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/** 一把独立密钥对应的来源:可能被一个或多个 OpenCode Provider 端点共享,或是配置里的手填密钥。 */
interface Source {
  id: string;
  name: string;
  endpoints: string[];
  keyHint: string | null;
  ref: EndpointRef;
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
    const names = sources.map((source) => source.name);
    return {
      'opencode-quota.endpoints': names.length ? names.join('、') : '未配置（无 OpenCode 端点且未填手填密钥）',
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
          description: '按独立 Key 展示三个窗口的已用/剩余额度、重置倒计时与月度本地趋势预测。',
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

  private async runPoll(): Promise<void> {
    const signal = this.stopController?.signal;
    const { sources } = this.resolveSources();
    this.pruneStale(sources);
    if (!sources.length) return;
    for (const source of sources) {
      if (signal?.aborted) return;
      try {
        const usage = await readUsage(source.ref, source.key, signal);
        if (signal?.aborted) return;
        this.latest.set(source.id, usage);
        this.failures.delete(source.id);
        this.readAt.set(source.id, nowIso(this.opts.timezone));
        this.history.append({
          ts: new Date().toISOString(),
          endpoint: source.name,
          keyId: source.id,
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

  /** 端点删改或换 Key 后清理已不在当前集合中的旧缓存。 */
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

  /** 构造某个来源的历史查询条件:优先按不可逆 keyId 连续匹配,并兼容旧版无 keyId 的历史记录。 */
  private historyQuery(source: Source): SourceQuery {
    return {
      keyId: source.id,
      endpoints: [source.name, ...source.endpoints.filter((ep) => ep !== source.name)],
      label: source.name,
    };
  }

  /** 面板与徽标共用:只报已经轮询到的值与本地历史月度趋势,不联网。 */
  snapshot(includeMonthly = true): QuotaSnapshot {
    const { sources, totalEndpoints } = this.resolveSources();
    const nowMs = Date.now();
    return {
      alertAt: this.opts.cfg.alertAt,
      pollMinutes: this.opts.cfg.pollMinutes,
      retainDays: normalizeRetainDays(this.opts.cfg.retainDays),
      displayMode: normalizeDisplayMode(this.opts.cfg.displayMode),
      totalEndpoints,
      sources: sources.map((source) => {
        const windows = this.latest.get(source.id) ?? null;
        const monthly = includeMonthly && windows
          ? this.history.monthlySeries(this.historyQuery(source), windows.monthly.resetsAt, windows.monthly.percent, nowMs)
          : null;
        return {
          name: source.name,
          endpoints: [...source.endpoints],
          keyHint: source.keyHint,
          gateway: source.ref.root,
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
   * 有供应商端点就按实际 Key(与网关根)去重合并;没有就退到配置里那对网关地址与手填密钥。
   * 手填密钥在两种情形下都优先。
   */
  private resolveSources(): { sources: Source[]; totalEndpoints: number } {
    const cfg = this.opts.cfg;
    const override = manualKey(cfg);
    const endpoints = readEndpoints(this.opts.botDir);
    if (endpoints.length) {
      const groups = new Map<string, Source>();
      for (const endpoint of endpoints) {
        const resolved = override ? [{ secretName: '', key: override }] : readEndpointKeys(endpoint);
        for (let index = 0; index < resolved.length; index += 1) {
          const item = resolved[index]!;
          const id = sourceId(endpoint.root, item.key);
          const existing = groups.get(id);
          if (existing) {
            if (!existing.endpoints.includes(endpoint.name)) existing.endpoints.push(endpoint.name);
            continue;
          }
          const name = index > 0 && item.secretName ? `${endpoint.name} (${item.secretName})` : endpoint.name;
          groups.set(id, {
            id,
            name,
            endpoints: [endpoint.name],
            keyHint: maskKeyHint(item.key),
            ref: endpoint,
            key: item.key,
          });
        }
      }
      return { sources: [...groups.values()], totalEndpoints: endpoints.length };
    }
    const root = gatewayRoot(configuredRoot(cfg));
    if (!root || !override) return { sources: [], totalEndpoints: 0 };
    return {
      sources: [
        {
          id: sourceId(root, override),
          name: 'manual',
          endpoints: [],
          keyHint: maskKeyHint(override),
          ref: { name: 'manual', dir: '', root, secretName: '' },
          key: override,
        },
      ],
      totalEndpoints: 0,
    };
  }

  private async readTool(args: Record<string, unknown>): Promise<string> {
    const sources = this.select(args.endpoint);
    if (!sources.length) return this.emptyMessage(args.endpoint);
    const lines: string[] = ['OpenCode 订阅额度'];
    for (const source of sources) {
      try {
        const usage = await readUsage(source.ref, source.key, this.stopController?.signal);
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
    const lines: string[] = [];
    for (const source of this.select(args.endpoint)) {
      const query = this.historyQuery(source);
      const trend = this.history.trend(query, days);
      if (!trend) continue;
      const latestRem = `${remainingPercent(trend.latest.rolling)}%/${remainingPercent(trend.latest.weekly)}%/${remainingPercent(trend.latest.monthly)}%`;
      const latestUsed = `${trend.latest.rolling}%/${trend.latest.weekly}%/${trend.latest.monthly}%`;
      const peakUsed = `${trend.peak.rolling}%/${trend.peak.weekly}%/${trend.peak.monthly}%`;
      const current = this.latest.get(source.id);
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
    return sources.filter((source) => source.name === name || source.endpoints.includes(name));
  }

  private emptyMessage(endpoint: unknown): string {
    if (typeof endpoint === 'string' && endpoint.trim()) return `没有名为 ${endpoint.trim()} 的监控来源。`;
    return '未找到可监控的 OpenCode 来源：部署根下没有 OpenCode Go 供应商端点，且配置中未同时填网关地址与密钥。';
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
