import type { CapacityCalendarSegment, Workspace } from './types';
import {
  LEGACY_DATA_ID,
  relateSnapshot,
  sanitizeCalendar,
  sanitizeSnapshot,
  sanitizeWorkspace,
} from './identity';
import type { SnapshotRelation, StoredSnapshot } from './identity';

export type { StoredSnapshot } from './identity';

export type { SnapshotRelation } from './identity';

const STORAGE_KEY = 'rail-possession-scheduler:v1';
const SNAPSHOT_KEY = 'rail-possession-scheduler:snapshot:v1';

interface PersistedWorkspace {
  capacity: number;
  version: number;
  jobs: Workspace['jobs'];
  /** 旧版本地数据可能没有该字段；缺省即全程 capacity（空数组） */
  capacityCalendar?: CapacityCalendarSegment[];
  /** 旧版本地数据没有该字段；缺省即遗留身份 */
  dataId?: string;
}

/** 写入时的最小 localStorage 抽象（测试以 Map 桩注入） */
function getStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function persistWorkspace(workspace: Workspace): void {
  try {
    const data: PersistedWorkspace = {
      capacity: workspace.capacity,
      version: workspace.version,
      jobs: workspace.jobs,
      capacityCalendar: workspace.capacityCalendar,
      dataId: workspace.dataId,
    };
    getStorage()?.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // 存储不可用（隐私模式/超额）不影响内存中的功能
  }
}

/**
 * 读取工作区并做完整结构校验。任何越界日历/作业、非法状态或结构不完整
 * 的记录都返回 null，绝不让畸形数据进入渲染/求解/下载链路。
 * 旧格式缺 capacityCalendar / version / dataId 按兼容规则补默认值。
 */
export function loadWorkspace(): Workspace | null {
  try {
    const raw = getStorage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    return sanitizeWorkspace(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function persistSnapshot(snapshot: StoredSnapshot): void {
  try {
    getStorage()?.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // 忽略：结果持久化失败不影响当前会话
  }
}

/** 删除快照（导入新批次或恢复时发现孤儿/畸形快照时调用） */
export function clearSnapshot(): void {
  try {
    getStorage()?.removeItem(SNAPSHOT_KEY);
  } catch {
    // 存储不可用不影响内存语义
  }
}

/**
 * 读取求解快照并做完整结构校验；结构畸形返回 null。
 * 注意：结构合法不代表属于当前工作区，调用方还须用 restoreSession /
 * relateSnapshot 做数据身份配对。
 */
export function loadSnapshot(): StoredSnapshot | null {
  try {
    const raw = getStorage()?.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    return sanitizeSnapshot(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export interface RestoredSession {
  workspace: Workspace;
  /** 与工作区同身份的快照（current 或 stale）；foreign/畸形时为 null */
  snapshot: StoredSnapshot | null;
  relation: SnapshotRelation | null;
}

/**
 * 恢复、导入、求解、展示和下载共享的唯一入口：工作区与快照必须通过
 * 同一数据身份校验才会一起恢复。
 *
 * 处理浏览器只成功写入其中一份记录的情况：
 *  - 工作区畸形：整个会话放弃（旧合法数据的优先级低于不冒充原则）；
 *  - 快照畸形或不属于该工作区（foreign，含同版本异数据/单键写入混合）：
 *    丢弃快照并主动清理存储键，只恢复工作区，页面不展示也不能下载它。
 */
export function restoreSession(): RestoredSession | null {
  const workspace = loadWorkspace();
  if (!workspace) return null;

  const snapshot = loadSnapshot();
  if (!snapshot) return { workspace, snapshot: null, relation: null };

  const relation = relateSnapshot(snapshot, workspace);
  if (relation === 'foreign') {
    clearSnapshot();
    return { workspace, snapshot: null, relation: null };
  }
  return { workspace, snapshot, relation };
}

/**
 * 屏幕展示集合与下载文件必须一致：统一由此函数构造结果 JSON。
 * 下载内容包含同一日历、集合、收益和峰值数据，不含任何占位值或派生猜测字段。
 * 结构与旧版完全一致（dataId 为内部身份字段，不进入下载文件）。
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

/** 供测试/兼容场景直接判定日历是否为合法结构 */
export function isValidCalendar(value: unknown): boolean {
  return sanitizeCalendar(value, 8) !== null;
}

/** 遗留身份常量再导出，避免调用方依赖内部模块路径 */
export { LEGACY_DATA_ID };
