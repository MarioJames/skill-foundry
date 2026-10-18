import {useEffect, useRef, useState} from 'react';
import {Empty} from '@lobehub/ui';
import {Alert, Button, Skeleton, Tag} from '@lobehub/ui/base-ui';
import {PageHeader, Surface} from '@lobehub/ui/dashboard';
import {RefreshCw} from 'lucide-react';
import type {BoardSnapshot, BoardTask, BoardWorker} from '../lib/agent-board';
import {styles} from './agent-board.style';

const POLL_MS = 10_000;

function formatTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'}).format(date);
}
function groupLabel(status: BoardTask['status']) {
  return status === 'active' ? '进行中' : status === 'closing' ? '收尾中' : '已结束';
}
function groupColor(status: BoardTask['status']) {
  return status === 'active' ? 'processing' : status === 'closing' ? 'warning' : 'gray';
}
function workerLabel(worker: BoardWorker) {
  if (worker.status === 'opening') return '启动中';
  if (worker.status === 'open') return '已派发';
  if (worker.status === 'closing') return '收尾中';
  if (worker.status === 'closed' && worker.outcome === 'accepted') return '已完成';
  if (worker.status === 'closed' && worker.outcome === 'failed') return '失败';
  if (worker.status === 'closed') return '已关闭';
  return '状态未知';
}
function workerColor(worker: BoardWorker) {
  if (worker.status === 'closed' && worker.outcome === 'failed') return 'error';
  if (worker.status === 'closed' && worker.outcome === 'accepted') return 'success';
  if (worker.status === 'closing' || worker.status === 'unknown') return 'warning';
  if (worker.status === 'opening') return 'processing';
  if (worker.status === 'open') return 'info';
  return 'gray';
}
async function readBoard(signal: AbortSignal): Promise<BoardSnapshot> {
  const response = await fetch('/api/agents', {signal});
  let data: {ok?: boolean; error?: string} | null = null;
  try {data = await response.json();} catch {throw new Error(`服务返回了无法读取的响应（${response.status}）。`);}
  if (!response.ok) throw new Error(data?.error || `无法读取 Agent 看板（${response.status}）。`);
  return data as BoardSnapshot;
}
function TaskList({tasks}: {tasks: BoardTask[]}) {
  return tasks.map(task => <Surface key={task.id} className={styles.surface}>
    <div className={styles.head}><h2 className={styles.heading}>{task.label || task.id}</h2><Tag size="small" color={groupColor(task.status)}>{groupLabel(task.status)}</Tag></div>
    <p className={styles.meta}>更新于 {formatTime(task.updated_at)}</p>
    {task.owners.map(owner => <section key={owner.id} className={styles.owner}>
      <div className={styles.head}><h3 className={styles.ownerTitle}>Owner Agent · {owner.owner_id}</h3><span className={styles.meta}>{owner.engine}</span><Tag size="small" color={groupColor(owner.status)}>{groupLabel(owner.status)}</Tag></div>
      {owner.last_error ? <p className={styles.error}>错误：{owner.last_error}</p> : null}
      {owner.workers.length ? owner.workers.map(worker => <div key={worker.id} className={styles.worker}>
        <div className={styles.head}>
          <h4 className={styles.workerTitle}>{worker.name || worker.worker_id}</h4>
          <Tag size="small" color={workerColor(worker)}>{workerLabel(worker)}</Tag>
          {worker.health === 'stale' ? <Tag size="small" color="warning">等待超时</Tag> : null}
        </div>
        <p className={styles.meta}>子 Agent · {worker.worker_id} · {worker.engine} / {worker.model}</p>
        <p className={styles.meta}>最近进展 {formatTime(worker.last_progress_at)}</p>
        {worker.last_error ? <p className={styles.error}>错误：{worker.last_error}</p> : null}
        {worker.keep_reason ? <p className={styles.note}>说明：{worker.keep_reason}</p> : null}
      </div>) : <p className={styles.meta}>暂无子 Agent 记录</p>}
    </section>)}
  </Surface>);
}
export function AgentBoard() {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [initialError, setInitialError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [loading, setLoading] = useState(true);
  const snapshotRef = useRef(snapshot);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let inflight = false;
    let request = 0;
    async function refresh() {
      if (stopped || inflight) return;
      inflight = true;
      const current = ++request;
      setLoading(true);
      try {
        const next = await readBoard(controller.signal);
        if (stopped || current !== request) return;
        snapshotRef.current = next;
        setSnapshot(next);
        setInitialError('');
        setRefreshError('');
      } catch (error) {
        if (stopped || controller.signal.aborted || current !== request) return;
        const message = error instanceof Error ? error.message : '无法读取 Agent 看板。';
        if (snapshotRef.current) setRefreshError(message);
        else setInitialError(message);
      } finally {
        if (!stopped && current === request) {inflight = false; setLoading(false);}
      }
    }
    refreshRef.current = () => {void refresh();};
    void refresh();
    const timer = window.setInterval(() => {void refresh();}, POLL_MS);
    return () => {stopped = true; controller.abort(); window.clearInterval(timer);};
  }, []);
  const current = snapshot?.tasks.filter(task => task.status !== 'closed') ?? [];
  const history = snapshot?.tasks.filter(task => task.status === 'closed') ?? [];
  const live = !snapshot && !initialError ? '正在读取协作任务。' : '';
  return <div className={styles.stack}>
    <div className={styles.header}><PageHeader title="Agent 看板" description="展示已登记的协作任务，每10秒更新。" action={<div className={styles.head}>
      <Button size="small" icon={RefreshCw} loading={loading} disabled={loading} onClick={() => refreshRef.current()}>刷新</Button>
      {live ? <span role="status" aria-live="polite" className={styles.status}>{live}</span> : null}
      {snapshot ? <span className={styles.meta}>更新于 {formatTime(snapshot.refreshed_at)}</span> : null}
    </div>} /></div>
    {!snapshot && initialError ? <Alert type="error" title="看板读取失败" description={initialError} action={<Button size="small" disabled={loading} onClick={() => refreshRef.current()}>重试读取</Button>} /> : null}
    {!snapshot && !initialError ? <Skeleton.Text animated rows={6} /> : null}
    {snapshot && refreshError ? <Alert type="warning" title="看板更新失败，仍显示上次读取的任务" description={refreshError} action={<Button size="small" disabled={loading} onClick={() => refreshRef.current()}>重试</Button>} /> : null}
    {snapshot && current.length === 0 ? <Surface className={styles.surface}><Empty title={snapshot.tasks.length === 0 ? '暂无协作任务' : '当前没有进行中的任务'} description={snapshot.tasks.length === 0 ? '通过协作技能启动任务后会在这里展示。' : '已结束的任务可以在下方展开。'} /></Surface> : null}
    {snapshot && current.length > 0 ? <TaskList tasks={current} /> : null}
    {history.length > 0 ? <details className={styles.history}><summary className={styles.summary}>已结束任务（{history.length}）</summary><div className={styles.historyBody}><TaskList tasks={history} /></div></details> : null}
  </div>;
}
