import type { SolverResult } from './solver';
import type { CapacityCalendarSegment, Workspace } from './types';

export interface StoredSnapshot {
  workspaceVersion: number;
  capacity: number;
  /** 本次求解使用的容量日历（与工作区同一数据源） */
  capacityCalendar: CapacityCalendarSegment[];
  solvedAt: string;
  result: SolverResult;
}

const STORAGE_KEY = 'rail-possession-scheduler:v1';
const SNAPSHOT_KEY = 'rail-possession-scheduler:snapshot:v1';

interface PersistedWorkspace {
  capacity: number;
  version: number;
  jobs: Workspace['jobs'];
  /** 旧版本地数据可能没有该字段；缺省即全程 capacity（空数组） */
  capacityCalendar?: CapacityCalendarSegment[];
}

function isCalendar(value: unknown): value is CapacityCalendarSegment[] {
  return (
    Array.isArray(value) &&
    value.every(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        Number.isInteger((s as CapacityCalendarSegment).start) &&
        Number.isInteger((s as CapacityCalendarSegment).end) &&
        Number.isInteger((s as CapacityCalendarSegment).available),
    )
  );
}

export function persistWorkspace(workspace: Workspace): void {
  try {
    const data: PersistedWorkspace = {
      capacity: workspace.capacity,
      version: workspace.version,
      jobs: workspace.jobs,
      capacityCalendar: workspace.capacityCalendar,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // 存储不可用（隐私模式/超额）不影响内存中的功能
  }
}

export function loadWorkspace(): Workspace | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedWorkspace;
    if (
      typeof data !== 'object' ||
      data === null ||
      !Number.isInteger(data.capacity) ||
      !Array.isArray(data.jobs)
    ) {
      return null;
    }
    return {
      capacity: data.capacity as Workspace['capacity'],
      version: typeof data.version === 'number' ? data.version : 1,
      jobs: data.jobs,
      // 旧 JSON / 旧本地数据缺字段：保持原行为（全程 capacity）
      capacityCalendar: isCalendar(data.capacityCalendar) ? data.capacityCalendar : [],
    };
  } catch {
    return null;
  }
}

export function persistSnapshot(snapshot: StoredSnapshot): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // 忽略：结果持久化失败不影响当前会话
  }
}

export function loadSnapshot(): StoredSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as StoredSnapshot;
    if (
      typeof data !== 'object' ||
      data === null ||
      typeof data.result !== 'object' ||
      data.result === null
    ) {
      return null;
    }
    return {
      ...data,
      // 旧快照缺日历字段：视为全程 capacity
      capacityCalendar: isCalendar(data.capacityCalendar) ? data.capacityCalendar : [],
    };
  } catch {
    return null;
  }
}

/**
 * 屏幕展示集合与下载文件必须一致：统一由此函数构造结果 JSON。
 * 下载内容包含同一日历、集合、收益和峰值数据，不含任何占位值或派生猜测字段。
 */
export function buildResultJson(snapshot: StoredSnapshot): {
  capacity: number;
  capacityCalendar: CapacityCalendarSegment[];
  workspaceVersion: number;
  solvedAt: string;
  totalBenefit: number;
  peakOccupancy: number;
  peakCellLimit: number;
  selectedCount: number;
  selectedIds: string[];
} {
  return {
    capacity: snapshot.capacity,
    capacityCalendar: snapshot.capacityCalendar,
    workspaceVersion: snapshot.workspaceVersion,
    solvedAt: snapshot.solvedAt,
    totalBenefit: snapshot.result.totalBenefit,
    peakOccupancy: snapshot.result.peakOccupancy,
    peakCellLimit:
      snapshot.result.peakCellLimit ?? effectiveFallback(snapshot.capacityCalendar, snapshot.capacity),
    selectedCount: snapshot.result.selectedCount,
    selectedIds: snapshot.result.selectedIds,
  };
}

/** 旧结果缺 peakCellLimit 时的展示回退：空日历即全程 capacity。 */
function effectiveFallback(calendar: CapacityCalendarSegment[], capacity: number): number {
  return calendar.length === 0 ? capacity : Math.min(...calendar.map((s) => s.available));
}
