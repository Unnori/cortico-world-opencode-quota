/**
 * World 页的额度面板(纯中文):
 * - 按独立 Key 聚合展示每 5 小时、每周、每月三个窗口的实时额度与重置倒计时
 * - 顶部支持「剩余额度 / 已用额度」一键切换(同步更新进度条、月度趋势图与页头徽标)
 * - 内置基于本地历史记录的月度用量 / 剩余趋势折线图,虚线明确标明为预测值;
 *   支持鼠标滚轮缩放(以光标为锚点)、左键左右拖动平移、双击或按钮还原全景,放大后横轴自动细化到日/小时刻度;
 *   在「剩余额度」模式下,预测曲线跌破 0% 时立即停在预计耗尽日,后段留出空档直至订阅重置日
 */
import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { DisplayMode, Window } from '../config.ts';
import { QUOTA_PANEL, type ManagedKeyInfo, type MonthlySeries, type QuotaSnapshot, type SourceSnapshot } from './protocol.ts';

const WINDOWS: readonly Window[] = ['rolling', 'weekly', 'monthly'];
const CONFIG_GROUP_ID = 'world:opencode-quota';
const DISPLAY_MODE_KEY = 'worlds.opencode-quota.displayMode';
const SVG_NS = 'http://www.w3.org/2000/svg';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MIN_VIEW_SPAN_MS = 6 * HOUR_MS;
/** 首条本地采样晚于周期起点超过该时长时,前段以引导虚线估算连接。 */
const LEADIN_GAP_MS = 6 * HOUR_MS;

const VIEW_W = 680;
const VIEW_H = 176;
const PAD_L = 46;
const PAD_R = 56;
const PAD_T = 24;
const PAD_B = 14;
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = VIEW_H - PAD_T - PAD_B;

type Severity = 'ok' | 'mid' | 'warn' | 'limit';
type CardStatus = Severity | 'error' | 'idle';

function windowLabel(window: Window): string {
  return window === 'rolling' ? '每 5 小时' : window === 'weekly' ? '每周' : '每月';
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function formatPercent(value: number): string {
  const clean = Math.round(value * 10) / 10;
  return Number.isInteger(clean) ? String(clean) : String(clean);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatCnDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatShortMD(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatHM(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatMDHM(ms: number): string {
  return `${formatShortMD(ms)} ${formatHM(ms)}`;
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '不足 1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${pad2(minutes % 60)}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function severityOf(used: number, alertAt: number, status: 'ok' | 'rate-limited'): Severity {
  if (used >= 100 || status === 'rate-limited') return 'limit';
  if (used >= alertAt) return 'warn';
  if (used >= Math.min(alertAt, 50)) return 'mid';
  return 'ok';
}

function worstSeverity(severities: readonly Severity[]): Severity {
  const rank: Record<Severity, number> = { ok: 0, mid: 1, warn: 2, limit: 3 };
  let worst: Severity = 'ok';
  for (const s of severities) {
    if (rank[s] > rank[worst]) worst = s;
  }
  return worst;
}

function statusLabel(status: CardStatus): string {
  switch (status) {
    case 'ok': return '额度充足';
    case 'mid': return '已用过半';
    case 'warn': return '已过告警线';
    case 'limit': return '已达上限';
    case 'error': return '读取失败';
    case 'idle': return '等待读取';
  }
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  text?: string,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

function createIcon(paths: readonly string[], cls?: string): SVGSVGElement {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    ...(cls ? { class: cls } : {}),
  });
  for (const d of paths) svg.append(svgEl('path', { d }));
  return svg;
}

const refreshIcon = () => createIcon([
  'M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8',
  'M3 3v5h5',
  'M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16',
  'M16 16h5v5',
], 'ocq-refresh-ico');

const keyIcon = () => createIcon([
  'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
]);

const clockIcon = () => createIcon([
  'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  'M12 6v6l4 2',
]);

const alertIcon = () => createIcon([
  'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  'M12 8v4',
  'M12 16h.01',
]);

interface AxisTick {
  ts: number;
  ratio: number;
  label: string;
  cls: string;
  grid?: boolean;
}

/** 构造自适应横轴刻度:全景按周/日,放大后依次细化到逐日 → 12h/6h → 4h/2h/1h。 */
function buildAdaptiveTicks(
  viewStart: number,
  viewEnd: number,
  monthly: MonthlySeries,
  showRemaining: boolean,
  isZoomed: boolean,
): AxisTick[] {
  const viewSpan = Math.max(1, viewEnd - viewStart);
  const ratioOf = (ts: number) => (ts - viewStart) / viewSpan;
  const placed: AxisTick[] = [];

  const fits = (ratio: number, minDist: number, edgeMargin = 0.08): boolean =>
    ratio >= edgeMargin && ratio <= 1 - edgeMargin && placed.every((item) => Math.abs(item.ratio - ratio) >= minDist);

  // 未缩放的整月视图:保留清晰的起止日、预测触顶/耗尽日、今天与均衡中间日
  if (!isZoomed && viewSpan > 14 * DAY_MS) {
    placed.push(
      { ts: viewStart, ratio: 0, label: formatCnDate(viewStart), cls: 'ocq-axis-tick is-start' },
      { ts: viewEnd, ratio: 1, label: formatCnDate(viewEnd), cls: 'ocq-axis-tick is-end' },
    );
    if (monthly.projectedHitAt !== null) {
      const r = ratioOf(monthly.projectedHitAt);
      if (fits(r, 0.11, 0.11)) {
        placed.push({
          ts: monthly.projectedHitAt,
          ratio: r,
          label: formatCnDate(monthly.projectedHitAt),
          cls: `ocq-axis-tick is-hit${showRemaining ? ' is-danger' : ''}`,
        });
      }
    }
    const rNow = ratioOf(monthly.now);
    if (fits(rNow, 0.15, 0.12)) {
      placed.push({ ts: monthly.now, ratio: rNow, label: '今天', cls: 'ocq-axis-tick' });
    }
    const rightAnchor = monthly.projectedHitAt ?? monthly.now;
    const midRight = (rightAnchor + monthly.cycleEnd) / 2;
    if (fits(ratioOf(midRight), 0.16, 0.12)) {
      placed.push({ ts: midRight, ratio: ratioOf(midRight), label: formatCnDate(midRight), cls: 'ocq-axis-tick' });
    }
    const midLeft = (monthly.cycleStart + monthly.now) / 2;
    if (fits(ratioOf(midLeft), 0.16, 0.12)) {
      placed.push({ ts: midLeft, ratio: ratioOf(midLeft), label: formatCnDate(midLeft), cls: 'ocq-axis-tick' });
    }
    return placed;
  }

  // 缩放后的精细自适应刻度:先放入可视区内的预测耗尽/触顶日作为高亮锚点
  if (monthly.projectedHitAt !== null && monthly.projectedHitAt >= viewStart && monthly.projectedHitAt <= viewEnd) {
    const r = ratioOf(monthly.projectedHitAt);
    if (r >= 0.05 && r <= 0.95) {
      const hitLbl = viewSpan <= 4 * DAY_MS ? formatMDHM(monthly.projectedHitAt) : formatCnDate(monthly.projectedHitAt);
      placed.push({
        ts: monthly.projectedHitAt,
        ratio: r,
        label: hitLbl,
        cls: `ocq-axis-tick is-hit${showRemaining ? ' is-danger' : ''}`,
      });
    }
  }

  // 根据可视跨度选择对齐本地时钟的步长
  const candidates: Array<{ ts: number; isMidnight: boolean }> = [];
  if (viewSpan > 4 * DAY_MS) {
    const stepDays = viewSpan > 16 * DAY_MS ? 4 : viewSpan > 8 * DAY_MS ? 2 : 1;
    const cursor = new Date(viewStart);
    cursor.setHours(0, 0, 0, 0);
    if (cursor.getTime() < viewStart) cursor.setDate(cursor.getDate() + 1);
    while (cursor.getTime() <= viewEnd) {
      candidates.push({ ts: cursor.getTime(), isMidnight: true });
      cursor.setDate(cursor.getDate() + stepDays);
    }
  } else {
    const stepHours = viewSpan > 60 * HOUR_MS
      ? 12
      : viewSpan > 36 * HOUR_MS
        ? 6
        : viewSpan > 20 * HOUR_MS
          ? 4
          : viewSpan > 11 * HOUR_MS
            ? 2
            : 1;
    const cursor = new Date(viewStart);
    cursor.setMinutes(0, 0, 0);
    const alignedHour = Math.ceil(cursor.getHours() / stepHours) * stepHours;
    cursor.setHours(alignedHour, 0, 0, 0);
    if (cursor.getTime() < viewStart) cursor.setHours(cursor.getHours() + stepHours);
    while (cursor.getTime() <= viewEnd) {
      candidates.push({ ts: cursor.getTime(), isMidnight: cursor.getHours() === 0 });
      cursor.setHours(cursor.getHours() + stepHours);
    }
  }

  let shownDateOnce = false;
  const minGap = viewSpan <= 4 * DAY_MS ? 0.13 : 0.11;
  for (const item of candidates) {
    const r = ratioOf(item.ts);
    if (!fits(r, minGap, 0.04)) continue;
    let label: string;
    let cls = 'ocq-axis-tick';
    if (viewSpan > 4 * DAY_MS) {
      label = formatShortMD(item.ts);
    } else if (item.isMidnight) {
      label = `${formatShortMD(item.ts)} 00:00`;
      cls = 'ocq-axis-tick is-day';
      shownDateOnce = true;
    } else if (!shownDateOnce) {
      label = formatMDHM(item.ts);
      shownDateOnce = true;
    } else {
      label = formatHM(item.ts);
    }
    placed.push({ ts: item.ts, ratio: r, label, cls, grid: true });
  }

  // 若极端情况下可视刻度过少,补起止两端
  if (placed.length < 2) {
    const edgeFmt = viewSpan <= 4 * DAY_MS ? formatMDHM : formatShortMD;
    if (placed.every((p) => p.ratio > 0.16)) {
      placed.push({ ts: viewStart, ratio: 0, label: edgeFmt(viewStart), cls: 'ocq-axis-tick is-start' });
    }
    if (placed.every((p) => p.ratio < 0.84)) {
      placed.push({ ts: viewEnd, ratio: 1, label: edgeFmt(viewEnd), cls: 'ocq-axis-tick is-end' });
    }
  }

  return placed.sort((a, b) => a.ratio - b.ratio);
}

interface HoverEval {
  /** actual=本地实测; leadin=首条记录前的引导估算虚线; forecast=未来预测虚线; gap=剩余模式下跌破 0% 后的预测空档期 */
  kind: 'actual' | 'leadin' | 'forecast' | 'gap';
  used: number;
  rem: number;
  plotYVal: number;
}

/** 根据时间戳插值计算悬停处对应的实测 / 引导估算 / 预测 / 空档值。 */
function evalSeriesAt(ts: number, monthly: MonthlySeries, showRemaining: boolean): HoverEval | null {
  if (ts < monthly.cycleStart || ts > monthly.cycleEnd) return null;
  if (ts <= monthly.now) {
    const pts = monthly.points;
    let used = monthly.currentUsed;
    let kind: 'actual' | 'leadin' = 'actual';
    if (pts.length > 0) {
      if (ts < pts[0]!.ts) {
        const span = Math.max(1, pts[0]!.ts - monthly.cycleStart);
        const ratio = Math.max(0, Math.min(1, (ts - monthly.cycleStart) / span));
        used = pts[0]!.used * ratio;
        if (pts[0]!.ts - monthly.cycleStart > LEADIN_GAP_MS) {
          kind = 'leadin';
        }
      } else if (ts === pts[0]!.ts) {
        used = pts[0]!.used;
      } else {
        let found = false;
        for (let i = 1; i < pts.length; i += 1) {
          const a = pts[i - 1]!;
          const b = pts[i]!;
          if (ts <= b.ts) {
            const ratio = Math.max(0, Math.min(1, (ts - a.ts) / Math.max(1, b.ts - a.ts)));
            used = a.used + (b.used - a.used) * ratio;
            found = true;
            break;
          }
        }
        if (!found) used = pts[pts.length - 1]!.used;
      }
    }
    const cleanUsed = clampPercent(used);
    const cleanRem = clampPercent(100 - cleanUsed);
    return { kind, used: cleanUsed, rem: cleanRem, plotYVal: showRemaining ? cleanRem : cleanUsed };
  }

  // 预测区间 (ts > now)
  if (showRemaining && (monthly.currentUsed >= 100 || (monthly.projectedHitAt !== null && ts > monthly.projectedHitAt))) {
    return { kind: 'gap', used: 100, rem: 0, plotYVal: 0 };
  }
  if (monthly.projectedEndUsed === null) return null;
  const fcSpan = Math.max(1, monthly.cycleEnd - monthly.now);
  const ratio = Math.max(0, Math.min(1, (ts - monthly.now) / fcSpan));
  const used = Math.round((monthly.currentUsed + (monthly.projectedEndUsed - monthly.currentUsed) * ratio) * 10) / 10;
  const rem = Math.max(0, Math.round((100 - used) * 10) / 10);
  return { kind: 'forecast', used, rem, plotYVal: showRemaining ? rem : used };
}

interface Viewport {
  cycleStart: number;
  cycleEnd: number;
  start: number;
  end: number;
}

/** 交互式月度趋势折线图控制器:支持滚轮缩放、左键拖动平移、双击/按钮还原与悬停十字读数。 */
class TrendChartView {
  readonly el: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly subEl: HTMLDivElement;
  private readonly zoomResetBtn: HTMLButtonElement;
  private readonly chartWrap: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly hoverTip: HTMLDivElement;
  private readonly axisInner: HTMLDivElement;
  private readonly avgEl: HTMLDivElement;
  private readonly legendEl: HTMLDivElement;

  private monthly: MonthlySeries | null = null;
  private mode: DisplayMode = 'used';
  private cardIndex = 0;
  private viewport: Viewport | null = null;
  private hoverTs: number | null = null;
  private dragging = false;
  private dragPointerId = -1;
  private dragStartX = 0;
  private dragOriginStart = 0;
  private dragOriginEnd = 0;

  constructor(
    private readonly h: WebUiPanelContext['ui']['h'],
    signal: AbortSignal,
  ) {
    this.el = h('div', 'ocq-trend');
    this.el.hidden = true;

    const head = h('div', 'ocq-trend-head');
    const left = h('div', 'ocq-trend-left');
    const titleRow = h('div', 'ocq-trend-title-row');
    this.titleEl = h('div', 'ocq-trend-title');
    titleRow.append(this.titleEl);
    this.subEl = h('div', 'ocq-trend-sub');
    left.append(titleRow, this.subEl);

    const actions = h('div', 'ocq-trend-actions');
    this.zoomResetBtn = h('button', 'ocq-zoom-reset', '重置缩放');
    this.zoomResetBtn.type = 'button';
    this.zoomResetBtn.hidden = true;
    this.zoomResetBtn.addEventListener('click', () => this.resetZoom(), { signal });

    const note = h('span', 'ocq-trend-note');
    note.append(h('span', 'ocq-dash-sample'), h('span', '', '虚线为预测值'));
    actions.append(this.zoomResetBtn, note);
    head.append(left, actions);

    this.chartWrap = h('div', 'ocq-chart-wrap');
    this.svg = svgEl('svg', {
      class: 'ocq-chart-svg',
      viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
      role: 'img',
    });
    this.hoverTip = h('div', 'ocq-hover-tip');
    this.hoverTip.hidden = true;
    this.chartWrap.append(this.svg, this.hoverTip);

    const axis = h('div', 'ocq-chart-axis');
    this.axisInner = h('div');
    this.axisInner.style.position = 'absolute';
    this.axisInner.style.inset = `0 ${((PAD_R / VIEW_W) * 100).toFixed(2)}% 0 ${((PAD_L / VIEW_W) * 100).toFixed(2)}%`;
    axis.append(this.axisInner);

    const foot = h('div', 'ocq-chart-foot');
    this.avgEl = h('div', 'ocq-chart-avg');
    this.legendEl = h('div', 'ocq-chart-legend');
    foot.append(this.avgEl, this.legendEl);

    this.el.append(head, this.chartWrap, axis, foot);
    this.bindInteractions(signal);
  }

  private isZoomed(): boolean {
    if (!this.viewport) return false;
    const full = this.viewport.cycleEnd - this.viewport.cycleStart;
    const cur = this.viewport.end - this.viewport.start;
    return cur < full * 0.995;
  }

  private resetZoom(): void {
    if (!this.monthly) return;
    this.viewport = {
      cycleStart: this.monthly.cycleStart,
      cycleEnd: this.monthly.cycleEnd,
      start: this.monthly.cycleStart,
      end: this.monthly.cycleEnd,
    };
    this.hoverTs = null;
    this.render();
  }

  private pointerToRatio(clientX: number): number | null {
    const rect = this.chartWrap.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const svgX = ((clientX - rect.left) / rect.width) * VIEW_W;
    if (svgX < PAD_L - 6 || svgX > PAD_L + PLOT_W + 6) return null;
    return Math.max(0, Math.min(1, (svgX - PAD_L) / PLOT_W));
  }

  private bindInteractions(signal: AbortSignal): void {
    // 鼠标滚轮缩放(以光标位置为锚点);在 100% 全景且向下滚时不拦截页面滚动
    this.chartWrap.addEventListener('wheel', (ev) => {
      if (!this.monthly || !this.viewport) return;
      const zoomingOut = ev.deltaY > 0;
      if (zoomingOut && !this.isZoomed()) return;
      ev.preventDefault();

      const ratio = this.pointerToRatio(ev.clientX) ?? 0.5;
      const fullSpan = Math.max(1, this.viewport.cycleEnd - this.viewport.cycleStart);
      const curSpan = Math.max(1, this.viewport.end - this.viewport.start);
      const anchorTs = this.viewport.start + ratio * curSpan;
      const factor = ev.deltaY < 0 ? 0.78 : 1 / 0.78;
      const minSpan = Math.min(fullSpan, MIN_VIEW_SPAN_MS);
      const nextSpan = Math.max(minSpan, Math.min(fullSpan, curSpan * factor));

      if (nextSpan >= fullSpan * 0.995) {
        this.viewport.start = this.viewport.cycleStart;
        this.viewport.end = this.viewport.cycleEnd;
      } else {
        let nextStart = anchorTs - ratio * nextSpan;
        let nextEnd = nextStart + nextSpan;
        if (nextStart < this.viewport.cycleStart) {
          nextStart = this.viewport.cycleStart;
          nextEnd = nextStart + nextSpan;
        }
        if (nextEnd > this.viewport.cycleEnd) {
          nextEnd = this.viewport.cycleEnd;
          nextStart = nextEnd - nextSpan;
        }
        this.viewport.start = nextStart;
        this.viewport.end = nextEnd;
      }
      this.hoverTs = this.viewport.start + ratio * (this.viewport.end - this.viewport.start);
      this.render();
    }, { passive: false, signal });

    // 左键按下拖动平移(放大后可用;移动超过 2px 再进入拖动状态,避免吞掉双击还原)
    this.chartWrap.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || !this.viewport || !this.isZoomed()) return;
      ev.preventDefault();
      this.dragging = false;
      this.dragPointerId = ev.pointerId;
      this.dragStartX = ev.clientX;
      this.dragOriginStart = this.viewport.start;
      this.dragOriginEnd = this.viewport.end;
    }, { signal });

    this.chartWrap.addEventListener('pointermove', (ev) => {
      if (!this.monthly || !this.viewport) return;
      if (this.dragPointerId !== -1 && ev.pointerId === this.dragPointerId) {
        if (!this.dragging) {
          if (Math.abs(ev.clientX - this.dragStartX) < 2) return;
          this.dragging = true;
          this.hoverTs = null;
          this.chartWrap.classList.add('is-grabbing');
          try { this.chartWrap.setPointerCapture(ev.pointerId); } catch { /* 某些测试环境无 pointer capture */ }
        }
        const rect = this.chartWrap.getBoundingClientRect();
        const plotPx = rect.width * (PLOT_W / VIEW_W);
        if (plotPx <= 0) return;
        const span = this.dragOriginEnd - this.dragOriginStart;
        const dt = -((ev.clientX - this.dragStartX) / plotPx) * span;
        let nextStart = this.dragOriginStart + dt;
        let nextEnd = this.dragOriginEnd + dt;
        if (nextStart < this.viewport.cycleStart) {
          nextStart = this.viewport.cycleStart;
          nextEnd = nextStart + span;
        }
        if (nextEnd > this.viewport.cycleEnd) {
          nextEnd = this.viewport.cycleEnd;
          nextStart = nextEnd - span;
        }
        this.viewport.start = nextStart;
        this.viewport.end = nextEnd;
        this.render();
        return;
      }
      const ratio = this.pointerToRatio(ev.clientX);
      if (ratio === null) {
        if (this.hoverTs !== null) {
          this.hoverTs = null;
          this.render();
        }
        return;
      }
      this.hoverTs = this.viewport.start + ratio * (this.viewport.end - this.viewport.start);
      this.render();
    }, { signal });

    const endDrag = (ev: PointerEvent) => {
      if (this.dragPointerId === -1 || ev.pointerId !== this.dragPointerId) return;
      const wasDragging = this.dragging;
      this.dragging = false;
      this.dragPointerId = -1;
      if (wasDragging) {
        this.chartWrap.classList.remove('is-grabbing');
        try { this.chartWrap.releasePointerCapture(ev.pointerId); } catch { /* 忽略 */ }
      }
    };
    window.addEventListener('pointerup', endDrag, { signal });
    window.addEventListener('pointercancel', endDrag, { signal });

    this.chartWrap.addEventListener('pointerleave', () => {
      if (this.dragging) return;
      if (this.hoverTs !== null) {
        this.hoverTs = null;
        this.render();
      }
    }, { signal });

    // 双击一键还原全景
    this.chartWrap.addEventListener('dblclick', () => {
      if (this.isZoomed()) this.resetZoom();
    }, { signal });
  }

  update(monthly: MonthlySeries | null, mode: DisplayMode, cardIndex: number): void {
    this.monthly = monthly;
    this.mode = mode;
    this.cardIndex = cardIndex;
    if (!monthly) {
      this.el.hidden = true;
      this.viewport = null;
      return;
    }
    this.el.hidden = false;
    // 同一计费周期内保留用户当前的缩放/平移视口,换新周期才重置
    if (!this.viewport || this.viewport.cycleStart !== monthly.cycleStart || this.viewport.cycleEnd !== monthly.cycleEnd) {
      this.viewport = {
        cycleStart: monthly.cycleStart,
        cycleEnd: monthly.cycleEnd,
        start: monthly.cycleStart,
        end: monthly.cycleEnd,
      };
    }
    this.render();
  }

  private render(): void {
    const monthly = this.monthly;
    const viewport = this.viewport;
    if (!monthly || !viewport) return;

    const h = this.h;
    const showRemaining = this.mode === 'remaining';
    const zoomed = this.isZoomed();
    const viewStart = viewport.start;
    const viewEnd = viewport.end;
    const viewSpan = Math.max(1, viewEnd - viewStart);

    const currentUsed = clampPercent(monthly.currentUsed);
    const currentRem = clampPercent(100 - currentUsed);
    const startStr = formatCnDate(monthly.cycleStart);
    const endStr = formatCnDate(monthly.cycleEnd);

    // 1. 头部文字 + 缩放重置按钮
    this.titleEl.textContent = showRemaining
      ? `本月剩余 ${formatPercent(currentRem)}%`
      : `本月已用 ${formatPercent(currentUsed)}%`;

    this.subEl.replaceChildren(h('span', '', `周期 ${startStr} – ${endStr} · ${endStr} 重置`));
    let paceText = '';
    let paceTone = '';
    if (currentUsed >= 100) {
      paceText = '· 本月额度已用尽';
      paceTone = ' is-danger';
    } else if (monthly.projectedHitAt !== null) {
      const hitDate = formatCnDate(monthly.projectedHitAt);
      paceText = showRemaining
        ? `· 按当前速度，预计 ${hitDate} 耗尽（跌破 0%）`
        : `· 按当前速度，预计 ${hitDate} 触顶（达 100%）`;
      paceTone = showRemaining ? ' is-danger' : '';
    } else if (monthly.dailyRate > 0 && monthly.projectedEndUsed !== null) {
      const endRem = Math.max(0, Math.round((100 - monthly.projectedEndUsed) * 10) / 10);
      paceText = showRemaining
        ? `· 按当前速度，周期末预计剩余 ${formatPercent(endRem)}%`
        : `· 按当前速度，周期末预计已用 ${formatPercent(monthly.projectedEndUsed)}%`;
      paceTone = ' is-ok';
    } else {
      paceText = '· 本周期暂无明显消耗，产生用量后自动预测';
      paceTone = ' is-ok';
    }
    this.subEl.append(h('span', `ocq-trend-pace${paceTone}`, paceText));

    this.chartWrap.classList.toggle('is-zoomed', zoomed);
    if (zoomed) {
      const rangeFmt = viewSpan <= 4 * DAY_MS ? formatMDHM : formatShortMD;
      this.zoomResetBtn.textContent = `${rangeFmt(viewStart)} – ${rangeFmt(viewEnd)} · 重置缩放`;
      this.zoomResetBtn.hidden = false;
    } else {
      this.zoomResetBtn.hidden = true;
    }

    // 2. 构建自适应横轴刻度(先算刻度,方便在缩放时同步画精细竖向网格线)
    const ticks = buildAdaptiveTicks(viewStart, viewEnd, monthly, showRemaining, zoomed);

    // 3. 坐标映射
    const xOf = (ts: number): number => PAD_L + ((ts - viewStart) / viewSpan) * PLOT_W;
    const inPlotX = (x: number): boolean => x >= PAD_L - 2 && x <= PAD_L + PLOT_W + 2;

    const endUsedVal = monthly.projectedEndUsed ?? currentUsed;
    let yMax = 100;
    let yTicks: number[] = [0, 50, 100];
    if (!showRemaining && endUsedVal > 100) {
      if (endUsedVal <= 170) {
        yMax = 200;
        yTicks = [0, 100, 200];
      } else if (endUsedVal <= 270) {
        yMax = 300;
        yTicks = [0, 100, 200, 300];
      } else {
        yMax = Math.ceil((endUsedVal + 30) / 100) * 100;
        yTicks = [0, 100, Math.round(yMax / 2), yMax];
      }
    }
    const yOf = (val: number): number => PAD_T + (1 - Math.max(0, Math.min(yMax, val)) / yMax) * PLOT_H;

    // 4. 重绘 SVG
    const svg = this.svg;
    svg.replaceChildren();
    svg.setAttribute('aria-label', showRemaining ? '本月剩余额度趋势与预测折线图' : '本月已用额度趋势与预测折线图');

    const uid = `ocq-c${this.cardIndex}-${showRemaining ? 'r' : 'u'}`;
    const defs = svgEl('defs');

    const clipPath = svgEl('clipPath', { id: `${uid}-clip` });
    clipPath.append(svgEl('rect', { x: PAD_L, y: PAD_T - 8, width: PLOT_W, height: PLOT_H + 16 }));
    defs.append(clipPath);

    const actualGrad = svgEl('linearGradient', { id: `${uid}-act`, x1: '0', y1: '0', x2: '0', y2: '1' });
    actualGrad.append(
      svgEl('stop', { offset: '0%', 'stop-color': 'var(--ok)', 'stop-opacity': '0.22' }),
      svgEl('stop', { offset: '100%', 'stop-color': 'var(--ok)', 'stop-opacity': '0.01' }),
    );
    defs.append(actualGrad);

    const forecastGrad = svgEl('linearGradient', { id: `${uid}-fc`, x1: '0', y1: '0', x2: '0', y2: '1' });
    forecastGrad.append(
      svgEl('stop', { offset: '0%', 'stop-color': 'var(--warn)', 'stop-opacity': '0.18' }),
      svgEl('stop', { offset: '100%', 'stop-color': 'var(--warn)', 'stop-opacity': '0.02' }),
    );
    defs.append(forecastGrad);

    const hatch = svgEl('pattern', {
      id: `${uid}-hatch`,
      width: '8',
      height: '8',
      patternUnits: 'userSpaceOnUse',
      patternTransform: 'rotate(45)',
    });
    hatch.append(svgEl('line', {
      x1: '0', y1: '0', x2: '0', y2: '8',
      stroke: 'var(--warn)', 'stroke-opacity': '0.12', 'stroke-width': '1.5',
    }));
    defs.append(hatch);
    svg.append(defs);

    // 水平网格线与 Y 轴刻度
    const yZero = yOf(0);
    for (const tick of yTicks) {
      const y = yOf(tick);
      const isRefLimit = showRemaining ? tick === 0 : tick === 100;
      svg.append(svgEl('line', {
        x1: PAD_L,
        y1: y,
        x2: PAD_L + PLOT_W,
        y2: y,
        class: isRefLimit
          ? `ocq-chart-limit-line${showRemaining && (monthly.projectedHitAt !== null || currentUsed >= 100) ? ' is-zero-hit' : ''}`
          : 'ocq-chart-grid',
      }));
      svg.append(svgEl('text', {
        x: PAD_L - 8,
        y: y + 3.5,
        'text-anchor': 'end',
        class: 'ocq-chart-ylabel',
      }, `${tick}%`));
    }

    // 缩放时的细腻竖向时间网格线
    if (zoomed) {
      for (const tick of ticks) {
        if (!tick.grid) continue;
        const x = PAD_L + tick.ratio * PLOT_W;
        svg.append(svgEl('line', { x1: x, y1: PAD_T, x2: x, y2: yZero, class: 'ocq-chart-vgrid' }));
      }
    }

    // 裁剪后的绘图区(防止缩放/平移时折线溢出 Y 轴或右边界)
    const plotG = svgEl('g', { 'clip-path': `url(#${uid}-clip)` });

    const xNow = xOf(monthly.now);
    if (inPlotX(xNow)) {
      plotG.append(svgEl('line', { x1: xNow, y1: PAD_T, x2: xNow, y2: yZero, class: 'ocq-chart-vguide' }));
    }

    const xHit = monthly.projectedHitAt !== null ? xOf(monthly.projectedHitAt) : null;
    if (xHit !== null && inPlotX(xHit)) {
      plotG.append(svgEl('line', { x1: xHit, y1: PAD_T, x2: xHit, y2: yZero, class: 'ocq-chart-vguide is-hit' }));
    }

    const valOf = (used: number) => (showRemaining ? clampPercent(100 - used) : clampPercent(used));
    const startVal = showRemaining ? 100 : 0;
    const pts = monthly.points.map((p) => ({ ts: p.ts, x: xOf(p.ts), y: yOf(valOf(p.used)), used: p.used }));
    const xStart = xOf(monthly.cycleStart);
    const yStart = yOf(startVal);
    const xEnd = xOf(monthly.cycleEnd);

    if (pts.length > 0 && pts[0]!.ts - monthly.cycleStart > LEADIN_GAP_MS) {
      plotG.append(svgEl('line', {
        x1: xStart, y1: yStart, x2: pts[0]!.x, y2: pts[0]!.y,
        class: 'ocq-chart-leadin',
      }));
    }

    if (pts.length >= 2) {
      const polyPts = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const areaD = `M ${pts[0]!.x.toFixed(1)} ${yZero.toFixed(1)} `
        + pts.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
        + ` L ${pts[pts.length - 1]!.x.toFixed(1)} ${yZero.toFixed(1)} Z`;
      plotG.append(svgEl('path', { d: areaD, fill: `url(#${uid}-act)` }));
      plotG.append(svgEl('polyline', { points: polyPts, class: 'ocq-chart-actual' }));
    } else if (pts.length === 1) {
      const areaD = `M ${xStart.toFixed(1)} ${yZero.toFixed(1)} L ${xStart.toFixed(1)} ${yStart.toFixed(1)} L ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)} L ${pts[0]!.x.toFixed(1)} ${yZero.toFixed(1)} Z`;
      plotG.append(svgEl('path', { d: areaD, fill: `url(#${uid}-act)`, opacity: '0.55' }));
    }

    const yNow = yOf(valOf(currentUsed));
    // 标注层放在 clip 之外(但只画锚点处于可见区内的文字),避免文字被顶部/边缘硬裁
    const labelG = svgEl('g');

    if (showRemaining) {
      if (currentUsed >= 100) {
        const gapStart = Math.max(PAD_L, xNow);
        const gapEnd = Math.min(PAD_L + PLOT_W, xEnd);
        const gapW = Math.max(0, gapEnd - gapStart);
        if (gapW > 2) {
          plotG.append(svgEl('rect', { x: gapStart, y: yZero - 5, width: gapW, height: 5, class: 'ocq-chart-gap-band' }));
          if (gapW >= 120) {
            const gapDays = Math.max(1, Math.ceil((monthly.cycleEnd - monthly.now) / DAY_MS));
            labelG.append(svgEl('text', {
              x: gapStart + gapW / 2,
              y: yZero - 12,
              'text-anchor': 'middle',
              class: 'ocq-chart-gap-label',
            }, `空档约 ${gapDays} 天 · 至 ${endStr} 重置`));
          }
        }
        if (inPlotX(xNow)) {
          const labelX = Math.max(PAD_L + 30, Math.min(PAD_L + PLOT_W - 30, xNow));
          labelG.append(svgEl('text', {
            x: labelX, y: yZero - 14, 'text-anchor': 'middle', class: 'ocq-chart-callout is-danger',
          }, '已耗尽 0%'));
        }
      } else if (xHit !== null && monthly.projectedHitAt !== null) {
        const fcArea = `M ${xNow.toFixed(1)} ${yZero.toFixed(1)} L ${xNow.toFixed(1)} ${yNow.toFixed(1)} L ${xHit.toFixed(1)} ${yZero.toFixed(1)} Z`;
        plotG.append(svgEl('path', { d: fcArea, fill: `url(#${uid}-fc)` }));
        plotG.append(svgEl('path', { d: fcArea, fill: `url(#${uid}-hatch)` }));
        plotG.append(svgEl('line', {
          x1: xNow, y1: yNow, x2: xHit, y2: yZero,
          class: 'ocq-chart-forecast',
        }));

        const gapStart = Math.max(PAD_L, xHit);
        const gapEnd = Math.min(PAD_L + PLOT_W, xEnd);
        const gapW = Math.max(0, gapEnd - gapStart);
        if (gapW > 2) {
          plotG.append(svgEl('rect', { x: gapStart, y: yZero - 5, width: gapW, height: 5, class: 'ocq-chart-gap-band' }));
          if (gapW >= 120) {
            const gapDays = Math.max(1, Math.round((monthly.cycleEnd - monthly.projectedHitAt) / DAY_MS));
            labelG.append(svgEl('text', {
              x: gapStart + gapW / 2,
              y: yZero - 12,
              'text-anchor': 'middle',
              class: 'ocq-chart-gap-label',
            }, `空档约 ${gapDays} 天 · 至 ${endStr} 重置`));
          }
        }

        if (inPlotX(xHit)) {
          plotG.append(svgEl('circle', { cx: xHit, cy: yZero, r: 4.5, class: 'ocq-chart-dot-hit is-danger' }));
          const hasRightRoom = PAD_L + PLOT_W - xHit >= 110;
          const calloutX = hasRightRoom ? xHit + 8 : Math.max(PAD_L + 60, xHit - 8);
          const calloutY = Math.max(PAD_T + 14, Math.min(yZero - 38, yNow - 10));
          labelG.append(svgEl('text', {
            x: calloutX,
            y: calloutY,
            'text-anchor': hasRightRoom ? 'start' : 'end',
            class: 'ocq-chart-callout is-danger',
          }, `预计 ${formatCnDate(monthly.projectedHitAt)} 耗尽`));
        }
      } else if (monthly.projectedEndUsed !== null) {
        const remEnd = Math.max(0, Math.round((100 - monthly.projectedEndUsed) * 10) / 10);
        const yEnd = yOf(remEnd);
        const fcArea = `M ${xNow.toFixed(1)} ${yZero.toFixed(1)} L ${xNow.toFixed(1)} ${yNow.toFixed(1)} L ${xEnd.toFixed(1)} ${yEnd.toFixed(1)} L ${xEnd.toFixed(1)} ${yZero.toFixed(1)} Z`;
        plotG.append(svgEl('path', { d: fcArea, fill: `url(#${uid}-fc)` }));
        plotG.append(svgEl('line', {
          x1: xNow, y1: yNow, x2: xEnd, y2: yEnd,
          class: 'ocq-chart-forecast',
        }));
        if (inPlotX(xEnd)) {
          plotG.append(svgEl('circle', { cx: xEnd, cy: yEnd, r: 4, class: 'ocq-chart-dot-end' }));
          labelG.append(svgEl('text', {
            x: xEnd,
            y: Math.max(PAD_T + 10, yEnd - 17),
            'text-anchor': 'end',
            class: 'ocq-chart-callout',
          }, `预计剩 ${formatPercent(remEnd)}%`));
        }
      }
    } else if (monthly.projectedEndUsed !== null) {
      const yEnd = yOf(endUsedVal);
      const fcArea = `M ${xNow.toFixed(1)} ${yZero.toFixed(1)} L ${xNow.toFixed(1)} ${yNow.toFixed(1)} L ${xEnd.toFixed(1)} ${yEnd.toFixed(1)} L ${xEnd.toFixed(1)} ${yZero.toFixed(1)} Z`;
      plotG.append(svgEl('path', { d: fcArea, fill: `url(#${uid}-fc)` }));
      plotG.append(svgEl('path', { d: fcArea, fill: `url(#${uid}-hatch)` }));
      plotG.append(svgEl('line', {
        x1: xNow, y1: yNow, x2: xEnd, y2: yEnd,
        class: 'ocq-chart-forecast',
      }));
      if (xHit !== null && monthly.projectedHitAt !== null && inPlotX(xHit)) {
        const yLimit = yOf(100);
        plotG.append(svgEl('circle', { cx: xHit, cy: yLimit, r: 4.5, class: 'ocq-chart-dot-hit' }));
        const hitLabelX = Math.max(PAD_L + 44, Math.min(PAD_L + PLOT_W - 64, xHit));
        labelG.append(svgEl('text', {
          x: hitLabelX,
          y: yLimit - 11,
          'text-anchor': 'middle',
          class: 'ocq-chart-callout',
        }, `预计 ${formatCnDate(monthly.projectedHitAt)} 触顶`));
      }
      if (inPlotX(xEnd)) {
        plotG.append(svgEl('circle', { cx: xEnd, cy: yEnd, r: 4, class: 'ocq-chart-dot-end' }));
        labelG.append(svgEl('text', {
          x: xEnd + 4,
          y: Math.max(PAD_T + 10, yEnd - 10),
          'text-anchor': 'end',
          class: 'ocq-chart-callout',
        }, `预计 ${formatPercent(endUsedVal)}%`));
      }
    }

    if (inPlotX(xNow)) {
      plotG.append(svgEl('circle', { cx: xNow, cy: yNow, r: 4.5, class: 'ocq-chart-dot-actual' }));
    }

    // 悬停十字准线与悬浮读数提示
    if (this.hoverTs !== null && !this.dragging) {
      const hx = xOf(this.hoverTs);
      const info = evalSeriesAt(this.hoverTs, monthly, showRemaining);
      if (info && inPlotX(hx)) {
        const hy = yOf(info.plotYVal);
        const isEstimated = info.kind !== 'actual';
        plotG.append(svgEl('line', { x1: hx, y1: PAD_T, x2: hx, y2: yZero, class: 'ocq-chart-hover-line' }));
        plotG.append(svgEl('circle', {
          cx: hx,
          cy: hy,
          r: isEstimated ? 5 : 4,
          class: `ocq-chart-hover-dot is-${info.kind}${isEstimated ? ' is-dashed' : ''}`,
        }));

        const tsText = formatMDHM(this.hoverTs);
        if (info.kind === 'gap') {
          this.hoverTip.textContent = `${tsText} · 预测空档期（预计已耗尽 0% · 预测值非实测）`;
        } else if (isEstimated) {
          this.hoverTip.textContent = showRemaining
            ? `${tsText} · 预测剩余 ${formatPercent(info.rem)}%（已用 ${formatPercent(info.used)}% · 预测值非实测）`
            : `${tsText} · 预测已用 ${formatPercent(info.used)}%（剩 ${formatPercent(info.rem)}% · 预测值非实测）`;
        } else {
          this.hoverTip.textContent = showRemaining
            ? `${tsText} · 实际剩余 ${formatPercent(info.rem)}%（已用 ${formatPercent(info.used)}%）`
            : `${tsText} · 实际已用 ${formatPercent(info.used)}%（剩 ${formatPercent(info.rem)}%）`;
        }
        this.hoverTip.className = isEstimated ? `ocq-hover-tip is-estimate is-${info.kind}` : 'ocq-hover-tip';
        this.hoverTip.hidden = false;
        const pctX = (hx / VIEW_W) * 100;
        if (pctX > 56) {
          this.hoverTip.style.left = 'auto';
          this.hoverTip.style.right = `${Math.max(1, 100 - pctX + 1.5).toFixed(2)}%`;
        } else {
          this.hoverTip.style.right = 'auto';
          this.hoverTip.style.left = `${Math.max(1, pctX + 1.5).toFixed(2)}%`;
        }
      } else {
        this.hoverTip.hidden = true;
      }
    } else {
      this.hoverTip.hidden = true;
    }

    svg.append(plotG, labelG);

    // 5. 更新底部时间轴胶囊条
    this.axisInner.replaceChildren();
    for (const tick of ticks) {
      const el = h('span', tick.cls, tick.label);
      el.style.left = `${(tick.ratio * 100).toFixed(2)}%`;
      this.axisInner.append(el);
    }

    // 6. 更新底栏速率与图例
    this.avgEl.replaceChildren(
      h('span', '', '日均消耗'),
      h('strong', '', `${formatPercent(monthly.dailyRate)}%`),
      h('span', '', monthly.sampleCount >= 2 ? `（基于本地 ${monthly.sampleCount} 条记录）` : '（按本周期已用估算）'),
      h('span', 'ocq-zoom-hint', zoomed ? '· 左键拖动 / 双击还原' : '· 滚轮缩放'),
    );

    this.legendEl.replaceChildren();
    const addLegend = (cls: string, label: string) => {
      const item = h('span', 'ocq-legend-item');
      item.append(h('span', `ocq-legend-swatch${cls ? ` ${cls}` : ''}`), h('span', '', label));
      this.legendEl.append(item);
    };
    addLegend('', showRemaining ? '实际余量' : '实际用量');
    addLegend('is-forecast', '预测趋势（虚线）');
    addLegend('is-limit', showRemaining ? '0% 耗尽线' : '月度上限 100%');
  }
}

interface TileRefs {
  window: Window;
  el: HTMLDivElement;
  badge: HTMLSpanElement;
  valNum: HTMLSpanElement;
  sub: HTMLSpanElement;
  track: HTMLDivElement;
  fill: HTMLDivElement;
  mark: HTMLDivElement;
  foot: HTMLDivElement;
  resetText: HTMLSpanElement;
  resetsAt: string;
  status: 'ok' | 'rate-limited';
}

interface CardRefs {
  el: HTMLDivElement;
  statusPill: HTMLSpanElement;
  statusText: HTMLSpanElement;
  timeEl: HTMLSpanElement;
  staleBanner: HTMLDivElement | null;
  staleText: HTMLSpanElement | null;
  errorText: HTMLSpanElement | null;
  tiles: TileRefs[];
  trend: TrendChartView | null;
}

function structureSignature(sources: readonly SourceSnapshot[]): string {
  return sources.map((source) => [
    source.name,
    source.labels.join(','),
    source.keyHint ?? '',
    source.windows ? 'ok' : source.error ? 'err' : 'wait',
  ].join('|')).join('||');
}

function keysSignature(keys: readonly ManagedKeyInfo[]): string {
  return keys.map((k) => `${k.secret}|${k.label}|${k.keyHint ?? ''}|${k.envDefault ? '1' : '0'}`).join('||');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const quotaPanel = {
  mount(ctx: WebUiPanelContext): void {
    const { ui } = ctx;
    let snapshot: QuotaSnapshot | null = null;
    let displayMode: DisplayMode = ctx.memo.get<string>('displayMode', 'used') === 'remaining' ? 'remaining' : 'used';
    let busy = false;
    let keySaving = false;
    let modeEpoch = 0;
    let renderedSig = '';
    let renderedKeysSig = '';
    let renderedCards: CardRefs[] = [];
    let keysPanelOpen = false;
    let keysOpenTouched = false;
    let editingSecret: string | null = null;

    const root = ui.h('div', 'ocq-root');
    ctx.root.append(root);

    // 顶部栏:标题 + 去重/多 Key 提示 + 显示模式切换 + 密钥管理 + 立即刷新
    const toolbar = ui.h('div', 'ocq-toolbar');
    const head = ui.h('div', 'ocq-head');
    const titleRow = ui.h('div', 'ocq-title-row');
    const title = ui.h('h3', 'ocq-title', '订阅额度');
    const headBadge = ui.h('span', 'ocq-head-badge');
    headBadge.hidden = true;
    titleRow.append(title, headBadge);
    const subtitle = ui.h('p', 'ocq-subtitle', '每 5 小时、每周、每月三个窗口的实时额度、重置倒计时与月度趋势预测。');
    head.append(titleRow, subtitle);

    const controls = ui.h('div', 'ocq-controls');
    const modeSwitch = ui.segmented(
      [
        { value: 'remaining', label: '剩余额度' },
        { value: 'used', label: '已用额度' },
      ],
      {
        value: displayMode,
        size: 'sm',
        onSelect: (value) => void switchDisplayMode(value === 'remaining' ? 'remaining' : 'used'),
      },
    );

    const keysToggleBtn = ui.h('button', 'ocq-keys-btn');
    keysToggleBtn.type = 'button';
    const keysToggleLbl = ui.h('span', '', '管理密钥');
    keysToggleBtn.append(keyIcon(), keysToggleLbl);
    keysToggleBtn.addEventListener('click', () => {
      keysOpenTouched = true;
      keysPanelOpen = !keysPanelOpen;
      if (!keysPanelOpen) editingSecret = null;
      syncKeysVisibility();
    }, { signal: ctx.signal });

    const refreshBtn = ui.h('button', 'ocq-refresh');
    refreshBtn.type = 'button';
    const refreshLbl = ui.h('span', '', '立即刷新');
    refreshBtn.append(refreshIcon(), refreshLbl);
    refreshBtn.addEventListener('click', () => void load('read'), { signal: ctx.signal });

    controls.append(modeSwitch.el, keysToggleBtn, refreshBtn);
    toolbar.append(head, controls);

    // 密钥管理卡片(支持新增、改名、更换、移除;实际密钥由框架写入本部署 .env,页面只显示脱敏尾标)
    const keysPanel = ui.h('section', 'ocq-keys-panel');
    keysPanel.hidden = true;

    const keysHead = ui.h('div', 'ocq-keys-head');
    const keysTitleWrap = ui.h('div', 'ocq-keys-title-wrap');
    keysTitleWrap.append(
      ui.h('div', 'ocq-keys-title', 'OpenCode Go 密钥管理'),
      ui.h('div', 'ocq-keys-desc', '密钥由 Cortico 框架隔离保存于本部署 .env（仅本人可读），不写入 config.json；页面只展示脱敏尾标。'),
    );
    const keysCloseBtn = ui.h('button', 'ocq-keys-close', '收起');
    keysCloseBtn.type = 'button';
    keysCloseBtn.addEventListener('click', () => {
      keysOpenTouched = true;
      keysPanelOpen = false;
      editingSecret = null;
      syncKeysVisibility();
    }, { signal: ctx.signal });
    keysHead.append(keysTitleWrap, keysCloseBtn);

    const keyListBox = ui.h('div', 'ocq-key-list');
    keyListBox.hidden = true;

    const addForm = ui.h('form', 'ocq-key-form');
    const addLabelInput = ui.h('input', 'ocq-input ocq-input-name');
    addLabelInput.type = 'text';
    addLabelInput.maxLength = 40;
    addLabelInput.placeholder = '名称（可选，如 主力 Key）';
    addLabelInput.autocomplete = 'off';

    const addKeyInput = ui.h('input', 'ocq-input ocq-input-secret');
    addKeyInput.type = 'password';
    addKeyInput.placeholder = '粘贴 OpenCode Go API Key';
    addKeyInput.autocomplete = 'new-password';
    addKeyInput.spellcheck = false;

    const addSubmitBtn = ui.h('button', 'ocq-btn-primary', '添加并查询');
    addSubmitBtn.type = 'submit';

    addForm.append(addLabelInput, addKeyInput, addSubmitBtn);
    addForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void handleAddKey();
    }, { signal: ctx.signal });

    const keyMsg = ui.msgline();
    keysPanel.append(keysHead, keyListBox, addForm, keyMsg);

    const message = ui.msgline();
    const cardsBox = ui.h('div', 'ocq-cards');
    const footer = ui.h('div', 'ocq-footer');

    root.append(toolbar, keysPanel, message, cardsBox, footer);

    function showToast(text: string, tone?: 'ok' | 'bad'): void {
      if (typeof ui.toast === 'function') ui.toast(text, tone);
    }

    function setKeyNotice(text: string, bad = false): void {
      keyMsg.textContent = text;
      keyMsg.classList.toggle('bad', bad);
    }

    function syncKeysVisibility(): void {
      const count = snapshot?.managedKeys.length ?? 0;
      keysPanel.hidden = !keysPanelOpen;
      keysToggleBtn.classList.toggle('is-open', keysPanelOpen);
      keysToggleBtn.setAttribute('aria-expanded', String(keysPanelOpen));
      keysToggleLbl.textContent = count > 0 ? `管理密钥 (${count})` : '添加密钥';
      keysCloseBtn.hidden = count === 0;
    }

    function applySnapshot(nextSnap: QuotaSnapshot): void {
      snapshot = { ...nextSnap, displayMode };
      if (!keysOpenTouched) {
        keysPanelOpen = nextSnap.managedKeys.length === 0;
      }
      paintAll();
    }

    async function handleAddKey(): Promise<void> {
      if (keySaving) return;
      const rawKey = addKeyInput.value.trim();
      const rawLabel = addLabelInput.value.trim();
      if (!rawKey) {
        setKeyNotice('请先粘贴 OpenCode Go API Key。', true);
        addKeyInput.focus();
        return;
      }
      keySaving = true;
      addLabelInput.disabled = true;
      addKeyInput.disabled = true;
      addSubmitBtn.disabled = true;
      addSubmitBtn.textContent = '保存并读取中…';
      setKeyNotice('');
      try {
        const nextSnap = await ctx.invoke<QuotaSnapshot>('addKey', [rawLabel, rawKey]);
        if (ctx.signal.aborted) return;
        addLabelInput.value = '';
        addKeyInput.value = '';
        keysOpenTouched = true;
        keysPanelOpen = false;
        editingSecret = null;
        applySnapshot(nextSnap);
        setKeyNotice('');
        showToast('已安全写入本部署 .env 并刷新额度', 'ok');
        void ctx.refresh();
      } catch (error) {
        if (ctx.signal.aborted) return;
        const text = errorText(error);
        setKeyNotice(text, true);
        showToast(text, 'bad');
      } finally {
        keySaving = false;
        if (!ctx.signal.aborted) {
          addLabelInput.disabled = false;
          addKeyInput.disabled = false;
          addSubmitBtn.disabled = false;
          addSubmitBtn.textContent = '添加并查询';
        }
      }
    }

    async function handleUpdateKey(secret: string, label: string, newKey: string): Promise<void> {
      if (keySaving) return;
      keySaving = true;
      setKeyNotice('');
      try {
        const nextSnap = await ctx.invoke<QuotaSnapshot>('updateKey', [secret, label, newKey]);
        if (ctx.signal.aborted) return;
        editingSecret = null;
        renderedKeysSig = '';
        applySnapshot(nextSnap);
        showToast(newKey ? '密钥已更新并刷新额度' : '名称已保存', 'ok');
        void ctx.refresh();
      } catch (error) {
        if (ctx.signal.aborted) return;
        const text = errorText(error);
        setKeyNotice(text, true);
        showToast(text, 'bad');
      } finally {
        keySaving = false;
      }
    }

    async function handleRemoveKey(info: ManagedKeyInfo): Promise<void> {
      if (keySaving) return;
      let confirmed = true;
      if (typeof ui.confirm === 'function') {
        confirmed = await ui.confirm({
          title: `移除密钥「${info.label}」？`,
          body: `将停止监控环境变量 ${info.secret} 对应的额度（本地历史文件保留，重新添加同把 Key 可自动衔接）。`,
          danger: true,
        });
      }
      if (!confirmed || ctx.signal.aborted) return;
      keySaving = true;
      setKeyNotice('');
      try {
        const nextSnap = await ctx.invoke<QuotaSnapshot>('removeKey', [info.secret]);
        if (ctx.signal.aborted) return;
        if (editingSecret === info.secret) editingSecret = null;
        renderedKeysSig = '';
        if (nextSnap.managedKeys.length === 0) {
          keysOpenTouched = false;
        }
        applySnapshot(nextSnap);
        showToast(`已移除「${info.label}」`, 'ok');
        void ctx.refresh();
      } catch (error) {
        if (ctx.signal.aborted) return;
        const text = errorText(error);
        setKeyNotice(text, true);
        showToast(text, 'bad');
      } finally {
        keySaving = false;
      }
    }

    function paintKeyList(keys: readonly ManagedKeyInfo[], force = false): void {
      const sig = `${keysSignature(keys)}#${editingSecret ?? ''}`;
      if (!force && sig === renderedKeysSig) return;
      renderedKeysSig = sig;
      keyListBox.replaceChildren();
      keyListBox.hidden = keys.length === 0;
      if (!keys.length) return;

      for (const info of keys) {
        const item = ui.h('div', 'ocq-key-row');
        const main = ui.h('div', 'ocq-key-row-main');

        const infoCol = ui.h('div', 'ocq-key-row-info');
        infoCol.append(
          ui.h('span', 'ocq-key-row-label', info.label),
          ui.h('span', 'ocq-key-row-env', info.secret),
          info.keyHint
            ? ui.h('span', 'ocq-key-hint', info.keyHint)
            : ui.h('span', 'ocq-key-missing', '未读到值'),
          ...(info.envDefault ? [ui.h('span', 'ocq-key-env-tag', '来自部署 .env')] : []),
        );

        const acts = ui.h('div', 'ocq-key-row-acts');
        const isEditing = editingSecret === info.secret;
        const editBtn = ui.h('button', 'ocq-btn-sm', isEditing ? '取消' : '编辑 / 更换');
        editBtn.type = 'button';
        editBtn.addEventListener('click', () => {
          editingSecret = isEditing ? null : info.secret;
          setKeyNotice('');
          paintKeyList(snapshot?.managedKeys ?? [], true);
        }, { signal: ctx.signal });
        acts.append(editBtn);

        if (!info.envDefault) {
          const rmBtn = ui.h('button', 'ocq-btn-sm is-danger', '移除');
          rmBtn.type = 'button';
          rmBtn.addEventListener('click', () => void handleRemoveKey(info), { signal: ctx.signal });
          acts.append(rmBtn);
        }

        main.append(infoCol, acts);
        item.append(main);

        if (isEditing) {
          const editForm = ui.h('form', 'ocq-key-edit');
          const nameIn = ui.h('input', 'ocq-input ocq-input-name');
          nameIn.type = 'text';
          nameIn.maxLength = 40;
          nameIn.value = info.label;
          nameIn.placeholder = '显示名称';

          const keyIn = ui.h('input', 'ocq-input ocq-input-secret');
          keyIn.type = 'password';
          keyIn.placeholder = '留空不改密钥；粘贴新 API Key 即替换';
          keyIn.autocomplete = 'new-password';
          keyIn.spellcheck = false;

          const saveBtn = ui.h('button', 'ocq-btn-primary', '保存');
          saveBtn.type = 'submit';
          editForm.append(nameIn, keyIn, saveBtn);
          editForm.addEventListener('submit', (ev) => {
            ev.preventDefault();
            void handleUpdateKey(info.secret, nameIn.value.trim(), keyIn.value.trim());
          }, { signal: ctx.signal });
          item.append(editForm);
        }

        keyListBox.append(item);
      }
    }

    function setLoading(loading: boolean): void {
      refreshBtn.disabled = loading;
      refreshBtn.classList.toggle('is-loading', loading);
      refreshBtn.setAttribute('aria-busy', String(loading));
      refreshLbl.textContent = loading ? '读取中…' : '立即刷新';
    }

    function paintCountdowns(): void {
      const now = Date.now();
      for (const card of renderedCards) {
        for (const tile of card.tiles) {
          const resetMs = Date.parse(tile.resetsAt);
          const left = Number.isFinite(resetMs) ? resetMs - now : NaN;
          if (tile.status === 'rate-limited') {
            tile.resetText.textContent = Number.isFinite(left) && left > 0
              ? `已达上限 · ${duration(left)} 后重置`
              : '已达上限';
          } else if (!Number.isFinite(left) || left <= 0) {
            tile.resetText.textContent = '即将重置';
          } else {
            tile.resetText.textContent = `${duration(left)} 后重置`;
          }
          if (Number.isFinite(resetMs)) {
            tile.foot.title = `预计重置时间：${new Date(resetMs).toLocaleString()}`;
          }
        }
      }
    }

    function buildCard(source: SourceSnapshot): CardRefs {
      const card = ui.h('div', 'ocq-card');
      const cardHead = ui.h('div', 'ocq-card-head');

      const ident = ui.h('div', 'ocq-card-ident');
      const identRow = ui.h('div', 'ocq-card-title-row');
      const icoWrap = ui.h('span', 'ocq-key-ico');
      icoWrap.append(keyIcon());
      const cardTitle = ui.h('span', 'ocq-card-title', source.name);
      cardTitle.title = source.name;
      const keyHint = ui.h('span', 'ocq-key-hint', source.keyHint ?? '');
      keyHint.hidden = !source.keyHint;
      identRow.append(icoWrap, cardTitle, keyHint);
      ident.append(identRow);

      if (source.labels.length > 1) {
        const provRow = ui.h('div', 'ocq-providers');
        provRow.append(ui.h('span', 'ocq-providers-label', '共用此 Key'));
        for (const lbl of source.labels) {
          provRow.append(ui.h('span', 'ocq-provider-tag', lbl));
        }
        ident.append(provRow);
      }

      const meta = ui.h('div', 'ocq-card-meta');
      const statusPill = ui.h('span', 'ocq-status');
      const statusDot = ui.h('span', 'ocq-status-dot');
      const statusText = ui.h('span');
      statusPill.append(statusDot, statusText);
      const timeEl = ui.h('span', 'ocq-card-time');
      meta.append(statusPill, timeEl);

      cardHead.append(ident, meta);
      card.append(cardHead);

      let staleBanner: HTMLDivElement | null = null;
      let staleText: HTMLSpanElement | null = null;
      let errorText: HTMLSpanElement | null = null;
      let trend: TrendChartView | null = null;
      const tiles: TileRefs[] = [];

      if (source.windows) {
        staleBanner = ui.h('div', 'ocq-stale-banner');
        staleText = ui.h('span');
        staleBanner.append(alertIcon(), staleText);
        staleBanner.hidden = !source.error;
        card.append(staleBanner);

        const grid = ui.h('div', 'ocq-windows');
        for (const window of WINDOWS) {
          const tileEl = ui.h('div', 'ocq-win');

          const top = ui.h('div', 'ocq-win-top');
          const nameWrap = ui.h('span', 'ocq-win-name');
          nameWrap.append(ui.h('span', 'ocq-dot'), ui.h('span', '', windowLabel(window)));
          const badge = ui.h('span', 'ocq-win-badge');
          top.append(nameWrap, badge);

          const metric = ui.h('div', 'ocq-win-metric');
          const val = ui.h('div', 'ocq-win-val');
          const valNum = ui.h('span', '', '0');
          const valUnit = ui.h('span', 'ocq-win-unit', '%');
          val.append(valNum, valUnit);
          const sub = ui.h('span', 'ocq-win-sub');
          metric.append(val, sub);

          const track = ui.h('div', 'ocq-bar-track');
          track.setAttribute('role', 'progressbar');
          track.setAttribute('aria-valuemin', '0');
          track.setAttribute('aria-valuemax', '100');
          const clip = ui.h('div', 'ocq-bar-clip');
          const fill = ui.h('div', 'ocq-bar-fill');
          clip.append(fill);
          const mark = ui.h('div', 'ocq-bar-mark');
          track.append(clip, mark);

          const foot = ui.h('div', 'ocq-win-foot');
          const resetText = ui.h('span');
          foot.append(clockIcon(), resetText);

          tileEl.append(top, metric, track, foot);
          grid.append(tileEl);

          tiles.push({
            window,
            el: tileEl,
            badge,
            valNum,
            sub,
            track,
            fill,
            mark,
            foot,
            resetText,
            resetsAt: source.windows[window].resetsAt,
            status: source.windows[window].status,
          });
        }
        card.append(grid);

        trend = new TrendChartView(ui.h.bind(ui), ctx.signal);
        card.append(trend.el);
      } else if (source.error) {
        const errBox = ui.h('div', 'ocq-error-box');
        errorText = ui.h('span', '', `无法读取额度：${source.error}`);
        errBox.append(alertIcon(), errorText);
        card.append(errBox);
      } else {
        card.append(ui.h('div', 'ocq-waiting', '正在等待首次额度数据…'));
      }

      return { el: card, statusPill, statusText, timeEl, staleBanner, staleText, errorText, tiles, trend };
    }

    function updateCard(refs: CardRefs, source: SourceSnapshot, alertAt: number, cardIndex: number): void {
      const remainingAlert = clampPercent(100 - alertAt);
      if (source.readAt) {
        refs.timeEl.textContent = new Date(source.readAt).toLocaleTimeString();
        refs.timeEl.hidden = false;
      } else {
        refs.timeEl.textContent = '';
        refs.timeEl.hidden = true;
      }

      let cardStatus: CardStatus = 'idle';
      if (source.windows) {
        if (refs.staleBanner && refs.staleText) {
          refs.staleBanner.hidden = !source.error;
          refs.staleText.textContent = source.error ? `最近一次刷新失败，当前显示缓存数据：${source.error}` : '';
        }

        const severities: Severity[] = [];
        for (const tile of refs.tiles) {
          const state = source.windows[tile.window];
          const used = clampPercent(state.percent);
          const left = clampPercent(100 - used);
          const sev = severityOf(used, alertAt, state.status);
          severities.push(sev);

          tile.resetsAt = state.resetsAt;
          tile.status = state.status;
          tile.el.className = `ocq-win is-${sev}`;

          const showRemaining = displayMode === 'remaining';
          const primary = showRemaining ? left : used;
          tile.valNum.textContent = formatPercent(primary);
          tile.sub.textContent = showRemaining
            ? `已用 ${formatPercent(used)}%`
            : `剩余 ${formatPercent(left)}%`;

          tile.badge.textContent = sev === 'limit'
            ? '已达上限'
            : sev === 'warn'
              ? '告警'
              : showRemaining
                ? '剩余'
                : '已用';

          tile.fill.style.width = `${primary}%`;
          tile.fill.classList.toggle('has-value', primary > 0);
          tile.track.setAttribute('aria-valuenow', formatPercent(primary));
          tile.track.setAttribute(
            'aria-label',
            `${windowLabel(tile.window)} ${showRemaining ? `剩余 ${formatPercent(left)}%` : `已用 ${formatPercent(used)}%`}`,
          );

          const markPos = showRemaining ? remainingAlert : clampPercent(alertAt);
          tile.mark.style.left = `${markPos}%`;
          tile.mark.title = `告警线：已用 ${alertAt}%（剩余 ${remainingAlert}%）`;
        }

        refs.trend?.update(source.monthly, displayMode, cardIndex);
        cardStatus = source.error ? 'error' : worstSeverity(severities);
      } else if (source.error) {
        cardStatus = 'error';
        if (refs.errorText) refs.errorText.textContent = `无法读取额度：${source.error}`;
      }

      refs.el.className = `ocq-card is-${cardStatus}`;
      refs.statusPill.className = `ocq-status is-${cardStatus}`;
      refs.statusText.textContent = source.windows && source.error ? '缓存 · 刷新失败' : statusLabel(cardStatus);
    }

    function paintHeaderBadge(snap: QuotaSnapshot): void {
      const keyCount = snap.sources.length;
      const slotCount = snap.managedKeys.length;
      if (keyCount > 1 && slotCount > keyCount) {
        headBadge.textContent = `${slotCount} 个条目 → ${keyCount} 把独立 Key`;
        headBadge.hidden = false;
      } else if (keyCount > 1) {
        headBadge.textContent = `共 ${keyCount} 把独立 Key`;
        headBadge.hidden = false;
      } else if (keyCount === 1 && slotCount > 1) {
        headBadge.textContent = `${slotCount} 个条目共用 1 把 Key`;
        headBadge.hidden = false;
      } else {
        headBadge.textContent = '';
        headBadge.hidden = true;
      }
    }

    function paintFooter(snap: QuotaSnapshot): void {
      footer.replaceChildren();
      const latest = snap.sources
        .map((source) => source.readAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);

      const remainingAlert = clampPercent(100 - snap.alertAt);
      const items = [
        latest ? `最近查询 ${new Date(latest).toLocaleTimeString()}` : '尚未读到额度数据',
        `每 ${snap.pollMinutes} 分钟自动读取`,
        `本地历史保留 ${snap.retainDays ?? 35} 天`,
        displayMode === 'remaining' ? `告警线：剩余 ≤ ${remainingAlert}%` : `告警线：已用 ≥ ${snap.alertAt}%`,
      ];
      items.forEach((item, index) => {
        if (index > 0) footer.append(ui.h('span', 'ocq-foot-dot'));
        footer.append(ui.h('span', 'ocq-foot-item', item));
      });
    }

    function paintEmpty(snap: QuotaSnapshot): void {
      const emptySig = snap.gateway ? '__empty_nokey__' : '__empty_nogw__';
      if (renderedSig === emptySig) return;
      renderedSig = emptySig;
      renderedCards = [];
      cardsBox.replaceChildren();
      const empty = ui.h('div', 'ocq-empty');
      const ico = ui.h('div', 'ocq-empty-ico');
      ico.append(keyIcon());
      if (!snap.gateway) {
        empty.append(
          ico,
          ui.h('div', 'ocq-empty-title', '网关地址无效'),
          ui.h('div', 'ocq-empty-desc', '请在「配置」页签检查 OpenCode 网关地址（默认 https://opencode.ai/inference）。'),
        );
      } else {
        empty.append(
          ico,
          ui.h('div', 'ocq-empty-title', '还没有监控中的 OpenCode Go Key'),
          ui.h('div', 'ocq-empty-desc', '在上方密钥管理区粘贴 OpenCode Go API Key 即可开始监控（也可在本部署 .env 中直接配置 OPENCODE_QUOTA_API_KEY）。'),
        );
      }
      cardsBox.append(empty);
    }

    function paintAll(): void {
      if (!snapshot) return;
      syncKeysVisibility();
      paintKeyList(snapshot.managedKeys);
      paintHeaderBadge(snapshot);
      const { sources, alertAt } = snapshot;
      if (!sources.length) {
        paintEmpty(snapshot);
        footer.replaceChildren();
        return;
      }

      const sig = structureSignature(sources);
      if (sig !== renderedSig) {
        renderedSig = sig;
        renderedCards = sources.map((source) => buildCard(source));
        cardsBox.replaceChildren(...renderedCards.map((refs) => refs.el));
      }

      for (let i = 0; i < sources.length; i += 1) {
        updateCard(renderedCards[i]!, sources[i]!, alertAt, i);
      }
      paintCountdowns();
      paintFooter(snapshot);
    }

    async function switchDisplayMode(next: DisplayMode): Promise<void> {
      const epoch = ++modeEpoch;
      displayMode = next;
      ctx.memo.set('displayMode', next);
      modeSwitch.setValue(next);
      if (snapshot) {
        snapshot = { ...snapshot, displayMode: next };
        paintAll();
      }
      try {
        try {
          await ctx.setConfig(CONFIG_GROUP_ID, { [DISPLAY_MODE_KEY]: next });
        } catch {
          await ctx.invoke<QuotaSnapshot>('mode', [next]);
        }
        if (ctx.signal.aborted || epoch !== modeEpoch) return;
        await ctx.refresh();
      } catch (error) {
        if (ctx.signal.aborted) return;
        message.textContent = errorText(error);
        message.classList.add('bad');
      }
    }

    async function load(method: 'state' | 'read'): Promise<void> {
      if (busy) return;
      busy = true;
      const epochAtStart = modeEpoch;
      if (method === 'read') setLoading(true);
      message.classList.remove('bad');
      try {
        const nextSnap = await ctx.invoke<QuotaSnapshot>(method);
        if (ctx.signal.aborted) return;
        if (epochAtStart === modeEpoch && (nextSnap.displayMode === 'used' || nextSnap.displayMode === 'remaining')) {
          displayMode = nextSnap.displayMode;
          ctx.memo.set('displayMode', displayMode);
          modeSwitch.setValue(displayMode);
        }
        applySnapshot(nextSnap);
        message.textContent = '';
        if (method === 'read') void ctx.refresh();
      } catch (error) {
        if (ctx.signal.aborted) return;
        message.textContent = errorText(error);
        message.classList.add('bad');
      } finally {
        busy = false;
        if (!ctx.signal.aborted && method === 'read') setLoading(false);
      }
    }

    void load('state');
    ctx.interval(() => void load('state'), 15_000);
    ctx.interval(paintCountdowns, 1_000);
  },
};

export default { panels: { [QUOTA_PANEL]: quotaPanel } } satisfies WebUiClientBundle;
