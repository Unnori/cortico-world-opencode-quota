// src/webui/protocol.ts
var QUOTA_PANEL = "quota";

// src/webui/client.ts
var WINDOWS = ["rolling", "weekly", "monthly"];
var CONFIG_GROUP_ID = "world:opencode-quota";
var DISPLAY_MODE_KEY = "worlds.opencode-quota.displayMode";
var SVG_NS = "http://www.w3.org/2000/svg";
var HOUR_MS = 36e5;
var DAY_MS = 864e5;
var MIN_VIEW_SPAN_MS = 6 * HOUR_MS;
var VIEW_W = 680;
var VIEW_H = 176;
var PAD_L = 46;
var PAD_R = 56;
var PAD_T = 24;
var PAD_B = 14;
var PLOT_W = VIEW_W - PAD_L - PAD_R;
var PLOT_H = VIEW_H - PAD_T - PAD_B;
function windowLabel(window2) {
  return window2 === "rolling" ? "\u6BCF 5 \u5C0F\u65F6" : window2 === "weekly" ? "\u6BCF\u5468" : "\u6BCF\u6708";
}
function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}
function formatPercent(value) {
  const clean = Math.round(value * 10) / 10;
  return Number.isInteger(clean) ? String(clean) : String(clean);
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function formatCnDate(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}\u6708${d.getDate()}\u65E5`;
}
function formatShortMD(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function formatHM(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function formatMDHM(ms) {
  return `${formatShortMD(ms)} ${formatHM(ms)}`;
}
function duration(ms) {
  const minutes = Math.floor(ms / 6e4);
  if (minutes < 1) return "\u4E0D\u8DB3 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${pad2(minutes % 60)}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function severityOf(used, alertAt, status) {
  if (used >= 100 || status === "rate-limited") return "limit";
  if (used >= alertAt) return "warn";
  if (used >= Math.min(alertAt, 50)) return "mid";
  return "ok";
}
function worstSeverity(severities) {
  const rank = { ok: 0, mid: 1, warn: 2, limit: 3 };
  let worst = "ok";
  for (const s of severities) {
    if (rank[s] > rank[worst]) worst = s;
  }
  return worst;
}
function statusLabel(status) {
  switch (status) {
    case "ok":
      return "\u989D\u5EA6\u5145\u8DB3";
    case "mid":
      return "\u5DF2\u7528\u8FC7\u534A";
    case "warn":
      return "\u5DF2\u8FC7\u544A\u8B66\u7EBF";
    case "limit":
      return "\u5DF2\u8FBE\u4E0A\u9650";
    case "error":
      return "\u8BFB\u53D6\u5931\u8D25";
    case "idle":
      return "\u7B49\u5F85\u8BFB\u53D6";
  }
}
function svgEl(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== void 0) el.textContent = text;
  return el;
}
function createIcon(paths, cls) {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    ...cls ? { class: cls } : {}
  });
  for (const d of paths) svg.append(svgEl("path", { d }));
  return svg;
}
var refreshIcon = () => createIcon([
  "M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",
  "M3 3v5h5",
  "M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16",
  "M16 16h5v5"
], "ocq-refresh-ico");
var keyIcon = () => createIcon([
  "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"
]);
var clockIcon = () => createIcon([
  "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
  "M12 6v6l4 2"
]);
var alertIcon = () => createIcon([
  "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
  "M12 8v4",
  "M12 16h.01"
]);
function buildAdaptiveTicks(viewStart, viewEnd, monthly, showRemaining, isZoomed) {
  const viewSpan = Math.max(1, viewEnd - viewStart);
  const ratioOf = (ts) => (ts - viewStart) / viewSpan;
  const placed = [];
  const fits = (ratio, minDist, edgeMargin = 0.08) => ratio >= edgeMargin && ratio <= 1 - edgeMargin && placed.every((item) => Math.abs(item.ratio - ratio) >= minDist);
  if (!isZoomed && viewSpan > 14 * DAY_MS) {
    placed.push(
      { ts: viewStart, ratio: 0, label: formatCnDate(viewStart), cls: "ocq-axis-tick is-start" },
      { ts: viewEnd, ratio: 1, label: formatCnDate(viewEnd), cls: "ocq-axis-tick is-end" }
    );
    if (monthly.projectedHitAt !== null) {
      const r = ratioOf(monthly.projectedHitAt);
      if (fits(r, 0.11, 0.11)) {
        placed.push({
          ts: monthly.projectedHitAt,
          ratio: r,
          label: formatCnDate(monthly.projectedHitAt),
          cls: `ocq-axis-tick is-hit${showRemaining ? " is-danger" : ""}`
        });
      }
    }
    const rNow = ratioOf(monthly.now);
    if (fits(rNow, 0.15, 0.12)) {
      placed.push({ ts: monthly.now, ratio: rNow, label: "\u4ECA\u5929", cls: "ocq-axis-tick" });
    }
    const rightAnchor = monthly.projectedHitAt ?? monthly.now;
    const midRight = (rightAnchor + monthly.cycleEnd) / 2;
    if (fits(ratioOf(midRight), 0.16, 0.12)) {
      placed.push({ ts: midRight, ratio: ratioOf(midRight), label: formatCnDate(midRight), cls: "ocq-axis-tick" });
    }
    const midLeft = (monthly.cycleStart + monthly.now) / 2;
    if (fits(ratioOf(midLeft), 0.16, 0.12)) {
      placed.push({ ts: midLeft, ratio: ratioOf(midLeft), label: formatCnDate(midLeft), cls: "ocq-axis-tick" });
    }
    return placed;
  }
  if (monthly.projectedHitAt !== null && monthly.projectedHitAt >= viewStart && monthly.projectedHitAt <= viewEnd) {
    const r = ratioOf(monthly.projectedHitAt);
    if (r >= 0.05 && r <= 0.95) {
      const hitLbl = viewSpan <= 4 * DAY_MS ? formatMDHM(monthly.projectedHitAt) : formatCnDate(monthly.projectedHitAt);
      placed.push({
        ts: monthly.projectedHitAt,
        ratio: r,
        label: hitLbl,
        cls: `ocq-axis-tick is-hit${showRemaining ? " is-danger" : ""}`
      });
    }
  }
  const candidates = [];
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
    const stepHours = viewSpan > 60 * HOUR_MS ? 12 : viewSpan > 36 * HOUR_MS ? 6 : viewSpan > 20 * HOUR_MS ? 4 : viewSpan > 11 * HOUR_MS ? 2 : 1;
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
    let label;
    let cls = "ocq-axis-tick";
    if (viewSpan > 4 * DAY_MS) {
      label = formatShortMD(item.ts);
    } else if (item.isMidnight) {
      label = `${formatShortMD(item.ts)} 00:00`;
      cls = "ocq-axis-tick is-day";
      shownDateOnce = true;
    } else if (!shownDateOnce) {
      label = formatMDHM(item.ts);
      shownDateOnce = true;
    } else {
      label = formatHM(item.ts);
    }
    placed.push({ ts: item.ts, ratio: r, label, cls, grid: true });
  }
  if (placed.length < 2) {
    const edgeFmt = viewSpan <= 4 * DAY_MS ? formatMDHM : formatShortMD;
    if (placed.every((p) => p.ratio > 0.16)) {
      placed.push({ ts: viewStart, ratio: 0, label: edgeFmt(viewStart), cls: "ocq-axis-tick is-start" });
    }
    if (placed.every((p) => p.ratio < 0.84)) {
      placed.push({ ts: viewEnd, ratio: 1, label: edgeFmt(viewEnd), cls: "ocq-axis-tick is-end" });
    }
  }
  return placed.sort((a, b) => a.ratio - b.ratio);
}
function evalSeriesAt(ts, monthly, showRemaining) {
  if (ts < monthly.cycleStart || ts > monthly.cycleEnd) return null;
  if (ts <= monthly.now) {
    const pts = monthly.points;
    let used2 = monthly.currentUsed;
    if (pts.length > 0) {
      if (ts <= pts[0].ts) {
        const span = Math.max(1, pts[0].ts - monthly.cycleStart);
        const ratio2 = Math.max(0, Math.min(1, (ts - monthly.cycleStart) / span));
        used2 = pts[0].used * ratio2;
      } else {
        let found = false;
        for (let i = 1; i < pts.length; i += 1) {
          const a = pts[i - 1];
          const b = pts[i];
          if (ts <= b.ts) {
            const ratio2 = Math.max(0, Math.min(1, (ts - a.ts) / Math.max(1, b.ts - a.ts)));
            used2 = a.used + (b.used - a.used) * ratio2;
            found = true;
            break;
          }
        }
        if (!found) used2 = pts[pts.length - 1].used;
      }
    }
    const cleanUsed = clampPercent(used2);
    const cleanRem = clampPercent(100 - cleanUsed);
    return { kind: "actual", used: cleanUsed, rem: cleanRem, plotYVal: showRemaining ? cleanRem : cleanUsed };
  }
  if (showRemaining && (monthly.currentUsed >= 100 || monthly.projectedHitAt !== null && ts > monthly.projectedHitAt)) {
    return { kind: "gap", used: 100, rem: 0, plotYVal: 0 };
  }
  if (monthly.projectedEndUsed === null) return null;
  const fcSpan = Math.max(1, monthly.cycleEnd - monthly.now);
  const ratio = Math.max(0, Math.min(1, (ts - monthly.now) / fcSpan));
  const used = Math.round((monthly.currentUsed + (monthly.projectedEndUsed - monthly.currentUsed) * ratio) * 10) / 10;
  const rem = Math.max(0, Math.round((100 - used) * 10) / 10);
  return { kind: "forecast", used, rem, plotYVal: showRemaining ? rem : used };
}
var TrendChartView = class {
  constructor(h, signal) {
    this.h = h;
    this.el = h("div", "ocq-trend");
    this.el.hidden = true;
    const head = h("div", "ocq-trend-head");
    const left = h("div", "ocq-trend-left");
    const titleRow = h("div", "ocq-trend-title-row");
    this.titleEl = h("div", "ocq-trend-title");
    titleRow.append(this.titleEl);
    this.subEl = h("div", "ocq-trend-sub");
    left.append(titleRow, this.subEl);
    const actions = h("div", "ocq-trend-actions");
    this.zoomResetBtn = h("button", "ocq-zoom-reset", "\u91CD\u7F6E\u7F29\u653E");
    this.zoomResetBtn.type = "button";
    this.zoomResetBtn.hidden = true;
    this.zoomResetBtn.addEventListener("click", () => this.resetZoom(), { signal });
    const note = h("span", "ocq-trend-note");
    note.append(h("span", "ocq-dash-sample"), h("span", "", "\u865A\u7EBF\u4E3A\u9884\u6D4B\u503C"));
    actions.append(this.zoomResetBtn, note);
    head.append(left, actions);
    this.chartWrap = h("div", "ocq-chart-wrap");
    this.svg = svgEl("svg", {
      class: "ocq-chart-svg",
      viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
      role: "img"
    });
    this.hoverTip = h("div", "ocq-hover-tip");
    this.hoverTip.hidden = true;
    this.chartWrap.append(this.svg, this.hoverTip);
    const axis = h("div", "ocq-chart-axis");
    this.axisInner = h("div");
    this.axisInner.style.position = "absolute";
    this.axisInner.style.inset = `0 ${(PAD_R / VIEW_W * 100).toFixed(2)}% 0 ${(PAD_L / VIEW_W * 100).toFixed(2)}%`;
    axis.append(this.axisInner);
    const foot = h("div", "ocq-chart-foot");
    this.avgEl = h("div", "ocq-chart-avg");
    this.legendEl = h("div", "ocq-chart-legend");
    foot.append(this.avgEl, this.legendEl);
    this.el.append(head, this.chartWrap, axis, foot);
    this.bindInteractions(signal);
  }
  h;
  el;
  titleEl;
  subEl;
  zoomResetBtn;
  chartWrap;
  svg;
  hoverTip;
  axisInner;
  avgEl;
  legendEl;
  monthly = null;
  mode = "used";
  cardIndex = 0;
  viewport = null;
  hoverTs = null;
  dragging = false;
  dragPointerId = -1;
  dragStartX = 0;
  dragOriginStart = 0;
  dragOriginEnd = 0;
  isZoomed() {
    if (!this.viewport) return false;
    const full = this.viewport.cycleEnd - this.viewport.cycleStart;
    const cur = this.viewport.end - this.viewport.start;
    return cur < full * 0.995;
  }
  resetZoom() {
    if (!this.monthly) return;
    this.viewport = {
      cycleStart: this.monthly.cycleStart,
      cycleEnd: this.monthly.cycleEnd,
      start: this.monthly.cycleStart,
      end: this.monthly.cycleEnd
    };
    this.hoverTs = null;
    this.render();
  }
  pointerToRatio(clientX) {
    const rect = this.chartWrap.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const svgX = (clientX - rect.left) / rect.width * VIEW_W;
    if (svgX < PAD_L - 6 || svgX > PAD_L + PLOT_W + 6) return null;
    return Math.max(0, Math.min(1, (svgX - PAD_L) / PLOT_W));
  }
  bindInteractions(signal) {
    this.chartWrap.addEventListener("wheel", (ev) => {
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
    this.chartWrap.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || !this.viewport || !this.isZoomed()) return;
      ev.preventDefault();
      this.dragging = false;
      this.dragPointerId = ev.pointerId;
      this.dragStartX = ev.clientX;
      this.dragOriginStart = this.viewport.start;
      this.dragOriginEnd = this.viewport.end;
    }, { signal });
    this.chartWrap.addEventListener("pointermove", (ev) => {
      if (!this.monthly || !this.viewport) return;
      if (this.dragPointerId !== -1 && ev.pointerId === this.dragPointerId) {
        if (!this.dragging) {
          if (Math.abs(ev.clientX - this.dragStartX) < 2) return;
          this.dragging = true;
          this.hoverTs = null;
          this.chartWrap.classList.add("is-grabbing");
          try {
            this.chartWrap.setPointerCapture(ev.pointerId);
          } catch {
          }
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
    const endDrag = (ev) => {
      if (this.dragPointerId === -1 || ev.pointerId !== this.dragPointerId) return;
      const wasDragging = this.dragging;
      this.dragging = false;
      this.dragPointerId = -1;
      if (wasDragging) {
        this.chartWrap.classList.remove("is-grabbing");
        try {
          this.chartWrap.releasePointerCapture(ev.pointerId);
        } catch {
        }
      }
    };
    window.addEventListener("pointerup", endDrag, { signal });
    window.addEventListener("pointercancel", endDrag, { signal });
    this.chartWrap.addEventListener("pointerleave", () => {
      if (this.dragging) return;
      if (this.hoverTs !== null) {
        this.hoverTs = null;
        this.render();
      }
    }, { signal });
    this.chartWrap.addEventListener("dblclick", () => {
      if (this.isZoomed()) this.resetZoom();
    }, { signal });
  }
  update(monthly, mode, cardIndex) {
    this.monthly = monthly;
    this.mode = mode;
    this.cardIndex = cardIndex;
    if (!monthly) {
      this.el.hidden = true;
      this.viewport = null;
      return;
    }
    this.el.hidden = false;
    if (!this.viewport || this.viewport.cycleStart !== monthly.cycleStart || this.viewport.cycleEnd !== monthly.cycleEnd) {
      this.viewport = {
        cycleStart: monthly.cycleStart,
        cycleEnd: monthly.cycleEnd,
        start: monthly.cycleStart,
        end: monthly.cycleEnd
      };
    }
    this.render();
  }
  render() {
    const monthly = this.monthly;
    const viewport = this.viewport;
    if (!monthly || !viewport) return;
    const h = this.h;
    const showRemaining = this.mode === "remaining";
    const zoomed = this.isZoomed();
    const viewStart = viewport.start;
    const viewEnd = viewport.end;
    const viewSpan = Math.max(1, viewEnd - viewStart);
    const currentUsed = clampPercent(monthly.currentUsed);
    const currentRem = clampPercent(100 - currentUsed);
    const startStr = formatCnDate(monthly.cycleStart);
    const endStr = formatCnDate(monthly.cycleEnd);
    this.titleEl.textContent = showRemaining ? `\u672C\u6708\u5269\u4F59 ${formatPercent(currentRem)}%` : `\u672C\u6708\u5DF2\u7528 ${formatPercent(currentUsed)}%`;
    this.subEl.replaceChildren(h("span", "", `\u5468\u671F ${startStr} \u2013 ${endStr} \xB7 ${endStr} \u91CD\u7F6E`));
    let paceText = "";
    let paceTone = "";
    if (currentUsed >= 100) {
      paceText = "\xB7 \u672C\u6708\u989D\u5EA6\u5DF2\u7528\u5C3D";
      paceTone = " is-danger";
    } else if (monthly.projectedHitAt !== null) {
      const hitDate = formatCnDate(monthly.projectedHitAt);
      paceText = showRemaining ? `\xB7 \u6309\u5F53\u524D\u901F\u5EA6\uFF0C\u9884\u8BA1 ${hitDate} \u8017\u5C3D\uFF08\u8DCC\u7834 0%\uFF09` : `\xB7 \u6309\u5F53\u524D\u901F\u5EA6\uFF0C\u9884\u8BA1 ${hitDate} \u89E6\u9876\uFF08\u8FBE 100%\uFF09`;
      paceTone = showRemaining ? " is-danger" : "";
    } else if (monthly.dailyRate > 0 && monthly.projectedEndUsed !== null) {
      const endRem = Math.max(0, Math.round((100 - monthly.projectedEndUsed) * 10) / 10);
      paceText = showRemaining ? `\xB7 \u6309\u5F53\u524D\u901F\u5EA6\uFF0C\u5468\u671F\u672B\u9884\u8BA1\u5269\u4F59 ${formatPercent(endRem)}%` : `\xB7 \u6309\u5F53\u524D\u901F\u5EA6\uFF0C\u5468\u671F\u672B\u9884\u8BA1\u5DF2\u7528 ${formatPercent(monthly.projectedEndUsed)}%`;
      paceTone = " is-ok";
    } else {
      paceText = "\xB7 \u672C\u5468\u671F\u6682\u65E0\u660E\u663E\u6D88\u8017\uFF0C\u4EA7\u751F\u7528\u91CF\u540E\u81EA\u52A8\u9884\u6D4B";
      paceTone = " is-ok";
    }
    this.subEl.append(h("span", `ocq-trend-pace${paceTone}`, paceText));
    this.chartWrap.classList.toggle("is-zoomed", zoomed);
    if (zoomed) {
      const rangeFmt = viewSpan <= 4 * DAY_MS ? formatMDHM : formatShortMD;
      this.zoomResetBtn.textContent = `${rangeFmt(viewStart)} \u2013 ${rangeFmt(viewEnd)} \xB7 \u91CD\u7F6E\u7F29\u653E`;
      this.zoomResetBtn.hidden = false;
    } else {
      this.zoomResetBtn.hidden = true;
    }
    const ticks = buildAdaptiveTicks(viewStart, viewEnd, monthly, showRemaining, zoomed);
    const xOf = (ts) => PAD_L + (ts - viewStart) / viewSpan * PLOT_W;
    const inPlotX = (x) => x >= PAD_L - 2 && x <= PAD_L + PLOT_W + 2;
    const endUsedVal = monthly.projectedEndUsed ?? currentUsed;
    let yMax = 100;
    let yTicks = [0, 50, 100];
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
    const yOf = (val) => PAD_T + (1 - Math.max(0, Math.min(yMax, val)) / yMax) * PLOT_H;
    const svg = this.svg;
    svg.replaceChildren();
    svg.setAttribute("aria-label", showRemaining ? "\u672C\u6708\u5269\u4F59\u989D\u5EA6\u8D8B\u52BF\u4E0E\u9884\u6D4B\u6298\u7EBF\u56FE" : "\u672C\u6708\u5DF2\u7528\u989D\u5EA6\u8D8B\u52BF\u4E0E\u9884\u6D4B\u6298\u7EBF\u56FE");
    const uid = `ocq-c${this.cardIndex}-${showRemaining ? "r" : "u"}`;
    const defs = svgEl("defs");
    const clipPath = svgEl("clipPath", { id: `${uid}-clip` });
    clipPath.append(svgEl("rect", { x: PAD_L, y: PAD_T - 8, width: PLOT_W, height: PLOT_H + 16 }));
    defs.append(clipPath);
    const actualGrad = svgEl("linearGradient", { id: `${uid}-act`, x1: "0", y1: "0", x2: "0", y2: "1" });
    actualGrad.append(
      svgEl("stop", { offset: "0%", "stop-color": "var(--ok)", "stop-opacity": "0.22" }),
      svgEl("stop", { offset: "100%", "stop-color": "var(--ok)", "stop-opacity": "0.01" })
    );
    defs.append(actualGrad);
    const forecastGrad = svgEl("linearGradient", { id: `${uid}-fc`, x1: "0", y1: "0", x2: "0", y2: "1" });
    forecastGrad.append(
      svgEl("stop", { offset: "0%", "stop-color": "var(--warn)", "stop-opacity": "0.18" }),
      svgEl("stop", { offset: "100%", "stop-color": "var(--warn)", "stop-opacity": "0.02" })
    );
    defs.append(forecastGrad);
    const hatch = svgEl("pattern", {
      id: `${uid}-hatch`,
      width: "8",
      height: "8",
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)"
    });
    hatch.append(svgEl("line", {
      x1: "0",
      y1: "0",
      x2: "0",
      y2: "8",
      stroke: "var(--warn)",
      "stroke-opacity": "0.12",
      "stroke-width": "1.5"
    }));
    defs.append(hatch);
    svg.append(defs);
    const yZero = yOf(0);
    for (const tick of yTicks) {
      const y = yOf(tick);
      const isRefLimit = showRemaining ? tick === 0 : tick === 100;
      svg.append(svgEl("line", {
        x1: PAD_L,
        y1: y,
        x2: PAD_L + PLOT_W,
        y2: y,
        class: isRefLimit ? `ocq-chart-limit-line${showRemaining && (monthly.projectedHitAt !== null || currentUsed >= 100) ? " is-zero-hit" : ""}` : "ocq-chart-grid"
      }));
      svg.append(svgEl("text", {
        x: PAD_L - 8,
        y: y + 3.5,
        "text-anchor": "end",
        class: "ocq-chart-ylabel"
      }, `${tick}%`));
    }
    if (zoomed) {
      for (const tick of ticks) {
        if (!tick.grid) continue;
        const x = PAD_L + tick.ratio * PLOT_W;
        svg.append(svgEl("line", { x1: x, y1: PAD_T, x2: x, y2: yZero, class: "ocq-chart-vgrid" }));
      }
    }
    const plotG = svgEl("g", { "clip-path": `url(#${uid}-clip)` });
    const xNow = xOf(monthly.now);
    if (inPlotX(xNow)) {
      plotG.append(svgEl("line", { x1: xNow, y1: PAD_T, x2: xNow, y2: yZero, class: "ocq-chart-vguide" }));
    }
    const xHit = monthly.projectedHitAt !== null ? xOf(monthly.projectedHitAt) : null;
    if (xHit !== null && inPlotX(xHit)) {
      plotG.append(svgEl("line", { x1: xHit, y1: PAD_T, x2: xHit, y2: yZero, class: "ocq-chart-vguide is-hit" }));
    }
    const valOf = (used) => showRemaining ? clampPercent(100 - used) : clampPercent(used);
    const startVal = showRemaining ? 100 : 0;
    const pts = monthly.points.map((p) => ({ ts: p.ts, x: xOf(p.ts), y: yOf(valOf(p.used)), used: p.used }));
    const xStart = xOf(monthly.cycleStart);
    const yStart = yOf(startVal);
    const xEnd = xOf(monthly.cycleEnd);
    if (pts.length > 0 && pts[0].ts - monthly.cycleStart > 6 * HOUR_MS) {
      plotG.append(svgEl("line", {
        x1: xStart,
        y1: yStart,
        x2: pts[0].x,
        y2: pts[0].y,
        class: "ocq-chart-leadin"
      }));
    }
    if (pts.length >= 2) {
      const polyPts = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      const areaD = `M ${pts[0].x.toFixed(1)} ${yZero.toFixed(1)} ` + pts.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + ` L ${pts[pts.length - 1].x.toFixed(1)} ${yZero.toFixed(1)} Z`;
      plotG.append(svgEl("path", { d: areaD, fill: `url(#${uid}-act)` }));
      plotG.append(svgEl("polyline", { points: polyPts, class: "ocq-chart-actual" }));
    } else if (pts.length === 1) {
      const areaD = `M ${xStart.toFixed(1)} ${yZero.toFixed(1)} L ${xStart.toFixed(1)} ${yStart.toFixed(1)} L ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L ${pts[0].x.toFixed(1)} ${yZero.toFixed(1)} Z`;
      plotG.append(svgEl("path", { d: areaD, fill: `url(#${uid}-act)`, opacity: "0.55" }));
    }
    const yNow = yOf(valOf(currentUsed));
    const labelG = svgEl("g");
    if (showRemaining) {
      if (currentUsed >= 100) {
        const gapStart = Math.max(PAD_L, xNow);
        const gapEnd = Math.min(PAD_L + PLOT_W, xEnd);
        const gapW = Math.max(0, gapEnd - gapStart);
        if (gapW > 2) {
          plotG.append(svgEl("rect", { x: gapStart, y: yZero - 5, width: gapW, height: 5, class: "ocq-chart-gap-band" }));
          if (gapW >= 120) {
            const gapDays = Math.max(1, Math.ceil((monthly.cycleEnd - monthly.now) / DAY_MS));
            labelG.append(svgEl("text", {
              x: gapStart + gapW / 2,
              y: yZero - 12,
              "text-anchor": "middle",
              class: "ocq-chart-gap-label"
            }, `\u7A7A\u6863\u7EA6 ${gapDays} \u5929 \xB7 \u81F3 ${endStr} \u91CD\u7F6E`));
          }
        }
        if (inPlotX(xNow)) {
          const labelX = Math.max(PAD_L + 30, Math.min(PAD_L + PLOT_W - 30, xNow));
          labelG.append(svgEl("text", {
            x: labelX,
            y: yZero - 14,
            "text-anchor": "middle",
            class: "ocq-chart-callout is-danger"
          }, "\u5DF2\u8017\u5C3D 0%"));
        }
      } else if (xHit !== null && monthly.projectedHitAt !== null) {
        const fcArea = `M ${xNow.toFixed(1)} ${yZero.toFixed(1)} L ${xNow.toFixed(1)} ${yNow.toFixed(1)} L ${xHit.toFixed(1)} ${yZero.toFixed(1)} Z`;
        plotG.append(svgEl("path", { d: fcArea, fill: `url(#${uid}-fc)` }));
        plotG.append(svgEl("path", { d: fcArea, fill: `url(#${uid}-hatch)` }));
        plotG.append(svgEl("line", {
          x1: xNow,
          y1: yNow,
          x2: xHit,
          y2: yZero,
          class: "ocq-chart-forecast"
        }));
        const gapStart = Math.max(PAD_L, xHit);
        const gapEnd = Math.min(PAD_L + PLOT_W, xEnd);
        const gapW = Math.max(0, gapEnd - gapStart);
        if (gapW > 2) {
          plotG.append(svgEl("rect", { x: gapStart, y: yZero - 5, width: gapW, height: 5, class: "ocq-chart-gap-band" }));
          if (gapW >= 120) {
            const gapDays = Math.max(1, Math.round((monthly.cycleEnd - monthly.projectedHitAt) / DAY_MS));
            labelG.append(svgEl("text", {
              x: gapStart + gapW / 2,
              y: yZero - 12,
              "text-anchor": "middle",
              class: "ocq-chart-gap-label"
            }, `\u7A7A\u6863\u7EA6 ${gapDays} \u5929 \xB7 \u81F3 ${endStr} \u91CD\u7F6E`));
          }
        }
        if (inPlotX(xHit)) {
          plotG.append(svgEl("circle", { cx: xHit, cy: yZero, r: 4.5, class: "ocq-chart-dot-hit is-danger" }));
          const hasRightRoom = PAD_L + PLOT_W - xHit >= 110;
          const calloutX = hasRightRoom ? xHit + 8 : Math.max(PAD_L + 60, xHit - 8);
          const calloutY = Math.max(PAD_T + 14, Math.min(yZero - 38, yNow - 10));
          labelG.append(svgEl("text", {
            x: calloutX,
            y: calloutY,
            "text-anchor": hasRightRoom ? "start" : "end",
            class: "ocq-chart-callout is-danger"
          }, `\u9884\u8BA1 ${formatCnDate(monthly.projectedHitAt)} \u8017\u5C3D`));
        }
      } else if (monthly.projectedEndUsed !== null) {
        const remEnd = Math.max(0, Math.round((100 - monthly.projectedEndUsed) * 10) / 10);
        const yEnd = yOf(remEnd);
        const fcArea = `M ${xNow.toFixed(1)} ${yZero.toFixed(1)} L ${xNow.toFixed(1)} ${yNow.toFixed(1)} L ${xEnd.toFixed(1)} ${yEnd.toFixed(1)} L ${xEnd.toFixed(1)} ${yZero.toFixed(1)} Z`;
        plotG.append(svgEl("path", { d: fcArea, fill: `url(#${uid}-fc)` }));
        plotG.append(svgEl("line", {
          x1: xNow,
          y1: yNow,
          x2: xEnd,
          y2: yEnd,
          class: "ocq-chart-forecast"
        }));
        if (inPlotX(xEnd)) {
          plotG.append(svgEl("circle", { cx: xEnd, cy: yEnd, r: 4, class: "ocq-chart-dot-end" }));
          labelG.append(svgEl("text", {
            x: xEnd,
            y: Math.max(PAD_T + 10, yEnd - 17),
            "text-anchor": "end",
            class: "ocq-chart-callout"
          }, `\u9884\u8BA1\u5269 ${formatPercent(remEnd)}%`));
        }
      }
    } else if (monthly.projectedEndUsed !== null) {
      const yEnd = yOf(endUsedVal);
      const fcArea = `M ${xNow.toFixed(1)} ${yZero.toFixed(1)} L ${xNow.toFixed(1)} ${yNow.toFixed(1)} L ${xEnd.toFixed(1)} ${yEnd.toFixed(1)} L ${xEnd.toFixed(1)} ${yZero.toFixed(1)} Z`;
      plotG.append(svgEl("path", { d: fcArea, fill: `url(#${uid}-fc)` }));
      plotG.append(svgEl("path", { d: fcArea, fill: `url(#${uid}-hatch)` }));
      plotG.append(svgEl("line", {
        x1: xNow,
        y1: yNow,
        x2: xEnd,
        y2: yEnd,
        class: "ocq-chart-forecast"
      }));
      if (xHit !== null && monthly.projectedHitAt !== null && inPlotX(xHit)) {
        const yLimit = yOf(100);
        plotG.append(svgEl("circle", { cx: xHit, cy: yLimit, r: 4.5, class: "ocq-chart-dot-hit" }));
        const hitLabelX = Math.max(PAD_L + 44, Math.min(PAD_L + PLOT_W - 64, xHit));
        labelG.append(svgEl("text", {
          x: hitLabelX,
          y: yLimit - 11,
          "text-anchor": "middle",
          class: "ocq-chart-callout"
        }, `\u9884\u8BA1 ${formatCnDate(monthly.projectedHitAt)} \u89E6\u9876`));
      }
      if (inPlotX(xEnd)) {
        plotG.append(svgEl("circle", { cx: xEnd, cy: yEnd, r: 4, class: "ocq-chart-dot-end" }));
        labelG.append(svgEl("text", {
          x: xEnd + 4,
          y: Math.max(PAD_T + 10, yEnd - 10),
          "text-anchor": "end",
          class: "ocq-chart-callout"
        }, `\u9884\u8BA1 ${formatPercent(endUsedVal)}%`));
      }
    }
    if (inPlotX(xNow)) {
      plotG.append(svgEl("circle", { cx: xNow, cy: yNow, r: 4.5, class: "ocq-chart-dot-actual" }));
    }
    if (this.hoverTs !== null && !this.dragging) {
      const hx = xOf(this.hoverTs);
      const info = evalSeriesAt(this.hoverTs, monthly, showRemaining);
      if (info && inPlotX(hx)) {
        const hy = yOf(info.plotYVal);
        plotG.append(svgEl("line", { x1: hx, y1: PAD_T, x2: hx, y2: yZero, class: "ocq-chart-hover-line" }));
        plotG.append(svgEl("circle", { cx: hx, cy: hy, r: 4, class: `ocq-chart-hover-dot is-${info.kind}` }));
        const tsText = formatMDHM(this.hoverTs);
        if (info.kind === "gap") {
          this.hoverTip.textContent = `${tsText} \xB7 \u7A7A\u6863\u671F\uFF08\u9884\u6D4B\u5DF2\u8017\u5C3D 0%\uFF09`;
        } else {
          const prefix = info.kind === "forecast" ? "\u9884\u6D4B" : "\u5B9E\u9645";
          this.hoverTip.textContent = showRemaining ? `${tsText} \xB7 ${prefix}\u5269\u4F59 ${formatPercent(info.rem)}%\uFF08\u5DF2\u7528 ${formatPercent(info.used)}%\uFF09` : `${tsText} \xB7 ${prefix}\u5DF2\u7528 ${formatPercent(info.used)}%\uFF08\u5269 ${formatPercent(info.rem)}%\uFF09`;
        }
        this.hoverTip.hidden = false;
        const pctX = hx / VIEW_W * 100;
        if (pctX > 56) {
          this.hoverTip.style.left = "auto";
          this.hoverTip.style.right = `${Math.max(1, 100 - pctX + 1.5).toFixed(2)}%`;
        } else {
          this.hoverTip.style.right = "auto";
          this.hoverTip.style.left = `${Math.max(1, pctX + 1.5).toFixed(2)}%`;
        }
      } else {
        this.hoverTip.hidden = true;
      }
    } else {
      this.hoverTip.hidden = true;
    }
    svg.append(plotG, labelG);
    this.axisInner.replaceChildren();
    for (const tick of ticks) {
      const el = h("span", tick.cls, tick.label);
      el.style.left = `${(tick.ratio * 100).toFixed(2)}%`;
      this.axisInner.append(el);
    }
    this.avgEl.replaceChildren(
      h("span", "", "\u65E5\u5747\u6D88\u8017"),
      h("strong", "", `${formatPercent(monthly.dailyRate)}%`),
      h("span", "", monthly.sampleCount >= 2 ? `\uFF08\u57FA\u4E8E\u672C\u5730 ${monthly.sampleCount} \u6761\u8BB0\u5F55\uFF09` : "\uFF08\u6309\u672C\u5468\u671F\u5DF2\u7528\u4F30\u7B97\uFF09"),
      h("span", "ocq-zoom-hint", zoomed ? "\xB7 \u5DE6\u952E\u62D6\u52A8 / \u53CC\u51FB\u8FD8\u539F" : "\xB7 \u6EDA\u8F6E\u7F29\u653E")
    );
    this.legendEl.replaceChildren();
    const addLegend = (cls, label) => {
      const item = h("span", "ocq-legend-item");
      item.append(h("span", `ocq-legend-swatch${cls ? ` ${cls}` : ""}`), h("span", "", label));
      this.legendEl.append(item);
    };
    addLegend("", showRemaining ? "\u5B9E\u9645\u4F59\u91CF" : "\u5B9E\u9645\u7528\u91CF");
    addLegend("is-forecast", "\u9884\u6D4B\u8D8B\u52BF\uFF08\u865A\u7EBF\uFF09");
    addLegend("is-limit", showRemaining ? "0% \u8017\u5C3D\u7EBF" : "\u6708\u5EA6\u4E0A\u9650 100%");
  }
};
function structureSignature(sources) {
  return sources.map((source) => [
    source.name,
    source.endpoints.join(","),
    source.keyHint ?? "",
    source.windows ? "ok" : source.error ? "err" : "wait"
  ].join("|")).join("||");
}
var quotaPanel = {
  mount(ctx) {
    const { ui } = ctx;
    let snapshot = null;
    let displayMode = ctx.memo.get("displayMode", "used") === "remaining" ? "remaining" : "used";
    let busy = false;
    let modeEpoch = 0;
    let renderedSig = "";
    let renderedCards = [];
    const root = ui.h("div", "ocq-root");
    ctx.root.append(root);
    const toolbar = ui.h("div", "ocq-toolbar");
    const head = ui.h("div", "ocq-head");
    const titleRow = ui.h("div", "ocq-title-row");
    const title = ui.h("h3", "ocq-title", "\u8BA2\u9605\u989D\u5EA6");
    const headBadge = ui.h("span", "ocq-head-badge");
    headBadge.hidden = true;
    titleRow.append(title, headBadge);
    const subtitle = ui.h("p", "ocq-subtitle", "\u6BCF 5 \u5C0F\u65F6\u3001\u6BCF\u5468\u3001\u6BCF\u6708\u4E09\u4E2A\u7A97\u53E3\u7684\u5B9E\u65F6\u989D\u5EA6\u3001\u91CD\u7F6E\u5012\u8BA1\u65F6\u4E0E\u6708\u5EA6\u8D8B\u52BF\u9884\u6D4B\u3002");
    head.append(titleRow, subtitle);
    const controls = ui.h("div", "ocq-controls");
    const modeSwitch = ui.segmented(
      [
        { value: "remaining", label: "\u5269\u4F59\u989D\u5EA6" },
        { value: "used", label: "\u5DF2\u7528\u989D\u5EA6" }
      ],
      {
        value: displayMode,
        size: "sm",
        onSelect: (value) => void switchDisplayMode(value === "remaining" ? "remaining" : "used")
      }
    );
    const refreshBtn = ui.h("button", "ocq-refresh");
    refreshBtn.type = "button";
    const refreshLbl = ui.h("span", "", "\u7ACB\u5373\u5237\u65B0");
    refreshBtn.append(refreshIcon(), refreshLbl);
    refreshBtn.addEventListener("click", () => void load("read"), { signal: ctx.signal });
    controls.append(modeSwitch.el, refreshBtn);
    toolbar.append(head, controls);
    const message = ui.msgline();
    const cardsBox = ui.h("div", "ocq-cards");
    const footer = ui.h("div", "ocq-footer");
    root.append(toolbar, message, cardsBox, footer);
    function setLoading(loading) {
      refreshBtn.disabled = loading;
      refreshBtn.classList.toggle("is-loading", loading);
      refreshBtn.setAttribute("aria-busy", String(loading));
      refreshLbl.textContent = loading ? "\u8BFB\u53D6\u4E2D\u2026" : "\u7ACB\u5373\u5237\u65B0";
    }
    function paintCountdowns() {
      const now = Date.now();
      for (const card of renderedCards) {
        for (const tile of card.tiles) {
          const resetMs = Date.parse(tile.resetsAt);
          const left = Number.isFinite(resetMs) ? resetMs - now : NaN;
          if (tile.status === "rate-limited") {
            tile.resetText.textContent = Number.isFinite(left) && left > 0 ? `\u5DF2\u8FBE\u4E0A\u9650 \xB7 ${duration(left)} \u540E\u91CD\u7F6E` : "\u5DF2\u8FBE\u4E0A\u9650";
          } else if (!Number.isFinite(left) || left <= 0) {
            tile.resetText.textContent = "\u5373\u5C06\u91CD\u7F6E";
          } else {
            tile.resetText.textContent = `${duration(left)} \u540E\u91CD\u7F6E`;
          }
          if (Number.isFinite(resetMs)) {
            tile.foot.title = `\u9884\u8BA1\u91CD\u7F6E\u65F6\u95F4\uFF1A${new Date(resetMs).toLocaleString()}`;
          }
        }
      }
    }
    function buildCard(source) {
      const card = ui.h("div", "ocq-card");
      const cardHead = ui.h("div", "ocq-card-head");
      const ident = ui.h("div", "ocq-card-ident");
      const identRow = ui.h("div", "ocq-card-title-row");
      const icoWrap = ui.h("span", "ocq-key-ico");
      icoWrap.append(keyIcon());
      const displayTitle = source.name === "manual" && source.endpoints.length === 0 ? "\u624B\u52A8\u914D\u7F6E Key" : source.name;
      const cardTitle = ui.h("span", "ocq-card-title", displayTitle);
      cardTitle.title = displayTitle;
      const keyHint = ui.h("span", "ocq-key-hint", source.keyHint ?? "");
      keyHint.hidden = !source.keyHint;
      identRow.append(icoWrap, cardTitle, keyHint);
      ident.append(identRow);
      const showProviders = source.endpoints.length > 1 || source.endpoints.length === 1 && source.endpoints[0] !== source.name;
      if (showProviders) {
        const provRow = ui.h("div", "ocq-providers");
        provRow.append(ui.h("span", "ocq-providers-label", "\u5171\u7528\u6B64 Key"));
        for (const ep of source.endpoints) {
          provRow.append(ui.h("span", "ocq-provider-tag", ep));
        }
        ident.append(provRow);
      }
      const meta = ui.h("div", "ocq-card-meta");
      const statusPill = ui.h("span", "ocq-status");
      const statusDot = ui.h("span", "ocq-status-dot");
      const statusText = ui.h("span");
      statusPill.append(statusDot, statusText);
      const timeEl = ui.h("span", "ocq-card-time");
      meta.append(statusPill, timeEl);
      cardHead.append(ident, meta);
      card.append(cardHead);
      let staleBanner = null;
      let staleText = null;
      let errorText = null;
      let trend = null;
      const tiles = [];
      if (source.windows) {
        staleBanner = ui.h("div", "ocq-stale-banner");
        staleText = ui.h("span");
        staleBanner.append(alertIcon(), staleText);
        staleBanner.hidden = !source.error;
        card.append(staleBanner);
        const grid = ui.h("div", "ocq-windows");
        for (const window2 of WINDOWS) {
          const tileEl = ui.h("div", "ocq-win");
          const top = ui.h("div", "ocq-win-top");
          const nameWrap = ui.h("span", "ocq-win-name");
          nameWrap.append(ui.h("span", "ocq-dot"), ui.h("span", "", windowLabel(window2)));
          const badge = ui.h("span", "ocq-win-badge");
          top.append(nameWrap, badge);
          const metric = ui.h("div", "ocq-win-metric");
          const val = ui.h("div", "ocq-win-val");
          const valNum = ui.h("span", "", "0");
          const valUnit = ui.h("span", "ocq-win-unit", "%");
          val.append(valNum, valUnit);
          const sub = ui.h("span", "ocq-win-sub");
          metric.append(val, sub);
          const track = ui.h("div", "ocq-bar-track");
          track.setAttribute("role", "progressbar");
          track.setAttribute("aria-valuemin", "0");
          track.setAttribute("aria-valuemax", "100");
          const clip = ui.h("div", "ocq-bar-clip");
          const fill = ui.h("div", "ocq-bar-fill");
          clip.append(fill);
          const mark = ui.h("div", "ocq-bar-mark");
          track.append(clip, mark);
          const foot = ui.h("div", "ocq-win-foot");
          const resetText = ui.h("span");
          foot.append(clockIcon(), resetText);
          tileEl.append(top, metric, track, foot);
          grid.append(tileEl);
          tiles.push({
            window: window2,
            el: tileEl,
            badge,
            valNum,
            sub,
            track,
            fill,
            mark,
            foot,
            resetText,
            resetsAt: source.windows[window2].resetsAt,
            status: source.windows[window2].status
          });
        }
        card.append(grid);
        trend = new TrendChartView(ui.h.bind(ui), ctx.signal);
        card.append(trend.el);
      } else if (source.error) {
        const errBox = ui.h("div", "ocq-error-box");
        errorText = ui.h("span", "", `\u65E0\u6CD5\u8BFB\u53D6\u989D\u5EA6\uFF1A${source.error}`);
        errBox.append(alertIcon(), errorText);
        card.append(errBox);
      } else {
        card.append(ui.h("div", "ocq-waiting", "\u6B63\u5728\u7B49\u5F85\u9996\u6B21\u989D\u5EA6\u6570\u636E\u2026"));
      }
      return { el: card, statusPill, statusText, timeEl, staleBanner, staleText, errorText, tiles, trend };
    }
    function updateCard(refs, source, alertAt, cardIndex) {
      const remainingAlert = clampPercent(100 - alertAt);
      if (source.readAt) {
        refs.timeEl.textContent = new Date(source.readAt).toLocaleTimeString();
        refs.timeEl.hidden = false;
      } else {
        refs.timeEl.textContent = "";
        refs.timeEl.hidden = true;
      }
      let cardStatus = "idle";
      if (source.windows) {
        if (refs.staleBanner && refs.staleText) {
          refs.staleBanner.hidden = !source.error;
          refs.staleText.textContent = source.error ? `\u6700\u8FD1\u4E00\u6B21\u5237\u65B0\u5931\u8D25\uFF0C\u5F53\u524D\u663E\u793A\u7F13\u5B58\u6570\u636E\uFF1A${source.error}` : "";
        }
        const severities = [];
        for (const tile of refs.tiles) {
          const state = source.windows[tile.window];
          const used = clampPercent(state.percent);
          const left = clampPercent(100 - used);
          const sev = severityOf(used, alertAt, state.status);
          severities.push(sev);
          tile.resetsAt = state.resetsAt;
          tile.status = state.status;
          tile.el.className = `ocq-win is-${sev}`;
          const showRemaining = displayMode === "remaining";
          const primary = showRemaining ? left : used;
          tile.valNum.textContent = formatPercent(primary);
          tile.sub.textContent = showRemaining ? `\u5DF2\u7528 ${formatPercent(used)}%` : `\u5269\u4F59 ${formatPercent(left)}%`;
          tile.badge.textContent = sev === "limit" ? "\u5DF2\u8FBE\u4E0A\u9650" : sev === "warn" ? "\u544A\u8B66" : showRemaining ? "\u5269\u4F59" : "\u5DF2\u7528";
          tile.fill.style.width = `${primary}%`;
          tile.fill.classList.toggle("has-value", primary > 0);
          tile.track.setAttribute("aria-valuenow", formatPercent(primary));
          tile.track.setAttribute(
            "aria-label",
            `${windowLabel(tile.window)} ${showRemaining ? `\u5269\u4F59 ${formatPercent(left)}%` : `\u5DF2\u7528 ${formatPercent(used)}%`}`
          );
          const markPos = showRemaining ? remainingAlert : clampPercent(alertAt);
          tile.mark.style.left = `${markPos}%`;
          tile.mark.title = `\u544A\u8B66\u7EBF\uFF1A\u5DF2\u7528 ${alertAt}%\uFF08\u5269\u4F59 ${remainingAlert}%\uFF09`;
        }
        refs.trend?.update(source.monthly, displayMode, cardIndex);
        cardStatus = source.error ? "error" : worstSeverity(severities);
      } else if (source.error) {
        cardStatus = "error";
        if (refs.errorText) refs.errorText.textContent = `\u65E0\u6CD5\u8BFB\u53D6\u989D\u5EA6\uFF1A${source.error}`;
      }
      refs.el.className = `ocq-card is-${cardStatus}`;
      refs.statusPill.className = `ocq-status is-${cardStatus}`;
      refs.statusText.textContent = source.windows && source.error ? "\u7F13\u5B58 \xB7 \u5237\u65B0\u5931\u8D25" : statusLabel(cardStatus);
    }
    function paintHeaderBadge(snap) {
      const keyCount = snap.sources.length;
      const epCount = snap.totalEndpoints;
      if (keyCount > 1 && epCount > keyCount) {
        headBadge.textContent = `${epCount} \u4E2A Provider \u2192 ${keyCount} \u628A\u72EC\u7ACB Key`;
        headBadge.hidden = false;
      } else if (keyCount > 1) {
        headBadge.textContent = `\u5171 ${keyCount} \u628A\u72EC\u7ACB Key`;
        headBadge.hidden = false;
      } else if (keyCount === 1 && epCount > 1) {
        headBadge.textContent = `${epCount} \u4E2A Provider \u5171\u7528 1 \u628A Key`;
        headBadge.hidden = false;
      } else {
        headBadge.textContent = "";
        headBadge.hidden = true;
      }
    }
    function paintFooter(snap) {
      footer.replaceChildren();
      const latest = snap.sources.map((source) => source.readAt).filter((value) => Boolean(value)).sort().at(-1);
      const remainingAlert = clampPercent(100 - snap.alertAt);
      const items = [
        latest ? `\u6700\u8FD1\u67E5\u8BE2 ${new Date(latest).toLocaleTimeString()}` : "\u5C1A\u672A\u8BFB\u5230\u989D\u5EA6\u6570\u636E",
        `\u6BCF ${snap.pollMinutes} \u5206\u949F\u81EA\u52A8\u8BFB\u53D6`,
        `\u672C\u5730\u5386\u53F2\u4FDD\u7559 ${snap.retainDays ?? 35} \u5929`,
        displayMode === "remaining" ? `\u544A\u8B66\u7EBF\uFF1A\u5269\u4F59 \u2264 ${remainingAlert}%` : `\u544A\u8B66\u7EBF\uFF1A\u5DF2\u7528 \u2265 ${snap.alertAt}%`
      ];
      items.forEach((item, index) => {
        if (index > 0) footer.append(ui.h("span", "ocq-foot-dot"));
        footer.append(ui.h("span", "ocq-foot-item", item));
      });
    }
    function paintEmpty() {
      renderedSig = "__empty__";
      renderedCards = [];
      cardsBox.replaceChildren();
      const empty = ui.h("div", "ocq-empty");
      const ico = ui.h("div", "ocq-empty-ico");
      ico.append(keyIcon());
      empty.append(
        ico,
        ui.h("div", "ocq-empty-title", "\u8FD8\u6CA1\u6709\u53EF\u76D1\u63A7\u7684 OpenCode Key"),
        ui.h("div", "ocq-empty-desc", "\u914D\u7F6E\u4EFB\u610F OpenCode Go \u4F9B\u5E94\u5546\u7AEF\u70B9\uFF0C\u6216\u5728\u300C\u914D\u7F6E\u300D\u9875\u7B7E\u586B\u5199\u7F51\u5173\u5730\u5740\u4E0E API Key \u540E\u5373\u53EF\u5728\u6B64\u67E5\u770B\u989D\u5EA6\u3002")
      );
      cardsBox.append(empty);
    }
    function paintAll() {
      if (!snapshot) return;
      paintHeaderBadge(snapshot);
      const { sources, alertAt } = snapshot;
      if (!sources.length) {
        paintEmpty();
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
        updateCard(renderedCards[i], sources[i], alertAt, i);
      }
      paintCountdowns();
      paintFooter(snapshot);
    }
    async function switchDisplayMode(next) {
      const epoch = ++modeEpoch;
      displayMode = next;
      ctx.memo.set("displayMode", next);
      modeSwitch.setValue(next);
      if (snapshot) {
        snapshot = { ...snapshot, displayMode: next };
        paintAll();
      }
      try {
        try {
          await ctx.setConfig(CONFIG_GROUP_ID, { [DISPLAY_MODE_KEY]: next });
        } catch {
          await ctx.invoke("mode", [next]);
        }
        if (ctx.signal.aborted || epoch !== modeEpoch) return;
        await ctx.refresh();
      } catch (error) {
        if (ctx.signal.aborted) return;
        message.textContent = String(error);
        message.classList.add("bad");
      }
    }
    async function load(method) {
      if (busy) return;
      busy = true;
      const epochAtStart = modeEpoch;
      if (method === "read") setLoading(true);
      message.classList.remove("bad");
      try {
        const nextSnap = await ctx.invoke(method);
        if (ctx.signal.aborted) return;
        if (epochAtStart === modeEpoch && (nextSnap.displayMode === "used" || nextSnap.displayMode === "remaining")) {
          displayMode = nextSnap.displayMode;
          ctx.memo.set("displayMode", displayMode);
          modeSwitch.setValue(displayMode);
        }
        snapshot = { ...nextSnap, displayMode };
        paintAll();
        message.textContent = "";
        if (method === "read") void ctx.refresh();
      } catch (error) {
        if (ctx.signal.aborted) return;
        message.textContent = String(error);
        message.classList.add("bad");
      } finally {
        busy = false;
        if (!ctx.signal.aborted && method === "read") setLoading(false);
      }
    }
    void load("state");
    ctx.interval(() => void load("state"), 15e3);
    ctx.interval(paintCountdowns, 1e3);
  }
};
var client_default = { panels: { [QUOTA_PANEL]: quotaPanel } };
export {
  client_default as default,
  quotaPanel
};
