export type Config = Record<string, any>;
export type Issue = {path: string; message: string};
export type Snapshot = {config: Config; revision: string; source: string; target: string; exists: boolean; metadata: {schema: any; efforts: Record<string, string[]>; classTags: string[]; classes: string[]}};
export type Availability = {ok: boolean; path: string; status: 'ready'|'missing'|'uncertain'; warnings: string[]; blocks: {engine: string; model?: string; release_at?: string|null; [key: string]: unknown}[]};
export type Feedback = {key: string; data: any};
export type EntitySection = 'engines'|'owners'|'workers';
export type PendingId = {section: EntitySection; id: string; value: string};
export type EditorState = {snapshot?: Snapshot; text: string; version: number; pendingIds: PendingId[]; availability?: Availability; quotaEdits: Record<string,string>; validation?: Feedback};
export const initialState: EditorState = {text: '', version: 0, pendingIds: [], quotaEdits: {}};
export const format = (config: unknown) => JSON.stringify(config, null, 2);
/** Controls see safe display values; only a user's changed fields enter the raw draft. */
export function formDraft(entity: Config) {
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    values: {
      enabled: typeof entity.enabled === 'boolean' ? entity.enabled : false,
      native_subagents: typeof entity.native_subagents === 'boolean' ? entity.native_subagents : false,
      kind: text(entity.kind), engine: text(entity.engine), model: text(entity.model), effort: text(entity.effort), description: text(entity.description),
      tags: Array.isArray(entity.tags) ? entity.tags.filter((tag: unknown): tag is string => typeof tag === 'string') : [],
      max_parallel: number(entity.max_parallel), max_wait_minutes: number(entity.max_wait_minutes),
    },
    change: (changed: Config): Config => ({...entity,...changed}),
  };
}
export function effortSuggestions(efforts: unknown, kind: string): string[] {
  if (!efforts || typeof efforts !== 'object' || !Object.hasOwn(efforts, kind)) return [];
  const suggestions = (efforts as Record<string, unknown>)[kind];
  return Array.isArray(suggestions) && suggestions.every(value => typeof value === 'string') ? suggestions : [];
}
export const configDirty = (state: EditorState) => state.pendingIds.length > 0 || (!!state.snapshot && state.text !== format(state.snapshot.config));
export const dirty = (state: EditorState) => configDirty(state) || Object.keys(state.quotaEdits).length > 0;
export function engineBlock(snapshot: Availability | undefined, engine: string) {
  return snapshot?.blocks.find(block => block.engine === engine && block.model === undefined);
}
export function localDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (n: number, width=2) => String(n).padStart(width,'0');
  return `${pad(date.getFullYear(),4)}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${date.getMilliseconds()?`.${pad(date.getMilliseconds(),3)}`:''}`;
}
export function quotaDateError(value: string, now=Date.now()): string {
  if (!value) return '';
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  const date = new Date(value);
  if (!parts || !Number.isFinite(date.getTime()) || [date.getFullYear(),date.getMonth()+1,date.getDate(),date.getHours(),date.getMinutes(),date.getSeconds(),date.getMilliseconds()].some((part,index)=>part !== Number(index===6 ? (parts[7]??'').padEnd(3,'0') : parts[index+1]??0))) return '请输入有效的本机日期和时间。';
  return date.getTime() > now ? '' : '恢复时间须晚于当前时间；清空可解除该引擎的额度限制。';
}
export function quotaUpdates(state: EditorState) {
  return Object.entries(state.quotaEdits).map(([engine,value]) => ({engine,release_at:value?new Date(value).toISOString():null}));
}
export function parsed(text: string): {config?: Config; error?: string} {
  let numberOutOfRange = false;
  try {
    const config = JSON.parse(text,(_key,value)=>{
      if (typeof value === 'number' && !Number.isFinite(value)) {numberOutOfRange=true;throw new Error();}
      return value;
    });
    if (!config || typeof config !== 'object' || Array.isArray(config)) return {error: '配置草稿必须是 JSON 对象。'};
    return {config};
  } catch { return {error: numberOutOfRange ? '数字超出当前可表示范围，请在配置文件中修正后重新加载。' : '配置内容无法解析，请在配置文件中修正后重新加载。'}; }
}
/** Match the ID rules supplied by the same schema as server validation. */
export function pendingIdError(state: EditorState, pending: PendingId): string {
  if (!pending.value) return '配置 ID 不能为空。';
  const schema = state.snapshot?.metadata.schema;
  const names = schema?.properties?.[pending.section]?.propertyNames;
  const rule = names?.$ref?.startsWith('#/$defs/') ? schema?.$defs?.[names.$ref.slice(8)] : names;
  if (rule?.pattern && !new RegExp(rule.pattern).test(pending.value)) return pending.section === 'workers' ? '请使用小写字母、数字或下划线，以字母开头并以 _worker 结尾，最长 40 个字符。' : '请使用小写字母、数字或下划线，以字母开头，最长 40 个字符。';
  const config = parsed(state.text).config;
  if (pending.value !== pending.id && config?.[pending.section] && Object.hasOwn(config[pending.section], pending.value)) return '该 ID 已存在。';
  return '';
}
export type Action =
  | {type: 'load'; snapshot: Snapshot}
  | {type: 'edit'; text: string}
  | {type: 'stageId'; section: EntitySection; id: string; value: string}
  | {type: 'applyId'; section: EntitySection; id: string}
  | {type: 'availabilityLoaded'; snapshot: Availability}
  | {type: 'quotaEdit'; engine: string; value: string}
  | {type: 'dropQuotaEdit'; engine: string}
  | {type: 'quotaSaved'; snapshot: Availability; submitted: Record<string,string>}
  | {type: 'saved'; snapshot: Snapshot; submittedVersion: number}
  | {type: 'validation'; version: number; key: string; data: any};
export function reducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'load': return {availability:state.availability, quotaEdits:{}, snapshot: action.snapshot, text: format(action.snapshot.config), version: state.version + 1, pendingIds: []};
    case 'availabilityLoaded': return {...state, availability:action.snapshot};
    case 'quotaEdit': {
      const quotaEdits = {...state.quotaEdits};
      const baseline = localDateTime(engineBlock(state.availability,action.engine)?.release_at);
      if ((action.value === baseline || (action.value && baseline && new Date(action.value).getTime() === new Date(baseline).getTime())) && (action.value !== '' || !Object.hasOwn(quotaEdits,action.engine))) delete quotaEdits[action.engine];
      else quotaEdits[action.engine] = action.value;
      return {...state, quotaEdits, version:state.version+1};
    }
    case 'dropQuotaEdit': {
      const quotaEdits = {...state.quotaEdits};delete quotaEdits[action.engine];
      return {...state, quotaEdits, version:state.version+1};
    }
    case 'quotaSaved': {
      const quotaEdits = {...state.quotaEdits};
      for (const [engine,value] of Object.entries(action.submitted)) if (quotaEdits[engine] === value) delete quotaEdits[engine];
      return {...state, availability:action.snapshot, quotaEdits};
    }
    case 'edit': return {...state, text: action.text, version: state.version + 1, validation: undefined};
    case 'stageId': {
      const pendingIds = state.pendingIds.filter(item => item.section !== action.section || item.id !== action.id);
      if (action.value !== action.id) pendingIds.push({section: action.section, id: action.id, value: action.value});
      return {...state, pendingIds, version: state.version + 1, validation: undefined};
    }
    case 'applyId': {
      const pending = state.pendingIds.find(item => item.section === action.section && item.id === action.id);
      const config = parsed(state.text).config;
      const entities = config?.[action.section];
      if (!pending || pendingIdError(state, pending) || !config || !entities || typeof entities !== 'object' || Array.isArray(entities) || !Object.hasOwn(entities, action.id) || Object.hasOwn(entities, pending.value)) return state;
      const renamed = Object.fromEntries(Object.entries(entities).map(([key,value]) => [key === action.id ? pending.value : key, value]));
      const next = {...config, [action.section]: renamed};
      const mapEntities = (section: 'owners'|'workers', change: (entity: Config) => Config) => {
        const entries = next[section];
        if (entries && typeof entries === 'object' && !Array.isArray(entries)) next[section] = Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, value && typeof value === 'object' && !Array.isArray(value) ? change(value as Config) : value]));
      };
      if (action.section === 'engines') {
        for (const section of ['owners','workers'] as const) mapEntities(section, entity => entity.engine === action.id ? {...entity, engine: pending.value} : entity);
      } else if (action.section === 'workers') {
        mapEntities('owners', entity => Array.isArray(entity.workers) ? {...entity, workers: entity.workers.map((id: unknown) => id === action.id ? pending.value : id)} : entity);
      }
      const quotaEdits = {...state.quotaEdits};
      if (action.section === 'engines' && Object.hasOwn(quotaEdits,action.id)) {quotaEdits[pending.value] = quotaEdits[action.id];delete quotaEdits[action.id];}
      return {...state, quotaEdits, text: format(next), pendingIds: state.pendingIds.filter(item => item !== pending), version: state.version + 1, validation: undefined};
    }
    case 'saved': return {...state, snapshot: action.snapshot, text: state.version === action.submittedVersion ? format(action.snapshot.config) : state.text};
    case 'validation': return action.version === state.version ? {...state, validation: {key: action.key, data: action.data}} : state;
  }
}
