import { useCallback, useEffect, useRef, useState } from 'react';
import { clearSnapshot, persistSnapshot, type StoredSnapshot } from '../core/persistence';
import type { Workspace } from '../core/types';
import { initialStatus, SolverSession, type SolverStatus } from './solverSession';

/**
 * React 适配层：真正的状态转移全部在纯类 SolverSession 中（可单测）。
 * 本 hook 只负责 Worker 生命周期与 React 状态同步，并额外保证：
 * worker 的 error / messageerror（消息解码失败）也会让状态确定退出
 * “计算中”，回到可再次求解的 error 状态。
 */
export function useSolverWorker(initialSnapshot: StoredSnapshot | null = null) {
  const workerRef = useRef<Worker | null>(null);
  const sessionRef = useRef<SolverSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = new SolverSession(initialStatus(initialSnapshot), {
      onPersistSnapshot: persistSnapshot,
      onClearSnapshot: clearSnapshot,
    });
  }

  const [status, setStatus] = useState<SolverStatus>(() => sessionRef.current!.getState());
  const sync = useCallback(() => {
    const s = sessionRef.current!.getState();
    // 浅拷贝触发 React 更新（每次转移都会产生新对象）
    setStatus({ ...s });
  }, []);

  useEffect(() => {
    // Worker 创建失败（极端环境）时也不得永久卡在 computing：直接转 error
    let worker: Worker;
    try {
      worker = new Worker(new URL('../solver/solver.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (err) {
      sessionRef.current!.handleWorkerError(
        `求解线程无法启动：${err instanceof Error ? err.message : String(err)}`,
      );
      sync();
      return;
    }
    workerRef.current = worker;

    worker.onmessage = (ev: MessageEvent<unknown>) => {
      sessionRef.current!.handleRawMessage(ev.data);
      sync();
    };
    // 求解进程异常（运行时错误、资源问题等）
    worker.onerror = (ev: ErrorEvent) => {
      sessionRef.current!.handleWorkerError(ev.message || '求解进程发生异常');
      sync();
    };
    // 消息解码失败（结构化克隆失败等）：同样必须退出 computing
    worker.onmessageerror = () => {
      sessionRef.current!.handleWorkerError('求解响应消息解码失败');
      sync();
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [sync]);

  const run = useCallback(
    (workspace: Workspace) => {
      const worker = workerRef.current;
      const session = sessionRef.current!;
      // worker 尚未就绪（理论上创建后同步可用）：在状态机里登记失败，
      // 保证按钮不会停在“计算中…”
      if (!worker) {
        session.handleWorkerError('求解线程尚未就绪，请稍后重试');
        sync();
        return;
      }
      const { request } = session.run(workspace);
      try {
        worker.postMessage(request);
      } catch (err) {
        // postMessage 本身失败（如消息无法序列化）：确定性进入 error
        session.handleWorkerError(
          `求解请求发送失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      sync();
    },
    [sync],
  );

  return { status, run };
}
