import { buildCapacityGrid } from './capacityCalendar';
import type { SolverResult } from './solver';
import type { CapacityCalendarSegment, JobStatus, Workspace } from './types';

/**
 * 一次成功求解的持久化形态：工作区身份（dataId + version）+ 求解所用
 * 容量/日历 + 结果。dataId 缺失（旧快照）时规范化为 LEGACY_DATA_ID。
 */
export interface StoredSnapshot {
  workspaceVersion: number;
  dataId: string;
  capacity: number;
  /** 本次求解使用的容量日历（与工作区同一数据源） */
  capacityCalendar: CapacityCalendarSegment[];
  solvedAt: string;
  /**
   * 求解结果；peakCellLimit 对旧快照允许缺失（展示/下载时按日历回退），
   * 其余字段必须完整且类型正确。
   */
  result: Omit<SolverResult, 'peakCellLimit'> & { peakCellLimit?: number };
}

/**
 * 数据身份（dataId）与存储结构校验。
 *
 * 背景：工作区与求解快照分别写入浏览器存储，仅凭 version 数字判断配套
 * 会出现两类冒充：
 *  1. 新导入的另一批作业从 version=1 重新起步，旧快照 version 恰好相同，
 *     旧作业的 selectedIds/收益/日历被标成新工作区的当前结果；
 *  2. 浏览器只成功写入其中一份记录时，新工作区与旧快照被混合恢复。
 *
 * 规则：
 *  - 每次导入生成唯一 dataId，约束修改保持不变；
 *  - 快照与工作区必须 dataId 相同，且容量、日历、版本、结果内容
 *    （selectedIds 是否存在、总收益）交叉一致才允许配对；
 *  - 旧版本地数据没有 dataId：双方都规范化为 LEGACY_DATA_ID（空串），
 *    再做逐字内容核对——旧合法数据可恢复，而新数据永远不会与之配对。
 *
 * 任何从存储读出的数据都先过本模块的结构校验，畸形记录一律拒绝，
 * 页面不得继续渲染或导出。
 */

/** 遗留数据（旧格式，无 dataId 字段）的统一身份；新数据永远不会取此值 */
export const LEGACY_DATA_ID = '';

/** 时间/容量边界，与导入契约一致 */
const MAX_BOUND = 1_000_000_000;
const MAX_JOBS = 50_000;
const VALID_STATUSES: ReadonlySet<string> = new Set(['normal', 'required', 'excluded']);

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 生成一批新导入数据的唯一身份。 */
export function createDataId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } };
  const crypto = g.crypto;
  if (crypto?.randomUUID) {
    const id = crypto.randomUUID();
    // randomUUID 理论上不会产出空串；空串是遗留身份的保留值
    if (id !== LEGACY_DATA_ID) return `d_${id}`;
  }
  if (crypto?.getRandomValues) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    const hex = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `d_${hex}`;
  }
  // 无 Web Crypto 的极端环境：时间 + 随机数兜底，仍保证非空且高概率唯一
  const rand = Math.random().toString(36).slice(2, 12);
  return `d_${Date.now().toString(36)}-${rand}`;
}

/* ------------------------------------------------------------------ */
/* 容量日历                                                            */
/* ------------------------------------------------------------------ */

/**
 * 严格校验容量日历片段数组。允许 undefined / 缺省（按空日历处理），
 * 但字段非法（非整数、越界、available 超出 capacity-1）或片段重叠
 * （相接允许）时返回 null。
 *
 * 校验通过时返回按 start 排序的规范化副本。
 */
export function sanitizeCalendar(
  value: unknown,
  capacity: number,
  bounds?: { min: number; max: number },
): CapacityCalendarSegment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const segments: CapacityCalendarSegment[] = [];
  for (const raw of value) {
    if (!isObject(raw)) return null;
    const { start, end, available } = raw;
    if (!isInteger(start) || !isInteger(end) || !isInteger(available)) return null;
    if (start < 0 || end > MAX_BOUND || end <= start) return null;
    if (available < 0 || available > capacity - 1) return null;
    if (bounds && (start < bounds.min || end > bounds.max)) return null;
    segments.push({ start, end, available });
  }

  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].end) return null; // 重叠（相接允许）
  }
  return segments;
}

/* ------------------------------------------------------------------ */
/* 工作区                                                              */
/* ------------------------------------------------------------------ */

/**
 * 严格校验从存储恢复的工作区。结构不完整、非法状态、越界作业或日历
 * 都返回 null；通过时返回字段规范化后的工作区对象（不就地修改入参）。
 *
 * 旧格式缺 capacityCalendar / version / dataId 时按兼容规则补默认值。
 */
export function sanitizeWorkspace(value: unknown): Workspace | null {
  if (!isObject(value)) return null;

  if (!isInteger(value.capacity) || value.capacity < 1 || value.capacity > 8) return null;
  const capacity = value.capacity;

  const version =
    value.version === undefined ? 1 : isInteger(value.version) && value.version >= 1 ? value.version : null;
  if (version === null) return null;

  if (value.dataId !== undefined && (typeof value.dataId !== 'string' || value.dataId.length === 0)) {
    return null;
  }
  const dataId = value.dataId === undefined ? LEGACY_DATA_ID : value.dataId;

  if (!Array.isArray(value.jobs) || value.jobs.length < 1 || value.jobs.length > MAX_JOBS) return null;

  const jobs: Workspace['jobs'] = [];
  const ids = new Set<string>();
  for (const raw of value.jobs) {
    if (!isObject(raw)) return null;
    const id = raw.id;
    if (typeof id !== 'string' || id.length === 0) return null;
    if (ids.has(id)) return null;
    if (!isInteger(raw.start) || raw.start < 0 || raw.start > MAX_BOUND) return null;
    if (!isInteger(raw.end) || raw.end <= raw.start || raw.end > MAX_BOUND) return null;
    if (!isInteger(raw.benefit) || raw.benefit < 1 || raw.benefit > MAX_BOUND) return null;
    // 非法作业状态不得冒充合法工作区（旧数据全为 normal，不会误伤）
    if (typeof raw.status !== 'string' || !VALID_STATUSES.has(raw.status)) return null;
    ids.add(id);
    jobs.push({
      id,
      start: raw.start,
      end: raw.end,
      benefit: raw.benefit,
      status: raw.status as JobStatus,
    });
  }

  let minStart = jobs[0].start;
  let maxEnd = jobs[0].end;
  for (const j of jobs) {
    if (j.start < minStart) minStart = j.start;
    if (j.end > maxEnd) maxEnd = j.end;
  }
  const calendar = sanitizeCalendar(value.capacityCalendar, capacity, { min: minStart, max: maxEnd });
  if (calendar === null) return null;

  return { capacity: capacity as Workspace['capacity'], version, jobs, capacityCalendar: calendar, dataId };
}

/* ------------------------------------------------------------------ */
/* 求解快照                                                            */
/* ------------------------------------------------------------------ */

/**
 * 严格校验从存储恢复的求解快照（结构层面，不涉及与工作区的配对）。
 * 结果字段缺失/类型错误、selectedIds 非字符串数组、数量不一致等都拒绝。
 *
 * 旧结果缺 peakCellLimit 不算畸形：兼容旧下载/存储结构，按 undefined
 * 保留，展示与下载时按日历回退；capacityCalendar 缺省视为空日历。
 */
export function sanitizeSnapshot(value: unknown): StoredSnapshot | null {
  if (!isObject(value)) return null;

  if (!isInteger(value.workspaceVersion) || value.workspaceVersion < 1) return null;
  if (!isInteger(value.capacity) || value.capacity < 1 || value.capacity > 8) return null;
  if (typeof value.solvedAt !== 'string') return null;

  const capacity = value.capacity;
  const calendar = sanitizeCalendar(value.capacityCalendar, capacity);
  if (calendar === null) return null;

  // dataId 缺省 = 遗留快照；存在则必须是非空字符串
  if (value.dataId !== undefined && (typeof value.dataId !== 'string' || value.dataId.length === 0)) {
    return null;
  }
  const dataId = value.dataId === undefined ? LEGACY_DATA_ID : value.dataId;

  const result = value.result;
  if (!isObject(result)) return null;
  if (!Array.isArray(result.selectedIds)) return null;
  const selectedIds: string[] = [];
  for (const id of result.selectedIds) {
    if (typeof id !== 'string') return null;
    selectedIds.push(id);
  }
  if (!isInteger(result.totalBenefit) || result.totalBenefit < 0) return null;
  if (!isInteger(result.peakOccupancy) || result.peakOccupancy < 0) return null;
  if (
    result.peakCellLimit !== undefined &&
    result.peakCellLimit !== null &&
    (!isInteger(result.peakCellLimit) || result.peakCellLimit < 0)
  ) {
    return null;
  }
  if (!isInteger(result.capacity) || result.capacity !== capacity) return null;
  if (!isInteger(result.selectedCount) || result.selectedCount !== selectedIds.length) return null;

  // 旧结果允许缺 peakCellLimit（undefined 或 null）；存在则必须是非负整数
  let peakCellLimit: number | undefined;
  if (result.peakCellLimit === undefined || result.peakCellLimit === null) {
    peakCellLimit = undefined;
  } else if (isInteger(result.peakCellLimit) && result.peakCellLimit >= 0) {
    peakCellLimit = result.peakCellLimit;
  } else {
    return null;
  }

  return {
    workspaceVersion: value.workspaceVersion,
    dataId,
    capacity,
    capacityCalendar: calendar,
    solvedAt: value.solvedAt,
    result: {
      selectedIds,
      totalBenefit: result.totalBenefit,
      peakOccupancy: result.peakOccupancy,
      peakCellLimit,
      capacity,
      selectedCount: result.selectedCount,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 工作区 ↔ 快照 配对                                                   */
/* ------------------------------------------------------------------ */

/** 快照与当前工作区的关系：当前结果 / 同批数据的旧结果 / 不属于当前数据 */
export type SnapshotRelation = 'current' | 'stale' | 'foreign';

function calendarsEqual(a: CapacityCalendarSegment[], b: CapacityCalendarSegment[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || a[i].available !== b[i].available) {
      return false;
    }
  }
  return true;
}

/**
 * 判断结构合法的快照是否属于给定工作区（恢复、导入、求解、展示、下载
 * 共用的唯一身份判定）。
 *
 *  - foreign：dataId 不同、容量/日历不一致、或结果引用的作业在工作区中
 *    不存在 / 总收益对不上，或快照版本比工作区还新（不可能属于该工作区）；
 *  - stale：同批数据，但工作区版本已前进（旧合法结果，须明确标过期）；
 *  - current：同批数据且版本一致。
 *
 * 遗留数据（双方 dataId 都是空串）只在容量、日历、作业 id 集合、版本
 * 全部吻合时配对：两份单键写入的新旧记录若数据不同即被判 foreign。
 */
export function relateSnapshot(snapshot: StoredSnapshot, workspace: Workspace): SnapshotRelation {
  if (snapshot.dataId !== workspace.dataId) return 'foreign';
  if (snapshot.capacity !== workspace.capacity) return 'foreign';
  if (!calendarsEqual(snapshot.capacityCalendar, workspace.capacityCalendar)) return 'foreign';
  if (snapshot.workspaceVersion > workspace.version) return 'foreign';

  // 内容交叉验证：结果中每个 id 必须在工作区中存在，且总收益必须
  // 与当前作业状态下这些 id 的收益和一致。同版本异数据（id 碰巧重合
  // 但 benefit 不同）也会在此被识破。
  const jobById = new Map<string, { benefit: number; status: JobStatus }>();
  for (const job of workspace.jobs) jobById.set(job.id, { benefit: job.benefit, status: job.status });

  let total = 0;
  const seen = new Set<string>();
  for (const id of snapshot.result.selectedIds) {
    const job = jobById.get(id);
    if (!job) return 'foreign'; // 不存在的作业不得交给下游
    if (seen.has(id)) return 'foreign';
    seen.add(id);
    // 被排除的作业不可能由当前工作区解出；必选作业若结果缺失则收益校验
    // 之后的版本语义会处理（stale/current 展示由版本决定，下载仍受限）。
    if (job.status === 'excluded') return 'foreign';
    total += job.benefit;
  }
  if (total !== snapshot.result.totalBenefit) return 'foreign';

  // 旧结果可能缺 peakCellLimit；以当前日历重算，作为防御性交叉核对
  if (snapshot.result.peakCellLimit !== undefined) {
    const recomputed = recomputePeakCellLimit(workspace, snapshot.result.selectedIds);
    if (recomputed !== null && snapshot.result.peakCellLimit !== recomputed) return 'foreign';
  }
  // 入选数超过容量日历任一格有效容量 => 结果不可能由该工作区产生
  if (!occupancyWithinCalendar(workspace, snapshot.result.selectedIds)) return 'foreign';

  return snapshot.workspaceVersion === workspace.version ? 'current' : 'stale';
}

/** 按选中 id 收集作业；有 id 在工作区中不存在时返回 null */
function collectSelected(workspace: Workspace, selectedIds: string[]): Workspace['jobs'] | null {
  const selected: Workspace['jobs'] = [];
  for (const id of selectedIds) {
    const job = workspace.jobs.find((j) => j.id === id);
    if (!job) return null;
    selected.push(job);
  }
  return selected;
}

/** 按选中 id 重算最早峰值格的有效容量上限；无法定位的 id 返回 null */
function recomputePeakCellLimit(workspace: Workspace, selectedIds: string[]): number | null {
  const selected = collectSelected(workspace, selectedIds);
  if (!selected) return null;
  const grid = buildCapacityGrid(selected, workspace.capacity, workspace.capacityCalendar);
  const m = grid.coords.length - 1;
  const diff = new Int32Array(m);
  for (const job of selected) {
    const li: number | undefined = grid.index.get(job.start);
    const ri: number | undefined = grid.index.get(job.end);
    if (li === undefined || ri === undefined) return null;
    diff[li] += 1;
    diff[ri] -= 1;
  }
  let peak = 0;
  let peakCellLimit: number = workspace.capacity;
  let cur = 0;
  for (let i = 0; i < m; i++) {
    cur += diff[i];
    if (cur > peak) {
      peak = cur;
      peakCellLimit = grid.cellCapacity[i];
    }
  }
  return peakCellLimit;
}

/** 逐格核对入选数不超过该格有效容量 */
function occupancyWithinCalendar(workspace: Workspace, selectedIds: string[]): boolean {
  const selected = collectSelected(workspace, selectedIds);
  if (!selected) return false;
  const grid = buildCapacityGrid(selected, workspace.capacity, workspace.capacityCalendar);
  const m = grid.coords.length - 1;
  const diff = new Int32Array(m);
  for (const job of selected) {
    const li: number | undefined = grid.index.get(job.start);
    const ri: number | undefined = grid.index.get(job.end);
    if (li === undefined || ri === undefined) return false;
    diff[li] += 1;
    diff[ri] -= 1;
  }
  let cur = 0;
  for (let i = 0; i < m; i++) {
    cur += diff[i];
    if (cur > grid.cellCapacity[i]) return false;
  }
  return true;
}
