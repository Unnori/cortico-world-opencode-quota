# cortico-world-opencode-quota

Owner: `src/definition.ts`

读 OpenCode 订阅额度的 World。三个窗口——每 5 小时、每周、每月——由网关报告;这个 World 定时读一遍,
把越线与重置交给 bot 决定说不说,并留一份可查的历史。

密钥默认从**供应商端点**读,不用输第二次;没有装供应商插件的人可以在配置里手填一把,填了就用它。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`:默认值、`create()`、自描述 |
| `src/config.ts` | 配置段与那唯一的配置组 |
| `src/world.ts` | 实例:轮询、越线判断、两个工具、环境提示词取值 |
| `src/gateway.ts` | 认端点、取密钥、读 `/go/v1/usage` |
| `src/history.ts` | 额度历史的追加、趋势与裁剪 |
| `src/ENV_PROMPT.md` | 进 system 前缀的那一段 |

## 安装

Coopanion 里:高级模式 →「扩展」→ 填包名 `cortico-world-opencode-quota`(可带版本,如 `cortico-world-opencode-quota@0.2.2`),装好重启进程,再到「World 总览」启用。改本地目录时,扩展页填包目录的绝对路径即可挂 link,改完源码同样是重启生效。

- npm:https://www.npmjs.com/package/cortico-world-opencode-quota
- 仓库:https://github.com/Unnori/cortico-world-opencode-quota
- 许可证:MIT

配套的供应商插件是 [`cortico-provider-opencode`](https://github.com/Unnori/cortico-provider-opencode);装了它并配好端点,这个 World 就不用再填密钥。

## 启用

World 默认是关的。装好之后到**高级模式 → World 总览**把它激活;激活时立刻读一遍,之后按「读取间隔」轮询。

## 配置

只有一组五项:

| 项 | 说明 |
|---|---|
| 读取间隔 | 分钟,1–180,默认 1。启动时定下,改动需重启本 World |
| 告警线 | 任一窗口到这个百分比提醒一次;一直在线以上不重复提醒 |
| 越线时提醒 | 关掉后只留工具与历史,不推事件 |
| 网关地址 | 没有供应商端点时读这里,默认 `https://opencode.ai/inference` |
| 手填 API Key | 留空 = 读端点自己声明的密钥;填了就用它 |

## 密钥从哪来

按顺序取第一条非空的:

1. 配置里的**手填 API Key**;
2. 供应商端点自己声明的变量名——进程环境优先,其次该端点目录的 `.env`。

所以:

- 装了本项目的 `cortico-provider-opencode` 并配好端点 → 什么都不用填。
- 没装,或系统里读不到 → 在配置里填网关地址与密钥,一样能用。
- 填了又清空 → 自动回到读端点密钥。

## 读哪些来源

- 部署根下 `providers/<名>/config.json` 里 `kind === "opencode"` 且不按量计费(`options.billing !== "balance"`)的端点,全部监控。
- 一个这样的端点都没有时,用配置里的网关地址 + 手填密钥,来源名是 `manual`。

部署根取 `CORTICO_HOME`,没有时取部署目录的父目录。

## 工具

| 工具 | 做什么 |
|---|---|
| `ocq_read` | 读此刻三个窗口的百分比与重置时间;可只读一个来源 |
| `ocq_history` | 看最近 14 天的样本数、峰值与最新值 |

两个都只读,不消耗额度。

## 事件

| type | 何时 |
|---|---|
| `opencode-quota.threshold` | 某个窗口**刚**越过告警线 |
| `opencode-quota.reset` | 某个窗口的重置时刻变了,即新窗口开始 |
| `opencode-quota.unavailable` | 某个来源读不到;同一个原因只报一次 |

事件按合批投递(`debounce`),越线不值得打断正在进行的回答。

## 面板

World 页有一张「订阅额度」卡片,页头三颗四态灯与三个读数徽标:

- 灯按用量换色:绿充足、黄用了大半、红过告警线、灰已用完;还没读到过时不报灯。
- 三个窗口各一条进度条,标签是「每 5 小时 · 19% · 2h41m 后重置」;倒计时每秒走本地时钟。
- 越过告警线的条与徽标换警示配色。
- 打开面板不联网:先读 World 已经轮询到的快照,之后每 15 秒跟着刷新;只有「立即刷新」会让 World 真的读一次网关。
- 页脚写明上次读取的时刻、轮询间隔与告警线。

## 历史文件

`<部署数据目录>/opencode-quota-history.jsonl`,一行一次读数,保留 14 天。World 页的「数据」页签能看行数并清空。

## 已知限制

- 额度窗口只有 Go 订阅有;按量计费的端点被排除,不是漏读。
- 越线判断用内存里的上一次读数,进程重启后第一次只记基线、不报警——避免重启就喊一次。
- 手填密钥存在 `config.json` 里,不像端点密钥那样单独放在 `.env`;诊断包里键名含 key 的值会被抹掉。
- 事件正文是给 Coo 看的英文,界面文案按 WebUI 语言给。

## 校验

```bash
pnpm typecheck && pnpm test
```

```bash
cd <Cortico 仓库根>
pnpm describe:extension <包目录>
pnpm check:extension <包目录>
```
