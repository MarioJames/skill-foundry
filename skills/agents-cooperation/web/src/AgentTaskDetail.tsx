import {useEffect, useRef, useState} from 'react';
import {Alert, Button, Drawer, Skeleton, Tag} from '@lobehub/ui/base-ui';
import type {BoardEvent, BoardOwner, BoardTask, BoardTaskDetail, BoardWorker} from '../lib/agent-board';
import {styles} from './agent-task-detail.style';

/** @lobehub/ui 5.58.0 没有 Timeline，调度记录用语义 ol/li。 */
const POLL_MS = 10_000;
const READ_TIMEOUT_MS = 15_000;

function formatTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).format(date);
}
function dateTimeAttr(value: number) {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function taskStatus(task: BoardTask) {
  if (task.bucket === 'completed') return {label: '已完成', color: 'success'};
  if (task.bucket === 'in_progress') return task.status === 'closing' ? {label: '收尾中', color: 'warning'} : {label: '进行中', color: 'processing'};
  return {label: '已关闭', color: 'gray'};
}
function ownerColor(status: BoardOwner['status']) {
  return status === 'active' ? 'processing' : status === 'closing' ? 'warning' : 'gray';
}
function ownerLabel(status: BoardOwner['status']) {
  return status === 'active' ? '进行中' : status === 'closing' ? '收尾中' : '已关闭';
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
function actorName(event: BoardEvent) {
  return event.worker_name || event.worker_id || event.owner_id;
}
function engineModel(event: BoardEvent) {
  return event.model ? `${event.engine} / ${event.model}` : event.engine;
}
function agentCount(task: BoardTask) {
  return task.owners.reduce((count, owner) => count + 1 + owner.workers.length, 0);
}

type TaskResult = {kind: 'ok'; detail: BoardTaskDetail} | {kind: 'missing'} | {kind: 'error'; message: string};

async function readTask(taskId: string, signal: AbortSignal): Promise<TaskResult> {
  const response = await fetch(`/api/agents/${encodeURIComponent(taskId)}`, {signal});
  let data: (Partial<BoardTaskDetail> & {error?: string}) | null = null;
  try {data = await response.json();} catch {return {kind: 'error', message: `服务返回了无法读取的响应（${response.status}）。`};}
  if (response.status === 404) return {kind: 'missing'};
  if (!response.ok || !data?.ok || !data.task) return {kind: 'error', message: data?.error || `无法读取任务详情（${response.status}）。`};
  return {kind: 'ok', detail: data as BoardTaskDetail};
}

function People({task}: {task: BoardTask}) {
  if (task.owners.length === 0) return <p className={styles.line}>暂无 Owner 记录</p>;
  return task.owners.map(owner => <div key={owner.id} className={styles.person}>
    <div className={styles.actor}><h4 className={styles.name}>Owner Agent · {owner.owner_id}</h4><Tag size="small" color={ownerColor(owner.status)}>{ownerLabel(owner.status)}</Tag></div>
    <p className={styles.line}>{owner.engine}</p>
    {owner.last_error ? <p className={styles.error}>错误：{owner.last_error}</p> : null}
    {owner.workers.length ? owner.workers.map(worker => <div key={worker.id} className={styles.worker}>
      <div className={styles.actor}>
        <h5 className={styles.name}>{worker.name || worker.worker_id}</h5>
        <Tag size="small" color={workerColor(worker)}>{workerLabel(worker)}</Tag>
        {worker.health === 'stale' ? <Tag size="small" color="warning">等待超时</Tag> : null}
      </div>
      <p className={styles.line}>子 Agent · {worker.worker_id} · {worker.engine} / {worker.model}</p>
      {worker.last_error ? <p className={styles.error}>错误：{worker.last_error}</p> : null}
      {worker.keep_reason ? <p className={styles.line}>说明：{worker.keep_reason}</p> : null}
    </div>) : <p className={styles.line}>暂无子 Agent 记录</p>}
  </div>);
}

function Timeline({detail}: {detail: BoardTaskDetail}) {
  const events = detail.events;
  return <section className={styles.section}>
    <h3 className={styles.heading}>调度时间线</h3>
    {detail.history_incomplete ? <p className={styles.note}>早期任务仅保留历史概要，详细调度从启用后记录。</p> : null}
    {events.length === 0 ? <p className={styles.line}>暂无调度记录</p> : <ol className={styles.timeline}>
      {events.map(event => <li key={event.id} className={styles.event}>
        <time className={styles.when} dateTime={dateTimeAttr(event.at)}>{formatTime(event.at)}</time>
        <div className={styles.actor}><span className={styles.name}>{actorName(event)}</span><span className={styles.line}>{engineModel(event)}</span></div>
        <p className={styles.title}>{event.title}</p>
        {event.detail ? <p className={styles.detail}>{event.detail}</p> : null}
      </li>)}
    </ol>}
  </section>;
}

export function AgentTaskDetail({taskId, onClose, onAfterClose}: {taskId: string | null; onClose: () => void; onAfterClose?: () => void}) {
  const [detail, setDetail] = useState<BoardTaskDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [initialError, setInitialError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [loading, setLoading] = useState(false);
  const detailRef = useRef(detail);
  const refreshRef = useRef<() => void>(() => {});
  const bodyRef = useRef<HTMLDivElement>(null);
  detailRef.current = detail;
  useEffect(() => {
    if (!taskId) return;
    bodyRef.current?.parentElement && (bodyRef.current.parentElement.scrollTop = 0);
    const controller = new AbortController();
    let stopped = false;
    let inflight = false;
    let request = 0;
    const opened = taskId;
    setMissing(false);
    setInitialError('');
    setRefreshError('');
    async function load() {
      if (stopped || inflight) return;
      inflight = true;
      const current = ++request;
      const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
      setLoading(true);
      try {
        const result = await readTask(opened, AbortSignal.any([controller.signal, timeout]));
        if (stopped || current !== request) return;
        if (result.kind === 'missing') {
          detailRef.current = null;
          setDetail(null);
          setMissing(true);
          setInitialError('');
          setRefreshError('');
          return;
        }
        if (result.kind === 'error') {
          if (detailRef.current?.task.id === opened) setRefreshError(result.message);
          else setInitialError(result.message);
          return;
        }
        if (result.detail.task.id !== opened) return;
        detailRef.current = result.detail;
        setDetail(result.detail);
        setMissing(false);
        setInitialError('');
        setRefreshError('');
      } catch (error) {
        if (stopped || controller.signal.aborted || current !== request) return;
        const message = timeout.aborted ? '读取超时，请重试。' : error instanceof Error ? error.message : '无法读取任务详情。';
        if (detailRef.current?.task.id === opened) setRefreshError(message);
        else setInitialError(message);
      } finally {
        if (!stopped && current === request) {inflight = false; setLoading(false);}
      }
    }
    refreshRef.current = () => {void load();};
    void load();
    const timer = window.setInterval(() => {void load();}, POLL_MS);
    return () => {stopped = true; controller.abort(); window.clearInterval(timer);};
  }, [taskId]);
  const visible = detail && taskId && detail.task.id === taskId ? detail : null;
  const status = visible ? taskStatus(visible.task) : null;
  const title = missing ? '任务已不存在' : visible ? (visible.task.label || visible.task.id) : '任务详情';
  return <Drawer open={taskId !== null} width={760} title={title} onClose={onClose} afterOpenChange={open => { if (!open) onAfterClose?.(); }}>
    <div ref={bodyRef} className={styles.body}>
      {missing ? <Alert type="warning" title="任务已不存在" description="这条任务已从看板中消失，可以关闭详情。" action={<Button size="small" onClick={onClose}>关闭</Button>} /> : null}
      {!visible && !missing && initialError ? <Alert type="error" title="详情读取失败" description={initialError} action={<Button size="small" loading={loading} disabled={loading} onClick={() => refreshRef.current()}>重试</Button>} /> : null}
      {!visible && !missing && !initialError ? <Skeleton.Text animated rows={6} /> : null}
      {visible && refreshError ? <Alert type="warning" title="详情更新失败，仍显示上次读取的任务" description={refreshError} action={<Button size="small" loading={loading} disabled={loading} onClick={() => refreshRef.current()}>重试</Button>} /> : null}
      {visible && status ? <>
        <div className={styles.meta}>
          <Tag size="small" color={status.color}>{status.label}</Tag>
          <span>开始于 {formatTime(visible.task.created_at)}</span>
          <span>更新于 {formatTime(visible.task.updated_at)}</span>
        </div>
        <Timeline detail={visible} />
        <details className={styles.disclosure}>
          <summary className={styles.summary}>当前 Agent 状态（{agentCount(visible.task)}）</summary>
          <div className={styles.disclosureBody}><People task={visible.task} /></div>
        </details>
      </> : null}
    </div>
  </Drawer>;
}
