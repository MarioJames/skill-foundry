import {useEffect, useMemo, useReducer, useRef, useState, type ReactNode} from 'react';
import {Empty, SortableList} from '@lobehub/ui';
import {Alert, Button, Input, InputNumber, Select, Skeleton, Switch} from '@lobehub/ui/base-ui';
import {Form, useForm} from '@lobehub/ui/base-ui/form';
import {ConsoleShell, ConsoleBrand, ConsoleNav, PageHeader, Surface} from '@lobehub/ui/dashboard';
import {ArrowDown, ArrowUp, Bot, Cpu, Kanban, Moon, Plus, Save, Settings2, Sun, Users} from 'lucide-react';
import {configDirty, dirty, engineBlock, localDateTime, quotaDateError, quotaUpdates, effortSuggestions, formDraft, format, initialState, parsed, pendingIdError, reducer, type Config, type Issue, type Snapshot, type EntitySection, type Action} from './state';
import {AgentBoard} from './AgentBoard';
import {styles} from './style';

type Section = 'engines'|'owners'|'workers'|'herdr'|'agents';
const sectionNames: Record<Section,string> = {engines:'引擎',owners:'协作负责人',workers:'工作代理',herdr:'系统设置',agents:'Agent 看板'};
const object = (value: unknown): Config => value && typeof value === 'object' && !Array.isArray(value) ? value as Config : {};
const keys = (value: unknown) => Object.keys(object(value));
const options = (values: string[]) => [...new Set(values)].map(value => ({value,label:value}));
const list = (value: unknown): string[] => Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
async function api(path: string, method = 'GET', body?: unknown, revision?: string) {
  const response = await fetch(path, {method, headers: {...(body ? {'Content-Type':'application/json'} : {}), ...(revision ? {'If-Match': revision} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  let data: any;
  try {data = await response.json();} catch {throw new Error(`服务返回了无法读取的响应（${response.status}）。`);}
  return {data, status: response.status, ok: response.ok};
}
function Issues({issues}: {issues?: Issue[]}) {
  return issues?.length ? <ul className={styles.error}>{issues.map((issue,index) => <li key={index}><code>{issue.path}</code>：{issue.message}</li>)}</ul> : null;
}
function EntityForm({section,pendingId,idError,onPendingIdChange,entity,config,metadata,onChange,onAcceptId,quotaField}: {section:EntitySection;pendingId:string;idError:string;onPendingIdChange:(value:string)=>void;entity:Config;config:Config;metadata:Snapshot['metadata'];onChange:(next:Config)=>void;onAcceptId:()=>void;quotaField?:ReactNode}) {
  const draft = useMemo(()=>formDraft(entity),[entity]);
  const form = useForm({values:draft.values, onValuesChange:changed=>onChange(draft.change(changed))});
  useEffect(()=>form.reset(draft.values),[draft,form]);
  const engines = object(config.engines);
  const engineId = text(entity.engine);
  const kind = Object.hasOwn(engines,engineId) ? text(object(engines[engineId]).kind) : '';
  const efforts = effortSuggestions(metadata.efforts, kind);
  const workerIds = list(entity.workers);
  const [addWorker,setAddWorker] = useState<string|null>(null);
  const engineOptions = options([...keys(config.engines),text(entity.engine)].filter(Boolean));
  return <Form form={form} layout="vertical" gap={16}>
    <div className={styles.formGrid}>
      <Form.Field label="配置 ID" required desc="失焦或按 Enter 接受修改，并同步相关引用。">
        <Input value={pendingId} onChange={event=>onPendingIdChange(event.target.value)} onBlur={onAcceptId} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();onAcceptId();}}} aria-invalid={!!idError} aria-describedby={idError?'config-id-error':undefined} aria-label="配置 ID" placeholder={section === 'workers' ? '例如：research_worker' : `例如：${section === 'engines' ? 'codex' : 'codex_owner'}`} />
        {idError && <p id="config-id-error" role="alert" className={styles.error}>{idError}</p>}
      </Form.Field>
      <Form.Field name="enabled" label="启用" valueProp="checked"><Switch /></Form.Field>
      {section === 'engines' ? <>
        <Form.Field name="kind" label="引擎类型" required><Select options={options(metadata.schema?.$defs?.engine?.properties?.kind?.enum ?? [])} /></Form.Field>
        <Form.Field name="native_subagents" label="支持原生子代理" valueProp="checked"><Switch /></Form.Field>
        {quotaField}
      </> : <>
        <Form.Field name="engine" label="所属引擎" required><Select options={engineOptions} /></Form.Field>
        <Form.Field name="model" label="模型" required><Input placeholder="例如：gpt-6.1-sol 或 provider/model" /></Form.Field>
        <Form.Field name="effort" label="推理强度 / variant" required desc={efforts.length ? `该引擎允许：${efforts.join('、')}` : '按模型支持的 variant 填写非空值。'}>{efforts.length ? <Select options={options(efforts)} /> : <Input placeholder="例如：max" />}</Form.Field>
        {section === 'workers' ? <>
          <Form.Field name="description" label="用途说明"><Input placeholder="例如：负责前端界面与浏览器验收" /></Form.Field>
          <Form.Field name="tags" label="能力标签" desc="可输入新标签并按 Enter 添加；mechanical、routine 为类别标签。"><Select mode="tags" options={options([...(metadata.classTags ?? []),...list(entity.tags)])} placeholder="例如：frontend、research" tokenSeparators={[',']} /></Form.Field>
        </> : <>
          <Form.Field name="max_parallel" label="并行上限" required><InputNumber placeholder="例如：4" /></Form.Field>
          <div className={styles.full}><Form.Field label="工作代理优先顺序" required desc="拖动手柄调整顺序；也可使用上移和下移按钮。">
            <SortableList items={workerIds.map(id=>({id}))} onChange={items=>onChange({...entity,workers:items.map(item=>item.id)})} renderItem={({id})=>{const index=workerIds.indexOf(id);return <SortableList.Item id={id} className={styles.workerRow}>
              <SortableList.DragHandle aria-label={`拖动排序 ${id}`} className={styles.dragHandle} />
              <span>{index+1}. {id}{!Object.hasOwn(object(config.workers),id) ? '（引用不存在）' : ''}</span>
              <Button size="small" aria-label={`上移 ${id}`} disabled={index===0} icon={ArrowUp} onClick={() => {const next=[...workerIds];[next[index-1],next[index]]=[next[index],next[index-1]];onChange({...entity,workers:next});}} />
              <Button size="small" aria-label={`下移 ${id}`} disabled={index===workerIds.length-1} icon={ArrowDown} onClick={() => {const next=[...workerIds];[next[index+1],next[index]]=[next[index],next[index+1]];onChange({...entity,workers:next});}} />
              <Button size="small" danger onClick={() => onChange({...entity,workers:workerIds.filter((_,i)=>i!==index)})} aria-label={`移除引用 ${id}`}>移除</Button>
            </SortableList.Item>;}} renderOverlay={({id})=>{const index=workerIds.indexOf(id);return <div className={styles.workerRow}><span>{index+1}. {id}{!Object.hasOwn(object(config.workers),id) ? '（引用不存在）' : ''}</span></div>;}} />
            <div className={styles.row}><Select value={addWorker} options={options(keys(config.workers).filter(w => !workerIds.includes(w)))} placeholder="选择要加入顺序的工作代理" onChange={value=>setAddWorker(typeof value==='string'?value:null)} /><Button disabled={!addWorker} onClick={() => {if(addWorker)onChange({...entity,workers:[...workerIds,addWorker]});setAddWorker(null);}}>添加引用</Button></div>
          </Form.Field></div>
        </>}
      </>}
    </div>
  </Form>;
}
function ReviewSwitch({value,onChange}:{value:unknown;onChange:(enabled:boolean)=>void}) {
  const checked = typeof value === 'boolean' ? value : true;
  const form = useForm({values:{chatgpt_review:checked},onValuesChange:changed=>{if(typeof changed.chatgpt_review==='boolean')onChange(changed.chatgpt_review);}});
  useEffect(()=>form.reset({chatgpt_review:checked}),[checked,form]);
  return <Form form={form} layout="vertical"><Form.Field name="chatgpt_review" label="ChatGPT Pro 自动审查" valueProp="checked" desc="关闭后跳过本技能的自动Pro审查，本地review和测试照常。"><Switch /></Form.Field></Form>;
}
function HerdrForm({value,onChange}:{value:Config;onChange:(value:Config)=>void}) {
  const draft = useMemo(()=>formDraft(value),[value]);
  const form = useForm({values:draft.values,onValuesChange:changed=>onChange(draft.change(changed))});
  useEffect(()=>form.reset(draft.values),[draft,form]);
  return <Form form={form} layout="vertical"><Form.Field name="max_wait_minutes" label="单次等待上限（分钟）" required desc="Owner 每次通过 Herdr 等待子 Agent 回报的最长时间；超时后先检查进展，再决定继续等待或重新派发。"><InputNumber placeholder="例如：15" /></Form.Field></Form>;
}

export default function App({appearance,onAppearanceChange}:{appearance:'light'|'dark';onAppearanceChange:()=>void}) {
  const [state,rawDispatch] = useReducer(reducer,initialState);
  const stateRef=useRef(state); stateRef.current=state;
  function dispatch(action: Action) {stateRef.current=reducer(stateRef.current,action);rawDispatch(action);}
  const [section,setSection]=useState<Section>('engines');
  const [selected,setSelected]=useState('');
  const selectedRef=useRef(selected);selectedRef.current=selected;
  const sectionRef=useRef(section);sectionRef.current=section;
  const [loading,setLoading]=useState(true);
  const [loadError,setLoadError]=useState('');
  const [quotaLoading,setQuotaLoading]=useState(true);
  const [quotaLoadError,setQuotaLoadError]=useState('');
  const quotaSequence=useRef(0);
  const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [saveState,setSaveState]=useState<'idle'|'saving'|'error'|'conflict'|'success'>('idle');
  const [saveError,setSaveError]=useState('');
  const [saveIssues,setSaveIssues]=useState<Issue[]>([]);
  const [validating,setValidating]=useState(false);
  const validateSequence=useRef(0);
  const loadSequence=useRef(0);const savingRef=useRef(false);
  const parsedDraft=useMemo(()=>parsed(state.text),[state.text]);
  const config=parsedDraft.config;
  const isDirty=dirty(state);
  const needsCreate=state.snapshot?.exists===false;
  const [message,setMessage]=useState('');
  async function load() {
    const request=++loadSequence.current;const version=stateRef.current.version;
    setLoading(true);setLoadError('');
    try {
      const result=await api('/api/config');
      if(request!==loadSequence.current)return;
      if(!result.ok)throw new Error(result.data.error || '无法读取配置');
      if(stateRef.current.version!==version)throw new Error('读取期间草稿又有修改，已保留新输入。请重试重新加载。');
      dispatch({type:'load',snapshot:result.data});
      setSaveState('idle');setSaveError('');setSaveIssues([]);setMessage(result.data.exists?'已读取磁盘配置。':'已载入默认模板；可直接创建配置。');
    } catch(error) {if(request===loadSequence.current)setLoadError(error instanceof Error?error.message:'读取失败，请重试。');}
    finally {if(request===loadSequence.current)setLoading(false);}
  }
  async function loadQuota() {
    const request=++quotaSequence.current;setQuotaLoading(true);setQuotaLoadError('');
    try {
      const result=await api('/api/availability');
      if(request!==quotaSequence.current)return;
      if(!result.ok)throw new Error(result.data.error||'额度状态无法确定，请重试读取。');
      dispatch({type:'availabilityLoaded',snapshot:result.data});
    } catch(error) {if(request===quotaSequence.current)setQuotaLoadError(error instanceof Error?error.message:'额度状态读取失败。');}
    finally {if(request===quotaSequence.current)setQuotaLoading(false);}
  }
  useEffect(()=>{void load();void loadQuota();},[]);
  useEffect(()=>{
    if(!isDirty)return;
    const protect=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);
  },[isDirty]);
  function edit(next:Config|string) {dispatch({type:'edit',text:typeof next==='string'?next:format(next)});setMessage('');setSaveIssues([]);if(saveState==='success')setSaveState('idle');}
  function acceptId(section: EntitySection, id: string) {
    const current=stateRef.current;
    const pending=current.pendingIds.find(item=>item.section===section&&item.id===id);
    if(!pending || pendingIdError(current,pending))return;
    const next=reducer(current,{type:'applyId',section,id});
    if(next===current)return;
    dispatch({type:'applyId',section,id});
    if(section===sectionRef.current && (selectedRef.current===id || !selectedRef.current)){selectedRef.current=pending.value;setSelected(pending.value);}
  }
  function acceptIds(reportError = true) {
    for(const pending of [...stateRef.current.pendingIds])acceptId(pending.section,pending.id);
    const invalid=stateRef.current.pendingIds[0];
    if(invalid){if(reportError)setMessage(`请修正${sectionNames[invalid.section]} ${invalid.id} 的配置 ID：${pendingIdError(stateRef.current,invalid)}`);return false;}
    return true;
  }
  async function save() {
    if(!acceptIds())return;
    const current=stateRef.current;const draft=parsed(current.text).config;
    if(!draft||!current.snapshot||savingRef.current)return;
    const invalid=Object.entries(current.quotaEdits).find(([,value])=>quotaDateError(value));
    if(invalid){setMessage(`请修正引擎 ${invalid[0]} 的额度恢复时间：${quotaDateError(invalid[1])}`);return;}
    const submittedQuota={...current.quotaEdits};
    const updates=quotaUpdates(current);
    const saveConfig=configDirty(current)||!current.snapshot.exists;
    savingRef.current=true;setSaveState('saving');setSaveError('');setSaveIssues([]);setMessage('');
    let configSaved=false;
    try {
      if(saveConfig) {
        const result=await api('/api/config','PUT',{config:draft},current.snapshot.revision);
        if(!result.ok) {setSaveState(result.status===409?'conflict':'error');setSaveError(result.data.error||'保存失败，请重试。');setSaveIssues(result.data.issues??[]);return;}
        dispatch({type:'saved',snapshot:result.data,submittedVersion:current.version});configSaved=true;
      }
      if(updates.length) {
        const result=await api('/api/availability','PUT',{updates});
        if(!result.ok){setSaveIssues(result.data.issues??[]);throw new Error(result.data.error||'请重试保存额度恢复时间。');}
        dispatch({type:'quotaSaved',snapshot:result.data,submitted:submittedQuota});
        ++quotaSequence.current;setQuotaLoading(false);setQuotaLoadError('');
      }
      setSaveState('success');
      setMessage(`${configSaved&&updates.length?'配置和额度恢复时间已保存。':updates.length?'额度恢复时间已保存。':current.snapshot.exists?'配置已保存。':'配置已创建。'}${dirty(stateRef.current)?'保存期间的新输入仍保留在草稿中。':''}`);
    } catch(error) {
      setSaveState('error');
      const detail=error instanceof Error?error.message:'连接失败，请重试。';
      setSaveError(configSaved?`配置已保存，额度恢复时间保存失败：${detail}`:updates.length&&!saveConfig?`额度恢复时间保存失败：${detail}`:detail);
    } finally {savingRef.current=false;}
  }
  async function validate() {
    if(!acceptIds())return;
    const current=stateRef.current;const draft=parsed(current.text).config;if(!draft)return;
    const request=++validateSequence.current;setValidating(true);
    try {const result=await api('/api/validate','POST',{config:draft});if(request===validateSequence.current)dispatch({type:'validation',version:current.version,key:String(request),data:result.data});}
    catch(error) {if(request===validateSequence.current)dispatch({type:'validation',version:current.version,key:String(request),data:{ok:false,error:error instanceof Error?error.message:'校验失败'}});}
    finally {if(request===validateSequence.current)setValidating(false);}
  }
  function reload() {if(!isDirty||window.confirm('重新加载会放弃当前未保存的草稿，并读取磁盘上的最新配置。继续吗？')){void load();void loadQuota();}}
  function discard() {if(state.snapshot&&window.confirm('放弃当前未保存的修改，恢复到本页最近保存或加载的配置？')) {dispatch({type:'load',snapshot:state.snapshot});setSaveState('idle');setSaveError('');setSaveIssues([]);setMessage('已放弃草稿修改。');}}
  const entities=config?object(config[section]):{};
  const ids=keys(entities);
  const active=ids.includes(selected)?selected:ids[0];
  const activePending=state.pendingIds.find(item=>item.section===section&&item.id===active);
  const activeBlock=engineBlock(state.availability,active);
  const quotaValue=Object.hasOwn(state.quotaEdits,active)?state.quotaEdits[active]:localDateTime(activeBlock?.release_at);
  const quotaError=Object.hasOwn(state.quotaEdits,active)?quotaDateError(quotaValue):'';
  const quotaField=<Form.Field label="额度恢复时间" desc={`按本机时区 ${timeZone} 输入；随顶部“保存配置”保存。`}>
    {quotaLoading?<span role="status" className={styles.meta}>正在读取额度状态…</span>:quotaLoadError?<div role="alert"><p className={styles.error}>{quotaLoadError}</p><Button size="small" onClick={()=>void loadQuota()}>重试读取额度状态</Button></div>:state.availability?<>
      <Input type="datetime-local" step="0.001" aria-label="额度恢复时间" aria-invalid={!!quotaError} aria-describedby={quotaError?'quota-date-error':undefined} value={quotaValue} onChange={event=>{dispatch({type:'quotaEdit',engine:active,value:event.target.value});setMessage('');if(saveState==='success')setSaveState('idle');}} />
      {quotaError?<p id="quota-date-error" role="alert" className={styles.error}>{quotaError}</p>:activeBlock?.release_at&&new Date(activeBlock.release_at).getTime()<=Date.now()&&!Object.hasOwn(state.quotaEdits,active)?<p className={styles.meta}>已到恢复时间。</p>:null}
      <p className={styles.meta}>{activeBlock&&!activeBlock.release_at?'该引擎当前受额度限制，尚未指定恢复时间。':!activeBlock?'该引擎当前没有额度限制。':'清空已有日期可解除该引擎的额度限制。'}</p>
      {state.availability.warnings?.length?<details><summary>额度状态诊断</summary><ul>{state.availability.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></details>:null}
    </>:null}
  </Form.Field>;
  const navigation=[{href:'engines',label:'引擎',icon:Cpu},{href:'owners',label:'协作负责人',icon:Users},{href:'workers',label:'工作代理',icon:Bot},{href:'herdr',label:'系统设置',icon:Settings2},{href:'agents',label:'任务看板',icon:Kanban}];
  function addEntity() {
    if(!config||!['engines','owners','workers'].includes(section))return;
    const base=section==='workers'?'new_worker':section==='owners'?'new_owner':'new_engine';let id=base;let n=2;
    while(Object.hasOwn(entities,id)){id=section==='workers'?`new_${n++}_worker`:`${base}_${n++}`;}
    const engine=keys(config.engines)[0]??'';
    const value=section==='engines'?{enabled:false,kind:'codex',native_subagents:true}:section==='owners'?{enabled:false,engine,model:'',effort:'high',max_parallel:1,workers:[]}:{enabled:false,engine,model:'',effort:'high',tags:[]};
    edit({...config,[section]:{...entities,[id]:value}});setSelected(id);
  }
  const validation=state.validation?.data;
  return <div className={styles.root}><ConsoleShell
    brand={<ConsoleBrand logo={<Bot size={23} style={{flexShrink:0}}/>} title="协作配置" renderLink={({children,className})=><div className={className}>{children}</div>} />}
    breadcrumb={<span>Agents Cooperation · 本地配置</span>}
    navigation={<ConsoleNav label="配置分区" items={navigation} pathname={section} onNavigate={href=>{acceptIds(false);setSection(href as Section);setSelected('');}} />}
    tools={<Button size="small" icon={appearance==='light'?Moon:Sun} onClick={onAppearanceChange}>{appearance==='light'?'深色模式':'浅色模式'}</Button>}
    openNavigationLabel="打开配置导航" skipToContentLabel="跳到配置内容" collapseLabel="收起导航" expandLabel="展开导航">
    <div className={styles.stack}>
      {section==='agents' ? <AgentBoard/> : <>
      <div className={styles.header}><PageHeader title={sectionNames[section]} description="编辑协作策略与额度恢复时间，校验后保存。" action={<div className={styles.row}>
        <Button size="small" disabled={loading||!config} loading={validating} onClick={()=>void validate()}>校验草稿</Button>
        <Button size="small" disabled={loading||!isDirty||saveState==='saving'} onClick={discard}>放弃修改</Button>
        <Button disabled={loading||saveState==='saving'} onClick={reload}>重新加载</Button>
        <Button disabled={loading||(!isDirty&&!needsCreate)||saveState==='saving'||!config} loading={saveState==='saving'} type="primary" icon={Save} onClick={()=>void save()}>{saveState==='error'?(needsCreate?'重试创建':'重试保存'):(needsCreate?'创建配置':'保存配置')}</Button>
        <span role="status" aria-live="polite" className={styles.status}>{message || (needsCreate ? '尚未创建配置' : isDirty ? '有未保存修改' : '')}</span>
      </div>} /></div>
      {loading && !state.snapshot ? <Skeleton.Text animated rows={6}/> : null}
      {loadError && <Alert type="error" title="配置读取失败" description={loadError} action={<Button size="small" onClick={()=>void load()}>重试读取</Button>} />}
      {state.snapshot && <>
        {saveState==='conflict' && <Alert type="warning" title="磁盘配置已被修改，当前草稿已保留" description="请明确重新加载最新配置后再编辑保存；放弃修改只恢复本页快照，不会覆盖外部更改。" action={<Button size="small" disabled={loading} onClick={reload}>重新加载最新配置</Button>} />}
        {(saveState==='error'||saveState==='conflict') && <div role="alert"><p className={styles.error}>{saveError}</p><Issues issues={saveIssues}/>{saveState==='error' && <Button size="small" disabled={!config} onClick={()=>void save()}>重试保存</Button>}</div>}
        {validation && <div role="status"><Alert type={validation.ok?'success':'error'} title={validation.ok?'完整草稿校验通过':validation.error||'草稿存在配置错误'} /><Issues issues={validation.issues}/></div>}
        {parsedDraft.error && <Alert type="error" title="配置草稿无法读取" description={parsedDraft.error} />}
        {config&&['engines','owners','workers'].includes(section) ? <div className={styles.workspace}>
          <div className={styles.list}><Button icon={Plus} onClick={addEntity}>新增{sectionNames[section]}</Button>{ids.map(id=><Button key={id} className={styles.listButton} type={id===active?'fill':'text'} onClick={()=>{acceptIds(false);setSelected(id);}}>{id}{object(entities[id]).enabled===false?' · 已停用':''}</Button>)}</div>
          <Surface className={styles.surface}>{active !== undefined ? <>
            <div className={styles.row}><h2 className={styles.heading}>{active}</h2><Button size="small" danger onClick={()=>{if(window.confirm(`从草稿删除 ${active}？其他对象的引用会保留，保存前请完成校验。`)){const next={...entities};delete next[active];edit({...config,[section]:next});dispatch({type:'stageId',section:section as EntitySection,id:active,value:active});if(section==='engines')dispatch({type:'dropQuotaEdit',engine:active});setSelected('');}}}>删除</Button></div>
            <p className={styles.subheading}>修改仅写入草稿；重命名自动同步相关引用，删除后请校验引用。</p>
            <EntityForm key={`${section}:${ids.indexOf(active)}`} section={section as 'engines'|'owners'|'workers'} pendingId={activePending?.value??active} idError={pendingIdError(state,{section:section as EntitySection,id:active,value:activePending?.value??active})} onPendingIdChange={value=>{dispatch({type:'stageId',section:section as EntitySection,id:active,value});setMessage('');}} entity={object(entities[active])} config={config} metadata={state.snapshot.metadata} onChange={value=>edit({...config,[section]:{...entities,[active]:value}})} onAcceptId={()=>acceptId(section as EntitySection,active)} quotaField={quotaField} />
          </> : <Empty title={`还没有${sectionNames[section]}`} description="新增一项配置，然后填写模型及引用关系。" action={<Button onClick={addEntity}>新增{sectionNames[section]}</Button>} />}</Surface>
        </div> : null}
        {config&&section==='herdr' ? <>
          <Surface className={styles.surface}><h2 className={styles.heading}>Owner Agent 等待上限</h2><HerdrForm value={object(config.herdr)} onChange={herdr=>edit({...config,herdr})}/></Surface>
          <Surface className={styles.surface}><ReviewSwitch value={config.chatgpt_review} onChange={chatgpt_review=>edit({...config,chatgpt_review})}/></Surface>
        </> : null}
      </>}
      </>}
    </div>
  </ConsoleShell></div>;
}
