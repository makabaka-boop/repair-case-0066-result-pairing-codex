import { relateSnapshot } from '../core/identity';
import type { StoredSnapshot } from '../core/persistence';
import type { CapacityCalendarSegment, Workspace } from '../core/types';
import type { SolveResponse } from '../solver/solver.worker';
import { decodeResponse, isCurrentResponse } from './messages';

export type SolveState = 'idle' | 'computing' | 'success' | 'error';

interface PendingRequest {
  requestId: number;
  /** 本次请求所属的数据身份；只接受同身份结果落地 */
  dataId: string;
  version: number;
  capacity: number;
  calendar: CapacityCalendarSegment[];
}

export interface SolverStatus {
  state: SolveState;
  /** 最近一次有效结果（必须与当前/上一个工作区同身份）；失败不会清空它 */
  snapshot: StoredSnapshot | null;
  /** 当前是否正在计算 */
  computing: boolean;
  /** 最近一次失败信息（不影响 snapshot） */
  errorMessage: string | null;
  /** 最近一次成功计算耗时（毫秒） */
  lastElapsedMs: number | null;
  /** 内部字段：进行中的请求 */
  pending: PendingRequest | null;
}

/**
 * 求解会话纯状态机：把 React 状态与 Worker 事件处理收敛到一个可单测的
 * 类中。所有“请求 → 成功/失败/解码失败/进程异常”的转移都在这里确定。
 *
 * 关键确定性保证：
 *  - 任何退出 computing 的路径（错误响应、结构畸形、解码失败、worker
 *    异常）都把 computing 置回 false，状态永久停在“计算中”不可能发生；
 *  - 失败只保留与当前工作区同身份（dataId）的最后一份有效快照；
 *    导入新批次后旧快照立即从内存移除，失败也不能下载旧作业结果；
 *  - 迟到的旧请求响应（requestId 不匹配）一律忽略，不改当前状态。
 */
export class SolverSession {
  private status: SolverStatus;
  private nextRequestId = 0;
  private readonly onPersistSnapshot: (snapshot: StoredSnapshot) => void;
  private readonly onClearSnapshot: () => void;

  constructor(
    initial: SolverStatus,
    hooks?: {
      onPersistSnapshot?: (snapshot: StoredSnapshot) => void;
      onClearSnapshot?: () => void;
      nextRequestId?: number;
    },
  ) {
    this.status = initial;
    this.nextRequestId = hooks?.nextRequestId ?? 0;
    this.onPersistSnapshot = hooks?.onPersistSnapshot ?? (() => {});
    this.onClearSnapshot = hooks?.onClearSnapshot ?? (() => {});
  }

  getState(): SolverStatus {
    return this.status;
  }

  /**
   * 发起一次求解。属于“当前数据”的内存快照管理也在此完成：
   *  - 换了数据身份（新批次导入，version 通常重置）：旧快照不再属于
   *    当前数据，立即丢弃并清理存储，绝不能在新求解失败后被下载；
   *  - 同一身份内的重算/约束修改：旧结果保留（随后按版本标 stale）。
   */
  run(workspace: Workspace): { requestId: number; request: import('../solver/solver.worker').SolveRequest } {
    this.nextRequestId += 1;
    const requestId = this.nextRequestId;
    const prevSnapshot = this.status.snapshot;
    if (prevSnapshot && prevSnapshot.dataId !== workspace.dataId) {
      this.status = { ...this.status, snapshot: null };
      this.onClearSnapshot();
    }
    this.status = {
      ...this.status,
      state: 'computing',
      computing: true,
      errorMessage: null,
      pending: {
        requestId,
        dataId: workspace.dataId,
        version: workspace.version,
        capacity: workspace.capacity,
        calendar: workspace.capacityCalendar,
      },
    };
    return {
      requestId,
      request: {
        type: 'solve',
        requestId,
        capacity: workspace.capacity,
        jobs: workspace.jobs,
        capacityCalendar: workspace.capacityCalendar,
      },
    };
  }

  /**
   * 处理 worker 回传的任意消息。raw 无法解码为合法响应（消息解码失败、
   * 结构畸形、结果结构不完整）时按求解失败处理：退出 computing，
   * 保留同身份最后有效快照，进入可立即重试的 error 状态。
   */
  handleRawMessage(raw: unknown): void {
    let msg: SolveResponse | null;
    try {
      msg = decodeResponse(raw);
    } catch (err) {
      this.fail(`求解响应无法解析：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (msg === null) {
      this.fail('求解进程返回了无法识别的消息');
      return;
    }
    this.handleResponse(msg);
  }

  /** worker 进程异常（onerror）：同上，确定退出 computing */
  handleWorkerError(message: string): void {
    this.fail(message || '求解进程发生异常');
  }

  /** 结构合法的成功/失败响应 */
  private handleResponse(msg: SolveResponse): void {
    const pending = this.status.pending;
    // 丢弃过期响应：导入/重算会发起更新的请求；旧请求晚到不得落地
    if (!pending || !isCurrentResponse(msg, pending.requestId)) return;

    if (msg.type === 'error') {
      this.fail(msg.message);
      return;
    }

    // 防御：成功结果的容量必须与请求一致，否则视为畸形结果
    if (msg.result.capacity !== pending.capacity) {
      this.fail('求解结果与当前容量不一致，已拒绝该结果');
      return;
    }

    const snapshot: StoredSnapshot = {
      workspaceVersion: pending.version,
      dataId: pending.dataId,
      capacity: pending.capacity,
      capacityCalendar: pending.calendar,
      solvedAt: new Date().toISOString(),
      result: msg.result,
    };
    this.onPersistSnapshot(snapshot);
    this.status = {
      state: 'success',
      snapshot,
      computing: false,
      errorMessage: null,
      lastElapsedMs: msg.elapsedMs,
      pending: null,
    };
  }

  /**
   * 统一失败转移：computing=false、state=error；保留的快照必须仍属于
   * 当前数据身份（run 已在换身份时清理，这里再防御一次）。
   */
  private fail(message: string): void {
    const pending = this.status.pending;
    let snapshot = this.status.snapshot;
    if (snapshot && pending && snapshot.dataId !== pending.dataId) {
      snapshot = null;
      this.onClearSnapshot();
    }
    this.status = {
      state: 'error',
      snapshot,
      computing: false,
      errorMessage: message,
      lastElapsedMs: this.status.lastElapsedMs,
      pending: null,
    };
  }
}

/** 由初始快照构造状态（页面加载/恢复时使用） */
export function initialStatus(snapshot: StoredSnapshot | null): SolverStatus {
  return {
    state: snapshot ? 'success' : 'idle',
    snapshot,
    computing: false,
    errorMessage: null,
    lastElapsedMs: null,
    pending: null,
  };
}

/**
 * 供 UI 层判断当前快照是否属于给定工作区；foreign 返回 null 时
 * 展示与下载都必须当作“没有结果”处理。
 */
export function snapshotRelationFor(
  snapshot: StoredSnapshot | null,
  workspace: Workspace | null,
): import('../core/identity').SnapshotRelation | null {
  if (!snapshot || !workspace) return null;
  return relateSnapshot(snapshot, workspace);
}
