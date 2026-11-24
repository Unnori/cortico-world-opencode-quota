/** 额度面板与 World 之间的数据面契约(两边只共享类型与常量)。 */
import type { DisplayMode } from '../config.ts';
import type { Usage } from '../gateway.ts';

export const QUOTA_PANEL = 'quota';

/** 月度趋势图上的单个实测点。 */
export interface MonthlyPoint {
  /** 采样时间戳(毫秒)。 */
  ts: number;
  /** 月度已用百分比(0–100)。 */
  used: number;
}

/** 单个独立 Key 在当前月度周期内的实测曲线与线性预测摘要。 */
export interface MonthlySeries {
  /** 本月计费周期开始时间(毫秒,由重置时刻往前推一个自然月得到)。 */
  cycleStart: number;
  /** 本月计费周期结束/重置时间(毫秒)。 */
  cycleEnd: number;
  /** 本次快照生成时刻(毫秒)。 */
  now: number;
  /** 当前月度已用百分比(0–100)。 */
  currentUsed: number;
  /** 当前周期内基于本地历史降采样后的实测点(按时间升序)。 */
  points: MonthlyPoint[];
  /** 当前周期内本地历史实际命中的样本总数。 */
  sampleCount: number;
  /** 按周期已过天数计算的日均消耗(百分点/天,保留 1 位小数)。 */
  dailyRate: number;
  /** 按当前速度推算到周期重置日的预测总用量百分比(可 >100%);样本不足或无消耗时为 null。 */
  projectedEndUsed: number | null;
  /** 预测触顶(已用 100% / 剩余跌破 0%)的时间戳(毫秒);若周期内不会耗尽或已达 100% 则为 null。 */
  projectedHitAt: number | null;
}

/** 密钥管理列表里的单个槽位状态(只下发脱敏尾标,绝不下发明文密钥)。 */
export interface ManagedKeyInfo {
  /** 展示名称(如「主力账号」)。 */
  label: string;
  /** 存放在本部署 `.env` 中的环境变量名(如 `OPENCODE_QUOTA_KEY_1`)。 */
  secret: string;
  /** 脱敏后的密钥尾标(如 `••••8f3a`),未读到值时为 null。 */
  keyHint: string | null;
  /** 是否来自本部署 `.env` 的默认变量 `OPENCODE_QUOTA_API_KEY`(未显式登记在 `keys` 中)。 */
  envDefault?: boolean;
}

export interface SourceSnapshot {
  /** 主展示名(取合并槽位中的第一个名称)。 */
  name: string;
  /** 共享这把实际 Key 的全部槽位名称(去重合并后列出)。 */
  labels: string[];
  /** 对应的环境变量名列表。 */
  secrets: string[];
  /** 脱敏后的密钥尾标(如 `••••a1b2`),绝不泄露完整密钥。 */
  keyHint: string | null;
  gateway: string;
  readAt: string | null;
  error: string | null;
  windows: Usage | null;
  /** 当前月度周期的本地实测曲线与线性预测;尚未读到额度或重置时间无效时为 null。 */
  monthly: MonthlySeries | null;
}

export interface QuotaSnapshot {
  alertAt: number;
  pollMinutes: number;
  /** 本地历史记录保留天数(7–365)。 */
  retainDays: number;
  displayMode: DisplayMode;
  /** 当前规范化后的网关地址(无效时为空串)。 */
  gateway: string;
  /** 已登记的密钥槽位列表(用于面板内的密钥管理区,只含脱敏尾标)。 */
  managedKeys: ManagedKeyInfo[];
  /** 按独立 Key 去重合并后的监控来源列表(用于渲染额度卡片)。 */
  sources: SourceSnapshot[];
}
