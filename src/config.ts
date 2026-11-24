/**
 * `worlds.opencode-quota` 的配置段与配置组。默认禁用,由 bot 或部署启用。
 *
 * 密钥不存进 `config.json`:本 World 仅在 `keys` 里记录展示名与部署 `.env` 变量名,
 * 实际 API Key 一律经由框架 `ctx.storeSecret()` 写入本部署 `.env`、经 `ctx.secret()` 读取。
 */
import type { ConfigGroup, TriggerMode } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';

/** 三个额度窗口的名字,与网关返回的键一致。 */
export type Window = 'rolling' | 'weekly' | 'monthly';

export const WINDOWS: readonly Window[] = ['rolling', 'weekly', 'monthly'];

/** 面板与页头徽标的额度展示方式:已用百分比或剩余百分比。 */
export type DisplayMode = 'used' | 'remaining';

export const DISPLAY_MODES: readonly DisplayMode[] = ['used', 'remaining'];

export function normalizeDisplayMode(value: unknown): DisplayMode {
  return value === 'remaining' ? 'remaining' : 'used';
}

/** 宿主的五种事件投递规则,按打扰程度从低到高排列。 */
export const TRIGGER_MODES: readonly TriggerMode[] = ['piggyback', 'debounce', 'flush', 'preempt', 'interrupt'];

export function normalizeTriggerMode(value: unknown, fallback: TriggerMode = 'piggyback'): TriggerMode {
  return typeof value === 'string' && (TRIGGER_MODES as readonly string[]).includes(value)
    ? (value as TriggerMode)
    : fallback;
}

export const MIN_RETAIN_DAYS = 7;
export const MAX_RETAIN_DAYS = 365;
export const DEFAULT_RETAIN_DAYS = 35;

export function normalizeRetainDays(value: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_RETAIN_DAYS;
  return Math.max(MIN_RETAIN_DAYS, Math.min(MAX_RETAIN_DAYS, n));
}

/**
 * 默认单 Key 环境变量名(供手动在本部署 `.env` 配置使用);
 * 不复用 `OPENCODE_API_KEY`,避免与供应商端点的密钥变量互相覆盖。
 */
export const DEFAULT_SECRET_NAME = 'OPENCODE_QUOTA_API_KEY';

/** 面板托管的多 Key 环境变量名前缀(`OPENCODE_QUOTA_KEY_1`、`OPENCODE_QUOTA_KEY_2`…)。 */
export const KEY_SECRET_PREFIX = 'OPENCODE_QUOTA_KEY_';

/** 合法的环境变量名格式(与框架 `storeSecret` 校验保持一致)。 */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface KeySlot {
  /** 用户自定义的展示名称(如「主力账号」「备用 Key」),仅元信息、不含密钥。 */
  label: string;
  /** 存放在本部署 `.env` 中的环境变量名,只经 `ctx.secret()` / `ctx.storeSecret()` 读写。 */
  secret: string;
}

export function normalizeKeySlots(raw: unknown): KeySlot[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: KeySlot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { label?: unknown; secret?: unknown };
    const secret = typeof rec.secret === 'string' ? rec.secret.trim() : '';
    if (!ENV_NAME_RE.test(secret) || seen.has(secret)) continue;
    seen.add(secret);
    const label = typeof rec.label === 'string' && rec.label.trim() ? rec.label.trim().slice(0, 40) : secret;
    out.push({ label, secret });
  }
  return out;
}

export interface OpenCodeQuotaConfigSection {
  enabled: boolean;
  /** OpenCode 网关地址,默认 https://opencode.ai/inference。 */
  baseUrl: string;
  /** 本 World 托管的密钥槽位列表(只存展示名与 `.env` 变量名,绝不存明文密钥)。 */
  keys: KeySlot[];
  /** 读额度的间隔,分钟。启动时定下。 */
  pollMinutes: number;
  /** 任一窗口到这个百分比就提醒。 */
  alertAt: number;
  /** 是否把越线与重置推成事件。 */
  notify: boolean;
  /** 窗口重置(额度刷新)事件的投递规则;默认 piggyback,不单独唤醒 bot。 */
  resetTrigger: TriggerMode;
  /** 越过告警线事件的投递规则;默认 piggyback,不单独唤醒 bot。 */
  thresholdTrigger: TriggerMode;
  /** 面板与徽标的显示模式:已用('used')或剩余('remaining')。 */
  displayMode: DisplayMode;
  /** 本地历史记录保留天数(7–365 天,默认 35 天覆盖完整月度周期)。 */
  retainDays: number;
}

export const OPENCODE_QUOTA_DEFAULTS: OpenCodeQuotaConfigSection = {
  enabled: false,
  baseUrl: 'https://opencode.ai/inference',
  keys: [],
  pollMinutes: 1,
  alertAt: 80,
  notify: true,
  resetTrigger: 'piggyback',
  thresholdTrigger: 'piggyback',
  displayMode: 'used',
  retainDays: DEFAULT_RETAIN_DAYS,
};

/** 网关地址,去空白后为空表示没填。 */
export function configuredRoot(cfg: OpenCodeQuotaConfigSection): string {
  return (cfg.baseUrl ?? '').trim();
}

/** 唯一的配置组(纯中文文案,不含明文密钥项;密钥在「额度」面板经框架 `.env` 安全管理)。 */
export function openCodeQuotaConfigGroups(_language?: Language): ConfigGroup[] {
  const prefix = 'worlds.opencode-quota.';
  return [
    {
      id: 'world:opencode-quota',
      owner: 'world:opencode-quota',
      schema: {
        type: 'object',
        title: 'OpenCode 额度',
        description: '读取 OpenCode Go 订阅额度(每 5 小时 / 每周 / 每月)。API Key 请在「额度」页签的密钥管理区添加(经框架写入本部署 .env,不落盘到 config.json)。',
        properties: {
          [`${prefix}pollMinutes`]: {
            type: 'integer',
            title: '读取间隔',
            description: '多久读一次额度。改动在重启本 World 后生效。',
            minimum: 1,
            maximum: 180,
            'x-suffix': ' 分钟',
            'x-hot': false,
          },
          [`${prefix}alertAt`]: {
            type: 'integer',
            title: '告警线',
            description: '任一窗口已用比例达到此百分比时触发一次告警;持续在线以上不重复提醒。',
            minimum: 1,
            maximum: 100,
            'x-suffix': '%',
            'x-hot': true,
          },
          [`${prefix}notify`]: {
            type: 'boolean',
            title: '推送额度事件',
            description: '关闭后仅保留查询工具、面板与本地历史,不向 bot 推送越线与额度刷新事件。',
            'x-hot': true,
          },
          [`${prefix}resetTrigger`]: {
            type: 'string',
            enum: [...TRIGGER_MODES],
            title: '额度刷新投递规则',
            description: '窗口重置(额度刷新)事件如何投递给 bot。piggyback(默认,最不打扰)= 仅静默入队、等下次事件搭便车;debounce = 安静片刻后合批唤醒;flush = 立即唤醒;preempt = 取消未输出在途轮重投;interrupt = 立即打断当前轮。',
            'x-hot': true,
          },
          [`${prefix}thresholdTrigger`]: {
            type: 'string',
            enum: [...TRIGGER_MODES],
            title: '越线告警投递规则',
            description: '任一窗口刚越过告警线时的投递方式。默认 piggyback(静默搭便车,不主动打扰);如需主动唤醒可改选 debounce 或 flush。',
            'x-hot': true,
          },
          [`${prefix}displayMode`]: {
            type: 'string',
            enum: [...DISPLAY_MODES],
            title: '显示模式',
            description: 'used = 按已用额度显示(进度条与折线随消耗增长),remaining = 按剩余额度显示(随消耗减少直至跌破 0%)。也可在额度面板顶部一键切换。',
            'x-hot': true,
          },
          [`${prefix}retainDays`]: {
            type: 'integer',
            title: '本地历史保留天数',
            description: '本地 JSONL 额度记录保留多久(默认 35 天以覆盖完整月度周期,可设 7–365 天),用于月度趋势图与历史查询。',
            minimum: MIN_RETAIN_DAYS,
            maximum: MAX_RETAIN_DAYS,
            'x-suffix': ' 天',
            'x-hot': true,
          },
          [`${prefix}baseUrl`]: {
            type: 'string',
            title: '网关地址',
            description: 'OpenCode Go 网关地址,默认为官方地址 https://opencode.ai/inference。API Key 请在「额度」面板中管理。',
            'x-hot': true,
          },
        },
      },
    },
  ];
}
