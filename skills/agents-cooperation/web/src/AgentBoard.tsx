import {useEffect, useRef, useState} from 'react';
import {Empty} from '@lobehub/ui';
import {Alert, Button, Skeleton, Tag} from '@lobehub/ui/base-ui';
import {PageHeader, Surface} from '@lobehub/ui/dashboard';
import {RefreshCw} from 'lucide-react';
import type {BoardSnapshot, BoardTask} from '../lib/agent-board';
import {AgentTaskDetail} from './AgentTaskDetail';
import {styles} from './agent-board.style';

const POLL_MS = 10_000;
const READ_TIMEOUT_MS = 15_000;
const columns = [
  {bucket: 'in_progress', title: '进行中'},
  {bucket: 'completed', title: '已完成'},
  {bucket: 'closed', title: '已关闭'},
] as const;

function formatTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).format(date);
}
function cardStatus(task: BoardTask) {
  if (task.bucket === 'completed') return {label: '已完成', color: 'success'};
  if (task.bucket === 'in_progress') return task.status === 'closing' ? {label: '收尾中', color: 'warning'} : {label: '进行中', color: 'processing'};
  return {label: '已关闭', color: 'gray'};
}
function ownerNames(task: BoardTask) {
  return task.owners.length ? task.owners.map(owner => owner.owner_id).join('、') : '暂无负责人';
}
function acceptance(task: BoardTask) {
  const workers = task.owners.flatMap(owner => owner.workers);
  const accepted = workers.filter(worker => worker.status === 'closed' && worker.outcome === 'accepted').length;
  return `${accepted}/${workers.length}`;
}
async function readBoard(signal: AbortSignal): Promise<BoardSnapshot> {
  const response = await fetch('/api/agents', {signal});
  let data: {ok?: boolean; error?: string} | null = null;
  try {data = await response.json();} catch {throw new Error(`服务返回了无法读取的响应（${response.status}）。`);}
  if (!response.ok) throw new Error(data?.error || `无法读取任务看板（${response.status}）。`);
  return data as BoardSnapshot;
}
function findTaskCard(taskId: string) {
  for (const card of document.querySelectorAll<HTMLButtonElement>('[data-task-id]')) {
    if (card.dataset.taskId === taskId && card.isConnected) return card;
  }
  return null;
}
function TaskCard({task, onOpen}: {task: BoardTask; onOpen: (taskId: string) => void}) {
  const status = cardStatus(task);
  return <li><button type="button" className={styles.card} data-task-id={task.id} onClick={() => onOpen(task.id)}>
    <span className={styles.cardTitle}>{task.label || task.id}</span>
    <Tag size="small" color={status.color}>{status.label}</Tag>
    <span className={styles.meta}>负责人 {ownerNames(task)}</span>
    <span className={styles.meta}>已验收 {acceptance(task)}</span>
    <span className={styles.meta}>更新于 {formatTime(task.updated_at)}</span>
  </button></li>;
}
export function AgentBoard() {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [initialError, setInitialError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [loading, setLoading] = useState(true);
  const [taskId, setTaskId] = useState<string | null>(null);
  const openedTaskId = useRef<string | null>(null);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const snapshotRef = useRef(snapshot);
  const refreshRef = useRef<() => void>(() => {});
  function openTask(id: string) {
    openedTaskId.current = id;
    setTaskId(id);
  }
  function restoreOpenedTaskFocus() {
    const card = openedTaskId.current ? findTaskCard(openedTaskId.current) : null;
    const target = card ?? refreshButtonRef.current;
    if (target?.isConnected) target.focus();
  }
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let inflight = false;
    let request = 0;
    async function refresh() {
      if (stopped || inflight) return;
      inflight = true;
      const current = ++request;
      const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
      setLoading(true);
      try {
        const next = await readBoard(AbortSignal.any([controller.signal, timeout]));
        if (stopped || current !== request) return;
        snapshotRef.current = next;
        setSnapshot(next);
        setInitialError('');
        setRefreshError('');
      } catch (error) {
        if (stopped || controller.signal.aborted || current !== request) return;
        const message = timeout.aborted ? '读取超时，请重试。' : error instanceof Error ? error.message : '无法读取任务看板。';
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
  const tasks = snapshot?.tasks ?? [];
  const live = !snapshot && !initialError ? '正在读取协作任务。' : '';
  return <div className={styles.stack}>
    <div className={styles.header}><PageHeader title="任务看板" description="按进行中、已完成、已关闭查看协作任务，每10秒更新。" action={<div className={styles.head}>
      <Button ref={refreshButtonRef} size="small" icon={RefreshCw} loading={loading} disabled={loading} onClick={() => refreshRef.current()}>刷新</Button>
      {live ? <span role="status" aria-live="polite" className={styles.status}>{live}</span> : null}
      {snapshot ? <span className={styles.meta}>更新于 {formatTime(snapshot.refreshed_at)}</span> : null}
    </div>} /></div>
    {!snapshot && initialError ? <Alert type="error" title="看板读取失败" description={initialError} action={<Button size="small" disabled={loading} onClick={() => refreshRef.current()}>重试读取</Button>} /> : null}
    {!snapshot && !initialError ? <Skeleton.Text animated rows={6} /> : null}
    {snapshot && refreshError ? <Alert type="warning" title="看板更新失败，仍显示上次读取的任务" description={refreshError} action={<Button size="small" disabled={loading} onClick={() => refreshRef.current()}>重试</Button>} /> : null}
    {snapshot && tasks.length === 0 ? <Surface className={styles.surface}><Empty title="暂无协作任务" description="通过协作技能启动任务后会在这里展示。" /></Surface> : null}
    {snapshot && tasks.length > 0 ? <div className={styles.columns}>
      {columns.map(column => {
        const items = tasks.filter(task => task.bucket === column.bucket);
        return <section key={column.bucket} className={styles.column}>
          <h2 className={styles.columnTitle}>{column.title}<span className={styles.count}>（{items.length}）</span></h2>
          {items.length === 0 ? <p className={styles.meta}>此列暂无任务</p> : <ul className={styles.list}>{items.map(task => <TaskCard key={task.id} task={task} onOpen={openTask} />)}</ul>}
        </section>;
      })}
    </div> : null}
    <AgentTaskDetail taskId={taskId} onClose={() => setTaskId(null)} onAfterClose={restoreOpenedTaskFocus} />
  </div>;
}
