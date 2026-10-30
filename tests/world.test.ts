import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { OPENCODE_QUOTA } from '../src/definition.ts';
import { configuredRoot, manualKey, OPENCODE_QUOTA_DEFAULTS, type OpenCodeQuotaConfigSection } from '../src/config.ts';
import { gatewayRoot, parseUsage, providersDir, readEndpoints, readKey } from '../src/gateway.ts';
import { History } from '../src/history.ts';
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

  it('默认禁用,配置只有一组五项', () => {
    expect(OPENCODE_QUOTA_DEFAULTS.enabled).toBe(false);
    const decl = OPENCODE_QUOTA.create(fakeWorldContext(OPENCODE_QUOTA, { scratchDir: root })).webUi?.('zh');
    expect(decl?.config).toHaveLength(1);
    expect(Object.keys(decl!.config![0]!.schema.properties)).toEqual([
      'worlds.opencode-quota.pollMinutes',
      'worlds.opencode-quota.alertAt',
      'worlds.opencode-quota.notify',
      'worlds.opencode-quota.baseUrl',
      'worlds.opencode-quota.apiKey',
    ]);
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
  it('只认 kind 为 opencode 且不是按量计费的端点', () => {
    deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' });
    endpoint('paid', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/openai/v1', options: { billing: 'balance' } });
    endpoint('other', { kind: 'cortico-provider-coo', baseUrl: 'https://api.deepseek.com' });
    endpoint('proxy', { kind: 'opencode', baseUrl: 'https://proxy.example.com/v1' });
    const found = readEndpoints(deployment());
    expect(found.map((item) => item.name)).toEqual(['demo']);
    expect(found[0]!.root).toBe('https://opencode.ai/inference');
    expect(found[0]!.secretName).toBe('CORTICO_KEY_DEMO');
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

  it('网关根只从 /inference 之前的路径取', () => {
    expect(gatewayRoot('https://opencode.ai/inference/go/openai/v1')).toBe('https://opencode.ai/inference');
    expect(gatewayRoot('https://proxy.example.com/v1')).toBe('');
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

  it('ocq_read 读到数字,ocq_history 没有样本时说实话', async () => {
    const botDir = deployment();
    endpoint('demo', { kind: 'opencode', baseUrl: 'https://opencode.ai/inference/go/openai/v1', secret: 'CORTICO_KEY_DEMO' },
      'CORTICO_KEY_DEMO=secret-value\n');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(usage(42, 21, 7)), { status: 200 }));
    const instance = world(botDir);
    const read = instance.tools().find((tool) => tool.name === 'ocq_read')!;
    const history = instance.tools().find((tool) => tool.name === 'ocq_history')!;
    expect(await read.handler({}, {} as never)).toContain('42%');
    expect(await history.handler({}, {} as never)).toMatch(/No allowance sample/);
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