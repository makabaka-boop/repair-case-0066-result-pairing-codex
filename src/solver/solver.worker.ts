import { solve, type SolverJob, type SolverResult } from '../core/solver';
import type { InfeasibleRequiredError } from '../core/solver';
import type { CapacityCalendarSegment } from '../core/types';

export interface SolveRequest {
  type: 'solve';
  requestId: number;
  jobs: SolverJob[];
  capacity: number;
  /** 当前请求的容量日历；约束变化（含日历）使旧结果过期 */
  capacityCalendar: CapacityCalendarSegment[];
}

export type SolveResponse =
  | {
      type: 'success';
      requestId: number;
      result: SolverResult;
      elapsedMs: number;
    }
  | {
      type: 'error';
      requestId: number;
      message: string;
      conflictingId?: string;
    };

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  onmessageerror: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage: (msg: SolveResponse) => void;
};

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** 拒绝畸形请求：回错误响应而不是静默吞掉（否则 UI 会永久等待） */
function rejectRequest(requestId: number, message: string): void {
  ctx.postMessage({ type: 'error', requestId, message });
}

ctx.onmessage = (ev: MessageEvent<unknown>) => {
  const msg = ev.data as Partial<SolveRequest> | null;
  if (!msg || typeof msg !== 'object' || msg.type !== 'solve') return;
  if (!isInteger(msg.requestId) || msg.requestId < 1) return; // 无法回应的消息
  const { requestId } = msg;
  if (!isInteger(msg.capacity) || !Array.isArray(msg.jobs)) {
    rejectRequest(requestId, '求解请求结构不完整：缺少 capacity 或 jobs');
    return;
  }

  const started = performance.now();
  try {
    // Worker 只提交当前请求携带的日历：迟到的旧请求响应会被 UI 丢弃
    const result = solve(msg.jobs as SolverJob[], msg.capacity, msg.capacityCalendar ?? []);
    const response: SolveResponse = {
      type: 'success',
      requestId: msg.requestId,
      result,
      elapsedMs: Math.round(performance.now() - started),
    };
    ctx.postMessage(response);
  } catch (err) {
    const infeasible = err as InfeasibleRequiredError;
    const response: SolveResponse = {
      type: 'error',
      requestId: msg.requestId,
      message: err instanceof Error ? err.message : String(err),
      conflictingId: infeasible?.conflictingId,
    };
    ctx.postMessage(response);
  }
};

// 主线程消息解码/克隆失败时明确报错，不让对端永久停在“计算中”
ctx.onmessageerror = () => {
  ctx.postMessage({ type: 'error', requestId: -1, message: '求解请求消息解码失败' });
};

export {};
