import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { OPENCODE_QUOTA } from '../src/definition.ts';
import {
  configuredRoot,
  manualKey,
  normalizeDisplayMode,
  normalizeRetainDays,
  normalizeTriggerMode,
  OPENCODE_QUOTA_DEFAULTS,
  TRIGGER_MODES,
  type OpenCodeQuotaConfigSection,
} from '../src/config.ts';
import {
  billingHintOf,
  gatewayRoot,
  maskKeyHint,
  MAX_RESPONSE_BYTES,
  parseUsage,
  providersDir,
  readEndpointKeys,
  readEndpoints,
  readKey,
} from '../src/gateway.ts';
import { History, subtractOneMonth } from '../src/history.ts';
import { OpenCodeQuotaWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

let root: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opencode-quota-'));
  // 让 providersDir 只看临时目录,不碰这台机器上真实的端点。
  savedHome = process.env.CORTICO_HOME;
  delete process.env.CORTICO_HOME;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.CORTICO_HOME;
  else process.env.CORTICO_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 部署根 = root;部署目录 root/companion;端点目录 root/providers/<名>。 */
function deployment(): string {
  const botDir = join(root, 'companion');
  mkdirSync(botDir, { recursive: true });
  return botDir;
}

function endpoint(name: string, config: Record<string, unknown>, env?: string): void {
  const dir = join(root, 'providers', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), 'utf8');
  if (env) writeFileSync(join(dir, '.env'), env, 'utf8');
}

const usage = (rolling: number, weekly = 10, monthly = 5, resets = '2030-01-01T00:00:00.000Z') => ({
  usage: {
    rolling: { status: 'ok', percent: rolling, resetsAt: resets },
    weekly: { status: 'ok', percent: weekly, resetsAt: resets },
    monthly: { status: 'ok', percent: monthly, resetsAt: resets },
  },
});

const cfg = (patch: Partial<OpenCodeQuotaConfigSection> = {}): OpenCodeQuotaConfigSection =>
  ({ ...OPENCODE_QUOTA_DEFAULTS, enabled: true, ...patch });

function world(botDir: string, patch: Partial<OpenCodeQuotaConfigSection> = {}): OpenCodeQuotaWorld {
  return new OpenCodeQuotaWorld({ cfg: cfg(patch), timezone: 'UTC', dataDir: root, botDir });
}

describe('OpenCode 额度 World', () => {
  it('干装载不报失败:装载器会接受它', async () => {
    const report = await dryMountWorld(OPENCODE_QUOTA, { scratchDir: root });
    expect(report.failures).toEqual([]);
  });

  it('默认禁用,配置只有一组九项,事件投递默认 piggyback 且含全部五种规则,本地保留默认 35 天', () => {
    expect(OPENCODE_QUOTA_DEFAULTS.enabled).toBe(false);
    expect(OPENCODE_QUOTA_DEFAULTS.displayMode).toBe('used');
    expect(OPENCODE_QUOTA_DEFAULTS.resetTrigger).toBe('piggyback');
    expect(OPENCODE_QUOTA_DEFAULTS.thresholdTrigger).toBe('piggyback');
    expect(OPENCODE_QUOTA_DEFAULTS.retainDays).toBe(35);
    expect(normalizeDisplayMode('remaining')).toBe('remaining');
    expect(normalizeDisplayMode('unknown')).toBe('used');
    expect(normalizeTriggerMode('flush')).toBe('flush');
    expect(normalizeTriggerMode('invalid')).toBe('piggyback');
    expect(normalizeRetainDays(90)).toBe(90);
    expect(normalizeRetainDays(1)).toBe(7);
    expect(normalizeRetainDays(999)).toBe(365);
    expect(normalizeRetainDays(undefined)).toBe(35);
    const decl = OPENCODE_QUOTA.create(fakeWorldContext(OPENCODE_QUOTA, { scratchDir: root })).webUi?.('zh');
    expect(decl?.config).toHaveLength(1);
    const props = decl!.config![0]!.schema.properties;
    expect(Object.keys(props)).toEqual([
      'worlds.opencode-quota.pollMinutes',
      'worlds.opencode-quota.alertAt',
      'worlds.opencode-quota.notify',
      'worlds.opencode-quota.resetTrigger',
      'worlds.opencode-quota.thresholdTrigger',
      'worlds.opencode-quota.displayMode',
      'worlds.opencode-quota.retainDays',
      'worlds.opencode-quota.baseUrl',
      'worlds.opencode-quota.apiKey',
    ]);
    expect(props['worlds.opencode-quota.resetTrigger']!.enum).toEqual([...TRIGGER_MODES]);
    expect(props['worlds.opencode-quota.thresholdTrigger']!.enum).toEqual([...TRIGGER_MODES]);
    expect(props['worlds.opencode-quota.retainDays']!.minimum).toBe(7);
    expect(props['worlds.opencode-quota.retainDays']!.maximum).toBe(365);
  });

  it('工具与自描述用同一份声明', () => {
    const instance = OPENCODE_QUOTA.create(fakeWorldContext(OPENCODE_QUOTA, { scratchDir: root }));
    const names = instance.tools().map((tool) => tool.name);
    expect(names).toEqual(['ocq_read', 'ocq_history']);
    expect(OPENCODE_QUOTA.describe?.tools.map((tool) => tool.name)).toEqual(names);
  });
});

describe('手填密钥与网关地址', () => {
  it('留空就是没有,去空白后也算没有', () => {
    expect(manualKey(cfg())).toBeUndefined();
    expect(manualKey(cfg({ apiKey: '   ' }))).toBeUndefined();
    expect(manualKey(cfg({ apiKey: ' oc_sk_x ' }))).toBe('oc_sk_x');
    expect(configuredRoot(cfg({ baseUrl: ' https://opencode.ai/inference ' }))).toBe('https://opencode.ai/inference');
  });

  it('没有供应商端点时,网关地址加手填密钥就够用', async () => {
    const botDir = deployment();
    const host = new FakeHost();
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      seen.push(String((init?.headers as Record<string, string>)?.Authorization));
      return new Response(JSON.stringify(usage(7)), { status: 200 });
    });
    const instance = world(botDir, { apiKey: 'oc_sk_manual' });
    await instance.start(host);
    expect(seen).toEqual(['Bearer oc_sk_manual']);
    expect(host.events).toHaveLength(0);
    await instance.stop();
  });

  it('只有网关地址、没有密钥时不发请求', async () => {
    const botDir = deployment();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const instance = world(botDir);
    await instance.start(new FakeHost());
    expect(fetchSpy).not.toHaveBeenCalled();
    await instance.stop();
  });

  it('手填密钥优先于端点自己声明的密钥', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' },
      'CORTICO_KEY_DEMO=from-file\n');
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      seen.push(String((init?.headers as Record<string, string>)?.Authorization));
      return new Response(JSON.stringify(usage(7)), { status: 200 });
    });
    const override = world(botDir, { apiKey: 'oc_sk_manual' });
    await override.start(new FakeHost());
    await override.stop();
    const fromSystem = world(botDir);
    await fromSystem.start(new FakeHost());
    await fromSystem.stop();
    expect(seen).toEqual(['Bearer oc_sk_manual', 'Bearer from-file']);
  });
});

describe('端点与密钥', () => {
  it('只认 kind 为 opencode 且不是按量计费(含按量 URL)的端点', () => {
    deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' });
    endpoint('bare', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference', secret: 'CORTICO_KEY_BARE' });
    endpoint('paid', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/openai/v1', options: { billing: 'balance' } });
    endpoint('paid-by-url', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/openai/v1', secret: 'CORTICO_KEY_PAID' });
    endpoint('paid-anthropic', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/anthropic/v1', secret: 'CORTICO_KEY_ANTH' });
    endpoint('other', { kind: 'cortico-provider-coo', baseUrl: 'https://api.deepseek.com' });
    endpoint('proxy', { kind: 'opencode', baseUrl: 'https://proxy.example.com/v1' });
    const found = readEndpoints(deployment());
    expect(found.map((item) => item.name)).toEqual(['bare', 'demo']);
    expect(found[1]!.root).toBe('https://opencode.ai/inference');
    expect(found[1]!.secretName).toBe('CORTICO_KEY_DEMO');
    expect(billingHintOf('https://opencode.ai/inference/go/openai/v1')).toBe('go');
    expect(billingHintOf('https://opencode.ai/inference/openai/v1')).toBe('balance');
    expect(billingHintOf('https://opencode.ai/inference')).toBeNull();
  });

  it('密钥进程环境优先,其次端点目录的 .env', () => {
    deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' },
      '# comment\nOTHER=1\nCORTICO_KEY_DEMO="from-file"\n');
    const found = readEndpoints(deployment())[0]!;
    expect(readKey(found)).toBe('from-file');
    process.env.CORTICO_KEY_DEMO = 'from-env';
    try {
      expect(readKey(found)).toBe('from-env');
    } finally {
      delete process.env.CORTICO_KEY_DEMO;
    }
  });

  it('网关根只认 http/https、拒绝内嵌凭证,且只取到 /inference', () => {
    expect(gatewayRoot('https://opencode.ai/inference/go/openai/v1')).toBe('https://opencode.ai/inference');
    expect(gatewayRoot('https://proxy.example.com/v1')).toBe('');
    expect(gatewayRoot('file:///tmp/inference/go')).toBe('');
    expect(gatewayRoot('ftp://opencode.ai/inference/go')).toBe('');
    expect(gatewayRoot('https://user:pass@opencode.ai/inference/go/openai/v1')).toBe('');
    expect(gatewayRoot('not a url')).toBe('');
  });

  it('CORTICO_HOME 优先于部署目录的父目录', () => {
    process.env.CORTICO_HOME = join(root, 'home');
    try {
      expect(providersDir('/elsewhere/companion')).toBe(join(root, 'home', 'providers'));
    } finally {
      delete process.env.CORTICO_HOME;
    }
    expect(providersDir('/elsewhere/companion')).toBe(join('/elsewhere', 'providers'));
  });
});

describe('额度读取', () => {
  it('接受三个窗口,拒绝缺字段的回应', () => {
    expect(parseUsage(usage(12)).rolling.percent).toBe(12);
    expect(() => parseUsage({})).toThrow(/usage/);
    expect(() => parseUsage({ usage: { rolling: { status: 'ok', percent: 'x', resetsAt: 'soon' } } })).toThrow(/百分比/);
  });

  it('越线只在刚越过时报一次,重置单独报', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' },
      'CORTICO_KEY_DEMO=secret-value\n');
    const host = new FakeHost();
    const instance = world(botDir, { alertAt: 80 });

    let payload = usage(10);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));

    await instance.start(host);               // 第一次只记基线
    expect(host.events).toHaveLength(0);

    payload = usage(85);                      // 越过 80
    await instance.poll();
    expect(host.events.map((event) => event.type)).toEqual(['opencode-quota.threshold']);

    await instance.poll();                    // 仍在线以上,不重复报
    expect(host.events).toHaveLength(1);

    // 只有每 5 小时那个窗口换了重置时刻,用量没变:空闲时 resetsAt 会往后滑,这不叫重置。
    payload = {
      usage: {
        rolling: { status: 'ok', percent: 85, resetsAt: '2030-02-01T00:00:00.000Z' },
        weekly: { status: 'ok', percent: 10, resetsAt: '2030-01-01T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 5, resetsAt: '2030-01-01T00:00:00.000Z' },
      },
    };
    await instance.poll();
    expect(host.events).toHaveLength(1);

    // 用量真的掉下来才算重置。
    payload = {
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: '2030-02-01T00:00:00.000Z' },
        weekly: { status: 'ok', percent: 10, resetsAt: '2030-01-01T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 5, resetsAt: '2030-01-01T00:00:00.000Z' },
      },
    };
    await instance.poll();
    expect(host.events.map((event) => event.type)).toEqual(['opencode-quota.threshold', 'opencode-quota.reset']);
    await instance.stop();
  });

  it('重置时刻每分钟往后滑时不报警——那次事故就是这么来的', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' },
      'CORTICO_KEY_DEMO=secret-value\n');
    const host = new FakeHost();
    const instance = world(botDir, { alertAt: 80 });
    let minute = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      usage: {
        // 百分比不动,重置时刻每分钟往前推一分钟。
        rolling: { status: 'ok', percent: 0, resetsAt: new Date(Date.UTC(2030, 0, 1, 5, minute++)).toISOString() },
        weekly: { status: 'ok', percent: 86, resetsAt: '2030-01-07T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 43, resetsAt: '2030-02-01T00:00:00.000Z' },
      },
    }), { status: 200 }));

    await instance.start(host);
    for (let index = 0; index < 5; index += 1) await instance.poll();
    expect(host.events).toHaveLength(0);
    await instance.stop();
  });

  it('同一窗口的同类事件在冷却时间内只报一次', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' },
      'CORTICO_KEY_DEMO=secret-value\n');
    const host = new FakeHost();
    const instance = world(botDir, { alertAt: 50 });
    let payload = usage(10);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));

    await instance.start(host);
    payload = usage(60);
    await instance.poll();                    // 越过 50,报一次
    expect(host.events).toHaveLength(1);

    payload = usage(5);
    await instance.poll();                    // 掉下去:重置是另一类,报一次
    expect(host.events).toHaveLength(2);

    payload = usage(60);
    await instance.poll();                    // 立刻又越线:同类事件在冷却内,不报
    expect(host.events.map((event) => event.type)).toEqual(['opencode-quota.threshold', 'opencode-quota.reset']);
    await instance.stop();
  });

  it('关掉提醒后不推事件,但工具照常能读', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' },
      'CORTICO_KEY_DEMO=secret-value\n');
    const host = new FakeHost();
    let payload = usage(10);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const instance = world(botDir, { alertAt: 80, notify: false });
    await instance.start(host);
    payload = usage(99);
    await instance.poll();
    expect(host.events).toHaveLength(0);
    const read = instance.tools().find((tool) => tool.name === 'ocq_read')!;
    expect(await read.handler({}, {} as never)).toContain('99%');
    await instance.stop();
  });

  it('读失败时把原因交给 bot 一次,之后不重复', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' },
      'CORTICO_KEY_DEMO=secret-value\n');
    const host = new FakeHost();
    const instance = world(botDir);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: { type: 'AuthError' } }), { status: 401 }));

    await instance.start(host);
    await instance.poll();
    expect(host.events.map((event) => event.type)).toEqual(['opencode-quota.unavailable']);
    expect(host.events[0]!.text).toContain('401');
    // 诊断只入库:deliver=false,不进 bot 的上下文。
    expect(host.pushOpts[0]?.deliver).toBe(false);
    await instance.stop();
  });

  it('一次网络抖动不算失败:同一次请求再试一遍', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' },
      'CORTICO_KEY_DEMO=secret-value\n');
    const host = new FakeHost();
    const instance = world(botDir, { alertAt: 80 });
    let attempt = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(usage(12)), { status: 200 });
    });
    await instance.start(host);
    expect(attempt).toBe(2);
    expect(host.events).toHaveLength(0);
    expect(instance.snapshot().sources[0]!.error).toBeNull();
    await instance.stop();
  });

  it('ocq_read 同时返回已用与剩余百分比,ocq_history 没有样本时如实返回中文提示', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' },
      'CORTICO_KEY_DEMO=secret-value\n');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(usage(42, 21, 7)), { status: 200 }));
    const instance = world(botDir);
    const read = instance.tools().find((tool) => tool.name === 'ocq_read')!;
    const history = instance.tools().find((tool) => tool.name === 'ocq_history')!;
    const readOut = await read.handler({}, {} as never);
    expect(readOut).toContain('已用 42%（剩 58%');
    expect(readOut).toContain('已用 21%（剩 79%');
    expect(readOut).toContain('已用 7%（剩 93%');
    expect(await history.handler({}, {} as never)).toContain('暂无本地额度历史记录');
  });
});

describe('历史', () => {
  it('记一行、算趋势、可清空', () => {
    const history = new History(join(root, 'history.jsonl'));
    const now = new Date().toISOString();
    history.append({ ts: now, endpoint: 'demo', rolling: 10, weekly: 20, monthly: 30, resets: { rolling: now, weekly: now, monthly: now } });
    history.append({ ts: now, endpoint: 'demo', rolling: 55, weekly: 25, monthly: 31, resets: { rolling: now, weekly: now, monthly: now } });
    const trend = history.trend('demo', 7)!;
    expect(trend.samples).toBe(2);
    expect(trend.peak).toEqual({ rolling: 55, weekly: 25, monthly: 31 });
    expect(trend.latest.rolling).toBe(55);
    expect(history.trend('other', 7)).toBeNull();
    history.clear();
    expect(history.read()).toEqual([]);
  });
});

describe('面板', () => {
  function withEndpoint(patch: Partial<OpenCodeQuotaConfigSection> = {}): { instance: OpenCodeQuotaWorld; host: FakeHost } {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' },
      'CORTICO_KEY_DEMO=secret-value\n');
    return { instance: world(botDir, patch), host: new FakeHost() };
  }

  it('state 不联网,只报已经轮询到的值', async () => {
    const { instance, host } = withEndpoint({ alertAt: 50 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(usage(61, 2, 3)), { status: 200 }));
    await instance.start(host);
    const callsAfterPoll = fetchSpy.mock.calls.length;

    const decl = instance.webUi('zh');
    const snapshot = await decl.invoke!('quota', 'state', []) as { alertAt: number; sources: Array<{ name: string; windows: { rolling: { percent: number } } | null }> };

    expect(fetchSpy.mock.calls.length).toBe(callsAfterPoll);
    expect(snapshot.alertAt).toBe(50);
    expect(snapshot.sources.map((source) => source.name)).toEqual(['demo']);
    expect(snapshot.sources[0]!.windows!.rolling.percent).toBe(61);
    await instance.stop();
  });

  it('read 让 World 立刻读一遍', async () => {
    const { instance, host } = withEndpoint();
    let payload = usage(10);
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await instance.start(host);
    const before = fetchSpy.mock.calls.length;
    payload = usage(44);
    const snapshot = await instance.webUi('zh').invoke!('quota', 'read', []) as { sources: Array<{ windows: { rolling: { percent: number } } | null }> };
    expect(fetchSpy.mock.calls.length).toBe(before + 1);
    expect(snapshot.sources[0]!.windows!.rolling.percent).toBe(44);
    await instance.stop();
  });

  it('徽标给三个窗口,越过告警线的那个换配色', async () => {
    const { instance, host } = withEndpoint({ alertAt: 50 });
    vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(usage(80, 10, 5)), { status: 200 }));
    await instance.start(host);
    const badges = instance.webUi('zh').badges!;
    expect(badges.map((badge) => badge.label)).toEqual(['每 5 小时', '每周', '每月']);
    expect(badges.map((badge) => badge.value)).toEqual(['80%', '10%', '5%']);
    expect(badges.map((badge) => badge.tone)).toEqual(['off', 'on', 'on']);
    await instance.stop();
  });
});
describe('四态灯', () => {
  it('按用量换色:绿充足、黄大半、红过线、灰用完;没读到时不报灯', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' },
      'CORTICO_KEY_DEMO=secret-value\n');
    const instance = world(botDir, { alertAt: 80 });
    expect(instance.webUi('zh').lamps).toEqual([]);

    let payload = usage(85, 60, 100);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const host = new FakeHost();
    await instance.start(host);
    expect(instance.webUi('zh').lamps!.map((lamp) => lamp.label)).toEqual(['每 5 小时', '每周', '每月']);
    expect(instance.webUi('zh').lamps!.map((lamp) => lamp.state)).toEqual(['error', 'loading', 'offline']);

    payload = usage(30, 10, 5);
    await instance.poll();
    expect(instance.webUi('zh').lamps!.map((lamp) => lamp.state)).toEqual(['online', 'online', 'online']);
    await instance.stop();
  });
});

describe('按 Key 去重与多 Key 面板', () => {
  it('多个 Provider 使用同一把 Key 时只合并为一个面板,且只发一次请求', async () => {
    const botDir = deployment();
    const sharedKey = 'sk-opencode-shared-1111aaaa';
    endpoint('oc-glm', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_GLM' },
      `CORTICO_KEY_GLM=${sharedKey}\n`);
    endpoint('oc-kimi', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_KIMI' },
      `CORTICO_KEY_KIMI=${sharedKey}\n`);
    endpoint('oc-minimax', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_MINIMAX' },
      `CORTICO_KEY_MINIMAX=${sharedKey}\n`);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(usage(12, 34, 56)), { status: 200 }));
    const instance = world(botDir);
    await instance.start(new FakeHost());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const snap = instance.snapshot();
    expect(snap.totalEndpoints).toBe(3);
    expect(snap.sources).toHaveLength(1);
    expect(snap.sources[0]!.name).toBe('oc-glm');
    expect(snap.sources[0]!.endpoints).toEqual(['oc-glm', 'oc-kimi', 'oc-minimax']);
    expect(snap.sources[0]!.keyHint).toBe('••••aaaa');
    expect(JSON.stringify(snap)).not.toContain(sharedKey);

    // 按被合并掉的 Provider 名称查询工具也应命中
    const read = instance.tools().find((tool) => tool.name === 'ocq_read')!;
    expect(await read.handler({ endpoint: 'oc-kimi' }, {} as never)).toContain('12%');
    await instance.stop();
  });

  it('只有两把 Key 不同时才显示两个额度面板,同 Key 的 Provider 自动归组', async () => {
    const botDir = deployment();
    endpoint('a-primary', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'KEY_A' },
      'KEY_A=sk-account-one-1111\n');
    endpoint('b-alias', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'KEY_B' },
      'KEY_B=sk-account-one-1111\n');
    endpoint('c-second', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'KEY_C' },
      'KEY_C=sk-account-two-2222\n');

    const seenKeys: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      seenKeys.push(auth);
      const body = auth.includes('2222') ? usage(88, 20, 10) : usage(15, 45, 30);
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const instance = world(botDir, { alertAt: 80 });
    await instance.start(new FakeHost());

    expect(seenKeys).toEqual(['Bearer sk-account-one-1111', 'Bearer sk-account-two-2222']);
    const snap = instance.snapshot();
    expect(snap.totalEndpoints).toBe(3);
    expect(snap.sources).toHaveLength(2);
    expect(snap.sources[0]!.endpoints).toEqual(['a-primary', 'b-alias']);
    expect(snap.sources[0]!.keyHint).toBe('••••1111');
    expect(snap.sources[1]!.endpoints).toEqual(['c-second']);
    expect(snap.sources[1]!.keyHint).toBe('••••2222');

    // 多把 Key 时,页头徽标与状态灯按最紧的窗口聚合,并显示独立 Key 数量
    const badges = instance.webUi('zh').badges!;
    expect(badges.map((b) => `${b.label}:${b.value}:${b.tone}`)).toEqual([
      '每 5 小时:88%:off',
      '每周:45%:on',
      '每月:30%:on',
      '独立 Key:2:plain',
    ]);
    const lamps = instance.webUi('zh').lamps!;
    expect(lamps.map((l) => l.state)).toEqual(['error', 'online', 'online']);
    expect(lamps[0]!.hint).toContain('c-second');
    await instance.stop();
  });

  it('单 Provider 配置 options.keys 多把不同 Key 时分列显示,重复的则去重', async () => {
    const botDir = deployment();
    endpoint(
      'main',
      {
        kind: 'opencode',
        baseUrl: 'https://opencode.ai/inference/go/openai/v1',
        secret: 'KEY_MAIN',
        options: { keys: 'KEY_ALT; KEY_DUP; KEY_MISSING' },
      },
      'KEY_MAIN=sk-primary-aaaa\nKEY_ALT=sk-backup-bbbb\nKEY_DUP=sk-primary-aaaa\n',
    );

    const found = readEndpoints(botDir)[0]!;
    expect(readEndpointKeys(found).map((k) => k.secretName)).toEqual(['KEY_MAIN', 'KEY_ALT', 'KEY_DUP']);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(usage(20, 30, 40)), { status: 200 }));
    const instance = world(botDir);
    await instance.start(new FakeHost());

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const snap = instance.snapshot();
    expect(snap.sources).toHaveLength(2);
    expect(snap.sources.map((s) => s.name)).toEqual(['main', 'main (KEY_ALT)']);
    expect(snap.sources.map((s) => s.keyHint)).toEqual(['••••aaaa', '••••bbbb']);
    await instance.stop();
  });

  it('手填密钥覆盖多个同网关 Provider 时也合并为一条来源', async () => {
    const botDir = deployment();
    endpoint('p1', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K1' }, 'K1=sk-11111111\n');
    endpoint('p2', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K2' }, 'K2=sk-22222222\n');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(usage(5)), { status: 200 }));

    const instance = world(botDir, { apiKey: 'sk-override-9999' });
    await instance.start(new FakeHost());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const snap = instance.snapshot();
    expect(snap.sources).toHaveLength(1);
    expect(snap.sources[0]!.endpoints).toEqual(['p1', 'p2']);
    expect(snap.sources[0]!.keyHint).toBe('••••9999');
    await instance.stop();
  });

  it('短密钥不暴露尾标,且网关回显密钥时在错误中脱敏', async () => {
    expect(maskKeyHint('short')).toBeNull();
    expect(maskKeyHint('12345678')).toBe('••••5678');

    const botDir = deployment();
    const secret = 'sk-secret-echo-test-9876';
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K' }, `K=${secret}\n`);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(`rejected key ${secret}`, { status: 401 }));

    const instance = world(botDir);
    await instance.start(new FakeHost());
    const errorText = instance.snapshot().sources[0]!.error ?? '';
    expect(errorText).toContain('[redacted]');
    expect(errorText).not.toContain(secret);
    await instance.stop();
  });

  it('Provider 改用同一 Key 后,旧缓存会被自动清理', async () => {
    const botDir = deployment();
    endpoint('p1', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K1' }, 'K1=sk-key-1111aaaa\n');
    endpoint('p2', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K2' }, 'K2=sk-key-2222bbbb\n');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(usage(10, 20, 30)), { status: 200 }));

    const instance = world(botDir);
    await instance.start(new FakeHost());
    expect(instance.snapshot().sources).toHaveLength(2);

    // 将 p2 改为与 p1 相同的 Key
    endpoint('p2', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K2' }, 'K2=sk-key-1111aaaa\n');
    await instance.poll();
    const snap = instance.snapshot();
    expect(snap.sources).toHaveLength(1);
    expect(snap.sources[0]!.endpoints).toEqual(['p1', 'p2']);
    await instance.stop();
  });
});

describe('已用 / 剩余显示模式切换', () => {
  it('切换为 remaining 后,快照、页头徽标与灯提示同步切为剩余额度', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K' }, 'K=sk-demo-12345678\n');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(usage(1, 67, 81)), { status: 200 }));

    const instance = world(botDir, { alertAt: 80 });
    await instance.start(new FakeHost());

    // 默认按已用显示
    expect(instance.snapshot().displayMode).toBe('used');
    expect(instance.webUi('zh').badges!.map((b) => b.value)).toEqual(['1%', '67%', '81%']);

    // 经面板方法切为剩余显示
    const next = await instance.webUi('zh').invoke!('quota', 'mode', ['remaining']) as { displayMode: string };
    expect(next.displayMode).toBe('remaining');
    expect(instance.snapshot().displayMode).toBe('remaining');
    expect(instance.webUi('zh').badges!.map((b) => `${b.label}:${b.value}:${b.tone}`)).toEqual([
      '每 5 小时:剩 99%:on',
      '每周:剩 33%:on',
      '每月:剩 19%:off',
    ]);
    expect(instance.webUi('zh').lamps![0]!.hint).toContain('剩余 99%');

    // 再切回已用显示
    await instance.webUi('zh').invoke!('quota', 'mode', ['used']);
    expect(instance.webUi('zh').badges!.map((b) => b.value)).toEqual(['1%', '67%', '81%']);
    await instance.stop();
  });
});

describe('事件投递规则', () => {
  it('默认采用 piggyback 静默搭便车,不主动唤醒 bot', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K' }, 'K=sk-demo-12345678\n');
    const host = new FakeHost();
    const instance = world(botDir, { alertAt: 80 });
    let payload = usage(10);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));

    await instance.start(host);
    payload = usage(85);
    await instance.poll();
    payload = usage(0);
    await instance.poll();

    expect(host.events.map((e) => e.type)).toEqual(['opencode-quota.threshold', 'opencode-quota.reset']);
    expect(host.pushOpts.map((opt) => opt?.trigger)).toEqual(['piggyback', 'piggyback']);
    await instance.stop();
  });

  it('越线与额度刷新可独立配置宿主五种投递规则,且支持热生效', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K' }, 'K=sk-demo-12345678\n');
    const host = new FakeHost();
    const liveCfg = cfg({ alertAt: 80, thresholdTrigger: 'flush', resetTrigger: 'debounce' });
    const instance = new OpenCodeQuotaWorld({ cfg: liveCfg, timezone: 'UTC', dataDir: root, botDir });
    let payload = usage(10, 10, 10);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));

    await instance.start(host);
    payload = usage(90, 10, 10);
    await instance.poll();
    payload = usage(0, 10, 10);
    await instance.poll();

    // 热修改配置后,下一条事件立即按新规则投递
    liveCfg.thresholdTrigger = 'preempt';
    liveCfg.resetTrigger = 'interrupt';
    payload = usage(0, 85, 10);
    await instance.poll();
    payload = usage(0, 0, 10);
    await instance.poll();

    expect(host.events.map((e) => e.type)).toEqual([
      'opencode-quota.threshold',
      'opencode-quota.reset',
      'opencode-quota.threshold',
      'opencode-quota.reset',
    ]);
    expect(host.pushOpts.map((opt) => opt?.trigger)).toEqual(['flush', 'debounce', 'preempt', 'interrupt']);
    await instance.stop();
  });
});

describe('安全加固、并发去重、缓存保留与月度趋势预测', () => {
  it('请求禁止重定向、携带超时 signal,超限响应与无效 JSON 均安全拒绝且不泄密', async () => {
    const botDir = deployment();
    const secret = 'sk-super-secret-json-9999';
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K' }, `K=${secret}\n`);
    const seenInits: Array<RequestInit | undefined> = [];
    let mode: 'ok' | 'big' | 'badjson' = 'ok';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      seenInits.push(init);
      if (mode === 'big') return new Response('x'.repeat(MAX_RESPONSE_BYTES + 128), { status: 200 });
      if (mode === 'badjson') return new Response(`not-json-${secret}`, { status: 200 });
      return new Response(JSON.stringify(usage(10, 20, 30)), { status: 200 });
    });

    const instance = world(botDir);
    await instance.start(new FakeHost());
    expect(seenInits[0]?.redirect).toBe('error');
    expect(seenInits[0]?.signal).toBeDefined();

    // 临时 502/超限响应后仍保留上一次有效读数,同时记录错误
    mode = 'big';
    await instance.poll();
    let snap = instance.snapshot();
    expect(snap.sources[0]!.windows?.rolling.percent).toBe(10);
    expect(snap.sources[0]!.error).toContain('字节上限');

    mode = 'badjson';
    await instance.poll();
    snap = instance.snapshot();
    expect(snap.sources[0]!.error).toContain('无法解析的 JSON');
    expect(snap.sources[0]!.error).not.toContain(secret);
    await instance.stop();
  });

  it('并发 poll 自动复用在途任务,不会发出双倍请求', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K' }, 'K=sk-demo-12345678\n');
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify(usage(15, 25, 35)), { status: 200 });
    });

    const instance = world(botDir);
    await Promise.all([instance.poll(), instance.poll(), instance.poll()]);
    expect(calls).toBe(1);
    await instance.stop();
  });

  it('stop() 会中止正在进行的网络请求', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K' }, 'K=sk-demo-12345678\n');
    let aborted = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    }));

    const instance = world(botDir);
    const starting = instance.start(new FakeHost());
    await new Promise((r) => setTimeout(r, 20));
    await instance.stop();
    await starting;
    expect(aborted).toBe(true);
    expect(instance.snapshot().sources[0]!.windows).toBeNull();
  });

  it('envPromptVars 精简为稳定来源列表,不注入易变时间戳', () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K' }, 'K=sk-demo-12345678\n');
    const instance = world(botDir);
    expect(Object.keys(instance.envPromptVars())).toEqual(['opencode-quota.endpoints']);
    expect(instance.envPromptVars()['opencode-quota.endpoints']).toBe('demo');
  });

  it('monthlySeries 基于本地记录准确推算日均消耗、预计触顶日与空档期', () => {
    const history = new History(join(root, 'monthly.jsonl'));
    const cycleEnd = Date.UTC(2026, 11, 9, 0, 0, 0);   // 2026-12-09
    const cycleStart = subtractOneMonth(cycleEnd);      // 2026-11-09
    expect(new Date(cycleStart).getUTCMonth()).toBe(10);
    expect(new Date(cycleStart).getUTCDate()).toBe(9);

    const now = Date.UTC(2026, 10, 22, 0, 0, 0);       // 2026-11-22 (已过 13 天, 剩 17 天)
    const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12, 0, 0)).toISOString();
    const resets = { rolling: day(22), weekly: day(23), monthly: new Date(cycleEnd).toISOString() };
    // 包含一次周期边界重置前的旧高值(95% -> 5%),应自动从重置后截取
    history.append({ ts: new Date(cycleStart + 1000).toISOString(), endpoint: 'demo', rolling: 0, weekly: 0, monthly: 95, resets });
    history.append({ ts: day(10), endpoint: 'demo', rolling: 5, weekly: 10, monthly: 8, resets });
    history.append({ ts: day(14), endpoint: 'demo', rolling: 10, weekly: 30, monthly: 45, resets });
    history.append({ ts: day(18), endpoint: 'demo', rolling: 12, weekly: 50, monthly: 62, resets });

    // 高消耗:13 天用 81%,日均约 6.2%,约 3 天后(11月25日)触顶/跌破 0%
    const fast = history.monthlySeries(['demo'], new Date(cycleEnd).toISOString(), 81, now)!;
    expect(fast.sampleCount).toBe(3); // 95% 被重置切点排除
    expect(fast.dailyRate).toBeCloseTo(6.2, 1);
    expect(fast.projectedEndUsed).toBeGreaterThan(180);
    expect(fast.projectedHitAt).not.toBeNull();
    const hitDate = new Date(fast.projectedHitAt!);
    expect(hitDate.getUTCMonth()).toBe(10);
    expect(hitDate.getUTCDate()).toBe(25);

    // 温和消耗:13 天用 26%,日均 2.0%,周期末约 60%,不会触顶
    const calm = history.monthlySeries(['demo'], new Date(cycleEnd).toISOString(), 26, now)!;
    expect(calm.dailyRate).toBe(2);
    expect(calm.projectedEndUsed).toBe(60);
    expect(calm.projectedHitAt).toBeNull();
  });

  it('History 保留天数支持动态配置(>30 天完整保留,调小后按新天数裁剪)', () => {
    let retain = 45;
    const history = new History(join(root, 'retain.jsonl'), () => retain);
    const now = Date.now();
    const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
    const resets = { rolling: daysAgo(-1), weekly: daysAgo(-5), monthly: daysAgo(-15) };

    history.append({ ts: daysAgo(40), endpoint: 'demo', rolling: 1, weekly: 2, monthly: 3, resets });
    history.append({ ts: daysAgo(20), endpoint: 'demo', rolling: 4, weekly: 5, monthly: 6, resets });
    history.append({ ts: daysAgo(2), endpoint: 'demo', rolling: 7, weekly: 8, monthly: 9, resets });
    history.trim();
    // 45 天配置下,40 天前与 20 天前的记录都完整保留
    expect(history.read()).toHaveLength(3);

    // 热调为 30 天后裁剪,40 天前的被裁掉,20 天前与 2 天前的保留
    retain = 30;
    history.trim();
    expect(history.read()).toHaveLength(2);
    expect(history.count()).toBe(2);
    // 原子裁剪完成后目录中不遗留临时文件
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('History 变化去重 + 30 分钟心跳 + 变化前稳态锚点压缩体积且不失真', () => {
    const file = join(root, 'compact.jsonl');
    const history = new History(file, { retainDays: 35, heartbeatMs: 30 * 60_000 });
    const t0 = Date.UTC(2026, 10, 22, 10, 0, 0);
    const ts = (mins: number) => new Date(t0 + mins * 60_000).toISOString();
    const resets = (mins: number) => ({
      // 模拟空闲期每 5 小时窗口 resetsAt 每分钟往后滑,不应破坏去重
      rolling: new Date(t0 + (300 + mins) * 60_000).toISOString(),
      weekly: '2026-11-28T00:00:00.000Z',
      monthly: '2026-12-09T00:00:00.000Z',
    });

    // 10:00 首次记录(落盘),10:01–10:29 共 29 分钟无变化(全部跳过),10:30 达到心跳(落盘)
    expect(history.append({ ts: ts(0), endpoint: 'demo', keyId: 'k1', rolling: 0, weekly: 20, monthly: 30, resets: resets(0) })).toBe(true);
    for (let m = 1; m <= 29; m += 1) {
      expect(history.append({ ts: ts(m), endpoint: 'demo', keyId: 'k1', rolling: 0, weekly: 20, monthly: 30, resets: resets(m) })).toBe(false);
    }
    expect(history.append({ ts: ts(30), endpoint: 'demo', keyId: 'k1', rolling: 0, weekly: 20, monthly: 30, resets: resets(30) })).toBe(true);

    // 10:31–10:44 平稳无变化(跳过),10:45 用量跳升至 32%(应同时补写 10:44 稳态锚点 + 10:45 新点)
    for (let m = 31; m <= 44; m += 1) {
      expect(history.append({ ts: ts(m), endpoint: 'demo', keyId: 'k1', rolling: 0, weekly: 20, monthly: 30, resets: resets(m) })).toBe(false);
    }
    expect(history.append({ ts: ts(45), endpoint: 'demo', keyId: 'k1', rolling: 5, weekly: 22, monthly: 32, resets: resets(45) })).toBe(true);

    // 46 次每分钟轮询被压缩为 4 条精准拐点
    const rows = history.read();
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => [r.ts, r.monthly])).toEqual([
      [ts(0), 30],
      [ts(30), 30],
      [ts(44), 30],
      [ts(45), 32],
    ]);

    // 磁盘持久化与新实例冷加载结果一致
    const reloaded = new History(file);
    expect(reloaded.count()).toBe(4);
    expect(reloaded.read().map((r) => r.monthly)).toEqual([30, 30, 30, 32]);
    // 坏行容错:追加一行损坏文本后重新加载仍完整保留 4 条有效记录
    writeFileSync(file, `${readFileSync(file, 'utf8')}{broken-json\n`, 'utf8');
    expect(new History(file).count()).toBe(4);
  });

  it('History 内存缓存命中不重复读盘,且支持 keyId 改名连续追踪、兼容旧记录、换 Key 不串曲线', () => {
    const file = join(root, 'keyid.jsonl');
    const now = Date.now();
    const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const resets = { rolling: hoursAgo(-4), weekly: hoursAgo(-72), monthly: hoursAgo(-240) };
    // 先预置一条旧版无 keyId 的历史行(来自升级前的 opencode-old)
    writeFileSync(file, `${JSON.stringify({ ts: hoursAgo(20), endpoint: 'opencode-old', rolling: 5, weekly: 10, monthly: 15, resets })}\n`, 'utf8');

    const history = new History(file);
    // 同 Key(key-a) 先挂在 opencode-old,随后改名为 opencode-renamed
    history.append({ ts: hoursAgo(10), endpoint: 'opencode-old', keyId: 'key-a', rolling: 12, weekly: 22, monthly: 28, resets });
    history.append({ ts: hoursAgo(2), endpoint: 'opencode-renamed', keyId: 'key-a', rolling: 18, weekly: 35, monthly: 40, resets });
    // 另一把 Key(key-b) 复用同一个端点名 opencode-renamed,绝不能串入 key-a 的历史
    history.append({ ts: hoursAgo(1), endpoint: 'opencode-renamed', keyId: 'key-b', rolling: 90, weekly: 95, monthly: 99, resets });

    // key-a(已改名,不再含 opencode-old)应拿到两条 key-a 记录,且不含 key-b 的 99%
    const renamedTrend = history.trend({ keyId: 'key-a', endpoints: ['opencode-renamed'], label: 'opencode-renamed' }, 7)!;
    expect(renamedTrend.samples).toBe(2);
    expect(renamedTrend.peak.monthly).toBe(40);

    // key-a 仍包含旧名 opencode-old 时,还能把升级前的旧版无 keyId 行一起无缝拼接
    const stitchedTrend = history.trend({ keyId: 'key-a', endpoints: ['opencode-old', 'opencode-renamed'], label: 'opencode-old' }, 7)!;
    expect(stitchedTrend.samples).toBe(3);
    expect(stitchedTrend.peak.monthly).toBe(40);

    // key-b 只看到自己的 99%,完全隔离
    const keyBTrend = history.trend({ keyId: 'key-b', endpoints: ['opencode-renamed'], label: 'opencode-renamed' }, 7)!;
    expect(keyBTrend.samples).toBe(1);
    expect(keyBTrend.peak.monthly).toBe(99);

    // 删除底层文件后,热缓存的 read/count/trend 仍直接命中内存(证明未重复读盘)
    rmSync(file);
    expect(history.count()).toBe(4);
    expect(history.trend({ keyId: 'key-a', endpoints: ['opencode-renamed'] }, 7)!.samples).toBe(2);
  });

  it('World 端到端:Provider 改名但保留同一把 Key 时,ocq_history 与月度趋势不断档', async () => {
    const botDir = deployment();
    const sharedKey = 'sk-opencode-rename-keep-history';
    endpoint('oc-before', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K' }, `K=${sharedKey}\n`);
    const monthlyReset = new Date(Date.now() + 15 * 86_400_000).toISOString();
    let curMonthly = 25;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: 'ok', percent: 10, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
        weekly: { status: 'ok', percent: 20, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
        monthly: { status: 'ok', percent: curMonthly, resetsAt: monthlyReset },
      },
    }), { status: 200 }));

    const instance = world(botDir);
    await instance.start(new FakeHost());

    // 将 Provider 目录从 oc-before 改名为 oc-after,密钥不变
    rmSync(join(root, 'providers', 'oc-before'), { recursive: true, force: true });
    endpoint('oc-after', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'K' }, `K=${sharedKey}\n`);
    curMonthly = 42;
    await instance.poll();

    const snap = instance.snapshot();
    expect(snap.sources).toHaveLength(1);
    expect(snap.sources[0]!.name).toBe('oc-after');
    expect(snap.sources[0]!.monthly?.sampleCount).toBe(2);

    const historyTool = instance.tools().find((t) => t.name === 'ocq_history')!;
    const out = await historyTool.handler({}, {} as never);
    expect(out).toContain('oc-after：');
    expect(out).toContain('共 2 条记录');
    expect(instance.webUi('zh').storage![0]!.stat!()).toBe('2 条记录');
    await instance.stop();
  });
});


