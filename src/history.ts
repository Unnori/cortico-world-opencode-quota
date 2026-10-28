/**
 * 每次读到的额度记一行,按天裁剪。文件放在部署数据目录,名字以 World id 开头,避免与其他 World
 * 的同名文件互相覆盖。历史只用于 `ocq_history` 的趋势,不参与越线判断——那个用内存里的上一次读数。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface Snapshot {
  /** ISO 时间,读取时刻。 */
  ts: string;
  endpoint: string;
  rolling: number;
  weekly: number;
  monthly: number;
  /** 三个窗口各自的重置时刻。 */
  resets: { rolling: string; weekly: string; monthly: string };
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

const MAX_LINES = 20000;

/** 保留天数:历史只服务趋势,不开放成配置项。 */
const RETAIN_DAYS = 14;

export class History {
  constructor(private readonly file: string) {}

  /** 追加一行,并裁掉超出保留天数的记录。 */
  append(snapshot: Snapshot): void {
    try {
      appendFileSync(this.file, `${JSON.stringify(snapshot)}\n`, 'utf8');
      this.trim();
    } catch {
      // 历史是附加信息:写不进去不该影响额度本身
    }
  }

  read(): Snapshot[] {
    if (!existsSync(this.file)) return [];
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const rows: Snapshot[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Snapshot;
        if (typeof row.ts === 'string' && typeof row.endpoint === 'string') rows.push(row);
      } catch {
        // 一行坏掉只丢这一行
      }
    }
    return rows;
  }

  /** 某端点在最近 `days` 天内的趋势;没有样本时返回 null。 */
  trend(endpoint: string, days: number): EndpointTrend | null {
    const since = Date.now() - days * 86_400_000;
    const rows = this.read().filter((row) => row.endpoint === endpoint && Date.parse(row.ts) >= since);
    if (!rows.length) return null;
    const peak = { rolling: 0, weekly: 0, monthly: 0 };
    for (const row of rows) {
      peak.rolling = Math.max(peak.rolling, row.rolling);
      peak.weekly = Math.max(peak.weekly, row.weekly);
      peak.monthly = Math.max(peak.monthly, row.monthly);
    }
    const last = rows[rows.length - 1]!;
    return {
      endpoint,
      samples: rows.length,
      peak,
      first: rows[0]!.ts,
      last: last.ts,
      latest: { rolling: last.rolling, weekly: last.weekly, monthly: last.monthly },
    };
  }

  /** 清空历史;存储项的清除动作调用它。 */
  clear(): void {
    try {
      writeFileSync(this.file, '', 'utf8');
    } catch {
      // 清不掉时保留原样,下次裁剪再试
    }
  }

  private trim(): void {
    const rows = this.read();
    const since = Date.now() - RETAIN_DAYS * 86_400_000;
    const kept = rows.filter((row) => Date.parse(row.ts) >= since).slice(-MAX_LINES);
    if (kept.length === rows.length) return;
    try {
      writeFileSync(this.file, kept.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
    } catch {
      // 同上:裁剪失败留到下次
    }
  }
}
