/** 定义:配置默认值、实例构造与自描述。工具与事件的自描述由同一份声明拼成。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { OPENCODE_QUOTA_DEFAULTS, type OpenCodeQuotaConfigSection } from './config.ts';
import { OpenCodeQuotaWorld, openCodeQuotaToolDecls } from './world.ts';

export const OPENCODE_QUOTA: WorldDefinition<OpenCodeQuotaConfigSection> = {
  id: 'opencode-quota',
  label: 'OpenCode 额度',
  defaults: () => ({ ...OPENCODE_QUOTA_DEFAULTS, keys: [] }),
  create: (ctx) =>
    new OpenCodeQuotaWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      dataDir: ctx.dataDir,
      secret: (name) => ctx.secret(name),
      storeSecret: (name, value) => ctx.storeSecret(name, value),
      persist: (patch) => ctx.persist(patch),
    }),
  describe: {
    tools: describeTools(openCodeQuotaToolDecls(), {
      ocq_read: {
        zh: '查询 OpenCode 订阅额度（5小时/周/月的已用与剩余比例及重置倒计时）。',
        en: 'Reads OpenCode subscription usage and remaining percentages with reset countdowns.',
      },
      ocq_history: {
        zh: '查询本地记录的近期额度峰值、最新值与月度日均消耗。',
        en: 'Reads locally recorded quota peaks, latest values, and monthly burn pace.',
      },
    }),
    events: [
      {
        type: 'opencode-quota.threshold',
        trigger: 'piggyback',
        description: {
          zh: '某个额度窗口刚越过配置的告警线（默认 piggyback 静默搭便车，可在配置中切换投递规则）。',
          en: 'An allowance window crossed the alert threshold (defaults to piggyback; configurable).',
        },
      },
      {
        type: 'opencode-quota.reset',
        trigger: 'piggyback',
        description: {
          zh: '某个额度窗口已重置刷新（默认 piggyback 静默搭便车，可在配置中切换投递规则）。',
          en: 'An allowance window reset after a usage drop (defaults to piggyback; configurable).',
        },
      },
      {
        type: 'opencode-quota.unavailable',
        description: {
          zh: '某个来源的额度读取失败（仅入库不唤醒 bot，同一来源只记录一次）。',
          en: 'A source could not be read (archived only without waking the bot; recorded once per outage).',
        },
      },
    ],
  },
};
