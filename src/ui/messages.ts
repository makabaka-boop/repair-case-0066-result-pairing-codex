import type { SolveResponse } from '../solver/solver.worker';
import type { SolverResult } from '../core/solver';

/**
 * 判断一条 worker 响应是否仍属于当前最新的请求。
 *
 * 工作区 A 计算期间立即导入工作区 B 会使最新 requestId 前移；
 * A 迟到（先于 B 返回）的响应 requestId 已过期，必须丢弃，
 * 否则 A 的集合/收益会被写入 B 的页面状态、快照与下载文件。
 */
export function isCurrentResponse(msg: SolveResponse, latestRequestId: number): boolean {
  return msg.requestId === latestRequestId;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 严格解码 worker 消息。
 *
 * 求解进程异常、消息通道投递给垃圾数据、成功消息里结果结构不完整
 * （selectedIds 含非字符串、数量对不上、数值字段非有限整数等）时，
 * 返回 null 或抛出错误——调用方一律按求解失败处理，从而确定性退出
 * “计算中”，而不是带着畸形结果继续渲染/持久化/导出。
 *
 * @returns 结构合法的 SolveResponse；无法识别的消息返回 null；
 *          可识别但字段畸形时抛出 Error（附带原因）。
 */
export function decodeResponse(raw: unknown): SolveResponse | null {
  if (!isObject(raw)) return null;
  if (raw.type !== 'success' && raw.type !== 'error') return null;
  if (!isInteger(raw.requestId) || raw.requestId < 1) {
    throw new Error('响应缺少合法的 requestId');
  }

  if (raw.type === 'error') {
    if (typeof raw.message !== 'string' || raw.message.length === 0) {
      throw new Error('错误响应缺少 message');
    }
    return {
      type: 'error',
      requestId: raw.requestId,
      message: raw.message,
      ...(typeof raw.conflictingId === 'string' ? { conflictingId: raw.conflictingId } : {}),
    };
  }

  const result = raw.result;
  if (!isObject(result)) throw new Error('成功响应缺少 result 对象');

  if (!Array.isArray(result.selectedIds)) throw new Error('result.selectedIds 必须是数组');
  const selectedIds: string[] = [];
  for (const id of result.selectedIds) {
    if (typeof id !== 'string') throw new Error('result.selectedIds 只能包含字符串');
    selectedIds.push(id);
  }
  const integerFields: Array<[string, unknown, number | null]> = [
    ['totalBenefit', result.totalBenefit, 0],
    ['peakOccupancy', result.peakOccupancy, 0],
    ['peakCellLimit', result.peakCellLimit, 0],
    ['capacity', result.capacity, null],
    ['selectedCount', result.selectedCount, 0],
  ];
  const checked: Record<string, number> = {};
  for (const [name, value, min] of integerFields) {
    if (!isInteger(value) || (min !== null && value < min)) {
      throw new Error(`result.${name} 必须是${min !== null ? `不小于 ${min} 的` : ''}整数`);
    }
    checked[name] = value;
  }
  if (checked.selectedCount !== selectedIds.length) {
    throw new Error('result.selectedCount 与 selectedIds 长度不一致');
  }
  if (!Number.isFinite(raw.elapsedMs) || typeof raw.elapsedMs !== 'number' || raw.elapsedMs < 0) {
    throw new Error('elapsedMs 必须是非负数字');
  }

  const solverResult: SolverResult = {
    selectedIds,
    totalBenefit: checked.totalBenefit,
    peakOccupancy: checked.peakOccupancy,
    peakCellLimit: checked.peakCellLimit,
    capacity: checked.capacity,
    selectedCount: checked.selectedCount,
  };
  return { type: 'success', requestId: raw.requestId, result: solverResult, elapsedMs: raw.elapsedMs };
}
