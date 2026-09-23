import type { SolveResponse } from '../solver/solver.worker';

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
