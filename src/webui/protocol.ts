/**
 * 面板与服务端之间的数据形状。两侧都 `import type`,打包时整段消失。
 */
import type { Window } from '../config.ts';
import type { WindowState } from '../gateway.ts';

/** 本页唯一的自定义面板 id。服务端与浏览器端都从这里取,免得两处写同一个字符串。 */
export const QUOTA_PANEL = 'quota';

/** 一个来源此刻的样子:三个窗口的读数,或读不到的原因。 */
export interface SourceSnapshot {
  name: string;
  /** 上次读到这个来源的时刻;还没读到过时为 null。 */
  readAt: string | null;
  /** 读不到时的原因;读得到时为 null。 */
  error: string | null;
  windows: Record<Window, WindowState> | null;
}

export interface QuotaSnapshot {
  /** 告警线,百分比。 */
  alertAt: number;
  /** 轮询间隔,分钟。 */
  pollMinutes: number;
  sources: SourceSnapshot[];
}
