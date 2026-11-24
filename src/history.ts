/**
 * 本地额度历史存储(零依赖升级版 JSONL):
 * - 内存索引缓存:首次读取加载一次到内存,后续 15 秒面板刷新、趋势查询与条数统计均为 0 磁盘 I/O
 * - 变化去重 + 低频心跳:三个窗口百分比有变化或月度重置时立即落盘(并补齐变化前最后一个稳态锚点防曲线斜拉),
 *   长时间无变化时按固定间隔(默认 30 分钟)补一条心跳点,把 35 天体积从 ~10 MB 压至 ~300 KB 且零失真
 * - 原子裁剪重写:裁剪过期记录时先写同目录临时文件再 `renameSync` 原子替换,避免崩溃或断电截断主文件
 * - Key 指纹绑定 + 向下兼容:新记录附带不可逆 `keyId` 指纹,改名 Provider 不断历史、换 Key 不串曲线;
 *   旧版无 `keyId` 的历史行按 `endpoint` 自动兼容
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MonthlyPoint, MonthlySeries } from './webui/protocol.ts';

export interface Snapshot {
  /** ISO 时间,读取时刻。 */
  ts: string;
  endpoint: string;
  /** 不可逆来源指纹(gateway + API Key 的短哈希),用于跨端点改名连续追踪历史。 */
  keyId?: string;
  rolling: number;
  weekly: number;
  monthly: number;
  /** 三个窗口各自的重置时刻。 */
  resets?: { rolling: string; weekly: string; monthly: string };
}

export interface SourceQuery {
  /** 不可逆来源指纹(单个或兼容多代的多个指纹,优先精确匹配)。 */
  keyId?: string;
  keyIds?: readonly string[];
  /** 关联的端点/展示名称列表(用于向下兼容旧版无 keyId 的历史记录)。 */
  endpoints: readonly string[];
  /** 返回趋势结果时的展示名(默认取 endpoints[0])。 */
  label?: string;
  /**
   * 当前月度计费周期的重置时刻(ISO 字符串):
   * 用于自动找回 0.1.x–0.2.x 无 keyId 且名称变更的旧记录(按同订阅重置锚点精确归属,不串账号)。
   */
  monthlyResetsAt?: string;
  /** 当前是否只有这一把监控中的 Key(仅用于缺 resets.monthly 的旧记录兜底收编)。 */
  singleSource?: boolean;
}

export interface EndpointTrend {
  endpoint: string;
  /** 观察窗口内的样本数。 */
  samples: number;
  /** 每个窗口在观察窗口内的最高百分比。 */
  peak: { rolling: number; weekly: number; monthly: number };
  /** 最早与最新的样本时刻。 */
  first: string;
  last: string;
  /** 最新的三个百分比。 */
  latest: { rolling: number; weekly: number; monthly: number };
}

export interface HistoryOptions {
  /** 保留天数(支持函数热读取最新配置),默认 35 天。 */
  retainDays?: number | (() => number);
  /** 数值无变化时的心跳间隔(毫秒),默认 30 分钟;设为 0 表示每次都落盘。 */
  heartbeatMs?: number;
}

interface CachedRow {
  row: Snapshot;
  tsMs: number;
}

const MIN_MAX_LINES = 60_000;
const HARD_MAX_LINES = 500_000;
/** 默认保留天数:覆盖完整自然月计费周期(31 天)并留余量。 */
const DEFAULT_RETAIN_DAYS = 35;
/** 数值无变化时的默认心跳间隔(30 分钟)。 */
const DEFAULT_HEARTBEAT_MS = 30 * 60_000;
/** 变化前补写稳态锚点的最小跨度(2 分钟),避免紧邻采样重复写。 */
const PLATEAU_ANCHOR_MIN_GAP_MS = 2 * 60_000;
/** 累计写入满 60 次或距上次裁剪满 1 小时再检查裁剪。 */
const TRIM_EVERY_APPENDS = 60;
const TRIM_INTERVAL_MS = 60 * 60_000;
/** 识别月度重置的最小回落幅度。 */
const MONTHLY_RESET_DROP = 5;
/** 判定月度重置时刻发生实质变化的阈值(1 小时),忽略空闲期微小漂移。 */
const MONTHLY_RESET_SHIFT_MS = 60 * 60_000;
/** 判定同周期月度重置锚点一致的容差(2 小时,兼容轻微时钟/接口偏移)。 */
const SAME_CYCLE_RESET_TOLERANCE_MS = 2 * 60 * 60_000;
/** 判定历史跨月重置锚点一致的容差(26 小时,兼容夏令时与大小月边界)。 */
const PRIOR_CYCLE_RESET_TOLERANCE_MS = 26 * 60 * 60_000;
/** 折线图最大采样点数:保留足够细节以支撑滚轮放大查看单日/数小时曲线。 */
const MAX_CHART_POINTS = 240;

/** 将重置时刻往前推 `months` 个自然月(保持原锚点日并防止月末溢出)。 */
function subtractMonths(endMs: number, months: number): number {
  const date = new Date(endMs);
  const day = date.getDate();
  date.setMonth(date.getMonth() - months);
  if (date.getDate() !== day) date.setDate(0);
  return date.getTime();
}

/** 将重置时刻往前推一个自然月(如 12月9日 → 11月9日),防止月末日期溢出。 */
export function subtractOneMonth(endMs: number): number {
  return subtractMonths(endMs, 1);
}

/** 判断某条无 keyId 旧记录的月度重置时刻是否属于当前订阅(本周期或前 12 个自然月锚点)。 */
function matchesMonthlyResetAnchor(rowResetMs: number, currentResetMs: number): boolean {
  if (Math.abs(rowResetMs - currentResetMs) <= SAME_CYCLE_RESET_TOLERANCE_MS) return true;
  if (rowResetMs > currentResetMs + SAME_CYCLE_RESET_TOLERANCE_MS) return false;
  for (let m = 1; m <= 12; m += 1) {
    const anchor = subtractMonths(currentResetMs, m);
    if (Math.abs(rowResetMs - anchor) <= PRIOR_CYCLE_RESET_TOLERANCE_MS) return true;
    if (anchor < rowResetMs - PRIOR_CYCLE_RESET_TOLERANCE_MS) break;
  }
  return false;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function normalizeQuery(target: string | readonly string[] | SourceQuery): SourceQuery {
  if (typeof target === 'string') return { endpoints: [target], label: target };
  if (Array.isArray(target)) return { endpoints: target, label: target[0] ?? '' };
  const query = target as SourceQuery;
  return {
    ...(query.keyId ? { keyId: query.keyId } : {}),
    ...(query.keyIds?.length ? { keyIds: query.keyIds } : {}),
    endpoints: query.endpoints,
    label: query.label ?? query.endpoints[0] ?? '',
    ...(query.monthlyResetsAt ? { monthlyResetsAt: query.monthlyResetsAt } : {}),
    ...(query.singleSource ? { singleSource: true } : {}),
  };
}

/**
 * 构造一条过滤函数:
 * 1. 双方都有 keyId 时严格按指纹集合匹配(支持 0.3.1 纯 Key 指纹与 0.3.0 旧指纹;改名/换网关不断档,换 Key 不串曲线);
 * 2. 旧行无 keyId(0.1.x–0.2.x)时:先按名称兼容,名称不符再按月度重置锚点精确归属,防止升级改名后丢失旧数据。
 */
function rowMatcher(query: SourceQuery): (row: Snapshot) => boolean {
  const names = new Set(query.endpoints);
  const keyIds = new Set<string>([
    ...(query.keyId ? [query.keyId] : []),
    ...(query.keyIds ?? []),
  ]);
  const curResetMs = query.monthlyResetsAt ? Date.parse(query.monthlyResetsAt) : NaN;
  const hasCurReset = Number.isFinite(curResetMs);

  return (row: Snapshot) => {
    if (keyIds.size > 0 && row.keyId) return keyIds.has(row.keyId);
    if (names.has(row.endpoint)) return true;
    if (keyIds.size === 0 || row.keyId) return false;

    const rowResetMs = row.resets?.monthly ? Date.parse(row.resets.monthly) : NaN;
    if (hasCurReset && Number.isFinite(rowResetMs)) {
      return matchesMonthlyResetAnchor(rowResetMs, curResetMs);
    }
    return Boolean(query.singleSource);
  };
}

/** 同一来源去重键:优先使用 keyId,无 keyId 时退回 endpoint。 */
function dedupeKeyOf(row: Snapshot): string {
  return row.keyId ? `k:${row.keyId}` : `e:${row.endpoint}`;
}

/** 判断两条采样是否存在实质变化(任一百分比变化,或月度重置时刻发生实质切换)。 */
function hasMeaningfulChange(prev: Snapshot, next: Snapshot): boolean {
  if (prev.rolling !== next.rolling || prev.weekly !== next.weekly || prev.monthly !== next.monthly) return true;
  const prevMonthlyReset = prev.resets?.monthly ? Date.parse(prev.resets.monthly) : NaN;
  const nextMonthlyReset = next.resets?.monthly ? Date.parse(next.resets.monthly) : NaN;
  if (Number.isFinite(prevMonthlyReset) && Number.isFinite(nextMonthlyReset)) {
    if (Math.abs(nextMonthlyReset - prevMonthlyReset) >= MONTHLY_RESET_SHIFT_MS) return true;
  }
  return false;
}

/** 将内容原子落盘:先写同目录临时文件再 `renameSync` 覆盖目标,失败时清理临时文件且保留原文件完好。 */
function atomicWriteFile(file: string, content: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 清理临时文件失败时忽略 */ }
    throw error;
  }
}

export class History {
  private readonly retainDaysOpt: number | (() => number);
  private readonly heartbeatMs: number;
  private cache: CachedRow[] | null = null;
  private lastWritten = new Map<string, CachedRow>();
  private lastObserved = new Map<string, CachedRow>();
  private appendsSinceTrim = 0;
  private lastTrimAt = 0;

  constructor(
    private readonly file: string,
    optionsOrRetainDays: number | (() => number) | HistoryOptions = DEFAULT_RETAIN_DAYS,
  ) {
    if (typeof optionsOrRetainDays === 'object' && optionsOrRetainDays !== null) {
      this.retainDaysOpt = optionsOrRetainDays.retainDays ?? DEFAULT_RETAIN_DAYS;
      this.heartbeatMs = Math.max(0, optionsOrRetainDays.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    } else {
      this.retainDaysOpt = optionsOrRetainDays;
      this.heartbeatMs = DEFAULT_HEARTBEAT_MS;
    }
  }

  private retainDays(): number {
    const raw = typeof this.retainDaysOpt === 'function' ? this.retainDaysOpt() : this.retainDaysOpt;
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_RETAIN_DAYS;
  }

  /** 懒加载到内存并建立最新写入索引;后续所有查询均直接读内存(0 磁盘 I/O)。 */
  private ensureLoaded(): CachedRow[] {
    if (this.cache !== null) return this.cache;
    const loaded: CachedRow[] = [];
    this.lastWritten.clear();
    this.lastObserved.clear();
    if (existsSync(this.file)) {
      try {
        const text = readFileSync(this.file, 'utf8');
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const raw = JSON.parse(line) as Partial<Snapshot>;
            if (typeof raw.ts !== 'string' || typeof raw.endpoint !== 'string') continue;
            const tsMs = Date.parse(raw.ts);
            if (!Number.isFinite(tsMs)) continue;
            const row: Snapshot = {
              ts: raw.ts,
              endpoint: raw.endpoint,
              ...(typeof raw.keyId === 'string' && raw.keyId ? { keyId: raw.keyId } : {}),
              rolling: typeof raw.rolling === 'number' && Number.isFinite(raw.rolling) ? raw.rolling : 0,
              weekly: typeof raw.weekly === 'number' && Number.isFinite(raw.weekly) ? raw.weekly : 0,
              monthly: typeof raw.monthly === 'number' && Number.isFinite(raw.monthly) ? raw.monthly : 0,
              ...(raw.resets ? { resets: raw.resets } : {}),
            };
            const entry: CachedRow = { row, tsMs };
            loaded.push(entry);
            const dKey = dedupeKeyOf(row);
            const prev = this.lastWritten.get(dKey);
            if (!prev || tsMs >= prev.tsMs) {
              this.lastWritten.set(dKey, entry);
              this.lastObserved.set(dKey, entry);
            }
          } catch {
            // 单行损坏只跳过该行,不影响其余历史
          }
        }
      } catch {
        // 文件暂不可读时以空缓存兜底
      }
    }
    this.cache = loaded;
    return loaded;
  }

  private persistBatch(entries: readonly CachedRow[]): boolean {
    if (!entries.length) return false;
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload = entries.map((e) => `${JSON.stringify(e.row)}\n`).join('');
      appendFileSync(this.file, payload, 'utf8');
      const rows = this.ensureLoaded();
      for (const entry of entries) {
        rows.push(entry);
        const dKey = dedupeKeyOf(entry.row);
        const prev = this.lastWritten.get(dKey);
        if (!prev || entry.tsMs >= prev.tsMs) {
          this.lastWritten.set(dKey, entry);
          this.lastObserved.set(dKey, entry);
        }
      }
      this.appendsSinceTrim += entries.length;
      const now = Date.now();
      if (this.appendsSinceTrim >= TRIM_EVERY_APPENDS || (this.lastTrimAt > 0 && now - this.lastTrimAt >= TRIM_INTERVAL_MS)) {
        this.trim();
      } else if (this.lastTrimAt === 0) {
        this.lastTrimAt = now;
      }
      return true;
    } catch {
      // 历史是附加信息:写不进去不该影响额度本身
      return false;
    }
  }

  /**
   * 追加一条读数(带变化去重与低频心跳):
   * - 首次记录、任一窗口百分比变化或月度重置时立即落盘;
   *   若变化前已跳过一段平稳采样,先补写变化前最后一条稳态锚点以保持折线拐点精确;
   * - 数值未变化时按 `heartbeatMs`(默认 30 分钟)补一条心跳点,其余跳过。
   * 返回本次是否实际写入了磁盘。
   */
  append(snapshot: Snapshot): boolean {
    const tsMs = Date.parse(snapshot.ts);
    if (!Number.isFinite(tsMs)) return false;

    this.ensureLoaded();
    const cleanRow: Snapshot = {
      ts: snapshot.ts,
      endpoint: snapshot.endpoint,
      ...(snapshot.keyId ? { keyId: snapshot.keyId } : {}),
      rolling: snapshot.rolling,
      weekly: snapshot.weekly,
      monthly: snapshot.monthly,
      ...(snapshot.resets ? { resets: snapshot.resets } : {}),
    };
    const entry: CachedRow = { row: cleanRow, tsMs };
    const dKey = dedupeKeyOf(cleanRow);
    const lastW = this.lastWritten.get(dKey);
    const lastO = this.lastObserved.get(dKey);

    // 首次采样、禁用心跳压缩、或时间乱序回填:直接写入
    if (!lastW || this.heartbeatMs === 0 || tsMs < lastW.tsMs) {
      return this.persistBatch([entry]);
    }

    if (hasMeaningfulChange(lastW.row, cleanRow)) {
      const batch: CachedRow[] = [];
      // 变化前若有较长的未落盘稳态尾巴,先补一条稳态锚点,防止折线在平台期提前斜拉
      if (
        lastO
        && lastO !== lastW
        && lastO.tsMs > lastW.tsMs
        && lastO.tsMs < tsMs
        && lastO.tsMs - lastW.tsMs >= PLATEAU_ANCHOR_MIN_GAP_MS
      ) {
        batch.push(lastO);
      }
      batch.push(entry);
      return this.persistBatch(batch);
    }

    // 数值无变化:达到心跳间隔再落一条心跳点,否则只更新内存观察锚点
    if (tsMs - lastW.tsMs >= this.heartbeatMs) {
      return this.persistBatch([entry]);
    }
    if (!lastO || tsMs >= lastO.tsMs) {
      this.lastObserved.set(dKey, entry);
    }
    return false;
  }

  /** 返回当前缓存中的记录总数(O(1),不触盘)。 */
  count(): number {
    return this.ensureLoaded().length;
  }

  /** 返回全部历史快照的副本(命中内存缓存,不重复读盘解析)。 */
  read(): Snapshot[] {
    return this.ensureLoaded().map((item) => item.row);
  }

  /** 某来源(支持 keyId 指纹与旧版 endpoint 列表)在最近 `days` 天内的趋势;没有样本时返回 null。 */
  trend(target: string | readonly string[] | SourceQuery, days: number): EndpointTrend | null {
    const query = normalizeQuery(target);
    const matches = rowMatcher(query);
    const since = Date.now() - days * 86_400_000;
    const rows = this.ensureLoaded()
      .filter((item) => item.tsMs >= since && matches(item.row))
      .sort((a, b) => a.tsMs - b.tsMs);
    if (!rows.length) return null;
    const peak = { rolling: 0, weekly: 0, monthly: 0 };
    for (const { row } of rows) {
      peak.rolling = Math.max(peak.rolling, row.rolling);
      peak.weekly = Math.max(peak.weekly, row.weekly);
      peak.monthly = Math.max(peak.monthly, row.monthly);
    }
    const first = rows[0]!.row;
    const last = rows[rows.length - 1]!.row;
    return {
      endpoint: query.label || last.endpoint,
      samples: rows.length,
      peak,
      first: first.ts,
      last: last.ts,
      latest: { rolling: last.rolling, weekly: last.weekly, monthly: last.monthly },
    };
  }

  /**
   * 汇总当前月度计费周期的本地实测折线点与线性消耗预测。
   * 预测速度取周期至今的日均消耗(`当前已用 / 已过天数`),用于绘制虚线趋势与预计触顶/耗尽日期。
   */
  monthlySeries(
    target: string | readonly string[] | SourceQuery,
    resetsAtIso: string,
    currentUsedRaw: number,
    nowMs = Date.now(),
  ): MonthlySeries | null {
    const cycleEnd = Date.parse(resetsAtIso);
    if (!Number.isFinite(cycleEnd) || cycleEnd <= nowMs) return null;
    const cycleStart = subtractOneMonth(cycleEnd);
    if (!Number.isFinite(cycleStart) || cycleStart >= cycleEnd) return null;

    const currentUsed = clampPercent(currentUsedRaw);
    const baseQuery = normalizeQuery(target);
    const query: SourceQuery = !baseQuery.monthlyResetsAt && (baseQuery.keyId || baseQuery.keyIds?.length)
      ? { ...baseQuery, monthlyResetsAt: resetsAtIso }
      : baseQuery;
    const matches = rowMatcher(query);
    const rawRows = this.ensureLoaded()
      .filter((item) => item.tsMs >= cycleStart && item.tsMs <= nowMs && matches(item.row))
      .sort((a, b) => a.tsMs - b.tsMs)
      .map((item) => ({ ts: item.tsMs, used: item.row.monthly }));

    // 若周期初边界附近有上一周期残留记录,从最后一次大幅回落(重置)之后截取。
    let startIdx = 0;
    for (let i = 1; i < rawRows.length; i += 1) {
      if (rawRows[i - 1]!.used - rawRows[i]!.used >= MONTHLY_RESET_DROP) {
        startIdx = i;
      }
    }
    const cycleRows = rawRows.slice(startIdx);
    const sampleCount = cycleRows.length;

    // 降采样:保留首点、数值拐点与均匀时间桶,末尾固定落在此刻实测值。
    const points: MonthlyPoint[] = [];
    if (cycleRows.length <= MAX_CHART_POINTS) {
      for (const row of cycleRows) {
        const used = clampPercent(row.used);
        const prev = points[points.length - 1];
        if (prev && prev.ts === row.ts) {
          prev.used = used;
        } else {
          points.push({ ts: row.ts, used });
        }
      }
    } else {
      const span = Math.max(1, nowMs - cycleStart);
      const bucketMs = span / (MAX_CHART_POINTS - 2);
      let currentBucket = -1;
      for (let i = 0; i < cycleRows.length; i += 1) {
        const row = cycleRows[i]!;
        const used = clampPercent(row.used);
        const bucket = Math.floor((row.ts - cycleStart) / bucketMs);
        if (i === 0 || i === cycleRows.length - 1 || bucket !== currentBucket) {
          points.push({ ts: row.ts, used });
          currentBucket = bucket;
        } else {
          // 同一时间桶保留最新读数,避免丢掉峰值或最新跳变
          points[points.length - 1] = { ts: row.ts, used };
        }
      }
    }

    const last = points[points.length - 1];
    if (!last || nowMs - last.ts > 60_000 || last.used !== currentUsed) {
      points.push({ ts: nowMs, used: currentUsed });
    }

    const elapsedDays = (nowMs - cycleStart) / 86_400_000;
    const remainingDays = Math.max(0, (cycleEnd - nowMs) / 86_400_000);

    let dailyRate = 0;
    let projectedEndUsed: number | null = null;
    let projectedHitAt: number | null = null;

    if (currentUsed > 0 && elapsedDays >= 1 / 24) {
      const rawRate = currentUsed / elapsedDays;
      dailyRate = Math.round(rawRate * 10) / 10;
      if (rawRate > 0) {
        projectedEndUsed = Math.round(Math.min(999, currentUsed + rawRate * remainingDays));
        if (currentUsed < 100) {
          const daysToLimit = (100 - currentUsed) / rawRate;
          const hitMs = nowMs + daysToLimit * 86_400_000;
          if (hitMs < cycleEnd) {
            projectedHitAt = Math.round(hitMs);
          }
        }
      }
    } else if (currentUsed === 0) {
      projectedEndUsed = 0;
    }

    return {
      cycleStart,
      cycleEnd,
      now: nowMs,
      currentUsed,
      points,
      sampleCount,
      dailyRate,
      projectedEndUsed,
      projectedHitAt,
    };
  }

  /** 清空历史与内存缓存;存储项的清除动作调用它。 */
  clear(): void {
    this.appendsSinceTrim = 0;
    this.lastTrimAt = Date.now();
    this.cache = [];
    this.lastWritten.clear();
    this.lastObserved.clear();
    try {
      atomicWriteFile(this.file, '');
    } catch {
      // 清不掉时保留内存已清空状态,下次裁剪再试
    }
  }

  /** 裁掉超出保留天数或行数上限的旧记录,并以临时文件 + rename 原子落盘防崩溃截断。 */
  trim(): void {
    this.appendsSinceTrim = 0;
    this.lastTrimAt = Date.now();
    const rows = this.ensureLoaded();
    const days = this.retainDays();
    const maxLines = Math.min(HARD_MAX_LINES, Math.max(MIN_MAX_LINES, days * 2_000));
    const since = Date.now() - days * 86_400_000;
    const kept = rows.filter((item) => item.tsMs >= since).slice(-maxLines);
    if (kept.length === rows.length) return;
    try {
      const content = kept.length ? `${kept.map((item) => JSON.stringify(item.row)).join('\n')}\n` : '';
      atomicWriteFile(this.file, content);
      this.cache = kept;
      this.lastWritten.clear();
      this.lastObserved.clear();
      for (const entry of kept) {
        const dKey = dedupeKeyOf(entry.row);
        const prev = this.lastWritten.get(dKey);
        if (!prev || entry.tsMs >= prev.tsMs) {
          this.lastWritten.set(dKey, entry);
          this.lastObserved.set(dKey, entry);
        }
      }
    } catch {
      // 原子替换失败时不破坏内存与原文件,下次周期再试
    }
  }
}
