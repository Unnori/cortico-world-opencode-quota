import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { DeepPartial } from 'cortico/world.ts';
import { OPENCODE_QUOTA } from '../src/definition.ts';
import {
  configuredRoot,
  DEFAULT_SECRET_NAME,
  ENV_NAME_RE,
  normalizeDisplayMode,
  normalizeKeySlots,
  normalizeRetainDays,
  normalizeTriggerMode,
  OPENCODE_QUOTA_DEFAULTS,
  TRIGGER_MODES,
  type OpenCodeQuotaConfigSection,
} from '../src/config.ts';
import {
  gatewayRoot,
  maskKeyHint,
  MAX_RESPONSE_BYTES,
  parseUsage,
} from '../src/gateway.ts';
import { History, subtractOneMonth } from '../src/history.ts';
import type { QuotaSnapshot } from '../src/webui/protocol.ts';
import { keyFingerprint, OpenCodeQuotaWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opencode-quota-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const usage = (rolling: number, weekly = 10, monthly = 5, resets = '2030-01-01T00:00:00.000Z') => ({
  usage: {
    rolling: { status: 'ok', percent: rolling, resetsAt: resets },
    weekly: { status: 'ok', percent: weekly, resetsAt: resets },
    monthly: { status: 'ok', percent: monthly, resetsAt: resets },
  },
});

const cfg = (patch: Partial<OpenCodeQuotaConfigSection> = {}): OpenCodeQuotaConfigSection =>
  ({ ...OPENCODE_QUOTA_DEFAULTS, keys: [], enabled: true, ...patch });

interface TestEnv {
  world: OpenCodeQuotaWorld;
  cfg: OpenCodeQuotaConfigSection;
  secrets: Map<string, string>;
  persisted: Array<DeepPartial<OpenCodeQuotaConfigSection>>;
  storedCalls: Array<[string, string]>;
}

/** 构造与 Cortico 真实 WorldContext 行为一致的测试环境(含 storeSecret 非空与变量名校验)。 */
function createWorld(
  patch: Partial<OpenCodeQuotaConfigSection> = {},
  initialSecrets: Record<string, string> = {},
): TestEnv {
  const liveCfg = cfg(patch);
  const secrets = new Map<string, string>(Object.entries(initialSecrets));
  const persisted: Array<DeepPartial<OpenCodeQuotaConfigSection>> = [];
  const storedCalls: Array<[string, string]> = [];

  const world = new OpenCodeQuotaWorld({
    cfg: liveCfg,
    timezone: 'UTC',
    dataDir: root,
    secret: (name) => secrets.get(name) ?? '',
    storeSecret: (name, value) => {
      // 与 Cortico src/world.ts writeEnvLine 保持完全一致的约束
      if (!ENV_NAME_RE.test(name)) throw new Error(`storeSecret: "${name}" is not an environment variable name`);
      if (!value || /\s/.test(value)) throw new Error(`storeSecret: the value of ${name} is empty or holds whitespace`);
      secrets.set(name, value);
      storedCalls.push([name, value]);
    },
    persist: (p) => {
      persisted.push(p);
      Object.assign(liveCfg, p);
    },
  });

  return { world, cfg: liveCfg, secrets, persisted, storedCalls };
}

/** 便捷构造一个带默认单把 Key 的 World。 */
function singleKeyWorld(
  patch: Partial<OpenCodeQuotaConfigSection> = {},
  keyValue = 'sk-demo-12345678',
  label = '主 Key',
): TestEnv {
  return createWorld(
    { keys: [{ label, secret: 'OPENCODE_QUOTA_KEY_1' }], ...patch },
    { OPENCODE_QUOTA_KEY_1: keyValue },
  );
}

describe('OpenCode 额度 World', () => {
  it('干装载不报失败:装载器会接受它', async () => {
    const report = await dryMountWorld(OPENCODE_QUOTA, { scratchDir: root });
    expect(report.failures).toEqual([]);
  });

  it('默认禁用,配置只有一组八项(不含明文 apiKey),事件投递默认 piggyback 且本地保留默认 35 天', () => {
    expect(OPENCODE_QUOTA_DEFAULTS.enabled).toBe(false);
    expect(OPENCODE_QUOTA_DEFAULTS.displayMode).toBe('used');
    expect(OPENCODE_QUOTA_DEFAULTS.resetTrigger).toBe('piggyback');
    expect(OPENCODE_QUOTA_DEFAULTS.thresholdTrigger).toBe('piggyback');
    expect(OPENCODE_QUOTA_DEFAULTS.retainDays).toBe(35);
    expect(OPENCODE_QUOTA_DEFAULTS.keys).toEqual([]);
    expect('apiKey' in OPENCODE_QUOTA_DEFAULTS).toBe(false);

    expect(normalizeDisplayMode('remaining')).toBe('remaining');
    expect(normalizeDisplayMode('unknown')).toBe('used');
    expect(normalizeTriggerMode('flush')).toBe('flush');
    expect(normalizeTriggerMode('invalid')).toBe('piggyback');
    expect(normalizeRetainDays(90)).toBe(90);
    expect(normalizeRetainDays(1)).toBe(7);
    expect(normalizeRetainDays(999)).toBe(365);
    expect(normalizeRetainDays(undefined)).toBe(35);
    expect(normalizeKeySlots([
      { label: ' 主力 ', secret: 'OPENCODE_QUOTA_KEY_1' },
      { label: '重复变量', secret: 'OPENCODE_QUOTA_KEY_1' },
      { label: '非法名', secret: 'bad-name!' },
      { label: '', secret: 'OPENCODE_QUOTA_KEY_2' },
    ])).toEqual([
      { label: '主力', secret: 'OPENCODE_QUOTA_KEY_1' },
      { label: 'OPENCODE_QUOTA_KEY_2', secret: 'OPENCODE_QUOTA_KEY_2' },
    ]);

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

describe('密钥隔离、ctx.storeSecret 与网关校验', () => {
  it('网关根只认 http/https、拒绝内嵌凭证,且只取到 /inference', () => {
    expect(configuredRoot(cfg({ baseUrl: ' https://opencode.ai/inference ' }))).toBe('https://opencode.ai/inference');
    expect(gatewayRoot('https://opencode.ai/inference/go/openai/v1')).toBe('https://opencode.ai/inference');
    expect(gatewayRoot('https://opencode.ai/inference')).toBe('https://opencode.ai/inference');
    expect(gatewayRoot('https://proxy.example.com/v1')).toBe('');
    expect(gatewayRoot('file:///tmp/inference/go')).toBe('');
    expect(gatewayRoot('ftp://opencode.ai/inference/go')).toBe('');
    expect(gatewayRoot('https://user:pass@opencode.ai/inference/go/openai/v1')).toBe('');
    expect(gatewayRoot('not a url')).toBe('');
  });

  it('未配置密钥时不发请求,只经 ctx.secret() 读默认变量 OPENCODE_QUOTA_API_KEY', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(usage(7)), { status: 200 }));

    const empty = createWorld();
    await empty.world.start(new FakeHost());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(empty.world.snapshot().sources).toEqual([]);
    await empty.world.stop();

    const withDefault = createWorld({}, { [DEFAULT_SECRET_NAME]: 'sk-default-env-1234' });
    await withDefault.world.start(new FakeHost());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const snap = withDefault.world.snapshot();
    expect(snap.managedKeys).toEqual([
      { label: '默认 Key', secret: DEFAULT_SECRET_NAME, keyHint: '••••1234', envDefault: true },
    ]);
    expect(snap.sources).toHaveLength(1);
    expect(snap.sources[0]!.keyHint).toBe('••••1234');
    await withDefault.world.stop();
  });

  it('通过面板 addKey / updateKey / removeKey 全程走 ctx.storeSecret + ctx.persist,绝不在配置存明文', async () => {
    const seenAuth: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      seenAuth.push(auth);
      return new Response(JSON.stringify(usage(auth.includes('2222') ? 66 : 18, 30, 40)), { status: 200 });
    });

    const env = createWorld();
    await env.world.start(new FakeHost());
    const invoke = env.world.webUi('zh').invoke!;

    // 1. 拒绝空值或含空白的 Key
    await expect(invoke('quota', 'addKey', ['主力', '   '])).rejects.toThrow(/不能为空/);
    await expect(invoke('quota', 'addKey', ['主力', 'sk-has space'])).rejects.toThrow(/空格/);

    // 2. 添加第一把 Key -> 写入 OPENCODE_QUOTA_KEY_1,config 只留元数据,立刻轮询
    const snap1 = await invoke('quota', 'addKey', ['主力账号', 'sk-first-key-1111']) as QuotaSnapshot;
    expect(env.storedCalls).toEqual([['OPENCODE_QUOTA_KEY_1', 'sk-first-key-1111']]);
    expect(env.cfg.keys).toEqual([{ label: '主力账号', secret: 'OPENCODE_QUOTA_KEY_1' }]);
    expect(JSON.stringify(env.cfg)).not.toContain('sk-first-key-1111');
    expect(JSON.stringify(snap1)).not.toContain('sk-first-key-1111');
    expect(snap1.sources).toHaveLength(1);
    expect(snap1.sources[0]!.windows?.rolling.percent).toBe(18);

    // 3. 拦截重复添加同一把 Key
    await expect(invoke('quota', 'addKey', ['重复名', 'sk-first-key-1111'])).rejects.toThrow(/无需重复添加/);

    // 4. 添加第二把不同 Key -> 自动分配 OPENCODE_QUOTA_KEY_2
    const snap2 = await invoke('quota', 'addKey', ['备用账号', 'sk-second-key-2222']) as QuotaSnapshot;
    expect(env.cfg.keys).toEqual([
      { label: '主力账号', secret: 'OPENCODE_QUOTA_KEY_1' },
      { label: '备用账号', secret: 'OPENCODE_QUOTA_KEY_2' },
    ]);
    expect(snap2.sources).toHaveLength(2);
    expect(snap2.sources.map((s) => s.keyHint)).toEqual(['••••1111', '••••2222']);

    // 5. 改名并更换第一把 Key 的实际值 -> 经 storeSecret 覆盖同变量名
    const snap3 = await invoke('quota', 'updateKey', ['OPENCODE_QUOTA_KEY_1', '工作主力', 'sk-rotated-key-3333']) as QuotaSnapshot;
    expect(env.secrets.get('OPENCODE_QUOTA_KEY_1')).toBe('sk-rotated-key-3333');
    expect(snap3.sources[0]!.name).toBe('工作主力');
    expect(snap3.sources[0]!.keyHint).toBe('••••3333');

    // 6. 移除第一把 Key -> 仅从 cfg.keys 移除,绝不调用 storeSecret(name, '') 触发框架抛错
    const storedBeforeRemove = env.storedCalls.length;
    const snap4 = await invoke('quota', 'removeKey', ['OPENCODE_QUOTA_KEY_1']) as QuotaSnapshot;
    expect(env.storedCalls.length).toBe(storedBeforeRemove);
    expect(env.cfg.keys).toEqual([{ label: '备用账号', secret: 'OPENCODE_QUOTA_KEY_2' }]);
    expect(snap4.sources).toHaveLength(1);
    expect(snap4.sources[0]!.name).toBe('备用账号');
    await env.world.stop();
  });

  it('若已通过默认变量 OPENCODE_QUOTA_API_KEY 运行,再经面板新增第二把 Key 时保留前者不丢失', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(usage(12, 22, 32)), { status: 200 }));
    const env = createWorld({}, { [DEFAULT_SECRET_NAME]: 'sk-default-aaaa' });
    await env.world.start(new FakeHost());

    const snap = await env.world.webUi('zh').invoke!('quota', 'addKey', ['二号 Key', 'sk-extra-bbbb']) as QuotaSnapshot;
    expect(env.cfg.keys).toEqual([
      { label: '默认 Key', secret: DEFAULT_SECRET_NAME },
      { label: '二号 Key', secret: 'OPENCODE_QUOTA_KEY_1' },
    ]);
    expect(snap.sources).toHaveLength(2);
    expect(snap.sources.map((s) => s.keyHint)).toEqual(['••••aaaa', '••••bbbb']);
    await env.world.stop();
  });

  it('槽位在 .env 中缺失密钥时给出明确提示,不发无效网络请求', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = createWorld({ keys: [{ label: '遗失密钥', secret: 'OPENCODE_QUOTA_KEY_1' }] }, {});
    await env.world.start(new FakeHost());
    expect(fetchSpy).not.toHaveBeenCalled();
    const snap = env.world.snapshot();
    expect(snap.managedKeys[0]!.keyHint).toBeNull();
    expect(snap.sources[0]!.error).toContain('OPENCODE_QUOTA_KEY_1');
    await env.world.stop();
  });
});

describe('额度读取', () => {
  it('接受三个窗口,拒绝缺字段的回应', () => {
    expect(parseUsage(usage(12)).rolling.percent).toBe(12);
    expect(() => parseUsage({})).toThrow(/usage/);
    expect(() => parseUsage({ usage: { rolling: { status: 'ok', percent: 'x', resetsAt: 'soon' } } })).toThrow(/百分比/);
  });

  it('越线只在刚越过时报一次,重置单独报', async () => {
    const host = new FakeHost();
    const { world } = singleKeyWorld({ alertAt: 80 });

    let payload = usage(10);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));

    await world.start(host);
    expect(host.events).toHaveLength(0);

    payload = usage(85);
    await world.poll();
    expect(host.events.map((event) => event.type)).toEqual(['opencode-quota.threshold']);

    await world.poll();
    expect(host.events).toHaveLength(1);

    // 只有每 5 小时窗口重置时刻往后滑,用量没变:不叫重置
    payload = {
      usage: {
        rolling: { status: 'ok', percent: 85, resetsAt: '2030-02-01T00:00:00.000Z' },
        weekly: { status: 'ok', percent: 10, resetsAt: '2030-01-01T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 5, resetsAt: '2030-01-01T00:00:00.000Z' },
      },
    };
    await world.poll();
    expect(host.events).toHaveLength(1);

    // 用量真的掉下来才算重置
    payload = {
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: '2030-02-01T00:00:00.000Z' },
        weekly: { status: 'ok', percent: 10, resetsAt: '2030-01-01T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 5, resetsAt: '2030-01-01T00:00:00.000Z' },
      },
    };
    await world.poll();
    expect(host.events.map((event) => event.type)).toEqual(['opencode-quota.threshold', 'opencode-quota.reset']);
    await world.stop();
  });

  it('重置时刻每分钟往后滑时不报警——那次事故就是这么来的', async () => {
    const host = new FakeHost();
    const { world } = singleKeyWorld({ alertAt: 80 });
    let minute = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: new Date(Date.UTC(2030, 0, 1, 5, minute++)).toISOString() },
        weekly: { status: 'ok', percent: 86, resetsAt: '2030-01-07T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 43, resetsAt: '2030-02-01T00:00:00.000Z' },
      },
    }), { status: 200 }));

    await world.start(host);
    for (let index = 0; index < 5; index += 1) await world.poll();
    expect(host.events).toHaveLength(0);
    await world.stop();
  });

  it('同一窗口的同类事件在冷却时间内只报一次', async () => {
    const host = new FakeHost();
    const { world } = singleKeyWorld({ alertAt: 50 });
    let payload = usage(10);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));

    await world.start(host);
    payload = usage(60);
    await world.poll();
    expect(host.events).toHaveLength(1);

    payload = usage(5);
    await world.poll();
    expect(host.events).toHaveLength(2);

    payload = usage(60);
    await world.poll();
    expect(host.events.map((event) => event.type)).toEqual(['opencode-quota.threshold', 'opencode-quota.reset']);
    await world.stop();
  });

  it('关掉提醒后不推事件,但工具照常能读', async () => {
    const host = new FakeHost();
    let payload = usage(10);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const { world } = singleKeyWorld({ alertAt: 80, notify: false });
    await world.start(host);
    payload = usage(99);
    await world.poll();
    expect(host.events).toHaveLength(0);
    const read = world.tools().find((tool) => tool.name === 'ocq_read')!;
    expect(await read.handler({}, {} as never)).toContain('99%');
    await world.stop();
  });

  it('读失败时把原因交给 bot 一次,之后不重复', async () => {
    const host = new FakeHost();
    const { world } = singleKeyWorld();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: { type: 'AuthError' } }), { status: 401 }));

    await world.start(host);
    await world.poll();
    expect(host.events.map((event) => event.type)).toEqual(['opencode-quota.unavailable']);
    expect(host.events[0]!.text).toContain('401');
    expect(host.pushOpts[0]?.deliver).toBe(false);
    await world.stop();
  });

  it('一次网络抖动不算失败:同一次请求再试一遍', async () => {
    const host = new FakeHost();
    const { world } = singleKeyWorld({ alertAt: 80 });
    let attempt = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(usage(12)), { status: 200 });
    });
    await world.start(host);
    expect(attempt).toBe(2);
    expect(host.events).toHaveLength(0);
    expect(world.snapshot().sources[0]!.error).toBeNull();
    await world.stop();
  });

  it('ocq_read 同时返回已用与剩余百分比,ocq_history 没有样本时如实返回中文提示', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(usage(42, 21, 7)), { status: 200 }));
    const { world } = singleKeyWorld();
    const read = world.tools().find((tool) => tool.name === 'ocq_read')!;
    const history = world.tools().find((tool) => tool.name === 'ocq_history')!;
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

describe('面板与四态灯', () => {
  it('state 不联网,只报已经轮询到的值', async () => {
    const { world } = singleKeyWorld({ alertAt: 50 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(usage(61, 2, 3)), { status: 200 }));
    await world.start(new FakeHost());
    const callsAfterPoll = fetchSpy.mock.calls.length;

    const decl = world.webUi('zh');
    const snapshot = await decl.invoke!('quota', 'state', []) as QuotaSnapshot;

    expect(fetchSpy.mock.calls.length).toBe(callsAfterPoll);
    expect(snapshot.alertAt).toBe(50);
    expect(snapshot.sources.map((source) => source.name)).toEqual(['主 Key']);
    expect(snapshot.sources[0]!.windows!.rolling.percent).toBe(61);
    await world.stop();
  });

  it('read 让 World 立刻读一遍', async () => {
    const { world } = singleKeyWorld();
    let payload = usage(10);
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await world.start(new FakeHost());
    const before = fetchSpy.mock.calls.length;
    payload = usage(44);
    const snapshot = await world.webUi('zh').invoke!('quota', 'read', []) as QuotaSnapshot;
    expect(fetchSpy.mock.calls.length).toBe(before + 1);
    expect(snapshot.sources[0]!.windows!.rolling.percent).toBe(44);
    await world.stop();
  });

  it('徽标给三个窗口,越过告警线的那个换配色', async () => {
    const { world } = singleKeyWorld({ alertAt: 50 });
    vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(usage(80, 10, 5)), { status: 200 }));
    await world.start(new FakeHost());
    const badges = world.webUi('zh').badges!;
    expect(badges.map((badge) => badge.label)).toEqual(['每 5 小时', '每周', '每月']);
    expect(badges.map((badge) => badge.value)).toEqual(['80%', '10%', '5%']);
    expect(badges.map((badge) => badge.tone)).toEqual(['off', 'on', 'on']);
    await world.stop();
  });

  it('四态灯按用量换色:绿充足、黄大半、红过线、灰用完;没读到时不报灯', async () => {
    const { world } = singleKeyWorld({ alertAt: 80 });
    expect(world.webUi('zh').lamps).toEqual([]);

    let payload = usage(85, 60, 100);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await world.start(new FakeHost());
    expect(world.webUi('zh').lamps!.map((lamp) => lamp.label)).toEqual(['每 5 小时', '每周', '每月']);
    expect(world.webUi('zh').lamps!.map((lamp) => lamp.state)).toEqual(['error', 'loading', 'offline']);

    payload = usage(30, 10, 5);
    await world.poll();
    expect(world.webUi('zh').lamps!.map((lamp) => lamp.state)).toEqual(['online', 'online', 'online']);
    await world.stop();
  });
});

describe('按 Key 去重与多 Key 面板', () => {
  it('多个槽位指向同一把实际 Key 时只合并为一个面板,且只发一次请求', async () => {
    const sharedKey = 'sk-opencode-shared-1111aaaa';
    const { world } = createWorld(
      {
        keys: [
          { label: '主力 A', secret: 'OPENCODE_QUOTA_KEY_1' },
          { label: '镜像 B', secret: 'OPENCODE_QUOTA_KEY_2' },
          { label: '镜像 C', secret: 'OPENCODE_QUOTA_KEY_3' },
        ],
      },
      {
        OPENCODE_QUOTA_KEY_1: sharedKey,
        OPENCODE_QUOTA_KEY_2: sharedKey,
        OPENCODE_QUOTA_KEY_3: sharedKey,
      },
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(usage(12, 34, 56)), { status: 200 }));
    await world.start(new FakeHost());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const snap = world.snapshot();
    expect(snap.managedKeys).toHaveLength(3);
    expect(snap.sources).toHaveLength(1);
    expect(snap.sources[0]!.name).toBe('主力 A');
    expect(snap.sources[0]!.labels).toEqual(['主力 A', '镜像 B', '镜像 C']);
    expect(snap.sources[0]!.keyHint).toBe('••••aaaa');
    expect(JSON.stringify(snap)).not.toContain(sharedKey);

    // 按被合并掉的槽位名称查询工具也应命中
    const read = world.tools().find((tool) => tool.name === 'ocq_read')!;
    expect(await read.handler({ endpoint: '镜像 B' }, {} as never)).toContain('12%');
    await world.stop();
  });

  it('只有两把 Key 不同时才显示两个额度面板,页头徽标与状态灯按最紧窗口聚合', async () => {
    const { world } = createWorld(
      {
        alertAt: 80,
        keys: [
          { label: '主力 A', secret: 'OPENCODE_QUOTA_KEY_1' },
          { label: '同 Key 别名', secret: 'OPENCODE_QUOTA_KEY_2' },
          { label: '二号账号', secret: 'OPENCODE_QUOTA_KEY_3' },
        ],
      },
      {
        OPENCODE_QUOTA_KEY_1: 'sk-account-one-1111',
        OPENCODE_QUOTA_KEY_2: 'sk-account-one-1111',
        OPENCODE_QUOTA_KEY_3: 'sk-account-two-2222',
      },
    );

    const seenKeys: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      seenKeys.push(auth);
      const body = auth.includes('2222') ? usage(88, 20, 10) : usage(15, 45, 30);
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await world.start(new FakeHost());

    expect(seenKeys).toEqual(['Bearer sk-account-one-1111', 'Bearer sk-account-two-2222']);
    const snap = world.snapshot();
    expect(snap.sources).toHaveLength(2);
    expect(snap.sources[0]!.labels).toEqual(['主力 A', '同 Key 别名']);
    expect(snap.sources[0]!.keyHint).toBe('••••1111');
    expect(snap.sources[1]!.labels).toEqual(['二号账号']);
    expect(snap.sources[1]!.keyHint).toBe('••••2222');

    const badges = world.webUi('zh').badges!;
    expect(badges.map((b) => `${b.label}:${b.value}:${b.tone}`)).toEqual([
      '每 5 小时:88%:off',
      '每周:45%:on',
      '每月:30%:on',
      '独立 Key:2:plain',
    ]);
    const lamps = world.webUi('zh').lamps!;
    expect(lamps.map((l) => l.state)).toEqual(['error', 'online', 'online']);
    expect(lamps[0]!.hint).toContain('二号账号');
    await world.stop();
  });

  it('短密钥全打码不露尾标,且网关回显密钥时在错误中脱敏', async () => {
    expect(maskKeyHint('')).toBeNull();
    expect(maskKeyHint('short')).toBe('••••');
    expect(maskKeyHint('12345678')).toBe('••••5678');

    const secret = 'sk-secret-echo-test-9876';
    const { world } = singleKeyWorld({}, secret);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(`rejected key ${secret}`, { status: 401 }));

    await world.start(new FakeHost());
    const errText = world.snapshot().sources[0]!.error ?? '';
    expect(errText).toContain('[redacted]');
    expect(errText).not.toContain(secret);
    await world.stop();
  });
});

describe('已用 / 剩余显示模式切换', () => {
  it('切换为 remaining 后,快照、页头徽标与灯提示同步切为剩余额度', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(usage(1, 67, 81)), { status: 200 }));

    const { world } = singleKeyWorld({ alertAt: 80 });
    await world.start(new FakeHost());

    expect(world.snapshot().displayMode).toBe('used');
    expect(world.webUi('zh').badges!.map((b) => b.value)).toEqual(['1%', '67%', '81%']);

    const next = await world.webUi('zh').invoke!('quota', 'mode', ['remaining']) as QuotaSnapshot;
    expect(next.displayMode).toBe('remaining');
    expect(world.snapshot().displayMode).toBe('remaining');
    expect(world.webUi('zh').badges!.map((b) => `${b.label}:${b.value}:${b.tone}`)).toEqual([
      '每 5 小时:剩 99%:on',
      '每周:剩 33%:on',
      '每月:剩 19%:off',
    ]);
    expect(world.webUi('zh').lamps![0]!.hint).toContain('剩余 99%');

    await world.webUi('zh').invoke!('quota', 'mode', ['used']);
    expect(world.webUi('zh').badges!.map((b) => b.value)).toEqual(['1%', '67%', '81%']);
    await world.stop();
  });
});

describe('事件投递规则', () => {
  it('默认采用 piggyback 静默搭便车,不主动唤醒 bot', async () => {
    const host = new FakeHost();
    const { world } = singleKeyWorld({ alertAt: 80 });
    let payload = usage(10);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));

    await world.start(host);
    payload = usage(85);
    await world.poll();
    payload = usage(0);
    await world.poll();

    expect(host.events.map((e) => e.type)).toEqual(['opencode-quota.threshold', 'opencode-quota.reset']);
    expect(host.pushOpts.map((opt) => opt?.trigger)).toEqual(['piggyback', 'piggyback']);
    await world.stop();
  });

  it('越线与额度刷新可独立配置宿主五种投递规则,且支持热生效', async () => {
    const host = new FakeHost();
    const env = singleKeyWorld({ alertAt: 80, thresholdTrigger: 'flush', resetTrigger: 'debounce' });
    let payload = usage(10, 10, 10);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));

    await env.world.start(host);
    payload = usage(90, 10, 10);
    await env.world.poll();
    payload = usage(0, 10, 10);
    await env.world.poll();

    env.cfg.thresholdTrigger = 'preempt';
    env.cfg.resetTrigger = 'interrupt';
    payload = usage(0, 85, 10);
    await env.world.poll();
    payload = usage(0, 0, 10);
    await env.world.poll();

    expect(host.events.map((e) => e.type)).toEqual([
      'opencode-quota.threshold',
      'opencode-quota.reset',
      'opencode-quota.threshold',
      'opencode-quota.reset',
    ]);
    expect(host.pushOpts.map((opt) => opt?.trigger)).toEqual(['flush', 'debounce', 'preempt', 'interrupt']);
    await env.world.stop();
  });
});

describe('安全加固、并发去重、缓存保留与月度趋势预测', () => {
  it('请求禁止重定向、携带超时 signal,超限响应与无效 JSON 均安全拒绝且不泄密', async () => {
    const secret = 'sk-super-secret-json-9999';
    const seenInits: Array<RequestInit | undefined> = [];
    let mode: 'ok' | 'big' | 'badjson' = 'ok';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      seenInits.push(init);
      if (mode === 'big') return new Response('x'.repeat(MAX_RESPONSE_BYTES + 128), { status: 200 });
      if (mode === 'badjson') return new Response(`not-json-${secret}`, { status: 200 });
      return new Response(JSON.stringify(usage(10, 20, 30)), { status: 200 });
    });

    const { world } = singleKeyWorld({}, secret);
    await world.start(new FakeHost());
    expect(seenInits[0]?.redirect).toBe('error');
    expect(seenInits[0]?.signal).toBeDefined();

    mode = 'big';
    await world.poll();
    let snap = world.snapshot();
    expect(snap.sources[0]!.windows?.rolling.percent).toBe(10);
    expect(snap.sources[0]!.error).toContain('字节上限');

    mode = 'badjson';
    await world.poll();
    snap = world.snapshot();
    expect(snap.sources[0]!.error).toContain('无法解析的 JSON');
    expect(snap.sources[0]!.error).not.toContain(secret);
    await world.stop();
  });

  it('并发 poll 自动复用在途任务,不会发出双倍请求', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify(usage(15, 25, 35)), { status: 200 });
    });

    const { world } = singleKeyWorld();
    await Promise.all([world.poll(), world.poll(), world.poll()]);
    expect(calls).toBe(1);
    await world.stop();
  });

  it('stop() 会中止正在进行的网络请求', async () => {
    let aborted = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    }));

    const { world } = singleKeyWorld();
    const starting = world.start(new FakeHost());
    await new Promise((r) => setTimeout(r, 20));
    await world.stop();
    await starting;
    expect(aborted).toBe(true);
    expect(world.snapshot().sources[0]!.windows).toBeNull();
  });

  it('envPromptVars 精简为稳定来源列表,不注入易变时间戳', () => {
    const { world } = singleKeyWorld({}, 'sk-demo-12345678', '主力账号');
    expect(Object.keys(world.envPromptVars())).toEqual(['opencode-quota.endpoints']);
    expect(world.envPromptVars()['opencode-quota.endpoints']).toBe('主力账号');
  });

  it('monthlySeries 基于本地记录准确推算日均消耗、预计触顶日与空档期', () => {
    const history = new History(join(root, 'monthly.jsonl'));
    const cycleEnd = Date.UTC(2026, 11, 9, 0, 0, 0);
    const cycleStart = subtractOneMonth(cycleEnd);
    expect(new Date(cycleStart).getUTCMonth()).toBe(10);
    expect(new Date(cycleStart).getUTCDate()).toBe(9);

    const now = Date.UTC(2026, 10, 22, 0, 0, 0);
    const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12, 0, 0)).toISOString();
    const resets = { rolling: day(22), weekly: day(23), monthly: new Date(cycleEnd).toISOString() };
    history.append({ ts: new Date(cycleStart + 1000).toISOString(), endpoint: 'demo', rolling: 0, weekly: 0, monthly: 95, resets });
    history.append({ ts: day(10), endpoint: 'demo', rolling: 5, weekly: 10, monthly: 8, resets });
    history.append({ ts: day(14), endpoint: 'demo', rolling: 10, weekly: 30, monthly: 45, resets });
    history.append({ ts: day(18), endpoint: 'demo', rolling: 12, weekly: 50, monthly: 62, resets });

    const fast = history.monthlySeries(['demo'], new Date(cycleEnd).toISOString(), 81, now)!;
    expect(fast.sampleCount).toBe(3);
    expect(fast.dailyRate).toBeCloseTo(6.2, 1);
    expect(fast.projectedEndUsed).toBeGreaterThan(180);
    expect(fast.projectedHitAt).not.toBeNull();
    const hitDate = new Date(fast.projectedHitAt!);
    expect(hitDate.getUTCMonth()).toBe(10);
    expect(hitDate.getUTCDate()).toBe(25);

    const calm = history.monthlySeries(['demo'], new Date(cycleEnd).toISOString(), 26, now)!;
    expect(calm.dailyRate).toBe(2);
    expect(calm.projectedEndUsed).toBe(60);
    expect(calm.projectedHitAt).toBeNull();
  });

  it('History 保留天数支持动态配置(>30 天完整保留,调小后按新天数原子裁剪且无 .tmp 残留)', () => {
    let retain = 45;
    const history = new History(join(root, 'retain.jsonl'), () => retain);
    const now = Date.now();
    const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
    const resets = { rolling: daysAgo(-1), weekly: daysAgo(-5), monthly: daysAgo(-15) };

    history.append({ ts: daysAgo(40), endpoint: 'demo', rolling: 1, weekly: 2, monthly: 3, resets });
    history.append({ ts: daysAgo(20), endpoint: 'demo', rolling: 4, weekly: 5, monthly: 6, resets });
    history.append({ ts: daysAgo(2), endpoint: 'demo', rolling: 7, weekly: 8, monthly: 9, resets });
    history.trim();
    expect(history.read()).toHaveLength(3);

    retain = 30;
    history.trim();
    expect(history.read()).toHaveLength(2);
    expect(history.count()).toBe(2);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('History 变化去重 + 30 分钟心跳 + 变化前稳态锚点压缩体积且不失真', () => {
    const file = join(root, 'compact.jsonl');
    const history = new History(file, { retainDays: 35, heartbeatMs: 30 * 60_000 });
    const t0 = Date.UTC(2026, 10, 22, 10, 0, 0);
    const ts = (mins: number) => new Date(t0 + mins * 60_000).toISOString();
    const resets = (mins: number) => ({
      rolling: new Date(t0 + (300 + mins) * 60_000).toISOString(),
      weekly: '2026-11-28T00:00:00.000Z',
      monthly: '2026-12-09T00:00:00.000Z',
    });

    expect(history.append({ ts: ts(0), endpoint: 'demo', keyId: 'k1', rolling: 0, weekly: 20, monthly: 30, resets: resets(0) })).toBe(true);
    for (let m = 1; m <= 29; m += 1) {
      expect(history.append({ ts: ts(m), endpoint: 'demo', keyId: 'k1', rolling: 0, weekly: 20, monthly: 30, resets: resets(m) })).toBe(false);
    }
    expect(history.append({ ts: ts(30), endpoint: 'demo', keyId: 'k1', rolling: 0, weekly: 20, monthly: 30, resets: resets(30) })).toBe(true);

    for (let m = 31; m <= 44; m += 1) {
      expect(history.append({ ts: ts(m), endpoint: 'demo', keyId: 'k1', rolling: 0, weekly: 20, monthly: 30, resets: resets(m) })).toBe(false);
    }
    expect(history.append({ ts: ts(45), endpoint: 'demo', keyId: 'k1', rolling: 5, weekly: 22, monthly: 32, resets: resets(45) })).toBe(true);

    const rows = history.read();
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => [r.ts, r.monthly])).toEqual([
      [ts(0), 30],
      [ts(30), 30],
      [ts(44), 30],
      [ts(45), 32],
    ]);

    const reloaded = new History(file);
    expect(reloaded.count()).toBe(4);
    expect(reloaded.read().map((r) => r.monthly)).toEqual([30, 30, 30, 32]);
    writeFileSync(file, `${readFileSync(file, 'utf8')}{broken-json\n`, 'utf8');
    expect(new History(file).count()).toBe(4);
  });

  it('History 内存缓存命中不重复读盘,且支持 keyId 改名连续追踪、兼容旧记录、换 Key 不串曲线', () => {
    const file = join(root, 'keyid.jsonl');
    const now = Date.now();
    const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const resets = { rolling: hoursAgo(-4), weekly: hoursAgo(-72), monthly: hoursAgo(-240) };
    writeFileSync(file, `${JSON.stringify({ ts: hoursAgo(20), endpoint: 'opencode-old', rolling: 5, weekly: 10, monthly: 15, resets })}\n`, 'utf8');

    const history = new History(file);
    history.append({ ts: hoursAgo(10), endpoint: 'opencode-old', keyId: 'key-a', rolling: 12, weekly: 22, monthly: 28, resets });
    history.append({ ts: hoursAgo(2), endpoint: 'opencode-renamed', keyId: 'key-a', rolling: 18, weekly: 35, monthly: 40, resets });
    history.append({ ts: hoursAgo(1), endpoint: 'opencode-renamed', keyId: 'key-b', rolling: 90, weekly: 95, monthly: 99, resets });

    const renamedTrend = history.trend({ keyId: 'key-a', endpoints: ['opencode-renamed'], label: 'opencode-renamed' }, 7)!;
    expect(renamedTrend.samples).toBe(2);
    expect(renamedTrend.peak.monthly).toBe(40);

    const stitchedTrend = history.trend({ keyId: 'key-a', endpoints: ['opencode-old', 'opencode-renamed'], label: 'opencode-old' }, 7)!;
    expect(stitchedTrend.samples).toBe(3);
    expect(stitchedTrend.peak.monthly).toBe(40);

    const keyBTrend = history.trend({ keyId: 'key-b', endpoints: ['opencode-renamed'], label: 'opencode-renamed' }, 7)!;
    expect(keyBTrend.samples).toBe(1);
    expect(keyBTrend.peak.monthly).toBe(99);

    rmSync(file);
    expect(history.count()).toBe(4);
    expect(history.trend({ keyId: 'key-a', endpoints: ['opencode-renamed'] }, 7)!.samples).toBe(2);
  });

  it('World 端到端:在面板内给 Key 改名时,ocq_history 与月度趋势不断档', async () => {
    const monthlyReset = new Date(Date.now() + 15 * 86_400_000).toISOString();
    let curMonthly = 25;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: 'ok', percent: 10, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
        weekly: { status: 'ok', percent: 20, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
        monthly: { status: 'ok', percent: curMonthly, resetsAt: monthlyReset },
      },
    }), { status: 200 }));

    const env = singleKeyWorld({}, 'sk-opencode-rename-keep-history', '旧名称');
    await env.world.start(new FakeHost());

    await env.world.webUi('zh').invoke!('quota', 'updateKey', ['OPENCODE_QUOTA_KEY_1', '新名称', '']);
    curMonthly = 42;
    await env.world.poll();

    const snap = env.world.snapshot();
    expect(snap.sources).toHaveLength(1);
    expect(snap.sources[0]!.name).toBe('新名称');
    expect(snap.sources[0]!.monthly?.sampleCount).toBe(2);

    const historyTool = env.world.tools().find((t) => t.name === 'ocq_history')!;
    const out = await historyTool.handler({}, {} as never);
    expect(out).toContain('新名称：');
    expect(out).toContain('共 2 条记录');
    expect(env.world.webUi('zh').storage![0]!.stat!()).toBe('2 条记录');
    await env.world.stop();
  });

  it('无损衔接:同一把 Key 跨 0.2.x(无 keyId 旧名) / 0.3.0(旧指纹) / 0.3.1(删后重加与换网关) 均连续可读且绝不存明文', async () => {
    const rawKey = 'sk-opencode-continuity-secret-8899';
    const otherKey = 'sk-opencode-another-account-7766';
    const historyFile = join(root, 'opencode-quota-history.jsonl');
    const now = Date.now();
    const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
    const curMonthlyReset = new Date(now + 15 * 86_400_000).toISOString();
    const prevMonthlyReset = new Date(subtractOneMonth(Date.parse(curMonthlyReset))).toISOString();
    const otherMonthlyReset = new Date(now + 5 * 86_400_000).toISOString();

    // 0.3.0 旧指纹格式: sha256(root + '\0key:' + key).slice(0, 16)
    const v030KeyId = createHash('sha256')
      .update(`https://opencode.ai/inference\0key:${rawKey}`)
      .digest('hex')
      .slice(0, 16);

    // 预置混合历史文件:
    // 1) 0.2.4 无 keyId 上周期旧记录(同订阅锚点)
    // 2) 0.2.4 无 keyId 本周期旧记录(旧 Provider 名 opencode-glm,同订阅锚点)
    // 3) 0.2.4 另一个账号的无 keyId 记录(重置日不同,不应被串入)
    // 4) 0.3.0 带旧指纹的记录
    const seedLines = [
      { ts: daysAgo(25), endpoint: 'opencode-glm', rolling: 5, weekly: 10, monthly: 70, resets: { rolling: daysAgo(24), weekly: daysAgo(20), monthly: prevMonthlyReset } },
      { ts: daysAgo(6), endpoint: 'opencode-glm', rolling: 8, weekly: 22, monthly: 20, resets: { rolling: daysAgo(5), weekly: daysAgo(1), monthly: curMonthlyReset } },
      { ts: daysAgo(4), endpoint: 'opencode-other', rolling: 99, weekly: 99, monthly: 95, resets: { rolling: daysAgo(3), weekly: daysAgo(1), monthly: otherMonthlyReset } },
      { ts: daysAgo(2), endpoint: 'opencode-glm', keyId: v030KeyId, rolling: 12, weekly: 35, monthly: 38, resets: { rolling: daysAgo(1), weekly: curMonthlyReset, monthly: curMonthlyReset } },
    ];
    writeFileSync(historyFile, `${seedLines.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      if (auth.includes(otherKey)) {
        return new Response(JSON.stringify({
          usage: {
            rolling: { status: 'ok', percent: 50, resetsAt: new Date(now + 2 * 3_600_000).toISOString() },
            weekly: { status: 'ok', percent: 60, resetsAt: new Date(now + 2 * 86_400_000).toISOString() },
            monthly: { status: 'ok', percent: 96, resetsAt: otherMonthlyReset },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        usage: {
          rolling: { status: 'ok', percent: 15, resetsAt: new Date(now + 3 * 3_600_000).toISOString() },
          weekly: { status: 'ok', percent: 40, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
          monthly: { status: 'ok', percent: 52, resetsAt: curMonthlyReset },
        },
      }), { status: 200 });
    });

    // 用户升级到 0.3.1 后,以全新名称「我的主 Key」添加同一把 Key
    const env = createWorld();
    await env.world.start(new FakeHost());
    const snap1 = await env.world.webUi('zh').invoke!('quota', 'addKey', ['我的主 Key', rawKey]) as QuotaSnapshot;

    // 应自动找回:本周期 0.2.4(20%) + 0.3.0(38%) + 0.3.1 新实测(52%) = 3 条本周期样本,且绝不混入另一账号的 95%
    expect(snap1.sources[0]!.monthly?.sampleCount).toBe(3);
    expect(snap1.sources[0]!.monthly?.points.map((p) => p.used)).toEqual([20, 38, 52]);

    // ocq_history 35 天趋势应含上周期 0.2.4(70%) + 本周期 3 条 = 4 条,峰值 70% 而非另一账号的 95%
    const historyTool = env.world.tools().find((t) => t.name === 'ocq_history')!;
    const out1 = await historyTool.handler({ days: 35 }, {} as never);
    expect(out1).toContain('共 4 条记录');
    expect(out1).toContain('峰值(5h/周/月) 15%/40%/70%');

    // 再添加另一把账号 Key:两把 Key 各自认领自己的旧记录,互不串扰
    const snap2 = await env.world.webUi('zh').invoke!('quota', 'addKey', ['二号账号', otherKey]) as QuotaSnapshot;
    expect(snap2.sources).toHaveLength(2);
    expect(snap2.sources[0]!.monthly?.sampleCount).toBe(3);
    expect(snap2.sources[1]!.monthly?.sampleCount).toBe(2); // 0.2.4 的 95% + 刚刚读到的 96%

    // 移除「我的主 Key」,更换网关代理地址后以新名字「重加主 Key」重新填回同一把 Key:历史依旧 100% 连续
    await env.world.webUi('zh').invoke!('quota', 'removeKey', ['OPENCODE_QUOTA_KEY_1']);
    env.cfg.baseUrl = 'https://proxy.example.com/inference';
    const snap3 = await env.world.webUi('zh').invoke!('quota', 'addKey', ['重加主 Key', rawKey]) as QuotaSnapshot;
    const readded = snap3.sources.find((s) => s.name === '重加主 Key')!;
    expect(readded.monthly?.sampleCount).toBeGreaterThanOrEqual(2);
    expect(readded.monthly?.points.some((p) => p.used === 52)).toBe(true);

    // 确认历史文件里只写单向不可逆指纹,绝不含任何明文密钥
    const rawDisk = readFileSync(historyFile, 'utf8');
    expect(rawDisk).toContain(keyFingerprint(rawKey));
    expect(rawDisk).not.toContain(rawKey);
    expect(rawDisk).not.toContain(otherKey);
    await env.world.stop();
  });
});
