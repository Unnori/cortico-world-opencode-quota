/**
 * 面板与服务端之间的数据形状。两侧都 `import type`,打包时整段消失。
 */
import type { DisplayMode, Window } from '../config.ts';
import type { WindowState } from '../gateway.ts';

/** 本页唯一的自定义面板 id。服务端与浏览器端都从这里取,免得两处写同一个字符串。 */
export const QUOTA_PANEL = 'quota';

/** 月度趋势图里的单个历史采样点。 */
export interface MonthlyPoint {
  /** 毫秒时间戳。 */
  ts: number;
  /** 月度已用百分比(0–100)。 */
  used: number;
}

/** 基于本地记录推算出的月度用量曲线与线性预测。 */
export interface MonthlySeries {
  /** 本月计费周期起点(重置时刻往前推 1 个自然月,毫秒)。 */
  cycleStart: number;
  /** 本月计费周期结束 / 重置时刻(毫秒)。 */
  cycleEnd: number;
  /** 本次计算对应的当前时刻(毫秒)。 */
  now: number;
  /** 当前月度已用百分比(0–100)。 */
  currentUsed: number;
  /** 实际记录折线点(按时间升序,末尾为此刻实测值)。 */
  points: MonthlyPoint[];
  /** 本周期内命中的本地历史条数。 */
  sampleCount: number;
  /** 周期至今的日均消耗(百分点/天)。 */
  dailyRate: number;
  /** 按当前速度预计周期结束时的总消耗百分比(可超过 100%);无消耗或无预测时为 null。 */
  projectedEndUsed: number | null;
  /** 按当前速度预计触顶(已用 100% / 剩余 0%)的时刻(毫秒);周期内不会触顶或已耗尽时为 null。 */
  projectedHitAt: number | null;
}

/** 一把独立密钥对应的额度快照:共享这把 Key 的端点列表、脱敏尾标、三个窗口读数、月度趋势或失败原因。 */
export interface SourceSnapshot {
  name: string;
  /** 共享这把 Key 的 OpenCode Provider 端点名(手填模式为空数组)。 */
  endpoints: string[];
  /** 安全脱敏的密钥尾标(仅末 4 位,如 `••••a1b2`),永不含完整密钥。 */
  keyHint: string | null;
  /** 网关根地址。 */
  gateway: string;
  /** 上次成功读到这个来源的时刻;还没读到过时为 null。 */
  readAt: string | null;
  /** 最近一次读取失败的原因;正常时为 null。有缓存读数时与 windows 共存,用于提示过期缓存。 */
  error: string | null;
  windows: Record<Window, WindowState> | null;
  /** 月度本地记录趋势与虚线预测;尚未读到月度窗口时为 null。 */
  monthly: MonthlySeries | null;
}

export interface QuotaSnapshot {
  /** 告警线,已用百分比。 */
  alertAt: number;
  /** 轮询间隔,分钟。 */
  pollMinutes: number;
  /** 本地历史保留天数。 */
  retainDays: number;
  /** 当前展示模式:已用('used')或剩余('remaining')。 */
  displayMode: DisplayMode;
  /** 去重前发现的 OpenCode Provider 端点总数。 */
  totalEndpoints: number;
  sources: SourceSnapshot[];
}
