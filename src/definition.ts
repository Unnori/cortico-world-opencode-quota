/** 定义:配置默认值、实例构造与自描述。工具与事件的自描述由同一份声明拼成。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { OPENCODE_QUOTA_DEFAULTS, type OpenCodeQuotaConfigSection } from './config.ts';
import { OpenCodeQuotaWorld, openCodeQuotaToolDecls } from './world.ts';

export const OPENCODE_QUOTA: WorldDefinition<OpenCodeQuotaConfigSection> = {
  id: 'opencode-quota',
  label: 'OpenCode 额度',
  defaults: () => ({ ...OPENCODE_QUOTA_DEFAULTS }),
  create: (ctx) =>
    new OpenCodeQuotaWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      dataDir: ctx.dataDir,
      botDir: ctx.botDir,
    }),
  describe: {
    tools: describeTools(openCodeQuotaToolDecls(), {
      ocq_read: {
        zh: '读 OpenCode 端点的订阅额度:三个窗口的百分比与重置时间。',
        en: 'Reads the subscription allowance of OpenCode endpoints: each window\u2019s percentage and reset time.',
      },
      ocq_history: {
        zh: '看最近记录的额度趋势:样本数、峰值与最新值。',
        en: 'Recent allowance trend: sample count, peak and latest value.',
      },
    }),
    events: [
      {
        type: 'opencode-quota.threshold',
        description: {
          zh: '某个额度窗口刚越过配置的告警线。',
          en: 'An allowance window just crossed its configured threshold.',
        },
      },
      {
        type: 'opencode-quota.reset',
        description: {
          zh: '某个额度窗口重置了(重置时刻变了)。',
          en: 'An allowance window reset, which shows as a new reset time.',
        },
      },
      {
        type: 'opencode-quota.unavailable',
        description: {
          zh: '某个端点的额度从此读不到;同一个原因只报一次。',
          en: 'An endpoint\u2019s allowance became unreadable; each reason is reported once.',
        },
      },
    ],
  },
};
