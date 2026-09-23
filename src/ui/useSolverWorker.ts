import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSnapshot, persistSnapshot, type StoredSnapshot } from '../core/persistence';
import type { CapacityCalendarSegment, Workspace } from '../core/types';
import type { SolveRequest, SolveResponse } from '../solver/solver.worker';
import { isCurrentResponse } from './messages';

export type SolveState = 'idle' | 'computing' | 'success' | 'error';

export interface SolverStatus {
  state: SolveState;
  /** 最近一次成功结果；失败不会清空它 */
  snapshot: StoredSnapshot | null;
  /** 当前是否正在计算 */
  computing: boolean;
  /** 最近一次失败信息（不影响 snapshot） */
  errorMessage: string | null;
  /** 最近一次成功计算耗时（毫秒） */
  lastElapsedMs: number | null;
  /** 内部字段：进行中的请求对应的工作区版本 */
  pendingVersion?: number;
  /** 内部字段：进行中的请求携带的日历（成功后写入快照） */
  pendingCalendar?: CapacityCalendarSegment[];
}

export function useSolverWorker() {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  const [status, setStatus] = useState<SolverStatus>(() => {
    const initial =
      typeof localStorage !== 'undefined' ? loadSnapshot() : null;
    return {
      state: initial ? 'success' : 'idle',
      snapshot: initial,
      computing: false,
      errorMessage: null,
      lastElapsedMs: null,
    } as SolverStatus;
  });

  useEffect(() => {
    const worker = new Worker(new URL('../solver/solver.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (ev: MessageEvent<SolveResponse>) => {
      const msg = ev.data;

      // 丢弃过期响应：导入/重算会发起更新的请求；若旧工作区的计算
      // 晚于新工作区返回，绝不能让旧结果顶替新工作区的待处理状态。
      if (!isCurrentResponse(msg, requestIdRef.current)) return;

      if (msg.type === 'success') {
        // snapshot 在调用 run 时已确定 workspaceVersion 与日历；这里回填结果
        setStatus((prev) => {
          if (!prev.pendingVersion) return prev;
          const snapshot: StoredSnapshot = {
            workspaceVersion: prev.pendingVersion,
            capacity: msg.result.capacity,
            capacityCalendar: prev.pendingCalendar ?? [],
            solvedAt: new Date().toISOString(),
            result: msg.result,
          };
          persistSnapshot(snapshot);
          return {
            state: 'success',
            snapshot,
            computing: false,
            errorMessage: null,
            lastElapsedMs: msg.elapsedMs,
            pendingVersion: undefined,
            pendingCalendar: undefined,
          };
        });
      } else {
        // 关键语义：失败不清空最近成功结果
        setStatus((prev) => ({
          state: 'error',
          snapshot: prev.snapshot,
          computing: false,
          errorMessage: msg.message,
          lastElapsedMs: prev.lastElapsedMs,
          pendingVersion: undefined,
          pendingCalendar: undefined,
        }));
      }
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const run = useCallback((workspace: Workspace) => {
    const worker = workerRef.current;
    if (!worker) return;
    requestIdRef.current += 1;
    const id = requestIdRef.current;
    // 求解请求携带当前日历；日历随导入确定，与 jobs/capacity 同源
    const request: SolveRequest = {
      type: 'solve',
      requestId: id,
      capacity: workspace.capacity,
      jobs: workspace.jobs,
      capacityCalendar: workspace.capacityCalendar,
    };
    setStatus((prev) => ({
      ...prev,
      state: 'computing',
      computing: true,
      errorMessage: null,
      pendingVersion: workspace.version,
      pendingCalendar: workspace.capacityCalendar,
    }));
    worker.postMessage(request);
  }, []);

  return { status, run };
}
