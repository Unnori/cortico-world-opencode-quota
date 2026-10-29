/**
 * OpenCode 额度 World:定时读订阅额度,把越线与重置交给 bot,并留一份可查的历史。
 *
 * 读哪儿由一件事决定:部署根下有没有 OpenCode 供应商端点。
 * - 有:每个端点一条来源,密钥用它自己声明的变量名;配置里填了手填密钥时,手填的优先。
 * - 没有:只要配置里同时给了网关地址与手填密钥,就把它当一条来源——不装供应商插件也能单独当监控用。
 *
 * 额度只在 Go 订阅上有;按量计费的端点由 `readEndpoints` 排除。越线判断用内存里的上一次读数,
 * 历史只服务 `ocq_history` 的趋势——两者不混用,免得一条坏历史改变告警。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { Language } from 'cortico/core/language.ts';
import { pick } from 'cortico/core/language.ts';
import { configuredRoot, manualKey, openCodeQuotaConfigGroups, WINDOWS, type OpenCodeQuotaConfigSection, type Window } from './config.ts';
import { gatewayRoot, readEndpoints, readKey, readUsage, type EndpointRef, type Usage } from './gateway.ts';
import { History } from './history.ts';
import { QUOTA_PANEL, type QuotaSnapshot } from './webui/protocol.ts';

const HISTORY_FILE = 'opencode-quota-history.jsonl';
/** 事件随其他事件合批投递:越线不值得打断正在进行的回答。 */
const TRIGGER = 'debounce' as const;
const RETAIN_DAYS = 14;
/** 用量掉这么多才算窗口重置,避免把抖动当重置。 */
const RESET_DROP = 5;
/** 同一来源、同一窗口、同一类事件的最小间隔。 */
const EVENT_COOLDOWN_MS = 30 * 60_000;

/** 工具描述、事件正文与环境提示词都是给模型看的,按项目规矩只写英文;界面文案另由 webUi(language) 给。 */
interface Text {
  readDescription: string;
  readEndpointParam: string;
  historyDescription: string;
  historyEndpointParam: string;
  historyDaysParam: string;
  noSource: string;
  noneMatched(names: string): string;
  thresholdEvent(window: Window, endpoint: string, percent: number, threshold: number): string;
  resetEvent(window: Window, endpoint: string): string;
  unavailable(endpoint: string, reason: string): string;
  windowLabel(window: Window): string;
  cell(window: Window, percent: number, left: string, limited: boolean): string;
  summaryTitle: string;
  summaryLine(name: string, cells: string): string;
  failureLine(name: string, reason: string): string;
  trendLine(endpoint: string, samples: number, peak: string, latest: string): string;
  noHistory: string;
}

function windowLabel(window: Window): string {
  return window === 'rolling' ? '5-hour' : window === 'weekly' ? 'weekly' : 'monthly';
}

const t: Text = {
  readDescription: 'Read the OpenCode subscription allowance: the 5-hour, weekly and monthly windows with percentages and reset times.',
  readEndpointParam: 'Only this source; omit to read every watched source.',
  historyDescription: 'Recent allowance trend: sample count, each window\u2019s peak and latest value.',
  historyEndpointParam: 'Only this source; omit for one line per source.',
  historyDaysParam: 'How many days back, defaulting to 14.',
  noSource: 'No OpenCode source: no provider endpoint under the deployment root has kind opencode, and no gateway URL with an API key was configured.',
  noneMatched: (names) => `No watched source is named ${names}.`,
  thresholdEvent: (window, endpoint, percent, threshold) =>
    `OpenCode source ${endpoint} reached ${percent}% of its ${windowLabel(window)} allowance, past the ${threshold}% threshold.`,
  resetEvent: (window, endpoint) => `The ${windowLabel(window)} allowance window of OpenCode source ${endpoint} has reset.`,
  unavailable: (endpoint, reason) => `The allowance of OpenCode source ${endpoint} could not be read: ${reason}`,
  windowLabel,
  cell: (window, percent, left, limited) => `${windowLabel(window)} ${percent}%${limited ? ' (at the limit)' : ''}, resets in ${left}`,
  summaryTitle: 'OpenCode allowance',
  summaryLine: (name, cells) => `${name}: ${cells}`,
  failureLine: (name, reason) => `${name}: unreadable (${reason})`,
  trendLine: (endpoint, samples, peak, latest) => `${endpoint}: ${samples} samples, peak ${peak}, latest ${latest}`,
  noHistory: 'No allowance sample has been recorded yet.',
};

/** 全部工具的声明;`describe` 与 `tools()` 都取它。 */
export function openCodeQuotaToolDecls(): ReadonlyArray<Omit<ToolDef, 'handler'>> {
  return [
    {
      name: 'ocq_read',
      description: t.readDescription,
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          endpoint: { type: 'string', description: t.readEndpointParam },
        },
      },
    },
    {
      name: 'ocq_history',
      description: t.historyDescription,
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          endpoint: { type: 'string', description: t.historyEndpointParam },
          days: { type: 'integer', minimum: 1, maximum: 90, description: t.historyDaysParam },
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
function lampState(percent: number, alertAt: number): 'online' | 'loading' | 'error' | 'offline' {
  if (percent >= 100) return 'offline';
  if (percent >= alertAt) return 'error';
  if (percent >= Math.min(alertAt, 50)) return 'loading';
  return 'online';
}

/** 一条来源:一个供应商端点,或配置里那对网关地址与手填密钥。 */
interface Source {
  name: string;
  ref: EndpointRef;
  key: string | undefined;
}

/** 上一个读到的百分比,用来判断「刚越过告警线」而不是「一直在线以上」。 */
type Previous = Map<string, { percent: number; resetsAt: string }>;

export class OpenCodeQuotaWorld implements World {
  readonly id = 'opencode-quota';

  private readonly history: History;
  private readonly previous: Previous = new Map();
  private readonly lastEventAt = new Map<string, number>();
  private readonly latest = new Map<string, Usage>();
  private readonly failures = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastReadAt: string | null = null;
  private readonly readAt = new Map<string, string>();
  private host: WorldHost | null = null;

  constructor(private readonly opts: OpenCodeQuotaOptions) {
    this.history = new History(join(opts.dataDir, HISTORY_FILE));
  }

  /** 只报值;前缀文本一律来自 ENV_PROMPT.md。 */
  envPromptVars(): Record<string, string> {
    const names = this.sources().map((source) => source.name);
    return {
      'opencode-quota.endpoints': names.length ? names.join(', ') : t.noSource,
      'opencode-quota.worst': this.worstWindow() ?? '—',
      'opencode-quota.lastRead': this.lastReadAt ?? '—',
    };
  }

  tools(): ToolDef[] {
    const [read, history] = openCodeQuotaToolDecls();
    return [
      { ...read!, handler: (args) => this.readTool(args) },
      { ...history!, handler: (args) => this.historyTool(args) },
    ];
  }

  webUi(language: Language): WorldWebUiDecl {
    const s = pick(language, {
      zh: { panel: 'OpenCode 额度历史', panelTitle: '额度', panelDescription: '三个窗口的用量、重置倒计时与上一次读取的时刻。', title: 'OpenCode 额度 · 环境提示词', description: '告诉 bot 什么时候去查额度、什么时候别主动提。', endpointVar: '此刻监控的来源。', worstVar: '此刻最紧的那个窗口。', readVar: '上一次读到额度的时刻。', rows: '行', none: '未读到' },
      en: { panel: 'OpenCode allowance history', panelTitle: 'Allowance', panelDescription: 'The three windows, their reset countdowns, and when they were last read.', title: 'OpenCode allowance \u00b7 environment prompt', description: 'Tells the bot when to check the allowance and when not to bring it up.', endpointVar: 'The sources watched right now.', worstVar: 'The tightest window right now.', readVar: 'When the allowance was last read.', rows: 'rows', none: 'not read' },
    });
    return {
      lamps: this.lamps(language),
      badges: this.badges(language),
      panels: [{ id: QUOTA_PANEL, title: s.panelTitle, description: s.panelDescription }],
      invoke: async (panel, method) => {
        if (panel !== QUOTA_PANEL) throw new Error(`no panel ${panel}`);
        if (method === 'state') return this.snapshot();
        if (method === 'read') {
          await this.poll();
          return this.snapshot();
        }
        throw new Error(`no method ${method}`);
      },
      config: openCodeQuotaConfigGroups(language),
      storage: [
        {
          key: 'opencode-quota-history',
          label: s.panel,
          kind: 'disk',
          location: join(this.opts.dataDir, HISTORY_FILE),
          stat: () => `${this.history.read().length} ${s.rows}`,
          clear: () => {
            this.history.clear();
            return s.panel;
          },
        },
      ],
      promptDocs: [
        {
          key: 'worlds.opencode-quota.envPrompt',
          title: s.title,
          description: s.description,
          path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
          role: 'envPrompt',
          vars: [
            { name: 'opencode-quota.endpoints', description: s.endpointVar },
            { name: 'opencode-quota.worst', description: s.worstVar },
            { name: 'opencode-quota.lastRead', description: s.readVar },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const minutes = Math.max(1, this.opts.cfg.pollMinutes);
    this.timer = setInterval(() => void this.poll(), minutes * 60_000);
    await this.poll();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.host = null;
  }

  /** 读一遍所有来源:更新快照、记历史、必要时推事件。 */
  async poll(): Promise<void> {
    const sources = this.sources();
    if (!sources.length) return;
    for (const source of sources) {
      try {
        const usage = await readUsage(source.ref, source.key);
        this.latest.set(source.name, usage);
        this.failures.delete(source.name);
        this.lastReadAt = nowIso(this.opts.timezone);
        this.readAt.set(source.name, this.lastReadAt);
        this.history.append({
          ts: new Date().toISOString(),
          endpoint: source.name,
          rolling: usage.rolling.percent,
          weekly: usage.weekly.percent,
          monthly: usage.monthly.percent,
          resets: { rolling: usage.rolling.resetsAt, weekly: usage.weekly.resetsAt, monthly: usage.monthly.resetsAt },
        });
        await this.report(source, usage);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const first = !this.failures.has(source.name);
        this.failures.set(source.name, reason);
        this.latest.delete(source.name);
        if (first) await this.push('opencode-quota.unavailable', t.unavailable(source.name, reason), `${source.name}:unavailable`);
      }
    }
  }

  /** 越线与重置:只在状态变化时报一次,不重复报同一条线。 */
  private async report(source: Source, usage: Usage): Promise<void> {
    const threshold = this.opts.cfg.alertAt;
    for (const window of WINDOWS) {
      const state = usage[window];
      const key = `${source.name}:${window}`;
      const previous = this.previous.get(key);
      this.previous.set(key, { percent: state.percent, resetsAt: state.resetsAt });
      if (!previous) continue;
      // 窗口重置只认用量掉下来。空闲时 resetsAt 每分钟往后滑,拿它判断等于每次轮询都报一次重置。
      if (previous.percent - state.percent >= RESET_DROP) {
        await this.push('opencode-quota.reset', t.resetEvent(window, source.name), `${key}:reset`);
        continue;
      }
      if (previous.percent < threshold && state.percent >= threshold) {
        await this.push('opencode-quota.threshold', t.thresholdEvent(window, source.name, state.percent, threshold), `${key}:threshold`);
      }
    }
  }

  private async push(
    type: 'opencode-quota.threshold' | 'opencode-quota.reset' | 'opencode-quota.unavailable',
    body: string,
    key: string,
  ): Promise<void> {
    if (!this.opts.cfg.notify || !this.host) return;
    // 同一来源、同一窗口、同一类事件在冷却时间内只报一次:判断再出错也最多吵一次,不会连成串。
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
    }, { trigger: TRIGGER });
  }

  /** 面板与徽标共用:只报已经轮询到的值,不联网。 */
  snapshot(): QuotaSnapshot {
    return {
      alertAt: this.opts.cfg.alertAt,
      pollMinutes: this.opts.cfg.pollMinutes,
      sources: this.sources().map((source) => ({
        name: source.name,
        readAt: this.readAt.get(source.name) ?? null,
        error: this.failures.get(source.name) ?? null,
        windows: this.latest.get(source.name) ?? null,
      })),
    };
  }

  /** 页头三颗四态灯:绿充足、黄用了大半、红过告警线、灰已用完。 */
  private lamps(language: Language): WorldWebUiDecl['lamps'] {
    const s = pick(language, {
      zh: { rolling: '每 5 小时', weekly: '每周', monthly: '每月', used: (percent: number) => `已用 ${percent}%` },
      en: { rolling: '5-hour', weekly: 'weekly', monthly: 'monthly', used: (percent: number) => `${percent}% used` },
    });
    const snapshot = this.snapshot();
    const windows = snapshot.sources[0]?.windows;
    // 还没读到过就不报灯:灰是「已用完」,不是「没数据」。
    if (!windows) return [];
    return WINDOWS.map((window) => ({
      label: window === 'rolling' ? s.rolling : window === 'weekly' ? s.weekly : s.monthly,
      state: lampState(windows[window].percent, snapshot.alertAt),
      hint: s.used(windows[window].percent),
    }));
  }

  /** World 页顶部的读数徽标:三个窗口各一个。 */
  private badges(language: Language): WorldWebUiDecl['badges'] {
    const s = pick(language, {
      zh: { none: '未读到', rolling: '每 5 小时', weekly: '每周', monthly: '每月' },
      en: { none: 'not read', rolling: '5-hour', weekly: 'weekly', monthly: 'monthly' },
    });
    const snapshot = this.snapshot();
    const windows = snapshot.sources[0]?.windows;
    if (!windows) return [{ label: s.none, value: '—', tone: 'plain' }];
    return WINDOWS.map((window) => ({
      label: window === 'rolling' ? s.rolling : window === 'weekly' ? s.weekly : s.monthly,
      value: `${windows[window].percent}%`,
      tone: windows[window].percent >= snapshot.alertAt ? 'off' : 'on',
    }));
  }

  /**
   * 有供应商端点就按端点来;没有就退到配置里那对网关地址与手填密钥。手填密钥在两种情形下都优先。
   */
  private sources(): Source[] {
    const cfg = this.opts.cfg;
    const override = manualKey(cfg);
    const endpoints = readEndpoints(this.opts.botDir);
    if (endpoints.length) {
      return endpoints.map((endpoint) => ({ name: endpoint.name, ref: endpoint, key: override ?? readKey(endpoint) }));
    }
    const root = gatewayRoot(configuredRoot(cfg));
    if (!root || !override) return [];
    return [{ name: 'manual', ref: { name: 'manual', dir: '', root, secretName: '' }, key: override }];
  }

  private worstWindow(): string | null {
    let worst: { label: string; percent: number } | null = null;
    for (const [name, usage] of this.latest) {
      for (const window of WINDOWS) {
        const percent = usage[window].percent;
        if (!worst || percent > worst.percent) worst = { label: `${name} ${windowLabel(window)}`, percent };
      }
    }
    return worst ? `${worst.label} ${worst.percent}%` : null;
  }

  private async readTool(args: Record<string, unknown>): Promise<string> {
    const sources = this.select(args.endpoint);
    if (!sources.length) return this.emptyMessage(args.endpoint);
    const lines: string[] = [t.summaryTitle];
    for (const source of sources) {
      try {
        const usage = await readUsage(source.ref, source.key);
        this.latest.set(source.name, usage);
        this.failures.delete(source.name);
        lines.push(t.summaryLine(source.name, this.describe(usage)));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.failures.set(source.name, reason);
        lines.push(t.failureLine(source.name, reason));
      }
    }
    return lines.join('\n');
  }

  private async historyTool(args: Record<string, unknown>): Promise<string> {
    const days = typeof args.days === 'number' ? Math.min(90, Math.max(1, args.days)) : RETAIN_DAYS;
    const lines: string[] = [];
    for (const source of this.select(args.endpoint)) {
      const trend = this.history.trend(source.name, days);
      if (!trend) continue;
      lines.push(t.trendLine(source.name, trend.samples,
        `${trend.peak.rolling}/${trend.peak.weekly}/${trend.peak.monthly}`,
        `${trend.latest.rolling}/${trend.latest.weekly}/${trend.latest.monthly}`));
    }
    return lines.length ? lines.join('\n') : t.noHistory;
  }

  private select(endpoint: unknown): Source[] {
    const sources = this.sources();
    if (typeof endpoint !== 'string' || !endpoint.trim()) return sources;
    const name = endpoint.trim();
    return sources.filter((source) => source.name === name);
  }

  private emptyMessage(endpoint: unknown): string {
    if (typeof endpoint === 'string' && endpoint.trim()) return t.noneMatched(endpoint.trim());
    return t.noSource;
  }

  private describe(usage: Usage): string {
    return WINDOWS.map((window) => {
      const state = usage[window];
      const left = duration(Math.max(0, Date.parse(state.resetsAt) - Date.now()));
      return t.cell(window, state.percent, left, state.status === 'rate-limited');
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
