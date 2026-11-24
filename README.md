# cortico-world-opencode-quota

Owner: `src/definition.ts`

读取 OpenCode Go 订阅额度的 World。三个窗口——每 5 小时、每周、每月——由网关报告；这个 World 定时读一遍，把越线与重置按低打扰规则交给 bot，并在面板展示实时进度与月度本地趋势预测。

密钥严格遵守 Cortico 密钥隔离规范：本 World 不扫描其他供应商目录，也不在 `config.json` 存明文密钥；所有 API Key 均在「额度」面板中通过框架 `ctx.storeSecret()` 写入本部署 `.env`（仅本人可读），运行时只经 `ctx.secret()` 读取。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`：默认值、`create()`、自描述 |
| `src/config.ts` | 配置段（不含明文密钥）与配置组 |
| `src/world.ts` | 实例：密钥管理、轮询、越线判断、两个工具、环境提示词取值 |
| `src/gateway.ts` | 网关地址校验与 `/go/v1/usage` 安全读取（不碰文件系统与环境变量） |
| `src/history.ts` | 额度历史的缓存、压缩追加、趋势预测与原子裁剪 |
| `src/ENV_PROMPT.md` | 进 system 前缀的环境提示词 |

## 安装

Coopanion 里：高级模式 →「扩展」→ 填包名 `cortico-world-opencode-quota`（可带版本，如 `cortico-world-opencode-quota@0.3.1`），装好重启进程，再到「World 总览」启用。改本地目录时，扩展页填包目录的绝对路径即可挂 link，改完源码同样是重启生效。

- npm：https://www.npmjs.com/package/cortico-world-opencode-quota
- 仓库：https://github.com/Unnori/cortico-world-opencode-quota
- 许可证：MIT

## 启用与添加密钥

World 默认是关的。装好之后到**高级模式 → World 总览**把它激活，然后打开「OpenCode 额度」页签：

1. **在面板中直接添加（推荐）**：首次未配置密钥时，「OpenCode Go 密钥管理」卡片会自动展开；输入可选名称（如「主力账号」）并粘贴你的 OpenCode Go API Key，点击「添加并查询」即可。
   - 密钥由 Cortico 框架通过 `ctx.storeSecret()` 写入本部署 `.env`（变量名形如 `OPENCODE_QUOTA_KEY_1`、`OPENCODE_QUOTA_KEY_2`…，绝不与供应商的 `OPENCODE_API_KEY` 冲突）；
   - `config.json` 的 `worlds.opencode-quota.keys` 仅保存非敏感的展示名与变量名，绝不存明文密钥；
   - 支持添加多把不同 Key 分卡监控，也支持随时改名、更换密钥或移除条目；内容相同的多把 Key 会自动去重合并为单次请求与单张卡片。
2. **手动在部署 `.env` 中配置**：也可以直接在本部署目录的 `.env` 里添加 `OPENCODE_QUOTA_API_KEY=<你的密钥>`（无需打开面板，启用即自动识别）。

## 配置

只有一组八项（不含明文密钥）：

| 项 | 说明 |
|---|---|
| 读取间隔 | 分钟，1–180，默认 1。启动时定下，改动需重启本 World |
| 告警线 | 任一窗口已用比例到这个百分比提醒一次；一直在线以上不重复提醒 |
| 推送额度事件 | 关掉后只留工具、面板与历史，不向 bot 推送越线与额度刷新事件 |
| 额度刷新投递规则 | 窗口重置事件投递方式，默认 `piggyback`（静默搭车、不单独叫醒 bot）；可选全部 5 种宿主规则，热生效 |
| 越线告警投递规则 | 越过告警线事件投递方式，默认 `piggyback`；需要主动唤醒可改为 `debounce` 或 `flush`，热生效 |
| 显示模式 | `used`（按已用额度显示）或 `remaining`（按剩余额度显示）；也可在额度面板顶部一键切换 |
| 本地历史保留天数 | 7–365 天，默认 35 天（覆盖完整自然月周期），热生效 |
| 网关地址 | OpenCode Go 网关地址，默认 `https://opencode.ai/inference` |

## 工具

| 工具 | 做什么 |
|---|---|
| `ocq_read` | 读此刻三个窗口的已用与剩余百分比及重置倒计时；可只读一个来源 |
| `ocq_history` | 看本地记录（默认按保留天数，最多 365 天）的样本数、峰值、最新已用/剩余值与本月日均消耗 |

两个都只读，不消耗额度。

## 事件

| type | 何时 | 默认投递规则 |
|---|---|---|
| `opencode-quota.threshold` | 某个窗口**刚**越过告警线 | `piggyback`（可在配置中改） |
| `opencode-quota.reset` | 某个窗口用量显著回落（额度刷新/新窗口开始） | `piggyback`（可在配置中改） |
| `opencode-quota.unavailable` | 某个来源读不到；同一个原因只报一次 | 仅入库（`deliver: false`） |

越线与刷新事件默认按 `piggyback` 静默入队、不单独唤醒 bot，等下一次有其他事件或对话时搭便车带入上下文；如需调整可在配置页从宿主 5 种投递规则（`piggyback` / `debounce` / `flush` / `preempt` / `interrupt`）中任选。

## 面板

World 页有一块纯中文「订阅额度」面板、页头三颗四态灯与顶部读数徽标：

- **密钥管理**：顶部点击「管理密钥」可展开/收起管理卡片，添加、改名、更换或移除 OpenCode Go API Key，页面仅显示脱敏尾标（`••••xxxx`）。
- **双模式切换**：顶部提供「剩余额度 / 已用额度」分段开关，点击后立即切换面板读数、进度条方向、告警线刻度、月度折线图以及页头徽标与状态灯提示，并自动持久化到配置。
- **按 Key 卡片展示**：每把独立 Key 渲染一张卡片，内含每 5 小时 / 每周 / 每月三列指标卡、进度条与告警线刻度、每秒走本地时钟的重置倒计时。偶发网络失败时保留上次有效缓存并显示轻量提醒。
- **月度本地趋势与预测折线图**：基于本地 JSONL 历史记录绘制当前月度周期的实际曲线与虚线预测（页面明确标明虚线为预测值，并展示日均消耗）。支持鼠标滚轮缩放、左键拖动平移、双击/按钮重置缩放与悬停读数，放大后横轴自动细化到日/小时刻度。切换为「剩余额度」模式时，若预测曲线在周期内跌破 0%，曲线停在预计耗尽日并标出预测日期，后段留出空档直至订阅重置日。
- **四态灯与徽标**：按用量换色（绿充足、黄过半、红过告警线、灰已达上限）；多把 Key 时按各窗口最紧状态聚合，并在页头显示独立 Key 数量。
- **打开不联网**：先读 World 已经轮询到的快照，之后每 15 秒跟着刷新；只有点击「立即刷新」或新增/更换密钥时才会让 World 读一次网关。

## 历史文件

`<部署数据目录>/opencode-quota-history.jsonl`，采用内存索引缓存、变化去重 + 30 分钟心跳压缩、原子替换裁剪与不可逆 `keyId` 指纹绑定（改名不断历史、换 Key 不串曲线，无缝兼容旧记录），默认保留 35 天（可在配置中调整为 7–365 天）。World 页的「数据清理」页签能看条数并清空。

## 已知限制

- 仅适用于 OpenCode Go 订阅（提供 `/go/v1/usage` 额度窗口的账户）。
- 越线判断用内存里的上一次读数，进程重启后第一次只记基线、不报警——避免重启就喊一次。
- 在面板中移除密钥会将其从 `worlds.opencode-quota.keys` 停止监控，不再读取该环境变量；如需彻底清除 `.env` 里的旧行，可手动编辑本部署 `.env`。

## 校验

```bash
pnpm typecheck && pnpm typecheck:web && pnpm test
```

```bash
cd <Cortico 仓库根>
pnpm describe:extension <包目录>
pnpm check:extension <包目录>
```
