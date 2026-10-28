/**
 * `worlds.opencode-quota` 的配置段与配置组。默认禁用,由 bot 或部署启用。
 *
 * 只有一个组、五个开关:多久读一次、告警线在哪、要不要提醒、网关地址、以及一把可选的手填密钥。
 * 手填密钥优先于端点自己的;清空它就回到读端点密钥——这样不装供应商插件也能单独当监控用。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { pick } from 'cortico/core/language.ts';

/** 三个额度窗口的名字,与网关返回的键一致。 */
export type Window = 'rolling' | 'weekly' | 'monthly';

export const WINDOWS: readonly Window[] = ['rolling', 'weekly', 'monthly'];

export interface OpenCodeQuotaConfigSection {
  enabled: boolean;
  /** 网关地址;没有供应商端点时用它。 */
  baseUrl: string;
  /** 手填密钥。填了就优先用它,清空则回到端点自己声明的密钥。 */
  apiKey: string;
  /** 读额度的间隔,分钟。启动时定下。 */
  pollMinutes: number;
  /** 任一窗口到这个百分比就提醒。 */
  alertAt: number;
  /** 是否把越线与重置推成事件。 */
  notify: boolean;
}

export const OPENCODE_QUOTA_DEFAULTS: OpenCodeQuotaConfigSection = {
  enabled: false,
  baseUrl: 'https://opencode.ai/inference',
  apiKey: '',
  pollMinutes: 1,
  alertAt: 80,
  notify: true,
};

/** 手填的密钥,去空白后为空表示没有。 */
export function manualKey(cfg: OpenCodeQuotaConfigSection): string | undefined {
  const key = (cfg.apiKey ?? '').trim();
  return key || undefined;
}

/** 网关地址,去空白后为空表示没填。 */
export function configuredRoot(cfg: OpenCodeQuotaConfigSection): string {
  return (cfg.baseUrl ?? '').trim();
}

interface Text {
  configTitle: string;
  configDescription: string;
  pollTitle: string;
  pollDescription: string;
  alertTitle: string;
  alertDescription: string;
  notifyTitle: string;
  notifyDescription: string;
  baseUrlTitle: string;
  baseUrlDescription: string;
  apiKeyTitle: string;
  apiKeyDescription: string;
}

const zh: Text = {
  configTitle: 'OpenCode 额度',
  configDescription: '读 OpenCode 订阅额度:每 5 小时、每周、每月。装了供应商插件时密钥从端点读,没装就填下面的密钥。',
  pollTitle: '读取间隔',
  pollDescription: '多久读一次额度。改动在重启本 World 后生效。',
  alertTitle: '告警线',
  alertDescription: '任一窗口到这个百分比时提醒一次;一直在线以上不重复提醒。',
  notifyTitle: '越线时提醒',
  notifyDescription: '关掉后只留工具与历史,不推事件。',
  baseUrlTitle: '网关地址',
  baseUrlDescription: '没有供应商端点时读这里。默认就是 OpenCode 网关。',
  apiKeyTitle: '手填 API Key',
  apiKeyDescription: '留空 = 读端点自己声明的密钥。填了就用它,不装供应商插件也能用;注意它存在配置里,不像端点密钥那样单独存放。',
};

const en: Text = {
  configTitle: 'OpenCode quota',
  configDescription: 'Reads the OpenCode subscription allowance: 5-hour, weekly and monthly. With the provider extension installed the key comes from the endpoint; without it, fill in the key below.',
  pollTitle: 'Read every',
  pollDescription: 'How often to read the allowance. Takes effect after this World restarts.',
  alertTitle: 'Alert at',
  alertDescription: 'Report once when any window reaches this percentage; staying above it does not repeat.',
  notifyTitle: 'Report crossings',
  notifyDescription: 'When off, only the tools and the history remain; nothing is pushed.',
  baseUrlTitle: 'Gateway URL',
  baseUrlDescription: 'Read from here when no provider endpoint exists. The default is the OpenCode gateway.',
  apiKeyTitle: 'API key',
  apiKeyDescription: 'Empty means read the endpoint\u2019s own key. A key here wins and works without the provider extension; note that it lives in the configuration rather than beside the endpoint.',
};

const text = (language: Language): Text => pick(language, { zh, en });

/** 唯一的配置组。 */
export function openCodeQuotaConfigGroups(language: Language): ConfigGroup[] {
  const t = text(language);
  const prefix = 'worlds.opencode-quota.';
  return [
    {
      id: 'world:opencode-quota',
      owner: 'world:opencode-quota',
      schema: {
        type: 'object',
        title: t.configTitle,
        description: t.configDescription,
        properties: {
          [`${prefix}pollMinutes`]: {
            type: 'integer',
            title: t.pollTitle,
            description: t.pollDescription,
            minimum: 1,
            maximum: 180,
            'x-suffix': ' min',
            'x-hot': false,
          },
          [`${prefix}alertAt`]: {
            type: 'integer',
            title: t.alertTitle,
            description: t.alertDescription,
            minimum: 1,
            maximum: 100,
            'x-suffix': '%',
            'x-hot': true,
          },
          [`${prefix}notify`]: {
            type: 'boolean',
            title: t.notifyTitle,
            description: t.notifyDescription,
            'x-hot': true,
          },
          [`${prefix}baseUrl`]: {
            type: 'string',
            title: t.baseUrlTitle,
            description: t.baseUrlDescription,
            'x-hot': true,
          },
          [`${prefix}apiKey`]: {
            type: 'string',
            title: t.apiKeyTitle,
            description: t.apiKeyDescription,
            'x-warning': true,
            'x-hot': true,
          },
        },
      },
    },
  ];
}
