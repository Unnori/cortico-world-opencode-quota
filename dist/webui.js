// src/webui/protocol.ts
var QUOTA_PANEL = "quota";

// src/webui/client.ts
var WINDOWS = ["rolling", "weekly", "monthly"];
var FULL = 100;
var zh = {
  title: "\u8BA2\u9605\u989D\u5EA6",
  desc: "\u6BCF 5 \u5C0F\u65F6\u3001\u6BCF\u5468\u3001\u6BCF\u6708\u4E09\u4E2A\u7A97\u53E3\u7684\u7528\u91CF\u4E0E\u91CD\u7F6E\u65F6\u95F4\u3002",
  refresh: "\u7ACB\u5373\u5237\u65B0",
  reading: "\u6B63\u5728\u8BFB\u53D6\u2026",
  rolling: "\u6BCF 5 \u5C0F\u65F6",
  weekly: "\u6BCF\u5468",
  monthly: "\u6BCF\u6708",
  resetsIn: (text2) => `${text2}\u540E\u91CD\u7F6E`,
  atLimit: "\u5DF2\u8FBE\u4E0A\u9650",
  readAt: (time) => `\u67E5\u8BE2\u4E8E ${time}`,
  notRead: "\u8FD8\u6CA1\u8BFB\u5230\u6570\u636E\u3002",
  autoEvery: (minutes) => `\u6BCF ${minutes} \u5206\u949F\u81EA\u52A8\u8BFB\u53D6`,
  alertAt: (percent) => `\u544A\u8B66\u7EBF ${percent}%`,
  unreadable: (reason) => `\u8BFB\u4E0D\u5230:${reason}`
};
var en = {
  title: "Subscription allowance",
  desc: "Usage and reset times for the 5-hour, weekly and monthly windows.",
  refresh: "Refresh now",
  reading: "Reading\u2026",
  rolling: "Every 5 hours",
  weekly: "Weekly",
  monthly: "Monthly",
  resetsIn: (text2) => `resets in ${text2}`,
  atLimit: "at the limit",
  readAt: (time) => `read at ${time}`,
  notRead: "Nothing has been read yet.",
  autoEvery: (minutes) => `reads every ${minutes} min`,
  alertAt: (percent) => `alert at ${percent}%`,
  unreadable: (reason) => `unreadable: ${reason}`
};
var text = (language) => language === "zh" || language === "zh-Hant" ? zh : en;
var windowLabel = (S, window) => window === "rolling" ? S.rolling : window === "weekly" ? S.weekly : S.monthly;
function duration(ms) {
  const minutes = Math.floor(ms / 6e4);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}
var quotaPanel = {
  mount(ctx) {
    const S = text(ctx.language);
    const { ui } = ctx;
    let snapshot = null;
    let busy = false;
    let rows = [];
    const sheet = ui.sheet({ title: S.title, desc: S.desc });
    ctx.root.append(sheet.el);
    const bar = ui.rowbar();
    const refresh = ui.button(S.refresh, { size: "sm", variant: "plain", onClick: () => void load("read") });
    const message = ui.msgline();
    bar.append(refresh, message);
    sheet.body.append(bar);
    const body = ui.h("div", "quota-body");
    sheet.body.append(body);
    const foot = ui.h("div", "quota-foot");
    sheet.body.append(foot);
    function paintLabels() {
      const now = Date.now();
      for (const row of rows) {
        const label = windowLabel(S, row.window);
        const left = Date.parse(row.resetsAt) - now;
        const state = row.status === "rate-limited" ? S.atLimit : S.resetsIn(duration(Math.max(0, left)));
        row.progress.setLabel(`${label} \xB7 ${state}`);
      }
    }
    function paintSource(source, into, alertAt) {
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
        const progress = ui.progress({ value: state.percent, max: FULL, tone: state.percent >= alertAt ? "warn" : "accent" });
        progress.setValue(state.percent, FULL);
        into.append(progress.el);
        rows.push({ window, progress, resetsAt: state.resetsAt, status: state.status });
      }
    }
    function paintAll() {
      if (!snapshot) return;
      body.replaceChildren();
      rows = [];
      const sources = snapshot.sources;
      if (!sources.length) {
        body.append(ui.placeholder(S.notRead));
        foot.textContent = "";
        return;
      }
      for (const source of sources) {
        if (sources.length > 1) body.append(ui.section(source.name));
        paintSource(source, body, snapshot.alertAt);
      }
      paintLabels();
      const latest = sources.map((source) => source.readAt).filter((value) => Boolean(value)).sort().at(-1);
      foot.textContent = [
        latest ? S.readAt(new Date(latest).toLocaleTimeString()) : S.notRead,
        S.autoEvery(snapshot.pollMinutes),
        S.alertAt(snapshot.alertAt)
      ].join(" \xB7 ");
    }
    async function load(method) {
      if (busy) return;
      busy = true;
      if (method === "read") message.textContent = S.reading;
      message.classList.remove("bad");
      try {
        snapshot = await ctx.invoke(method);
        paintAll();
        message.textContent = "";
      } catch (error) {
        message.textContent = String(error);
        message.classList.add("bad");
      } finally {
        busy = false;
      }
    }
    void load("state");
    ctx.interval(() => void load("state"), 15e3);
    ctx.interval(paintLabels, 1e3);
  }
};
var client_default = { panels: { [QUOTA_PANEL]: quotaPanel } };
export {
  client_default as default,
  quotaPanel
};
