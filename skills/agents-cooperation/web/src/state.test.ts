import {describe, expect, test} from 'bun:test';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {Input, InputNumber, Select, Switch} from '@lobehub/ui/base-ui';
import schema from '../../assets/config.schema.json';
import {configDirty, dirty, engineBlock, localDateTime, quotaDateError, quotaUpdates, effortSuggestions, formDraft, format, initialState, parsed, pendingIdError, reducer, type Snapshot, type Availability} from './state';
const snap = (model: string, revision = '"v1"'): Snapshot => ({config: {version: 1, workers: {a_worker: {model}}, unknown: {preserve: true}}, revision, source: 'source', target: 'target', exists: true, metadata: {schema, efforts: {}, classTags: [], classes: []}});
describe('无效草稿的表单展示与字段回写', () => {
  test('对象、数组和 null 仅投影为安全控件值，修改无关字段保留原错误及未知字段', () => {
    const invalid = {toString: null};
    const entity = {engine: invalid, kind: invalid, model: [], effort: null, description: invalid, enabled: invalid, native_subagents: [], tags: ['research', invalid, null, 1], max_parallel: invalid, max_wait_minutes: 'invalid', unknown: {keep: true}};
    const before = format(entity);
    const draft = formDraft(entity);
    expect(draft.values).toMatchObject({engine:'',kind:'',model:'',effort:'',description:'',enabled:false,native_subagents:false,tags:['research'],max_parallel:null,max_wait_minutes:null});
    expect(format(entity)).toBe(before);
    expect(draft.change({model:'repaired-model'})).toEqual({...entity,model:'repaired-model'});
    expect(draft.change({enabled:true})).toEqual({...entity,enabled:true});
    expect(formDraft(draft.change({model:'repaired-model'})).change({max_parallel:2})).toEqual({...entity,model:'repaired-model',max_parallel:2});
    expect(format(entity)).toBe(before);
  });
  test('合法值和字段编辑正常，非有限数字只影响展示', () => {
    const valid = {engine:'codex',kind:'codex',model:'model',effort:'high',description:'描述',enabled:true,native_subagents:true,tags:['research'],max_parallel:4,max_wait_minutes:15,unknown:'keep'};
    const {unknown,...fields} = valid;
    expect(formDraft(valid).values).toEqual(fields);
    expect(formDraft(valid).change({effort:'max'})).toEqual({...valid,effort:'max'});
    for (const value of [NaN,Infinity,-Infinity]) {
      const entity = {max_parallel:value,max_wait_minutes:value};
      expect(formDraft(entity).values).toMatchObject({max_parallel:null,max_wait_minutes:null});
      expect(formDraft(entity).change({description:'保留数值错误'})).toEqual({...entity,description:'保留数值错误'});
    }
  });
  test('真实 Lobe 控件可渲染投影，未经验证的输入仍完整保留', () => {
    const invalid = {toString:null};
    for (const value of [invalid,[],null,42,false,'tag']) {
      const entity = {engine:value,kind:value,tags:[value],model:value,max_parallel:value,enabled:value};
      const before = format(entity);
      const {values} = formDraft(entity);
      const controls = createElement('div',null,
        createElement(Select,{value:values.engine,options:[]}),
        createElement(Select,{value:values.kind,options:[]}),
        createElement(Select,{mode:'tags',value:values.tags,options:[]}),
        createElement(Select,{mode:'tags',value:formDraft({tags:value}).values.tags,options:[]}),
        createElement(Input,{value:values.model}),
        createElement(InputNumber,{value:values.max_parallel}),
        createElement(Switch,{checked:values.enabled}));
      expect(()=>renderToString(controls)).not.toThrow();
      expect(format(entity)).toBe(before);
    }
  });
});
describe('未校验引擎的 effort 建议', () => {
  test.each(['constructor', 'toString', '__proto__'])('原型属性名 %s 不作为可渲染建议', kind => {
    expect(effortSuggestions({codex: ['high']}, kind)).toEqual([]);
  });
  test('继承的建议与非字符串数组都不能进入表单', () => {
    expect(effortSuggestions(Object.create({codex: ['high']}), 'codex')).toEqual([]);
    for (const value of [null, 'high', 1, {}, () => ['high'], ['high', 1], [null]]) {
      expect(effortSuggestions({codex: value}, 'codex')).toEqual([]);
    }
  });
  test('保留自己的字符串数组，未知或缺失元数据不提供建议', () => {
    const efforts = {codex: ['low', 'high'], opencode: ['custom-variant']};
    expect(effortSuggestions(efforts, 'codex')).toEqual(['low', 'high']);
    expect(effortSuggestions(efforts, 'opencode')).toEqual(['custom-variant']);
    expect(effortSuggestions(efforts, 'unknown')).toEqual([]);
    expect(effortSuggestions(undefined, 'codex')).toEqual([]);
    expect(effortSuggestions(null, 'codex')).toEqual([]);
  });
});
describe('完整草稿与异步保存', () => {
  test('超范围数字保留原始 JSON 供修正，不进入可视表单；有限数字照常读取', () => {
    for (const number of ['1e309','-1e309']) {
      const text = `{"max_parallel":${number},"unknown":"保留原文"}`;
      const state = reducer(reducer(initialState,{type:'load',snapshot:snap('first')}),{type:'edit',text});
      expect(parsed(state.text).config).toBeUndefined();
      expect(parsed(state.text).error).toContain('数字超出当前可表示范围');
      expect(state.text).toBe(text);
      expect(dirty(state)).toBe(true);
    }
    expect(parsed('{"number":1.79e308,"zero":0,"negative":-1}').config).toEqual({number:1.79e308,zero:0,negative:-1});
  });
  test('缺失目标直接创建：默认模板不算编辑，创建后接收目标快照和新 revision', () => {
    const missing = {...snap('default', '"missing"'), exists:false, source:'default-asset'};
    let state = reducer(initialState, {type:'load',snapshot:missing});
    expect(dirty(state)).toBe(false);
    const submittedVersion = state.version;
    const created = {...snap('default', '"created"'), source:missing.target};
    state = reducer(state, {type:'saved',submittedVersion,snapshot:created});
    expect(state.snapshot?.exists).toBe(true);
    expect(state.snapshot?.source).toBe(missing.target);
    expect(state.snapshot?.revision).toBe('"created"');
    expect(state.text).toBe(format(missing.config));
    expect(dirty(state)).toBe(false);
  });
  test('保存等待期间继续输入：接收新 revision 及提交快照，保留后续输入 dirty', () => {
    let state = reducer(initialState, {type: 'load', snapshot: snap('first')});
    state = reducer(state, {type: 'edit', text: format(snap('submitted').config)});
    const submittedVersion = state.version;
    state = reducer(state, {type: 'edit', text: format(snap('newer').config)});
    state = reducer(state, {type: 'saved', submittedVersion, snapshot: snap('submitted', '"v2"')});
    expect(state.snapshot?.revision).toBe('"v2"');
    expect(state.snapshot?.config.workers.a_worker.model).toBe('submitted');
    expect(parsed(state.text).config?.workers.a_worker.model).toBe('newer');
    expect(dirty(state)).toBe(true);
    expect(parsed(state.text).config?.unknown).toEqual({preserve: true});
  });
  test('旧草稿校验不能覆盖当前输入，失败草稿不变', () => {
    let state = reducer(initialState, {type: 'load', snapshot: snap('first')});
    const oldVersion = state.version;
    state = reducer(state, {type: 'edit', text: '{ "unfinished":'});
    const text = state.text;
    state = reducer(state, {type: 'validation', version: oldVersion, key: 'old', data: {ok: true}});
    expect(state.validation).toBeUndefined();
    expect(state.text).toBe(text); expect(parsed(state.text).error).toBeTruthy();
  });
  test('未继续编辑的保存解除 dirty；加载使在途旧结果失效', () => {
    let state = reducer(initialState, {type: 'load', snapshot: snap('first')});
    state = reducer(state, {type: 'edit', text: format(snap('submitted').config)});
    const submittedVersion = state.version;
    state = reducer(state, {type: 'saved', submittedVersion, snapshot: snap('submitted', '"v2"')});
    expect(dirty(state)).toBe(false);
    state = reducer(state, {type: 'load', snapshot: snap('external', '"v3"')});
    state = reducer(state, {type: 'validation', version: submittedVersion, key: 'old', data: {ok: true}});
    expect(state.validation).toBeUndefined();
  });
});

describe('配置 ID 与统一草稿保护', () => {
  test('暂存 ID 单独触发 dirty，跨实体保留，旧保存响应不丢输入，明确放弃后解除保护', () => {
    let state = reducer(initialState, {type:'load',snapshot:snap('first')});
    const submittedVersion = state.version;
    state = reducer(state, {type:'stageId',section:'workers',id:'a_worker',value:'renamed_worker'});
    state = reducer(state, {type:'stageId',section:'engines',id:'a',value:'next_engine'});
    expect(dirty(state)).toBe(true);
    state = reducer(state, {type:'saved',submittedVersion,snapshot:snap('first','"v2"')});
    expect(state.pendingIds).toHaveLength(2);
    expect(state.snapshot?.revision).toBe('"v2"');
    expect(dirty(state)).toBe(true);
    state = reducer(state, {type:'stageId',section:'workers',id:'a_worker',value:'a_worker'});
    expect(state.pendingIds).toEqual([{section:'engines',id:'a',value:'next_engine'}]);
    state = reducer(state, {type:'load',snapshot:state.snapshot!});
    expect(state.pendingIds).toHaveLength(0);
    expect(dirty(state)).toBe(false);
  });
  test('接受 ID 同步引用并保留未知字段；重复目标与无效草稿不丢输入', () => {
    const initial = snap('first');
    initial.config.owners = {owner:{workers:['other_worker','a_worker','other_worker'],unknown:'a_worker'}};
    initial.config.workers.other_worker = {model:'other'};
    let state = reducer(initialState, {type:'load',snapshot:initial});
    state = reducer(state, {type:'stageId',section:'workers',id:'a_worker',value:'other_worker'});
    state = reducer(state, {type:'applyId',section:'workers',id:'a_worker'});
    expect(state.pendingIds[0].value).toBe('other_worker');
    expect(parsed(state.text).config?.workers.a_worker.model).toBe('first');
    state = reducer(state, {type:'stageId',section:'workers',id:'a_worker',value:'renamed_worker'});
    state = reducer(state, {type:'applyId',section:'workers',id:'a_worker'});
    expect(state.pendingIds).toHaveLength(0);
    const draft = parsed(state.text).config!;
    expect(draft.workers.renamed_worker.model).toBe('first');
    expect(draft.owners.owner).toEqual({workers:['other_worker','renamed_worker','other_worker'],unknown:'a_worker'});
    expect(draft.unknown).toEqual({preserve:true});
    state = reducer(state, {type:'stageId',section:'workers',id:'renamed_worker',value:'future_worker'});
    state = reducer(state, {type:'edit',text:'{"unfinished":'});
    state = reducer(state, {type:'applyId',section:'workers',id:'renamed_worker'});
    expect(state.text).toBe('{"unfinished":');
    expect(state.pendingIds[0].value).toBe('future_worker');
  });
  test('空值、格式或重复 ID 不接受；引擎重命名只同步已知 engine 字段', () => {
    const initial = snap('first');
    initial.config.engines = {codex:{kind:'codex'}};
    initial.config.owners = {owner:{engine:'codex',workers:['a_worker'],unknown:{engine:'codex'}}};
    initial.config.workers.a_worker.engine = 'codex';
    initial.config.workers.other_worker = {engine:'other',unknown:'codex'};
    let state = reducer(initialState,{type:'load',snapshot:initial});
    for (const value of ['', 'Bad ID', 'a'.repeat(41)]) {
      state = reducer(state,{type:'stageId',section:'engines',id:'codex',value});
      expect(pendingIdError(state,state.pendingIds[0])).toBeTruthy();
      expect(reducer(state,{type:'applyId',section:'engines',id:'codex'})).toBe(state);
    }
    state = reducer(state,{type:'stageId',section:'engines',id:'codex',value:'next_engine'});
    state = reducer(state,{type:'applyId',section:'engines',id:'codex'});
    const draft = parsed(state.text).config!;
    expect(draft.owners.owner).toEqual({engine:'next_engine',workers:['a_worker'],unknown:{engine:'codex'}});
    expect(draft.workers.a_worker.engine).toBe('next_engine');
    expect(draft.workers.other_worker).toEqual({engine:'other',unknown:'codex'});
    expect(Object.keys(draft.engines)).toEqual(['next_engine']);
    state = reducer(state,{type:'stageId',section:'workers',id:'a_worker',value:'missing_suffix'});
    expect(pendingIdError(state,state.pendingIds[0])).toContain('_worker');
    expect(reducer(state,{type:'applyId',section:'workers',id:'a_worker'})).toBe(state);
  });

});

const availability = (release_at?: string): Availability => ({ok:true,path:'fixture.sqlite',status:'ready',warnings:[],blocks:[{engine:'codex',reason:'preserve',since:'old',by:'fixture',...(release_at?{release_at}:{})},{engine:'codex',model:'specific',release_at:'2099-01-01T00:00:00Z'},{engine:'other',release_at:'2099-02-01T00:00:00Z'}]});
describe('额度恢复日期草稿与统一保存', () => {
  test('仅映射 engine 级记录，本机显示往返同一时刻，未编辑的空日期不写解除', () => {
    const value='2099-01-02T03:04:05.123Z';
    let state=reducer(initialState,{type:'load',snapshot:snap('first')});
    state=reducer(state,{type:'availabilityLoaded',snapshot:availability(value)});
    expect(engineBlock(state.availability,'codex')?.release_at).toBe(value);
    expect(engineBlock(state.availability,'missing')).toBeUndefined();
    expect(new Date(localDateTime(value)).toISOString()).toBe(value);
    expect(dirty(state)).toBe(false);
    expect(quotaUpdates(state)).toEqual([]);
    state=reducer(state,{type:'quotaEdit',engine:'codex',value:localDateTime(value)});
    expect(quotaUpdates(state)).toEqual([]);
    state=reducer(state,{type:'availabilityLoaded',snapshot:availability()});
    state=reducer(state,{type:'quotaEdit',engine:'codex',value:''});
    expect(quotaUpdates(state)).toEqual([]);
    const date=localDateTime(value);
    state=reducer(state,{type:'quotaEdit',engine:'codex',value:date});
    expect(configDirty(state)).toBe(false);expect(dirty(state)).toBe(true);
    expect(quotaUpdates(state)).toEqual([{engine:'codex',release_at:value}]);
    state=reducer(state,{type:'availabilityLoaded',snapshot:availability()});
    expect(state.quotaEdits.codex).toBe(date);
    state=reducer(state,{type:'quotaEdit',engine:'codex',value:''});
    expect(quotaUpdates(state)).toEqual([{engine:'codex',release_at:null}]);
  });
  test('日期必须有效且在未来；空值是显式解除，已过期快照只显示而不自动改动', () => {
    const now=new Date('2030-01-01T00:00:00Z').getTime();
    expect(quotaDateError(localDateTime('2031-01-01T00:00:00Z'),now)).toBe('');
    expect(quotaDateError(localDateTime('2029-01-01T00:00:00Z'),now)).toContain('晚于');
    for (const value of ['invalid','2031-02-30T10:00','2031-13-01T10:00']) expect(quotaDateError(value,now)).toContain('有效');
    expect(quotaDateError('',now)).toBe('');
    const state=reducer(initialState,{type:'availabilityLoaded',snapshot:availability('2020-01-01T00:00:00Z')});
    expect(quotaUpdates(state)).toEqual([]);
  });
  test('配置成功但额度失败可只重试日期；额度保存成功仅清理未继续编辑的提交键', () => {
    let state=reducer(initialState,{type:'load',snapshot:snap('first')});
    state=reducer(state,{type:'availabilityLoaded',snapshot:availability()});
    state=reducer(state,{type:'edit',text:format(snap('submitted').config)});
    const first=localDateTime('2099-03-01T10:00:00Z');
    const newer=localDateTime('2099-04-01T10:00:00Z');
    state=reducer(state,{type:'quotaEdit',engine:'codex',value:first});
    state=reducer(state,{type:'quotaEdit',engine:'other',value:first});
    const submitted={...state.quotaEdits};const submittedVersion=state.version;
    state=reducer(state,{type:'saved',snapshot:snap('submitted','"v2"'),submittedVersion});
    expect(configDirty(state)).toBe(false);expect(dirty(state)).toBe(true);
    expect(state.snapshot?.revision).toBe('"v2"');
    expect(quotaUpdates(state)).toHaveLength(2);
    state=reducer(state,{type:'quotaEdit',engine:'codex',value:newer});
    state=reducer(state,{type:'edit',text:format(snap('typing').config)});
    state=reducer(state,{type:'quotaSaved',snapshot:availability('2099-03-01T10:00:00Z'),submitted});
    expect(state.quotaEdits).toEqual({codex:newer});
    expect(parsed(state.text).config?.workers.a_worker.model).toBe('typing');
    expect(state.snapshot?.config.workers.a_worker.model).toBe('submitted');
    expect(quotaUpdates(state)).toEqual([{engine:'codex',release_at:'2099-04-01T10:00:00.000Z'}]);
    state=reducer(state,{type:'load',snapshot:state.snapshot!});
    expect(dirty(state)).toBe(false);expect(state.quotaEdits).toEqual({});
  });
  test('重命名只映射未保存日期，不改变 runtime 快照；删除丢弃本实体编辑不清历史', () => {
    const initial=snap('first');initial.config.engines={codex:{kind:'codex'}};
    let state=reducer(initialState,{type:'load',snapshot:initial});
    const snapshot=availability('2099-01-01T00:00:00Z');
    state=reducer(state,{type:'availabilityLoaded',snapshot});
    state=reducer(state,{type:'quotaEdit',engine:'codex',value:localDateTime('2099-05-01T00:00:00Z')});
    state=reducer(state,{type:'stageId',section:'engines',id:'codex',value:'renamed'});
    state=reducer(state,{type:'applyId',section:'engines',id:'codex'});
    expect(Object.keys(state.quotaEdits)).toEqual(['renamed']);
    expect(state.availability).toBe(snapshot);
    expect(engineBlock(state.availability,'renamed')).toBeUndefined();
    expect(engineBlock(state.availability,'codex')?.release_at).toBe('2099-01-01T00:00:00Z');
    state=reducer(state,{type:'dropQuotaEdit',engine:'renamed'});
    expect(quotaUpdates(state)).toEqual([]);expect(state.availability).toBe(snapshot);
  });
});
