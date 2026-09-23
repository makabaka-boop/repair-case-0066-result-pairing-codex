import { describe, expect, it, beforeEach } from 'vitest';
import { createWorkspace } from '../src/core/workspace';
import {
  buildResultJson,
  clearSnapshot,
  loadSnapshot,
  loadWorkspace,
  persistSnapshot,
  persistWorkspace,
  restoreSession,
  type StoredSnapshot,
} from '../src/core/persistence';
import { LEGACY_DATA_ID, relateSnapshot, sanitizeSnapshot, sanitizeWorkspace } from '../src/core/identity';
import type { Workspace } from '../src/core/types';
import { decodeResponse } from '../src/ui/messages';
import { initialStatus, SolverSession } from '../src/ui/solverSession';
import type { SolveResponse } from '../src/solver/solver.worker';

/**
 * 自动化验收：恢复、导入、求解、展示、下载共享同一数据身份。
 * 预置注入：同版本异数据、单键写入、畸形日历/结果、求解进程异常、
 * 消息解码失败。断言：不展示/不下载混合结果，旧合法数据可恢复，
 * 且状态确定地回到可再次求解。
 */

const WS_KEY = 'rail-possession-scheduler:v1';
const SNAP_KEY = 'rail-possession-scheduler:snapshot:v1';

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

/* ----------------------------- 构造夹具 ----------------------------- */

function makeWorkspace(overrides: Partial<{ id: string; benefit: number }> = {}): Workspace {
  return createWorkspace({
    capacity: 2,
    jobs: [
      { id: overrides.id ?? 'a', start: 0, end: 10, benefit: overrides.benefit ?? 5 },
      { id: 'b', start: 10, end: 20, benefit: 7 },
    ],
  });
}

function makeSnapshot(ws: Workspace, resultOverride?: Partial<StoredSnapshot['result']>): StoredSnapshot {
  const selectedIds = resultOverride?.selectedIds ?? ws.jobs.map((j) => j.id);
  const totalBenefit =
    resultOverride?.totalBenefit ??
    selectedIds.reduce((sum, id) => sum + (ws.jobs.find((j) => j.id === id)?.benefit ?? 0), 0);
  return {
    workspaceVersion: ws.version,
    dataId: ws.dataId,
    capacity: ws.capacity,
    capacityCalendar: ws.capacityCalendar,
    solvedAt: '2026-09-23T00:00:00.000Z',
    result: {
      selectedIds,
      totalBenefit,
      peakOccupancy: resultOverride?.peakOccupancy ?? 1,
      peakCellLimit: resultOverride?.peakCellLimit ?? ws.capacity,
      capacity: ws.capacity,
      selectedCount: resultOverride?.selectedCount ?? selectedIds.length,
    },
  };
}

function writeRawWorkspace(data: unknown): void {
  storage.set(WS_KEY, JSON.stringify(data));
}
function writeRawSnapshot(data: unknown): void {
  storage.set(SNAP_KEY, JSON.stringify(data));
}

function makeSession(snapshot: StoredSnapshot | null = null) {
  const persisted: StoredSnapshot[] = [];
  let cleared = 0;
  const session = new SolverSession(initialStatus(snapshot), {
    onPersistSnapshot: (s) => {
      persisted.push(s);
      persistSnapshot(s);
    },
    onClearSnapshot: () => {
      cleared += 1;
      clearSnapshot();
    },
  });
  return {
    session,
    persisted: () => persisted,
    clearCount: () => cleared,
  };
}

function successResponse(
  requestId: number,
  resultOverride: Partial<StoredSnapshot['result']> = {},
): SolveResponse {
  return {
    type: 'success',
    requestId,
    elapsedMs: 10,
    result: {
      selectedIds: ['a', 'b'],
      totalBenefit: 12,
      peakOccupancy: 1,
      peakCellLimit: 2,
      capacity: 2,
      selectedCount: 2,
      ...resultOverride,
    },
  };
}

/* ----------------- 1. 同版本异数据：不冒充当前结果 ----------------- */

describe('验收：同一版本号的不同数据不得互相冒充', () => {
  it('新批次版本从 1 起步、旧快照也是 v1：恢复为无结果，且旧快照被清理', () => {
    // 旧批次（昨日）工作区 + 快照均为 v1，dataId 相同
    const oldWs = makeWorkspace();
    const oldSnap = makeSnapshot(oldWs, { selectedIds: ['a'], totalBenefit: 5 });
    persistWorkspace(oldWs);
    persistSnapshot(oldSnap);

    // 调度员今日重新导入另一批作业（同样 v1），只有工作区成功写入；
    // 快照键仍是昨日的旧记录 —— 等价于“单键写入 / 同版本异数据”
    const newWs = makeWorkspace({ id: 'x' }); // 作业 id 完全不同
    expect(newWs.version).toBe(oldWs.version); // 版本数字相同
    expect(newWs.dataId).not.toBe(oldWs.dataId); // 数据身份不同
    persistWorkspace(newWs);

    const restored = restoreSession();
    expect(restored).not.toBeNull();
    expect(restored!.workspace.jobs.map((j) => j.id)).toEqual(['x', 'b']);
    // 旧作业的 selectedIds/收益不得标成当前结果
    expect(restored!.snapshot).toBeNull();
    expect(restored!.relation).toBeNull();
    // 存储中的冒充快照已被主动清理，刷新后也不会复活
    expect(storage.has(SNAP_KEY)).toBe(false);
  });

  it('id 恰好重合但 benefit 不同的同版本快照同样被拒（内容交叉验证）', () => {
    const wsA = makeWorkspace({ benefit: 5 });
    const wsB = makeWorkspace({ benefit: 500 }); // 同 id、同版本、不同收益
    persistWorkspace(wsB);
    persistSnapshot(makeSnapshot(wsA, { selectedIds: ['a'], totalBenefit: 5 }));
    expect(restoreSession()!.snapshot).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);
  });

  it('同身份但版本更新（约束已修改）：标 stale 而非 current，仍可查看/下载', () => {
    const ws = makeWorkspace();
    const snap = makeSnapshot(ws, { selectedIds: ['a'], totalBenefit: 5 });
    // 模拟一次约束修改：版本 +1、dataId 不变
    const changed: Workspace = { ...ws, version: ws.version + 1, jobs: ws.jobs.map((j) => ({ ...j })) };
    persistWorkspace(changed);
    persistSnapshot(snap);
    const restored = restoreSession();
    expect(restored!.relation).toBe('stale');
    expect(restored!.snapshot).not.toBeNull();
  });
});

/* ------------------- 2. 单键写入：不混合恢复 ------------------- */

describe('验收：浏览器只成功写入其中一份记录', () => {
  it('只写入新工作区（旧快照残留）：只恢复工作区', () => {
    const oldWs = makeWorkspace();
    persistSnapshot(makeSnapshot(oldWs));
    const newWs = makeWorkspace({ id: 'today' });
    persistWorkspace(newWs);
    const session = restoreSession();
    expect(session!.workspace.dataId).toBe(newWs.dataId);
    expect(session!.snapshot).toBeNull();
  });

  it('只写入新快照（旧工作区残留）：快照结构合法但在内存中无归属', () => {
    const oldWs = makeWorkspace();
    persistWorkspace(oldWs);
    const newWs = makeWorkspace({ id: 'today' });
    persistSnapshot(makeSnapshot(newWs));
    // 恢复以工作区为准：新快照不属于旧工作区，被丢弃清理
    const session = restoreSession();
    expect(session).not.toBeNull();
    expect(session!.snapshot).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);
  });

  it('配套的两份记录同时存在：正常恢复为 current', () => {
    const ws = makeWorkspace();
    const snap = makeSnapshot(ws);
    persistWorkspace(ws);
    persistSnapshot(snap);
    const session = restoreSession();
    expect(session!.relation).toBe('current');
    expect(session!.snapshot!.result.selectedIds).toEqual(['a', 'b']);
  });
});

/* -------------- 3. 畸形日历 / 工作区 / 结果：拒绝渲染 -------------- */

describe('验收：存储中的畸形记录不得继续渲染或导出', () => {
  it('越界日历（available 超出 capacity-1）被拒绝', () => {
    const ws = makeWorkspace();
    writeRawWorkspace({
      capacity: 2,
      version: 1,
      dataId: ws.dataId,
      jobs: ws.jobs,
      capacityCalendar: [{ start: 0, end: 10, available: 2 }], // 只允许 0..1
    });
    expect(loadWorkspace()).toBeNull();
    expect(restoreSession()).toBeNull();
  });

  it('重叠日历片段被拒绝（端点相接允许）', () => {
    const ws = makeWorkspace();
    writeRawWorkspace({
      capacity: 2,
      version: 1,
      dataId: ws.dataId,
      jobs: ws.jobs,
      capacityCalendar: [
        { start: 0, end: 10, available: 1 },
        { start: 5, end: 15, available: 0 },
      ],
    });
    expect(loadWorkspace()).toBeNull();
  });

  it('日历片段超出作业范围 / 端点非整数被拒绝', () => {
    const ws = makeWorkspace();
    writeRawWorkspace({
      capacity: 2,
      version: 1,
      dataId: ws.dataId,
      jobs: ws.jobs,
      capacityCalendar: [{ start: -1, end: 10, available: 1 }],
    });
    expect(loadWorkspace()).toBeNull();
  });

  it('非法作业状态（含拼写错误）被拒绝', () => {
    const ws = makeWorkspace();
    writeRawWorkspace({
      capacity: 2,
      version: 1,
      dataId: ws.dataId,
      jobs: [{ ...ws.jobs[0], status: 'requird' }],
    });
    expect(loadWorkspace()).toBeNull();
  });

  it('作业越界 / 重复 id / 结构不完整被拒绝', () => {
    const ws = makeWorkspace();
    writeRawWorkspace({
      capacity: 2,
      version: 1,
      dataId: ws.dataId,
      jobs: [{ ...ws.jobs[0], end: 1_000_000_001 }],
    });
    expect(loadWorkspace()).toBeNull();

    writeRawWorkspace({
      capacity: 2,
      version: 1,
      dataId: ws.dataId,
      jobs: [ws.jobs[0], { ...ws.jobs[0] }],
    });
    expect(loadWorkspace()).toBeNull();

    writeRawWorkspace({ capacity: 2, version: 1, dataId: ws.dataId, jobs: 'nope' });
    expect(loadWorkspace()).toBeNull();

    writeRawWorkspace({ capacity: 9, version: 1, dataId: ws.dataId, jobs: ws.jobs });
    expect(loadWorkspace()).toBeNull();
  });

  it('结构不完整的结果（缺 selectedIds / 数量不符 / 含非字符串 / 收益为负）被拒绝', () => {
    const ws = makeWorkspace();
    const base = () => ({
      workspaceVersion: 1,
      dataId: ws.dataId,
      capacity: 2,
      capacityCalendar: [],
      solvedAt: '2026-09-23T00:00:00.000Z',
    });

    writeRawSnapshot({ ...base(), result: { totalBenefit: 1 } });
    expect(loadSnapshot()).toBeNull();

    writeRawSnapshot({
      ...base(),
      result: { selectedIds: ['a'], totalBenefit: 5, peakOccupancy: 1, peakCellLimit: 2, capacity: 2, selectedCount: 9 },
    });
    expect(loadSnapshot()).toBeNull();

    writeRawSnapshot({
      ...base(),
      result: { selectedIds: ['a', 7], totalBenefit: 5, peakOccupancy: 1, peakCellLimit: 2, capacity: 2, selectedCount: 2 },
    });
    expect(loadSnapshot()).toBeNull();

    writeRawSnapshot({
      ...base(),
      result: { selectedIds: [], totalBenefit: -1, peakOccupancy: 0, peakCellLimit: 2, capacity: 2, selectedCount: 0 },
    });
    expect(loadSnapshot()).toBeNull();
  });

  it('快照引用不存在的作业：不配对、不展示、不下载', () => {
    const ws = makeWorkspace();
    persistWorkspace(ws);
    persistSnapshot(makeSnapshot(ws, { selectedIds: ['ghost'], totalBenefit: 99, selectedCount: 1 }));
    const session = restoreSession();
    expect(session!.snapshot).toBeNull();
    expect(relateSnapshot(makeSnapshot(ws, { selectedIds: ['ghost'], totalBenefit: 99, selectedCount: 1 }), ws)).toBe(
      'foreign',
    );
  });

  it('入选数违反容量日历的快照被拒绝（不会显示错误容量）', () => {
    const ws = createWorkspace({
      capacity: 2,
      jobs: [
        { id: 'a', start: 0, end: 10, benefit: 5 },
        { id: 'b', start: 0, end: 10, benefit: 6 },
      ],
      capacityCalendar: [{ start: 0, end: 10, available: 1 }],
    });
    // 两项重叠作业在 available=1 时段同时入选：不可能由该工作区产生
    const bad = makeSnapshot(ws, { selectedIds: ['a', 'b'], totalBenefit: 11, peakOccupancy: 2, peakCellLimit: 1 });
    expect(relateSnapshot(bad, ws)).toBe('foreign');
  });

  it('快照日历与工作区日历不符（同 dataId/版本）也拒绝', () => {
    const ws = createWorkspace({
      capacity: 2,
      jobs: [{ id: 'a', start: 0, end: 20, benefit: 5 }],
      capacityCalendar: [{ start: 0, end: 10, available: 1 }],
    });
    const otherCalendar = makeSnapshot(ws);
    otherCalendar.capacityCalendar = [];
    expect(relateSnapshot(otherCalendar, ws)).toBe('foreign');

    const otherCapacity = makeSnapshot(ws);
    otherCapacity.capacity = 1 as StoredSnapshot['capacity'];
    otherCapacity.result = { ...otherCapacity.result, capacity: 1, peakCellLimit: 1 };
    expect(relateSnapshot(otherCapacity, ws)).toBe('foreign');
  });

  it('selectedIds 含重复 id：结构层放行但配对层拒绝', () => {
    const ws = makeWorkspace();
    const dup = makeSnapshot(ws, { selectedIds: ['a', 'a'], totalBenefit: 10, selectedCount: 2 });
    expect(relateSnapshot(dup, ws)).toBe('foreign');
  });

  it('顶层 JSON 畸形（字符串/数组/null）安全返回 null，不抛异常', () => {
    storage.set(WS_KEY, '{not json');
    expect(loadWorkspace()).toBeNull();
    storage.set(SNAP_KEY, '[1,2,3]');
    expect(loadSnapshot()).toBeNull();
    expect(restoreSession()).toBeNull();
  });

  it('sanitize 单元守卫：日历/快照的各类畸形输入均为 null', () => {
    expect(sanitizeWorkspace(null)).toBeNull();
    expect(sanitizeWorkspace(undefined)).toBeNull();
    expect(sanitizeWorkspace('x')).toBeNull();
    expect(sanitizeSnapshot(null)).toBeNull();
    expect(sanitizeSnapshot({ workspaceVersion: 1 })).toBeNull();
  });
});

/* ---------------- 4. 旧合法存储：兼容恢复 ---------------- */

describe('验收：既有合法存储与缺省日历仍可恢复', () => {
  it('旧工作区无 dataId/calendar/version 字段：补默认值后恢复', () => {
    writeRawWorkspace({
      capacity: 3,
      jobs: [{ id: 'old', start: 0, end: 10, benefit: 1, status: 'normal' }],
    });
    const ws = loadWorkspace();
    expect(ws).not.toBeNull();
    expect(ws!.capacity).toBe(3);
    expect(ws!.version).toBe(1);
    expect(ws!.dataId).toBe(LEGACY_DATA_ID);
    expect(ws!.capacityCalendar).toEqual([]);
  });

  it('旧快照无 dataId/calendar/peakCellLimit：与同内容旧工作区配对并恢复', () => {
    writeRawWorkspace({
      capacity: 2,
      version: 2,
      jobs: [{ id: 'x', start: 0, end: 10, benefit: 5, status: 'normal' }],
    });
    writeRawSnapshot({
      workspaceVersion: 2,
      capacity: 2,
      solvedAt: '2026-09-20T00:00:00.000Z',
      result: {
        selectedIds: ['x'],
        totalBenefit: 5,
        peakOccupancy: 1,
        capacity: 2,
        selectedCount: 1,
      },
    });
    const session = restoreSession();
    expect(session).not.toBeNull();
    expect(session!.relation).toBe('current');
    expect(session!.snapshot!.dataId).toBe(LEGACY_DATA_ID);
    const json = buildResultJson(session!.snapshot!);
    expect(json.selectedIds).toEqual(['x']);
    expect(json.peakCellLimit).toBe(2); // 旧结果缺字段：回退全程 capacity
    expect(json.capacityCalendar).toEqual([]);
  });

  it('旧快照不能与新数据（有 dataId）配对，即使版本相同', () => {
    const newWs = makeWorkspace();
    persistWorkspace(newWs);
    writeRawSnapshot({
      workspaceVersion: 1,
      capacity: 2,
      solvedAt: '2026-09-20T00:00:00.000Z',
      result: {
        selectedIds: ['a', 'b'],
        totalBenefit: 12,
        peakOccupancy: 1,
        peakCellLimit: 2,
        capacity: 2,
        selectedCount: 2,
      },
    });
    expect(restoreSession()!.snapshot).toBeNull();
  });

  it('下载结构保持原样：不含 dataId，字段集合与旧版一致', () => {
    const ws = makeWorkspace();
    const json = buildResultJson(makeSnapshot(ws));
    expect(Object.keys(json).sort()).toEqual(
      [
        'capacity',
        'capacityCalendar',
        'peakCellLimit',
        'peakOccupancy',
        'selectedCount',
        'selectedIds',
        'solvedAt',
        'totalBenefit',
        'workspaceVersion',
      ].sort(),
    );
    expect(json).not.toHaveProperty('dataId');
  });
});

/* --------- 5. 求解异常 / 解码失败：确定退出“计算中”可重试 --------- */

describe('验收：求解进程异常与消息解码失败', () => {
  it('error 响应：退出 computing，保留同身份旧结果，可立即再次求解', () => {
    const ws = makeWorkspace();
    const oldSnap = makeSnapshot(ws, { selectedIds: ['a'], totalBenefit: 5 });
    const { session } = makeSession(oldSnap);

    session.run(ws);
    expect(session.getState().computing).toBe(true);
    expect(session.getState().state).toBe('computing');

    const { requestId } = session.run(ws); // 再次发起也合法；以最新请求为准
    session.handleRawMessage({ type: 'error', requestId, message: '必选不可行' });

    const s = session.getState();
    expect(s.computing).toBe(false); // 不确定地停在计算中
    expect(s.state).toBe('error');
    expect(s.errorMessage).toContain('必选不可行');
    expect(s.pending).toBeNull();
    // 最后一份同数据有效结果保留
    expect(s.snapshot!.result.selectedIds).toEqual(['a']);

    // 可再次求解，且能成功落地
    const retry = session.run(ws);
    expect(session.getState().computing).toBe(true);
    session.handleRawMessage(successResponse(retry.requestId));
    const after = session.getState();
    expect(after.state).toBe('success');
    expect(after.computing).toBe(false);
    expect(after.snapshot!.result.selectedIds).toEqual(['a', 'b']);
  });

  it('worker 进程异常（onerror）：退出 computing 且可重试', () => {
    const ws = makeWorkspace();
    const { session } = makeSession(null);
    session.run(ws);
    session.handleWorkerError('求解进程崩溃');
    const s = session.getState();
    expect(s.computing).toBe(false);
    expect(s.state).toBe('error');
    const retry = session.run(ws);
    session.handleRawMessage(successResponse(retry.requestId));
    expect(session.getState().state).toBe('success');
  });

  it('消息完全无法解码（垃圾数据/解码异常）：按失败处理，不卡死', () => {
    const ws = makeWorkspace();
    const { session } = makeSession(null);
    session.run(ws);
    for (const garbage of [null, undefined, 'oops', 42, [], { type: 'weird' }]) {
      session.handleRawMessage(garbage);
      const s = session.getState();
      expect(s.computing).toBe(false);
      expect(s.state).toBe('error');
      expect(s.pending).toBeNull();
    }
  });

  it('成功消息结构畸形：拒绝落地、不持久化、退出 computing', () => {
    const ws = makeWorkspace();
    const { session, persisted } = makeSession(null);
    const { requestId } = session.run(ws);

    session.handleRawMessage({ type: 'success', requestId, elapsedMs: 1, result: null });
    expect(session.getState().state).toBe('error');
    expect(session.getState().computing).toBe(false);
    expect(session.getState().snapshot).toBeNull();
    expect(persisted()).toHaveLength(0);
    expect(loadSnapshot()).toBeNull(); // 畸形结果没有被写入存储

    // 数量对不上同样拒绝
    session.run(ws);
    session.handleRawMessage(
      successResponse(session.getState().pending!.requestId, {
        selectedIds: ['a'],
        totalBenefit: 5,
        peakOccupancy: 1,
        peakCellLimit: 2,
        capacity: 2,
        selectedCount: 2,
      }),
    );
    expect(session.getState().state).toBe('error');
  });

  it('成功结果容量与请求不符：拒绝落地', () => {
    const ws = makeWorkspace();
    const { session } = makeSession(null);
    const { requestId } = session.run(ws);
    session.handleRawMessage(
      successResponse(requestId, {
        selectedIds: [],
        totalBenefit: 0,
        peakOccupancy: 0,
        peakCellLimit: 3,
        capacity: 3, // 请求 capacity=2
        selectedCount: 0,
      }),
    );
    const s = session.getState();
    expect(s.state).toBe('error');
    expect(s.snapshot).toBeNull();
  });

  it('迟到的旧请求响应（含成功/失败）被忽略，不改变可重试状态', () => {
    const ws = makeWorkspace();
    const { session } = makeSession(null);
    const first = session.run(ws);
    const second = session.run(ws);
    expect(first.requestId).not.toBe(second.requestId);

    session.handleRawMessage(successResponse(first.requestId)); // 旧请求迟到
    expect(session.getState().computing).toBe(true); // 仍在等最新请求
    expect(session.getState().state).toBe('computing');

    session.handleRawMessage({ type: 'error', requestId: first.requestId, message: '旧失败' });
    expect(session.getState().computing).toBe(true);

    session.handleRawMessage(successResponse(second.requestId));
    expect(session.getState().state).toBe('success');
  });
});

/* ------ 6. 导入新批次：旧结果在失败后仍不展示、不可下载 ------ */

describe('验收：新工作区与旧快照严格隔离（失败保留的是当前数据的结果）', () => {
  it('导入另一批后自动求解失败：内存与存储中都没有旧结果可下载', () => {
    const oldWs = makeWorkspace();
    const oldSnap = makeSnapshot(oldWs);
    const { session, clearCount } = makeSession(oldSnap);
    expect(session.getState().snapshot).not.toBeNull();
    persistSnapshot(oldSnap);

    // 调度员立即导入另一批作业（版本同样从 1 起步）
    const newWs = makeWorkspace({ id: 'today' });
    const { requestId } = session.run(newWs);
    expect(clearCount()).toBe(1);
    expect(session.getState().snapshot).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);

    // 新批次求解失败：旧结果不得复活
    session.handleRawMessage({ type: 'error', requestId, message: '求解失败' });
    const s = session.getState();
    expect(s.state).toBe('error');
    expect(s.snapshot).toBeNull();
    expect(storage.has(SNAP_KEY)).toBe(false);

    // 再试一次并成功：只落地新数据的结果
    const retry = session.run(newWs);
    session.handleRawMessage(successResponse(retry.requestId));
    expect(session.getState().snapshot!.dataId).toBe(newWs.dataId);
  });

  it('同身份重算失败：保留该身份最后一份有效结果', () => {
    const ws = makeWorkspace();
    const snap = makeSnapshot(ws);
    const { session, clearCount } = makeSession(snap);
    const { requestId } = session.run(ws); // 同一 dataId
    expect(clearCount()).toBe(0);
    session.handleRawMessage({ type: 'error', requestId, message: 'boom' });
    expect(session.getState().snapshot).not.toBeNull();
    expect(session.getState().snapshot!.dataId).toBe(ws.dataId);
  });
});

/* ----------------------- 7. 往返与身份唯一性 ----------------------- */

describe('验收：持久化往返与导入身份', () => {
  it('工作区与快照写入后可往返，且两次导入的 dataId 不同', () => {
    const ws1 = makeWorkspace();
    const ws2 = makeWorkspace();
    expect(ws1.dataId).not.toBe(ws2.dataId);
    expect(ws1.dataId).not.toBe('');
    persistWorkspace(ws1);
    persistSnapshot(makeSnapshot(ws1));
    const session = restoreSession();
    expect(session!.workspace).toEqual(ws1);
    expect(session!.relation).toBe('current');
  });

  it('约束修改保持 dataId、版本前进；旧结果标 stale', () => {
    const ws = makeWorkspace();
    // 旧结果只选 a（b 未入选）；之后把 b 设为排除不影响旧集合的可产生性，
    // 但版本前进 => 同身份旧结果应标 stale
    persistWorkspace(ws);
    persistSnapshot(makeSnapshot(ws, { selectedIds: ['a'], totalBenefit: 5 }));
    const changed: Workspace = {
      ...ws,
      version: ws.version + 1,
      jobs: ws.jobs.map((j) => (j.id === 'b' ? { ...j, status: 'excluded' as const } : { ...j })),
    };
    persistWorkspace(changed);
    const session = restoreSession();
    expect(session!.relation).toBe('stale');
    // stale 是同身份旧结果，仍允许按原结构下载（界面明确标过期）
    const json = buildResultJson(session!.snapshot!);
    expect(json.workspaceVersion).toBe(ws.version);
  });
});

/* ------------------- 8. decodeResponse 单元边界 ------------------- */

describe('验收：decodeResponse 严格解码', () => {
  it('合法成功/失败响应通过', () => {
    expect(decodeResponse(successResponse(1))!.type).toBe('success');
    const err = decodeResponse({ type: 'error', requestId: 2, message: 'x' });
    expect(err).toEqual({ type: 'error', requestId: 2, message: 'x' });
  });

  it('无法识别的消息返回 null；畸形字段抛错', () => {
    expect(decodeResponse({ type: 'done', requestId: 1 })).toBeNull();
    expect(decodeResponse(null)).toBeNull();
    // 可识别为成功响应但缺 requestId：抛错（调用方按失败处理）
    expect(() => decodeResponse({ type: 'success' })).toThrow();
    expect(() => decodeResponse({ type: 'success', requestId: 1, elapsedMs: 1 })).toThrow();
    expect(() => decodeResponse({ type: 'error', requestId: 1, message: '' })).toThrow();
  });
});
