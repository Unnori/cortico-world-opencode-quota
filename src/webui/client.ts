/**
 * World 页的额度面板:三个窗口的进度条、重置倒计时与一次手动刷新。
 *
 * 数据面只有两个方法——`state` 读 World 已经轮询到的快照(不联网),`read` 让 World 立刻读一遍。
 * 面板自己不联网,所以打开页面不会产生请求;倒计时走本地时钟。
 */
import type { WebUiClientBundle, WebUiPanelContext, WebUiProgress } from 'cortico/web/shared/client-panel.ts';
import { QUOTA_PANEL, type QuotaSnapshot, type SourceSnapshot } from './protocol.ts';

type Window = 'rolling' | 'weekly' | 'monthly';

const WINDOWS: readonly Window[] = ['rolling', 'weekly', 'monthly'];

/** 进度条的满值。`ui.progress` 缺省满值是 1,不传就成了 2300%。 */
const FULL = 100;

interface PanelText {
  title: string;
  desc: string;
  refresh: string;
  reading: string;
  rolling: string;
  weekly: string;
  monthly: string;
  resetsIn(text: string): string;
  atLimit: string;
  readAt(time: string): string;
  notRead: string;
  autoEvery(minutes: number): string;
  alertAt(percent: number): string;
  unreadable(reason: string): string;
}

const zh: PanelText = {
  title: '订阅额度',
  desc: '每 5 小时、每周、每月三个窗口的用量与重置时间。',
  refresh: '立即刷新',
  reading: '正在读取…',
  rolling: '每 5 小时',
  weekly: '每周',
  monthly: '每月',
  resetsIn: (text) => `${text}后重置`,
  atLimit: '已达上限',
  readAt: (time) => `查询于 ${time}`,
  notRead: '还没读到数据。',
  autoEvery: (minutes) => `每 ${minutes} 分钟自动读取`,
  alertAt: (percent) => `告警线 ${percent}%`,
  unreadable: (reason) => `读不到:${reason}`,
};

const en: PanelText = {
  title: 'Subscription allowance',
  desc: 'Usage and reset times for the 5-hour, weekly and monthly windows.',
  refresh: 'Refresh now',
  reading: 'Reading…',
  rolling: 'Every 5 hours',
  weekly: 'Weekly',
  monthly: 'Monthly',
  resetsIn: (text) => `resets in ${text}`,
  atLimit: 'at the limit',
  readAt: (time) => `read at ${time}`,
  notRead: 'Nothing has been read yet.',
  autoEvery: (minutes) => `reads every ${minutes} min`,
  alertAt: (percent) => `alert at ${percent}%`,
  unreadable: (reason) => `unreadable: ${reason}`,
};

const text = (language: string): PanelText => (language === 'zh' || language === 'zh-Hant' ? zh : en);

const windowLabel = (S: PanelText, window: Window): string =>
  window === 'rolling' ? S.rolling : window === 'weekly' ? S.weekly : S.monthly;

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** 一条进度条与它对应的窗口:倒计时每秒只改标签。 */
interface Row {
  window: Window;
  progress: WebUiProgress;
  resetsAt: string;
  status: 'ok' | 'rate-limited';
}

export const quotaPanel = {
  mount(ctx: WebUiPanelContext): void {
    const S = text(ctx.language);
    const { ui } = ctx;
    let snapshot: QuotaSnapshot | null = null;
    let busy = false;
    let rows: Row[] = [];

    const sheet = ui.sheet({ title: S.title, desc: S.desc });
    ctx.root.append(sheet.el);

    const bar = ui.rowbar();
    const refresh = ui.button(S.refresh, { size: 'sm', variant: 'plain', onClick: () => void load('read') });
    const message = ui.msgline();
    bar.append(refresh, message);
    sheet.body.append(bar);

    const body = ui.h('div', 'quota-body');
    sheet.body.append(body);
    const foot = ui.h('div', 'quota-foot');
    sheet.body.append(foot);

    function paintLabels(): void {
      const now = Date.now();
      for (const row of rows) {
        const label = windowLabel(S, row.window);
        const left = Date.parse(row.resetsAt) - now;
        const state = row.status === 'rate-limited' ? S.atLimit : S.resetsIn(duration(Math.max(0, left)));
        row.progress.setLabel(`${label} · ${state}`);
      }
    }

    /** 一个来源的三条进度条;调用方决定放在哪儿。 */
    function paintSource(source: SourceSnapshot, into: HTMLElement, alertAt: number): void {
      if (source.error) {
        into.append(ui.placeholder(S.unreadable(source.error)));
        return;
      }
      if (!source.windows) {
        into.append(ui.placeholder(S.notRead));
        return;
      }
      for (const window of WINDOWS) {
        const state = source.windows[window];
        const progress = ui.progress({ value: state.percent, max: FULL, tone: state.percent >= alertAt ? 'warn' : 'accent' });
        progress.setValue(state.percent, FULL);
        into.append(progress.el);
        rows.push({ window, progress, resetsAt: state.resetsAt, status: state.status });
      }
    }

    function paintAll(): void {
      if (!snapshot) return;
      body.replaceChildren();
      rows = [];
      const sources = snapshot.sources;
      if (!sources.length) {
        body.append(ui.placeholder(S.notRead));
        foot.textContent = '';
        return;
      }
      for (const source of sources) {
        if (sources.length > 1) body.append(ui.section(source.name));
        paintSource(source, body, snapshot.alertAt);
      }
      paintLabels();
      const latest = sources
        .map((source) => source.readAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);
      foot.textContent = [
        latest ? S.readAt(new Date(latest).toLocaleTimeString()) : S.notRead,
        S.autoEvery(snapshot.pollMinutes),
        S.alertAt(snapshot.alertAt),
      ].join(' · ');
    }

    async function load(method: 'state' | 'read'): Promise<void> {
      if (busy) return;
      busy = true;
      if (method === 'read') message.textContent = S.reading;
      message.classList.remove('bad');
      try {
        snapshot = await ctx.invoke<QuotaSnapshot>(method);
        paintAll();
        message.textContent = '';
      } catch (error) {
        message.textContent = String(error);
        message.classList.add('bad');
      } finally {
        busy = false;
      }
    }

    void load('state');
    ctx.interval(() => void load('state'), 15_000);
    ctx.interval(paintLabels, 1_000);
  },
};

export default { panels: { [QUOTA_PANEL]: quotaPanel } } satisfies WebUiClientBundle;
