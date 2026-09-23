import { useMemo } from 'react';
import { buildResultJson, type StoredSnapshot } from '../core/persistence';
import type { SnapshotRelation } from '../core/identity';
import type { SolverStatus } from './solverSession';

interface Props {
  status: SolverStatus;
  workspaceVersion: number;
  /** 快照与当前工作区的身份关系；null 表示无归属结果（含 foreign），不展示不下载 */
  relation: SnapshotRelation | null;
  onRecompute: () => void;
}

/**
 * 求解结果区。
 * 关键语义：
 *  - 计算中：显示进行中状态，同身份旧结果仍可见
 *  - 失败：显示错误，不清空同身份最近一次成功结果，并可立即重试
 *  - relation === 'stale'：同批数据的旧版本结果，标记“已过期，请重算”
 *  - relation === null（含 foreign / 结构畸形）：当作没有结果，
 *    不展示、不允许下载——任何不匹配快照都不得冒充当前结果
 *  - 屏幕显示的集合 = 下载 JSON 中的集合（同一个 buildResultJson 数据源）
 */
export function ResultPanel({ status, workspaceVersion, relation, onRecompute }: Props) {
  const rawSnapshot = status.snapshot;
  // 唯一的“可归属快照”判据：恢复/导入/求解/展示/下载共享同一身份关系
  const snapshot: StoredSnapshot | null =
    rawSnapshot && relation !== null && relation !== 'foreign' ? rawSnapshot : null;
  const stale = relation === 'stale';

  const download = useMemo(() => {
    if (!snapshot || status.computing) return null;
    return () => {
      const payload = buildResultJson(snapshot);
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `schedule-${payload.workspaceVersion}.json`;
      a.click();
      URL.revokeObjectURL(url);
    };
  }, [snapshot, status.computing]);

  return (
    <section className="panel result-panel">
      <div className="result-head">
        <h2>3. 排程结果</h2>
        <div className="result-actions">
          <button
            className="primary"
            onClick={onRecompute}
            disabled={status.computing}
            title="按当前必选/排除约束精确最大化收益"
          >
            {status.computing ? '计算中…' : snapshot ? '重新计算' : '计算最优排程'}
          </button>
          <button onClick={() => download?.()} disabled={download === null}>
            下载结果 JSON
          </button>
        </div>
      </div>

      {status.state === 'error' && status.errorMessage && (
        <div className="error-box" role="alert">
          计算失败：{status.errorMessage}
          <div className="hint">
            最近一次同数据的成功结果仍保留在下方，未被清空；修正约束后可立即重算。
          </div>
        </div>
      )}

      {status.computing && <div className="info-box">正在精确求解，请稍候…</div>}

      {!snapshot && !status.computing && (
        <div className="hint">尚未计算。导入数据后将自动求解，或点击上方按钮手动计算。</div>
      )}

      {snapshot && (
        <div className={stale ? 'stale' : ''}>
          {stale && (
            <div className="warn-box">
              约束已修改，以下结果基于旧版本（v{snapshot.workspaceVersion}，当前 v
              {workspaceVersion}），已过期。点击“重新计算”获取最新最优解。
            </div>
          )}
          <div className="metric-grid">
            <Metric label="总收益（精确）" value={snapshot.result.totalBenefit.toLocaleString()} />
            <Metric
              label="峰值占用 / 最早峰值格上限"
              value={`${snapshot.result.peakOccupancy} / ${snapshot.result.peakCellLimit ?? snapshot.capacity}`}
            />
            <Metric label="入选作业数" value={String(snapshot.result.selectedCount)} />
            <Metric label="求解版本" value={`v${snapshot.workspaceVersion}`} />
          </div>
          <div className="result-meta">
            计算完成时间：{snapshot.solvedAt}
            {status.lastElapsedMs !== null && (
              <>　·　耗时 {status.lastElapsedMs} ms</>
            )}
          </div>
          <SelectedIds snapshot={snapshot} />
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

function SelectedIds({ snapshot }: { snapshot: StoredSnapshot }) {
  const ids = snapshot.result.selectedIds;
  const jsonIds = buildResultJson(snapshot).selectedIds;
  // 屏幕集合与下载一致性断言（同数据源，正常情况下恒等）
  const consistent = ids.length === jsonIds.length && ids.every((v, i) => v === jsonIds[i]);
  return (
    <details className="selected-details">
      <summary>
        入选集合（{ids.length} 项{consistent ? '，与下载 JSON 一致' : '，与下载不一致！'}）
      </summary>
      <textarea readOnly rows={10} value={JSON.stringify(ids, null, 2)} spellCheck={false} />
    </details>
  );
}
