/**
 * 作业状态：
 *  - normal：普通，求解器可自由决定是否入选择
 *  - required：必选，必须排入（受 capacity 重叠约束）
 *  - excluded：排除，任何情况下都不会入选
 */
export type JobStatus = 'normal' | 'required' | 'excluded';

export interface Job {
  /** 唯一非空字符串标识（JSON 中可以是数字/字符串，规范化为字符串） */
  id: string;
  /** 开始时刻（含），整数，>=0 */
  start: number;
  /** 结束时刻（不含），整数，> start，<= 1e9 */
  end: number;
  /** 收益，整数，1..1e9 */
  benefit: number;
  status: JobStatus;
}

export type Capacity = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * 容量日历片段：在左闭右开区间 [start, end) 内有效容量为 available。
 * 片段互不重叠但允许端点相接；未被任何片段覆盖的时间保持全程 capacity。
 * available 取值 0..capacity-1（达到 capacity 的限制没有意义，应直接省略）。
 * 片段范围限于最早作业开始 ~ 最晚作业结束。
 */
export interface CapacityCalendarSegment {
  start: number;
  end: number;
  available: number;
}

export interface Workspace {
  capacity: Capacity;
  jobs: Job[];
  /**
   * 容量日历（已按 start 排序、互不重叠）；空数组表示全程 capacity，
   * 与旧版无该字段的行为完全一致。
   */
  capacityCalendar: CapacityCalendarSegment[];
  /**
   * 单调递增的数据版本：任何成功的导入或约束修改都会使其 +1。
   * 注意：版本号会在每次导入时从 1 重新开始，不能单独作为工作区身份。
   */
  version: number;
  /**
   * 数据身份：每次成功导入生成的唯一标识，在该批数据的整个生命周期内
   * （导入、约束修改、求解、展示、下载、恢复）保持不变。
   * 工作区与求解快照只有 dataId 相同才可能配套；仅版本号相同不算。
   * 旧版本地数据没有该字段时规范化为 LEGACY_DATA_ID（空串），
   * 只能与同为遗留身份、且内容逐字对得上的记录配对。
   */
  dataId: string;
}

/** 用户 JSON 中单个作业的原始形态 */
export interface RawJob {
  id: unknown;
  start: unknown;
  end: unknown;
  benefit: unknown;
}

export interface RawCalendarSegment {
  start: unknown;
  end: unknown;
  available: unknown;
}

export interface ImportPayload {
  capacity: unknown;
  jobs: unknown;
  capacityCalendar?: unknown;
}
