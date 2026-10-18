import {afterEach,expect,test,spyOn} from 'bun:test';
import * as fs from 'node:fs';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Runtime,runRuntime,type Execute,type RunRow} from '../scripts/agents-runtime.ts';
import {openState,transaction,upsertBlock} from '../scripts/lib/state-db.ts';
import {processIdentity,processLife,operationInFlight,procStat} from '../scripts/lib/process-identity.ts';
import {directoryId,fingerprint} from '../scripts/lib/session-evidence.ts';
import {DEFAULT_CONFIG} from '../scripts/agents-config.ts';
const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
/** Real SQLite and /proc evidence; only the external Herdr/route/systemctl boundary is fake. */
function fixture(host='host-A'){
 const root=mkdtempSync(join(tmpdir(),'runtime-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 const db=openState(join(root,'state.sqlite'));cleanup.push(()=>db.close());
 const config=JSON.parse(readFileSync(DEFAULT_CONFIG,'utf8'));config.owners.claude_owner.engine='claude';
 const state={sessions:new Map<string,{status:string;server:ReturnType<typeof Bun.spawn>;workspaces:Map<string,Map<string,Set<string>>>}>(),calls:[] as string[][],unknownOnClose:false,failInventory:false,failStop:false,failDelete:false,loseReceipt:false,foreign:false,deleteCount:0};
 const env={HOME:root,CLAUDE_CODE_SESSION_ID:host,PATH:process.env.PATH};
 const external:Execute=(full)=>{
  const marker=full.indexOf('--'),a=full.slice(marker+1);state.calls.push(a);
  const good=(v:any)=>({code:0,stdout:typeof v==='string'?v:JSON.stringify(v),stderr:''});
  const bad=(message:string)=>({code:1,stdout:'',stderr:message});
  if(a[0]==='systemctl')return good('invocation-one\n');
  if(a[1]?.endsWith('route-lane.ts')){
    const args=a.slice(2),get=(k:string)=>args[args.indexOf(k)+1],first=args.includes('--create-session'),name=get(first?'--create-session':'--session');
    if(state.foreign)return bad('session_foreign');
    let session=state.sessions.get(name);
    if(first){if(session)return bad('session_exists');
      const server=Bun.spawn(['sleep','600'],{stdout:'ignore',stderr:'ignore'});cleanup.push(async()=>{try{server.kill();}catch{}await server.exited;});
      mkdirSync(join(root,'.config/herdr/sessions',name),{recursive:true});writeFileSync(join(root,'.config/herdr/sessions',name,'herdr-server.log'),'created');
      session={status:'running',server,workspaces:new Map()};state.sessions.set(name,session);
    }
    if(!session||session.status!=='running')return bad('not running');
    let tabs=session.workspaces.get('shared');if(!tabs){tabs=new Map();session.workspaces.set('shared',tabs);}
    const n=state.calls.filter(c=>c[1]?.endsWith('route-lane.ts')).length,tab=`tab-${n}`,pane=`pane-${n}`;tabs.set(tab,new Set([pane]));
    if(state.loseReceipt)return bad('receipt lost');
    const identity=processIdentity(session.server.pid);
    return good({ok:true,session:{name,created:first,...(first?{proof:{unit:`herdr-session-${name}.scope`,invocation_id:'invocation-one',server_pid:identity.pid,server_starttime:Number(identity.starttime),boot_id:identity.boot_id},dir_id:directoryId(join(root,'.config/herdr/sessions',name))}:{})},result:{workspace_id:'shared',tab_id:tab,pane_id:pane}});
  }
  if(a[0]!=='herdr')return bad('unexpected '+a.join(' '));
  let args=a.slice(1),name:string|undefined;if(args[0]==='--session'){name=args[1];args=args.slice(2);}
  if(args[0]==='session'&&args[1]==='list')return good({result:{sessions:[...state.sessions].map(([name,s])=>({name,status:s.status}))}});
  if(args[0]==='session'&&args[1]==='stop'){
    if(state.failStop)return bad('interrupted stop');const s=state.sessions.get(args[2])!;s.server.kill();s.status='stopped';return good('stopped');
  }
  if(args[0]==='session'&&args[1]==='delete'){
    if(state.failDelete)return bad('delete interrupted');state.deleteCount++;state.sessions.delete(args[2]);rmSync(join(root,'.config/herdr/sessions',args[2]),{recursive:true});return good('deleted');
  }
  const session=state.sessions.get(name!);if(!session||session.status!=='running')return bad('server_not_running');
  if(state.failInventory&&args[1]==='list')return bad('inventory unavailable');
  const reply=(key:string,rows:any[])=>good({result:{[key]:rows}});
  if(args[0]==='workspace'&&args[1]==='list')return reply('workspaces',[...session.workspaces.keys()].map(workspace_id=>({workspace_id})));
  if(args[0]==='tab'&&args[1]==='list')return reply('tabs',[...session.workspaces.get(args[3])!.keys()].map(tab_id=>({tab_id})));
  if(args[0]==='pane'&&args[1]==='list')return reply('panes',[...session.workspaces.get(args[3])!.values()].flatMap(panes=>[...panes].map(pane_id=>({pane_id}))));
  if(args[0]==='pane'&&args[1]==='close'){
    for(const [ws,tabs]of session.workspaces)for(const [tab,panes]of tabs)if(panes.has(args[2])){
      if(state.unknownOnClose)panes.add('unknown-inserted-after-check');panes.delete(args[2]);if(!panes.size)tabs.delete(tab);if(!tabs.size)session.workspaces.delete(ws);
    }
    return good({ok:true});
  }
  return bad('unexpected '+args.join(' '));
 };
 const runtime=new Runtime(db,config,{env,execute:external});
 const open=(request='request',collab='collab',cwd=root)=>runtime.openRun({owner:'claude_owner',collab,request,cwd,label:'1017｜FIX｜state'});
 const lane=(run:string,op='op',name=op)=>runtime.openLane({run,worker:'codex_worker',class:'judgment',name,op});
 return {root,db,config,env,state,runtime,open,lane,path:(r:RunRow)=>join(root,'.config/herdr/sessions',r.session_name)};
}
test('run identity branches, idempotence, conflict isolation, R4 and empty close',()=>{
 const f=fixture(),a=f.open();expect(f.open().run_id).toBe(a.run_id);
 expect(()=>f.open('request','other')).toThrow('conflicts');const other=join(f.root,'other');mkdirSync(other);expect(()=>f.open('request','collab',other)).toThrow('conflicts');
 const foreign=new Runtime(f.db,f.config,{env:{...f.env,CLAUDE_CODE_SESSION_ID:'other'},execute:()=>({code:0,stdout:'{}',stderr:''})});expect(()=>foreign.closeRun(a.run_id)).toThrow('identity');
 const noIdentity=new Runtime(f.db,f.config,{env:{HOME:f.root}});expect(()=>noIdentity.openRun({owner:'claude_owner',collab:'c',request:'r',cwd:f.root,label:'x'})).toThrow('both missing');expect(f.db.query('SELECT * FROM runs').all()).toHaveLength(1);
 expect(f.runtime.closeRun(a.run_id).status).toBe('closed');expect(f.open().run_id).not.toBe(a.run_id);
});
test('same workspace lanes close only their recorded pane and preserve the other lane',()=>{
 const f=fixture(),r=f.open(),a=f.lane(r.run_id,'a'),b=f.lane(r.run_id,'b');
 expect(a.workspace_id).toBe(b.workspace_id);expect(f.runtime.closeLane(a.lane_id).status).toBe('closed');
 expect(f.runtime.lane(b.lane_id).status).toBe('open');expect(f.state.sessions.get(r.session_name)!.workspaces.get('shared')!.get(b.tab_id!)!.has(b.pane_id!)).toBe(true);
 expect(f.state.calls.filter(c=>c.includes('close')).map(c=>c.slice(-3))).toEqual([['pane','close',a.pane_id!]]);
});
test('pane inserted after the close check is preserved and blocks session deletion',()=>{
 const f=fixture(),r=f.open(),a=f.lane(r.run_id);f.state.unknownOnClose=true;
 expect(f.runtime.closeLane(a.lane_id).status).toBe('closed');expect(()=>f.runtime.closeRun(r.run_id)).toThrow('unknown resources');expect(f.state.deleteCount).toBe(0);expect(f.runtime.run(r.run_id).status).toBe('closing');
 const inv=f.state.sessions.get(r.session_name)!.workspaces.get('shared')!;expect([...inv.values()].flatMap(x=>[...x])).toEqual(['unknown-inserted-after-check']);
});
test('creating without committed proof and route receipt loss never adopt by session name or label',()=>{
 const f=fixture(),r=f.open();f.runtime.updateRun(r.run_id,{session_phase:'creating'});expect(()=>f.lane(r.run_id)).toThrow('interrupted session');expect(f.runtime.run(r.run_id).session_phase).toBe('unknown');expect(f.state.calls.some(c=>c.includes('stop'))).toBe(false);
 const second=f.open('second');f.state.loseReceipt=true;expect(()=>f.lane(second.run_id)).toThrow('receipt lost');expect(f.runtime.run(second.run_id).session_phase).toBe('unknown');expect(f.runtime.lanes(second.run_id)[0].status).toBe('unknown');
});
test('session_foreign is unknown and never stopped or deleted',()=>{
 const f=fixture(),r=f.open();f.state.foreign=true;expect(()=>f.lane(r.run_id)).toThrow('session_foreign');expect(f.runtime.run(r.run_id).session_phase).toBe('unknown');f.runtime.gc();expect(f.state.calls.some(c=>c.includes('stop')||c.includes('delete'))).toBe(false);
});
test('same op in separate runs never aliases lanes; same-run conflicting parameters fail',()=>{
 const f=fixture(),a=f.open('a'),b=f.open('b'),la=f.lane(a.run_id),lb=f.lane(b.run_id);
 expect(la.lane_id).not.toBe(lb.lane_id);expect(f.lane(a.run_id).lane_id).toBe(la.lane_id);expect(()=>f.lane(a.run_id,'op','different')).toThrow('conflicts');
});
test('alive and unverifiable lock owners cannot be taken over; no TTL exists',()=>{
 const f=fixture(),r=f.open(),self=processIdentity();f.runtime.updateRun(r.run_id,{lock_proc:JSON.stringify(self),lock_op:'existing',updated_at:0});
 expect(()=>f.runtime.withLock(r.run_id,()=>{})).toThrow('alive');
 f.runtime.updateRun(r.run_id,{lock_proc:JSON.stringify({...self,pid:null}),lock_op:'uncertain'});expect(()=>f.runtime.withLock(r.run_id,()=>{})).toThrow('unknown');
 f.runtime.updateRun(r.run_id,{lock_proc:JSON.stringify({...self,pid:2147483647}),lock_op:null});expect(()=>f.runtime.withLock(r.run_id,()=>{})).toThrow('no verifiable');
 f.runtime.updateRun(r.run_id,{lock_proc:JSON.stringify({...self,pid:2147483647}),lock_op:'dead-no-child'});expect(f.runtime.withLock(r.run_id,()=>42)).toBe(42);
});
test('dead runtime lock with a live tagged helper cannot be reclaimed',async()=>{
 const f=fixture(),r=f.open(),tag=`${r.run_id}:tagged`;
 const child=Bun.spawn([process.execPath,join(import.meta.dir,'../scripts/lib/external-call.ts'),'--op-tag',tag,'--','sleep','600'],{stdout:'ignore',stderr:'ignore'});cleanup.push(async()=>{try{child.kill();}catch{}await child.exited;});
 // Wait until the helper has exec'd the external boundary; the helper itself also carries the tag.
 expect(await waitForOperationState(tag,processIdentity(),true)).toBe(true);
 f.runtime.updateRun(r.run_id,{lock_proc:JSON.stringify({...processIdentity(),pid:2147483647}),lock_op:tag});expect(()=>f.runtime.withLock(r.run_id,()=>{})).toThrow('in-flight');
 child.kill();await child.exited;
 // The tagged child argv0 remains visible after its helper was killed.
 const {readdirSync}=await import('node:fs');const tagged:number[]=[];
 for(const p of readdirSync('/proc').filter(p=>/^\d+$/.test(p)))try{if(readFileSync(`/proc/${p}/cmdline`,'utf8').split('\0')[0]===`agents-cooperation-op:${tag}`)tagged.push(Number(p));}catch{}
 for(const pid of tagged)process.kill(pid,'SIGKILL');
});
test('process PID/starttime/boot evidence has alive, dead and unknown-safe behavior',()=>{
 const self=processIdentity();expect(processLife(self)).toBe('alive');expect(processLife({...self,starttime:'0'})).toBe('dead');expect(processLife({...self,boot_id:'other'})).toBe('dead');expect(processLife(null)).toBe('unknown');expect(procStat(process.pid).starttime).toBe(self.starttime);
});
test('lane outcome/progress/keep do not change lifecycle; stale owners are reported without closing',()=>{
 const f=fixture(),r=f.open(),a=f.lane(r.run_id);f.runtime.markLane(a.lane_id,{outcome:'accepted',keepReason:'review'});expect(f.runtime.lane(a.lane_id).status).toBe('open');
 f.runtime.updateLane(a.lane_id,{last_progress_at:Date.now()-4*f.config.herdr.max_wait_minutes*60000});expect(f.runtime.gc().reports.some(x=>x.lane===a.lane_id)).toBe(true);expect(f.runtime.lane(a.lane_id).status).toBe('open');
 f.runtime.markLane(a.lane_id,{keepReason:''});f.runtime.gc();expect(f.runtime.lane(a.lane_id).health).toBe('stale');f.runtime.markLane(a.lane_id,{progress:true});expect(f.runtime.lane(a.lane_id).health).toBe('ok');
});
test('inventory failure leaves closing run resumable, and gc progresses it after owner exits',async()=>{
 const f=fixture(),r=f.open(),a=f.lane(r.run_id);f.runtime.closeLane(a.lane_id);f.state.failInventory=true;expect(()=>f.runtime.closeRun(r.run_id)).toThrow('inventory unavailable');expect(f.runtime.run(r.run_id).status).toBe('closing');
 f.state.failInventory=false;f.runtime.updateRun(r.run_id,{owner_proc:JSON.stringify({...processIdentity(),pid:2147483647})});
 // Fake Herdr stop sends a real signal. Wait for the kernel to reap it before a recovery retry when necessary.
 f.runtime.gc();await Bun.sleep(5);f.runtime.gc();expect(f.runtime.run(r.run_id).status).toBe('closed');expect(f.state.deleteCount).toBe(1);
});
test('stop intent can resume a still-running original session, then delete safely',async()=>{
 const f=fixture(),r=f.open(),a=f.lane(r.run_id);f.runtime.closeLane(a.lane_id);f.state.failStop=true;expect(()=>f.runtime.closeRun(r.run_id)).toThrow('interrupted stop');expect(f.runtime.run(r.run_id).session_phase).toBe('stopping');
 f.state.failStop=false;f.runtime.gc();await Bun.sleep(5);f.runtime.gc();expect(f.runtime.run(r.run_id).status).toBe('closed');
});
async function stoppedFixture(phase='stopped'){
 const f=fixture(),r=f.open(),a=f.lane(r.run_id);f.runtime.closeLane(a.lane_id);const s=f.state.sessions.get(r.session_name)!;s.server.kill();await s.server.exited;s.status='stopped';
 f.runtime.updateRun(r.run_id,{status:'closing',session_phase:phase,stopped_fingerprint:JSON.stringify(fingerprint(f.path(r))),stop_observed_at:Date.now()+10});return {...f,r};
}
test('stopping recovery uses previously observed exit time, otherwise refuses adoption',async()=>{
 const f=await stoppedFixture('stopping');f.runtime.gc();expect(f.runtime.run(f.r.run_id).status).toBe('closed');
 const g=await stoppedFixture('stopping');g.runtime.updateRun(g.r.run_id,{stop_observed_at:null,stopped_fingerprint:null});g.runtime.gc();expect(g.runtime.run(g.r.run_id).session_phase).toBe('unknown');expect(g.state.deleteCount).toBe(0);
});
test('R2 restart-and-stop changes recursive fingerprint; stopped and deleting retries preserve it',async()=>{
 for(const phase of ['stopped','deleting']){const f=await stoppedFixture(phase);mkdirSync(join(f.path(f.r),'session-snapshots'));writeFileSync(join(f.path(f.r),'session-snapshots','foreign.json'),'foreign pane');f.runtime.gc();expect(f.runtime.run(f.r.run_id).session_phase).toBe('unknown');expect(f.state.deleteCount).toBe(0);expect(existsSync(f.path(f.r))).toBe(true);}
});
test('stopped/deleting/deleted boundaries complete through gc when evidence agrees',async()=>{
 for(const phase of ['stopped','deleting','deleted']){const f=await stoppedFixture(phase);if(phase==='deleted'){f.state.sessions.delete(f.r.session_name);rmSync(f.path(f.r),{recursive:true});}f.runtime.gc();expect(f.runtime.run(f.r.run_id).status).toBe('closed');}
});
test('directory replacement and running generation proof changes refuse destructive cleanup',async()=>{
 const f=fixture(),r=f.open(),a=f.lane(r.run_id);f.runtime.updateRun(r.run_id,{session_dir_id:JSON.stringify({dev:'0',ino:'0'})});expect(()=>f.runtime.closeLane(a.lane_id)).toThrow('identity changed');expect(f.runtime.run(r.run_id).session_phase).toBe('unknown');
 const g=await stoppedFixture();g.state.sessions.get(g.r.session_name)!.status='running';g.runtime.gc();expect(g.runtime.run(g.r.run_id).session_phase).toBe('unknown');expect(g.state.deleteCount).toBe(0);
});
test('ls is read-only and orphan aw sessions are reported, never removed',()=>{
 const f=fixture(),r=f.open(),a=f.lane(r.run_id);const before=f.runtime.lane(a.lane_id);const ls=f.runtime.ls(r.run_id);expect(ls.runs[0].actual).toMatchObject({status:'running'});expect(f.runtime.lane(a.lane_id)).toEqual(before);
 f.state.sessions.set('aw-orphan',f.state.sessions.get(r.session_name)!);expect(f.runtime.gc().reports.some(x=>x.session==='aw-orphan')).toBe(true);expect(f.state.deleteCount).toBe(0);
});

test('quota-blocked owner or worker and invalid lane classes cannot create resources',()=>{
 for(const which of ['worker','owner','class']){
  const f=fixture(),r=f.open();
  if(which!=='class')transaction(f.db,()=>upsertBlock(f.db,{engine:which==='worker'?'codex':'claude',reason:'quota',since:new Date().toISOString()}));
  expect(()=>f.runtime.openLane({run:r.run_id,worker:'codex_worker',class:which==='class'?'invalid':'judgment',name:'x',op:'x'})).toThrow(which==='class'?'invalid lane class':'unavailable');
  expect(f.runtime.lanes(r.run_id)).toEqual([]);expect(f.state.calls.some(c=>c[1]?.endsWith('route-lane.ts'))).toBe(false);
 }
});
test('automatic gc diagnostics are returned, and ls reports unknown and missing resources without writes',()=>{
 const f=fixture(),r=f.open(),a=f.lane(r.run_id);f.state.sessions.set('aw-orphan',f.state.sessions.get(r.session_name)!);
 const b=f.lane(r.run_id,'b');expect(b.gc_reports.some(x=>x.session==='aw-orphan')).toBe(true);
 const tabs=f.state.sessions.get(r.session_name)!.workspaces.get('shared')!;tabs.get(a.tab_id!)!.delete(a.pane_id!);tabs.get(b.tab_id!)!.add('unknown-pane');
 const before=f.runtime.lanes(r.run_id);const ls=f.runtime.ls(r.run_id).runs[0].actual as any;
 expect(ls.unknown.panes).toContain('unknown-pane');expect(ls.missing).toContainEqual({lane_id:a.lane_id,pane_id:a.pane_id});expect(f.runtime.lanes(r.run_id)).toEqual(before);
});

test('H4 killing the real locked runtime leaves tagged helper/native child in flight and prevents replay',async()=>{
 const f=fixture(),r=f.open(),dbPath=join(f.root,'state.sqlite');
 const runtimeModule=join(import.meta.dir,'../scripts/agents-runtime.ts'),dbModule=join(import.meta.dir,'../scripts/lib/state-db.ts');
 const source=`import {Runtime} from ${JSON.stringify(runtimeModule)};import {openState} from ${JSON.stringify(dbModule)};import {readFileSync} from 'node:fs';const config=JSON.parse(readFileSync(${JSON.stringify(DEFAULT_CONFIG)},'utf8'));const runtime=new Runtime(openState(${JSON.stringify(dbPath)}),config,{env:{...process.env,HOME:${JSON.stringify(f.root)},CODEX_THREAD_ID:undefined,CLAUDE_PID:undefined,CLAUDE_CODE_SESSION_ID:'host-A'},execute:(argv,env)=>{if(argv.includes('list'))return {code:0,stdout:JSON.stringify({result:{sessions:[]}}),stderr:''};const split=argv.indexOf('--');const child=Bun.spawnSync({cmd:[...argv.slice(0,split+1),'sleep','600'],env,stdout:'pipe',stderr:'pipe'});return {code:child.exitCode,stdout:child.stdout.toString(),stderr:child.stderr.toString()};}});runtime.openLane({run:${JSON.stringify(r.run_id)},worker:'codex_worker',class:'judgment',name:'inflight',op:'inflight'});`;
 const runtimeProcess=Bun.spawn([process.execPath,'--eval',source],{stdout:'ignore',stderr:'pipe'});
 const {readdirSync}=await import('node:fs');
 const tagged=(op:string)=>fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)).flatMap(n=>{try{const args=readFileSync(`/proc/${n}/cmdline`,'utf8').split('\0');return args[0]===`agents-cooperation-op:${op}`||args.some((a,i)=>a==='--op-tag'&&args[i+1]===op)?[{pid:Number(n),args}]:[];}catch{return [];}});
 let operation:string|null=null;
 cleanup.push(()=>{try{runtimeProcess.kill();}catch{}if(operation)for(const p of tagged(operation))try{process.kill(p.pid,'SIGKILL');}catch{}});
 for(let attempt=0;attempt<200;attempt++){
  operation=f.runtime.run(r.run_id).lock_op;
  if(operation&&tagged(operation).some(p=>p.args[0]===`agents-cooperation-op:${operation}`))break;
  await Bun.sleep(5);
 }
 expect(operation).toBeTruthy();expect(tagged(operation!).some(p=>p.args[0]===`agents-cooperation-op:${operation}`)).toBe(true);
 const lockOwner=JSON.parse(f.runtime.run(r.run_id).lock_proc!);expect(lockOwner.pid).toBe(runtimeProcess.pid);
 runtimeProcess.kill('SIGKILL');await runtimeProcess.exited;
 expect(processLife(lockOwner)).toBe('dead');expect(()=>f.runtime.withLock(r.run_id,()=>{throw new Error('must not replay');})).toThrow('in-flight');
 // Also kill the helper: the native call's controlled argv0 must independently hold the fence.
 for(const p of tagged(operation!))if(p.args[0]!==`agents-cooperation-op:${operation}`)process.kill(p.pid,'SIGKILL');
 expect(await waitForOperationState(operation!,lockOwner,true)).toBe(true);expect(()=>f.runtime.withLock(r.run_id,()=>{})).toThrow('in-flight');
 for(const p of tagged(operation!))process.kill(p.pid,'SIGKILL');
 await waitForOperationState(operation!,lockOwner,false);
 expect(f.runtime.withLock(r.run_id,()=>42)).toBe(42);
});

test('process identity takes precedence over host session identity for authorization and idempotence',()=>{
 const f=fixture(),env={...f.env,CLAUDE_PID:String(process.pid)},owner=new Runtime(f.db,f.config,{env});
 const input={owner:'claude_owner',collab:'proc',request:'proc',cwd:f.root,label:'1017｜FIX｜proc'};
 const r=owner.openRun(input);expect(JSON.parse(r.owner_proc!).pid).toBe(process.pid);expect(owner.openRun(input).run_id).toBe(r.run_id);
 const sameProcessOtherHost=new Runtime(f.db,f.config,{env:{...env,CLAUDE_CODE_SESSION_ID:'host-other'}});expect(()=>sameProcessOtherHost.authorize(r)).not.toThrow();
 const sameHostDifferentProcess=new Runtime(f.db,f.config,{env:{...f.env,CLAUDE_PID:String(process.ppid)}});
 expect(processIdentity(process.ppid).pid).not.toBe(process.pid);
 expect(()=>sameHostDifferentProcess.authorize(r)).toThrow('identity');expect(()=>sameHostDifferentProcess.openRun(input)).toThrow('conflicts');
 const sameHostNoProcess=new Runtime(f.db,f.config,{env:{...f.env,CLAUDE_PID:'2147483647'}});expect(()=>sameHostNoProcess.authorize(r)).toThrow('identity');
 expect(()=>sameHostNoProcess.openRun(input)).toThrow('conflicts');
});
test('active runs with confirmed dead owners are reclaimed; unknown owners and unknown lanes are retained',()=>{
 const f=fixture(),r=f.open();f.runtime.updateRun(r.run_id,{owner_proc:JSON.stringify({...processIdentity(),pid:2147483647})});f.runtime.gc();expect(f.runtime.run(r.run_id).status).toBe('closed');
 const unknown=f.open('unknown');f.runtime.gc();expect(f.runtime.run(unknown.run_id).status).toBe('active');
 const blocked=f.open('blocked'),lane=f.lane(blocked.run_id);f.runtime.updateLane(lane.lane_id,{status:'unknown'});f.runtime.updateRun(blocked.run_id,{owner_proc:JSON.stringify({...processIdentity(),pid:2147483647})});f.runtime.gc();expect(f.runtime.run(blocked.run_id).status).toBe('closing');expect(f.state.deleteCount).toBe(0);
});
test('dead-owner gc closes known lanes on both sides of an unknown lane and preserves its session',()=>{
 const f=fixture(),r=f.open(),a=f.lane(r.run_id,'a'),b=f.lane(r.run_id,'b'),c=f.lane(r.run_id,'c');
 for(const [index,lane]of [a,b,c].entries())f.runtime.updateLane(lane.lane_id,{created_at:index});
 f.runtime.updateLane(b.lane_id,{status:'unknown'});
 f.runtime.updateRun(r.run_id,{owner_proc:JSON.stringify({...processIdentity(),pid:2147483647})});
 const reports=f.runtime.gc().reports;
 expect(f.runtime.lane(a.lane_id).status).toBe('closed');expect(f.runtime.lane(c.lane_id).status).toBe('closed');
 expect(f.runtime.lane(b.lane_id).status).toBe('unknown');expect(JSON.stringify(reports)).toContain(b.lane_id);
 expect(f.runtime.run(r.run_id)).toMatchObject({status:'closing',session_phase:'created'});
 expect(f.state.calls.some(c=>c.includes('stop')||c.includes('delete'))).toBe(false);
 expect(f.state.sessions.get(r.session_name)!.workspaces.get('shared')!.get(b.tab_id!)!.has(b.pane_id!)).toBe(true);
});
test('a known lane close failure does not skip later lanes, and every later close verifies the instance',()=>{
 for(const changeProof of [false,true]){
  const f=fixture(),r=f.open(),a=f.lane(r.run_id,'a'),b=f.lane(r.run_id,'b');
  f.runtime.updateLane(a.lane_id,{created_at:0});f.runtime.updateLane(b.lane_id,{created_at:1});
  let failed=false;
  const runtime=new Runtime(f.db,f.config,{env:f.env,execute:(argv,env)=>{
   if(argv.includes('close')&&argv.at(-1)===a.pane_id){failed=true;return {code:1,stdout:'',stderr:'pane close failed'};}
   if(changeProof&&failed&&argv.includes('systemctl'))return {code:0,stdout:'different-invocation',stderr:''};
   return f.runtime.exec(argv,env);
  }});
  expect(()=>runtime.closeRun(r.run_id)).toThrow();expect(f.runtime.lane(a.lane_id).status).toBe('closing');
  expect(f.runtime.lane(b.lane_id).status).toBe(changeProof?'open':'closed');
  expect(f.state.calls.some(c=>c.includes('stop')||c.includes('delete'))).toBe(false);
 }
});
test('existing-session lane routing requires a running session and rejects a restart receipt',async()=>{
 for(const mode of ['stopped-before-route','started-receipt','changed-after-route']){
  const f=fixture(),r=f.open();f.lane(r.run_id,'first');let routed=false;
  const runtime=new Runtime(f.db,f.config,{env:f.env,execute:(argv,env)=>{
   if(argv.includes('--session')&&argv.some(a=>a.endsWith('/route-lane.ts'))){
    expect(argv).toContain('--require-running');routed=true;
    if(mode==='stopped-before-route'){
     const session=f.state.sessions.get(r.session_name)!;session.server.kill();session.status='stopped';
     return {code:1,stdout:'',stderr:'session is not running'};
    }
    const result=f.runtime.exec(argv,env);
    if(mode==='started-receipt'){const receipt=JSON.parse(result.stdout);receipt.session.started=true;return {...result,stdout:JSON.stringify(receipt)};}
    return result;
   }
   if(mode==='changed-after-route'&&routed&&argv.includes('systemctl'))return {code:0,stdout:'changed-invocation',stderr:''};
   return f.runtime.exec(argv,env);
  }});
  expect(()=>runtime.openLane({run:r.run_id,worker:'codex_worker',class:'judgment',name:mode,op:mode})).toThrow();
  expect(routed).toBe(true);expect(f.runtime.lanes(r.run_id).filter(l=>l.agent_name===mode)[0].status).toBe('unknown');
  expect(f.state.sessions.size).toBe(1);expect(f.state.calls.some(c=>c.includes('stop')||c.includes('delete'))).toBe(false);
  if(mode==='stopped-before-route')await f.state.sessions.get(r.session_name)!.server.exited;
 }
});
test('runtime refuses non-default XDG config roots before any Herdr side effect and accepts normalized defaults',()=>{
 for(const xdg of [join(tmpdir(),'foreign-config-root'),'',join('relative-config'),undefined,'default']){
  const f=fixture(),r=f.open(),value=xdg==='default'?`${f.root}/.config/../.config`:xdg;
  const open=()=>new Runtime(f.db,f.config,{env:{...f.env,XDG_CONFIG_HOME:value},execute:f.runtime.exec}).openLane({run:r.run_id,worker:'codex_worker',class:'judgment',name:'xdg',op:'xdg'});
  if(xdg&&xdg!=='default'){
   expect(open).toThrow('HOME/.config');expect(f.state.calls).toEqual([]);expect(f.state.sessions.size).toBe(0);
   expect(f.runtime.lanes(r.run_id)).toEqual([]);expect(f.runtime.run(r.run_id).session_phase).toBe('none');
  }else expect(open().status).toBe('open');
 }
});
test('an unsupported XDG environment cannot mutate an existing run or query other Herdr resources',()=>{
 const f=fixture(),r=f.open();f.lane(r.run_id);
 const before={run:f.runtime.run(r.run_id),lanes:f.runtime.lanes(r.run_id),calls:f.state.calls.length};
 expect(()=>new Runtime(f.db,f.config,{env:{...f.env,XDG_CONFIG_HOME:join(f.root,'other-config')},execute:f.runtime.exec})).toThrow('HOME/.config');
 expect({run:f.runtime.run(r.run_id),lanes:f.runtime.lanes(r.run_id),calls:f.state.calls.length}).toEqual(before);
});
test('run open records the host session ID of the owner engine and tolerates its absence when a process is found',()=>{
 const f=fixture(),claude=f.open();expect(claude.host_session_id).toBe('host-A');
 const codex=new Runtime(f.db,f.config,{env:{HOME:f.root,CODEX_THREAD_ID:'thread-B',CLAUDE_CODE_SESSION_ID:'host-A',PATH:process.env.PATH},execute:f.runtime.exec});
 const input={owner:'codex_owner',collab:'codex',request:'codex',cwd:f.root,label:'1017｜FIX｜host'};
 const opened=codex.openRun(input);expect(opened.host_session_id).toBe('thread-B');expect(codex.openRun(input).run_id).toBe(opened.run_id);
 // Claude without CLAUDE_PID has no process evidence even when this test is
 // itself launched under a real Codex CLI ancestor. Another engine's host is
 // deliberately insufficient as the Claude owner identity.
 const noClaudeIdentity=new Runtime(f.db,f.config,{env:{HOME:f.root,CODEX_THREAD_ID:'thread-B'}});
 expect(()=>noClaudeIdentity.openRun({...input,owner:'claude_owner',request:'claude-no-identity'})).toThrow('both missing');
 const withProcess=new Runtime(f.db,f.config,{env:{HOME:f.root,CLAUDE_PID:String(process.pid)}}).openRun({...input,owner:'claude_owner',request:'no-host'});
 expect(withProcess.host_session_id).toBeNull();expect(JSON.parse(withProcess.owner_proc!).pid).toBe(process.pid);
});
test('host-only Codex run records authorize matching hosts and reject different hosts independently of CLI ancestry',()=>{
 const f=fixture(),codex=new Runtime(f.db,f.config,{env:{HOME:f.root,CODEX_THREAD_ID:'thread-B',CLAUDE_CODE_SESSION_ID:'host-A'},execute:f.runtime.exec});
 const input={owner:'codex_owner',collab:'fallback',request:'fallback',cwd:f.root,label:'1017｜FIX｜host fallback'};
 const opened=codex.openRun(input);expect(opened.host_session_id).toBe('thread-B');
 // Construct the persisted host-only case explicitly. Actual CLI ancestry may
 // supply process evidence to the caller, but this record must use host fallback.
 f.runtime.updateRun(opened.run_id,{owner_proc:null});const hostOnly=codex.run(opened.run_id);
 expect(hostOnly.owner_proc).toBeNull();expect(()=>codex.authorize(hostOnly)).not.toThrow();expect(codex.openRun(input).run_id).toBe(hostOnly.run_id);
 const differentHost=new Runtime(f.db,f.config,{env:{...codex.env,CODEX_THREAD_ID:'thread-C'}});
 expect(()=>differentHost.authorize(hostOnly)).toThrow('identity');expect(()=>differentHost.openRun(input)).toThrow('conflicts');
});
test('gc reports each reclaim and resume it performs, including through lane open and run close',()=>{
 const f=fixture(),dead=JSON.stringify({...processIdentity(),pid:2147483647});
 const r=f.open();f.runtime.updateRun(r.run_id,{owner_proc:dead});
 expect(f.runtime.gc().reports).toEqual([{run_id:r.run_id,action:'reclaimed',owner_life:'dead',session_phase:'none'}]);
 expect(f.runtime.gc().reports).toEqual([]);
 const g=f.open('with-session'),lane=f.lane(g.run_id);f.runtime.closeLane(lane.lane_id);f.runtime.updateRun(g.run_id,{owner_proc:dead});
 expect(f.runtime.gc().reports).toEqual([{run_id:g.run_id,action:'reclaimed',owner_life:'dead',session_phase:'deleted'}]);
 const h=f.open('interrupted'),second=f.lane(h.run_id,'a');f.runtime.closeLane(second.lane_id);f.state.failInventory=true;expect(()=>f.runtime.closeRun(h.run_id)).toThrow('inventory unavailable');f.state.failInventory=false;
 const k=f.open('keeper'),opened=f.lane(k.run_id,'b');
 expect(opened.gc_reports).toEqual([{run_id:h.run_id,action:'resumed',from:'created',to:'deleted'}]);
 const j=f.open('close-gc');f.runtime.updateRun(j.run_id,{owner_proc:dead});
 expect(f.runtime.closeRun(k.run_id).gc_reports).toEqual([{run_id:j.run_id,action:'reclaimed',owner_life:'dead',session_phase:'none'}]);
});
test('gc converts interrupted opening to unknown and retries closing panes without adopting other resources',()=>{
 const f=fixture(),r=f.open(),lane=f.lane(r.run_id);f.runtime.updateLane(lane.lane_id,{status:'opening'});expect(f.runtime.gc().reports).toContainEqual({lane_id:lane.lane_id,action:'marked_unknown',from:'opening'});expect(f.runtime.lane(lane.lane_id).status).toBe('unknown');
 const second=f.open('second'),other=f.lane(second.run_id);f.runtime.updateLane(other.lane_id,{status:'closing'});expect(f.runtime.gc().reports).toContainEqual({lane_id:other.lane_id,action:'closed',from:'closing'});expect(f.runtime.lane(other.lane_id).status).toBe('closed');expect(f.runtime.run(second.run_id).status).toBe('active');
});
test('recursive fingerprints include nanosecond mtime changes even when size and names match',()=>{
 const f=fixture(),r=f.open();mkdirSync(f.path(r),{recursive:true});const file=join(f.path(r),'log');writeFileSync(file,'abc');const before=fingerprint(f.path(r));utimesSync(file,new Date('2020-01-01'),new Date('2020-01-01'));const after=fingerprint(f.path(r));expect(after.hash).not.toBe(before.hash);expect(after.entries.find(e=>e.relpath==='log')!.size).toBe('3');
});

test('CLI parses lifecycle commands, applies R4, and exposes gc diagnostics through real argv execution',()=>{
 const f=fixture(),bin=join(f.root,'bin');mkdirSync(bin);writeFileSync(join(bin,'herdr'),`#!${process.execPath}\nconsole.log(JSON.stringify({sessions:[{name:'aw-orphan',status:'stopped'}]}));\n`,{mode:0o755});
 const env={...f.env,PATH:`${bin}:${process.env.PATH}`},common=['--config',DEFAULT_CONFIG,'--state',join(f.root,'cli.sqlite')];
 const args=['run','open','--owner','claude_owner','--collab','cli','--request','cli','--cwd',f.root,'--label','1017｜FIX｜cli',...common];
 expect(runRuntime(args,{HOME:f.root}).stderr).toContain('both missing');
 const opened=runRuntime(args,env);expect(opened.code).toBe(0);const run=JSON.parse(opened.stdout);
 const ls=runRuntime(['ls','--run',run.run_id,...common],env);expect(JSON.parse(ls.stdout).runs[0].actual.status).toBe('absent');
 const closed=runRuntime(['run','close','--run',run.run_id,...common],env);expect(closed.code).toBe(0);expect(JSON.parse(closed.stdout)).toMatchObject({status:'closed',gc_reports:[{session:'aw-orphan',status:'stopped',error:'unregistered session; report only'}]});
});

test("runtime tags each external command environment without mutating its caller environment", () => {
  const f = fixture(), run = f.open(), calls: { argv: string[]; env: Record<string, string | undefined> }[] = [];
  const env = { ...f.env, AGENTS_COOPERATION_OP_TAG: "inherited-unrelated" };
  const runtime = new Runtime(f.db, f.config, {
    env,
    execute: (argv, commandEnv) => {
      calls.push({ argv, env: commandEnv });
      return { code: 0, stdout: JSON.stringify({ sessions: [] }), stderr: "" };
    }
  });
  const originalProcessTag = process.env.AGENTS_COOPERATION_OP_TAG;
  runtime.ls(run.run_id);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.env.AGENTS_COOPERATION_OP_TAG).toBe(call.argv[call.argv.indexOf("--op-tag") + 1]);
    expect(call.env).not.toBe(env);
  }
  expect(env.AGENTS_COOPERATION_OP_TAG).toBe("inherited-unrelated");
  expect(process.env.AGENTS_COOPERATION_OP_TAG).toBe(originalProcessTag);
});

test("environment-only native leaf fences a dead runtime lock after its capture parent is killed", async () => {
  const f = fixture(), run = f.open(), op = `${run.run_id}:environment-only`;
  const ready = join(f.root, "leaf-ready.json");
  const source = `import {writeFileSync} from 'node:fs';const child=Bun.spawn(['sleep','600'],{stdout:'pipe',stderr:'pipe'});writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:child.pid}));await Promise.all([Bun.readableStreamToText(child.stdout),Bun.readableStreamToText(child.stderr),child.exited]);`;
  const parent = Bun.spawn([process.execPath, "--eval", source], {
    env: { ...process.env, AGENTS_COOPERATION_OP_TAG: op }, stdout: "ignore", stderr: "pipe"
  });
  let leaf: number | undefined;
  try {
    for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++) await Bun.sleep(5);
    expect(existsSync(ready)).toBe(true);
    leaf = JSON.parse(readFileSync(ready, "utf8")).pid;
    const argv = readFileSync(`/proc/${leaf}/cmdline`, "utf8").split("\0");
    expect(argv).not.toContain(op);
    expect(argv).not.toContain(`agents-cooperation-op:${op}`);
    const identity = processIdentity(parent.pid);
    f.runtime.updateRun(run.run_id, { lock_proc: JSON.stringify(identity), lock_op: op });
    expect(await waitForOperationState(op,identity,true)).toBe(true);
    parent.kill("SIGKILL");
    await parent.exited;
    expect(processLife(identity)).toBe("dead");
    await waitForOperationState(op,identity,true);
    expect(() => f.runtime.withLock(run.run_id, () => "unsafe replay")).toThrow("in-flight");
    process.kill(leaf!, "SIGKILL");
    await waitForOperationState(op,identity,false);
    const released = f.runtime.withLock(run.run_id, () => "released");
    expect(released).toBe("released");
    writeFileSync(join(f.root, "full-proc-environment-leaf.json"), JSON.stringify({ holder: identity, leaf, argvContainsTag: false, killedParent: true, rejectedWhileLeafAlive: true, released, enumerationMocked: false, readMocked: false }, null, 2));
  } finally {
    try { parent.kill("SIGKILL"); } catch {}
    await parent.exited;
    if (!leaf && existsSync(ready)) leaf = JSON.parse(readFileSync(ready, "utf8")).pid;
    if (leaf) try { process.kill(leaf, "SIGKILL"); } catch (error) { if ((error as any).code !== "ESRCH") throw error; }
  }
});

function withProcBoundary(input: { uid?: number; fail?: "status" | "cmdline" | "environ"; code?: string; environment?: string; status?: string; state?: string; starttime?: string; stat?: string; statFail?: string }, action: () => void) {
  const originalRead = fs.readFileSync, originalList = fs.readdirSync, pid = 2147483646;
  const read = spyOn(fs, "readFileSync").mockImplementation(((path: any, options: any) => {
    const file = String(path);
    if (file.startsWith(`/proc/${pid}/`)) {
      const entry = file.slice(`/proc/${pid}/`.length);
      if (entry === input.fail) throw Object.assign(new Error("injected read failure"), { code: input.code ?? "EACCES" });
      if (entry === "status") {
        const real = input.uid ?? process.getuid!(), effective = input.uid ?? process.geteuid!();
        if (input.status !== undefined) return input.status;
        return `Name:\tfixture\nUid:\t${real}\t${effective}\t${effective}\t${effective}\n`;
      }
      if (entry === "stat") {
        if (input.statFail) throw Object.assign(new Error("injected stat failure"), { code: input.statFail });
        if (input.stat !== undefined) return input.stat;
        const fields = Array(20).fill("0"); fields[0] = input.state ?? "S"; fields[1] = String(process.pid); fields[19] = input.starttime ?? "100";
        return `${pid} (fixture) ${fields.join(" ")}`;
      }
      if (entry === "cmdline") return "sleep\0capture\0";
      if (entry === "environ") return Buffer.from(input.environment ?? "UNRELATED=1\0");
      throw new Error(`unexpected fixture entry ${entry}`);
    }
    return originalRead(path, options);
  }) as typeof fs.readFileSync);
  const list = spyOn(fs, "readdirSync").mockImplementation(((path: any, options: any) => String(path) === "/proc" ? [String(pid)] : originalList(path, options)) as typeof fs.readdirSync);
  try { action(); } finally { list.mockRestore(); read.mockRestore(); }
}

test("in-flight environment matching uses exact NUL entries and skips foreign uid before reading private data", () => {
  const self = processIdentity(), op = "exact-environment-tag";
  withProcBoundary({ environment: `PREFIX_AGENTS_COOPERATION_OP_TAG=${op}\0AGENTS_COOPERATION_OP_TAG=${op}-other\0` }, () => {
    expect(operationInFlight(op, self.boot_id)).toBe(false);
  });
  withProcBoundary({ environment: `OTHER=1\0AGENTS_COOPERATION_OP_TAG=${op}\0` }, () => {
    expect(operationInFlight(op, self.boot_id)).toBe(true);
  });
  for (const fail of ["cmdline", "environ"] as const) withProcBoundary({ uid: Math.max(process.getuid!(), process.geteuid!()) + 1, fail }, () => {
    expect(operationInFlight(op, self.boot_id)).toBe(false);
  });
  withProcBoundary({ status: "Name:\tfixture\nUid:\tinvalid\n" }, () => {
    expect(() => operationInFlight(op, self.boot_id)).toThrow("cannot inspect");
  });
});

test("same-uid status and private-data read errors fail closed except vanished processes", () => {
  const f = fixture(), run = f.open(), op = `${run.run_id}:read-errors`, self = processIdentity();
  f.runtime.updateRun(run.run_id, { lock_proc: JSON.stringify({ ...self, pid: 2147483647 }), lock_op: op });
  for (const fail of ["status", "cmdline", "environ"] as const) {
    for (const code of ["EACCES", "EIO"]) withProcBoundary({ fail, code, starttime:self.starttime }, () => {
      expect(() => f.runtime.withLock(run.run_id, () => "unsafe replay")).toThrow("cannot inspect");
    });
    for (const code of ["ENOENT", "ESRCH"]) withProcBoundary({ fail, code }, () => {
      expect(operationInFlight(op, self.boot_id)).toBe(false);
    });
  }
});

test("lock release retains unreadable operation evidence and preserves the original exception", () => {
 const f=fixture(),run=f.open(),original=new Error('original action failed');
 withProcBoundary({fail:'environ',starttime:processIdentity().starttime},()=>{
  expect(()=>f.runtime.withLock(run.run_id,()=>{throw original;})).toThrow(original);
 });
 const retained=f.runtime.run(run.run_id);expect(retained.lock_proc).toBeTruthy();expect(retained.lock_op).toBeTruthy();
 expect(retained.last_error).toContain('cannot inspect');expect(()=>f.runtime.withLock(run.run_id,()=>42)).toThrow('alive');
});

test("only confirmed zombies skip private evidence; live and unreadable process states retain the fence",()=>{
 const self=processIdentity(),op='zombie-state-boundary';
 withProcBoundary({state:'Z',fail:'environ',starttime:self.starttime},()=>expect(operationInFlight(op,self.boot_id,self.starttime)).toBe(false));
 for(const state of ['R','S','D','T','t','X','x','K','W','P','I'])withProcBoundary({state,fail:'environ',starttime:self.starttime},()=>{
  expect(()=>operationInFlight(op,self.boot_id,self.starttime)).toThrow('cannot inspect');
 });
 for(const statFail of ['EACCES','EIO'])withProcBoundary({statFail},()=>{
  expect(()=>operationInFlight(op,self.boot_id,self.starttime)).toThrow('cannot inspect');
 });
});

test("a real unreaped tagged zombie does not prevent the run lock from being released",async()=>{
 const f=fixture(),run=f.open(),ready=join(f.root,'zombie-ready.json'),release=join(f.root,'reap-zombie');
 let parent:ReturnType<typeof Bun.spawn>|undefined,zombie:number|undefined,operation:string|undefined;
 try{
  f.runtime.withLock(run.run_id,op=>{
   operation=op;
   const source=`import {existsSync,writeFileSync} from 'node:fs';const child=Bun.spawn(['sleep','600'],{env:{...process.env,AGENTS_COOPERATION_OP_TAG:${JSON.stringify(op)}},stdout:'ignore',stderr:'ignore'});writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:child.pid}));child.kill('SIGKILL');const deadline=Date.now()+10000;while(!existsSync(${JSON.stringify(release)})&&Date.now()<deadline)Bun.sleepSync(5);await child.exited;`;
   parent=Bun.spawn([process.execPath,'--eval',source],{stdout:'ignore',stderr:'ignore'});
   for(let attempt=0;attempt<400;attempt++){
    if(existsSync(ready)){zombie=JSON.parse(readFileSync(ready,'utf8')).pid;try{if(procStat(zombie!).state==='Z')break;}catch{}}
    Bun.sleepSync(5);
   }
   expect(zombie).toBeTruthy();expect(procStat(zombie!).state).toBe('Z');expect(processLife(processIdentity(zombie!))).toBe('dead');
  });
  expect(f.runtime.run(run.run_id).lock_op).toBeNull();expect(f.runtime.run(run.run_id).last_error).toBeNull();
 }finally{
  if(parent){writeFileSync(release,'reap');await parent.exited;}
  if(zombie)try{process.kill(zombie,'SIGKILL');}catch(error){if((error as any).code!=='ESRCH')throw error;}
 }
 expect(operation).toBeTruthy();
});

test("terminating only the route layer preserves its live native call fence after runtime catches the error", async () => {
 const f=fixture(),run=f.open(),ready=join(f.root,'route-ready.json'),caught=join(f.root,'runtime-caught.json');
 const route=join(f.root,'route-fixture.ts'),runtimeModule=join(import.meta.dir,'../scripts/agents-runtime.ts'),stateModule=join(import.meta.dir,'../scripts/lib/state-db.ts');
 // The route owns independent pipes just like capture(): the native call never inherits the helper's output pipes.
 writeFileSync(route,`import {writeFileSync} from 'node:fs';const leaf=Bun.spawn(['sleep','600'],{stdout:'pipe',stderr:'pipe'});writeFileSync(${JSON.stringify(ready)},JSON.stringify({route:process.pid,leaf:leaf.pid}));await leaf.exited;`);
 const source=`import {Runtime} from ${JSON.stringify(runtimeModule)};import {openState} from ${JSON.stringify(stateModule)};import {readFileSync,writeFileSync} from 'node:fs';const runtime=new Runtime(openState(${JSON.stringify(join(f.root,'state.sqlite'))}),JSON.parse(readFileSync(${JSON.stringify(DEFAULT_CONFIG)},'utf8')),{env:{...process.env,HOME:${JSON.stringify(f.root)},CLAUDE_PID:undefined,CLAUDE_CODE_SESSION_ID:'host-A'},execute:(argv,env)=>{if(argv.includes('list'))return {code:0,stdout:JSON.stringify({result:{sessions:[]}}),stderr:''};const split=argv.indexOf('--');const result=Bun.spawnSync({cmd:[...argv.slice(0,split+1),process.execPath,${JSON.stringify(route)}],env,stdout:'pipe',stderr:'pipe'});return {code:result.exitCode,stdout:result.stdout.toString(),stderr:result.stderr.toString()};}});let message;try{runtime.openLane({run:${JSON.stringify(run.run_id)},worker:'codex_worker',class:'judgment',name:'interrupted-route',op:'interrupted-route'});}catch(error){message=error.message;}writeFileSync(${JSON.stringify(caught)},JSON.stringify({message,run:runtime.run(${JSON.stringify(run.run_id)})}));setInterval(()=>{},1000);`;
 const runtimeProcess=Bun.spawn([process.execPath,'--eval',source],{stdout:'ignore',stderr:'pipe'});
 let routePid:number|undefined,leafPid:number|undefined;
 try{
  for(let attempt=0;attempt<400&&!existsSync(ready);attempt++)await Bun.sleep(5);
  expect(existsSync(ready)).toBe(true);({route:routePid,leaf:leafPid}=JSON.parse(readFileSync(ready,'utf8')));
  const held=f.runtime.run(run.run_id),holder=JSON.parse(held.lock_proc!),leaf=processIdentity(leafPid!);
  expect(holder.pid).toBe(runtimeProcess.pid);expect(processLife(holder)).toBe('alive');expect(processLife(leaf)).toBe('alive');
  process.kill(routePid!,'SIGKILL');
  for(let attempt=0;attempt<400&&!existsSync(caught);attempt++)await Bun.sleep(5);
  expect(existsSync(caught)).toBe(true);
  const result=JSON.parse(readFileSync(caught,'utf8'));expect(result.message).toContain('external command failed');
  expect(result.run.lock_op).toBe(held.lock_op);expect(result.run.lock_proc).toBe(held.lock_proc);expect(result.run.last_error).toContain('in-flight');
  expect(processLife(holder)).toBe('alive');expect(processLife(leaf)).toBe('alive');
  expect(()=>f.runtime.withLock(run.run_id,()=>{throw new Error('must not enter');})).toThrow('alive');
  runtimeProcess.kill('SIGKILL');await runtimeProcess.exited;
  expect(()=>f.runtime.withLock(run.run_id,()=>{throw new Error('must not replay');})).toThrow('in-flight');
  process.kill(leafPid!,'SIGKILL');await waitForOperationState(held.lock_op!,holder,false);
  expect(f.runtime.withLock(run.run_id,()=>42)).toBe(42);
 }finally{
  try{runtimeProcess.kill('SIGKILL');}catch{}await runtimeProcess.exited;
  if(existsSync(ready)){const pids=JSON.parse(readFileSync(ready,'utf8'));routePid??=pids.route;leafPid??=pids.leaf;}
  for(const pid of [routePid,leafPid])if(pid)try{process.kill(pid,'SIGKILL');}catch(error){if((error as any).code!=='ESRCH')throw error;}
 }
});

test("ls computes current open-lane health at timeout and keep boundaries without writing SQLite", () => {
  const f = fixture(), run = f.open(), lane = f.lane(run.run_id), now = 1800000000000;
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const max = f.config.herdr.max_wait_minutes * 60000;
    for (const entry of [
      { elapsed: max - 1, keep: null, health: "ok", reported: false },
      { elapsed: max, keep: null, health: "ok", reported: false },
      { elapsed: max + 1, keep: null, health: "stale", reported: true },
      { elapsed: max + 1, keep: "review", health: "ok", reported: false },
      { elapsed: max * 3, keep: "review", health: "ok", reported: false },
      { elapsed: max * 3 + 1, keep: "review", health: "ok", reported: true }
    ]) {
      f.runtime.updateLane(lane.lane_id, { last_progress_at: now - entry.elapsed, keep_reason: entry.keep, health: "ok" });
      const before = { runs: f.db.query("SELECT * FROM runs").all(), lanes: f.db.query("SELECT * FROM lanes").all() };
      const output = f.runtime.ls(run.run_id);
      expect(output.runs[0].lanes[0].health).toBe(entry.health);
      expect({ runs: f.db.query("SELECT * FROM runs").all(), lanes: f.db.query("SELECT * FROM lanes").all() }).toEqual(before);
      expect(f.runtime.gc().reports.some(report => report.lane === lane.lane_id)).toBe(entry.reported);
      expect(f.runtime.lane(lane.lane_id).health).toBe(entry.health);
    }
    f.runtime.updateRun(run.run_id, { owner_proc: JSON.stringify({ ...processIdentity(), pid: 2147483647 }) });
    f.runtime.updateLane(lane.lane_id, { last_progress_at: now - max * 4, keep_reason: null, health: "ok" });
    const before = f.runtime.lane(lane.lane_id);
    expect(f.runtime.ls(run.run_id).runs[0].lanes[0].health).toBe("ok");
    expect(f.runtime.lane(lane.lane_id)).toEqual(before);
  } finally { clock.mockRestore(); }
});


test("only strictly older unreadable environments can be excluded using exact same-boot starttime evidence", () => {
  const self = processIdentity(), op = "starttime-exclusion", holderStart = "9007199254740993";
  for (const starttime of ["9007199254740992", "0009007199254740992"]) {
    withProcBoundary({ fail: "environ", starttime }, () => {
      expect(operationInFlight(op, self.boot_id, holderStart)).toBe(false);
    });
  }
  for (const starttime of [holderStart, "9007199254740994"]) {
    withProcBoundary({ fail: "environ", starttime }, () => {
      expect(() => operationInFlight(op, self.boot_id, holderStart)).toThrow("cannot inspect");
    });
  }
  const invalidStatFields = Array(20).fill("0");
  invalidStatFields[0] = "S"; invalidStatFields[1] = "1"; invalidStatFields[19] = "1";
  for (const input of [
    { stat: `garbage) ${invalidStatFields.join(" ")}` },
    { statFail: "EACCES" }, { statFail: "EIO" }, { stat: "malformed" },
    { starttime: "not-an-integer" }, { starttime: "-1" }
  ]) withProcBoundary({ fail: "environ", ...input }, () => {
    expect(() => operationInFlight(op, self.boot_id, holderStart)).toThrow("cannot inspect");
  });
  withProcBoundary({ fail: "environ", starttime: "1" }, () => {
    expect(() => operationInFlight(op, self.boot_id)).toThrow("cannot inspect");
    expect(() => operationInFlight(op, self.boot_id, "invalid")).toThrow("cannot inspect");
  });
  for (const fail of ["status", "cmdline"] as const) withProcBoundary({ fail, starttime: "1" }, () => {
    expect(() => operationInFlight(op, self.boot_id, holderStart)).toThrow("cannot inspect");
  });
  const list = spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("must not enumerate across boot"); });
  try { expect(operationInFlight(op, "different-boot", holderStart)).toBe(false); } finally { list.mockRestore(); }
});

test("full proc production path reclaims a real SIGKILLed lock holder with no external children", async () => {
  const f = fixture(), run = f.open(), ready = join(f.root, "lock-ready");
  const runtimeModule = join(import.meta.dir, "../scripts/agents-runtime.ts"), stateModule = join(import.meta.dir, "../scripts/lib/state-db.ts");
  const source = `import {Runtime} from ${JSON.stringify(runtimeModule)};import {openState} from ${JSON.stringify(stateModule)};import {readFileSync,writeFileSync} from 'node:fs';const config=JSON.parse(readFileSync(${JSON.stringify(DEFAULT_CONFIG)},'utf8'));const runtime=new Runtime(openState(${JSON.stringify(join(f.root,"state.sqlite"))}),config);runtime.withLock(${JSON.stringify(run.run_id)},()=>{writeFileSync(${JSON.stringify(ready)},'ready');Bun.sleepSync(60000);});`;
  const holder = Bun.spawn([process.execPath, "--eval", source], { stdout: "ignore", stderr: "pipe" });
  try {
    for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++) await Bun.sleep(5);
    expect(existsSync(ready)).toBe(true);
    const identity = JSON.parse(f.runtime.run(run.run_id).lock_proc!);
    expect(identity.pid).toBe(holder.pid);
    const childrenBeforeKill = readFileSync(`/proc/${holder.pid}/task/${holder.pid}/children`, "utf8").trim();
    expect(childrenBeforeKill).toBe("");
    holder.kill("SIGKILL"); await holder.exited;
    expect(processLife(identity)).toBe("dead");
    let callbackExecuted = false;
    const result = f.runtime.withLock(run.run_id, () => { callbackExecuted = true; return "reclaimed"; });
    expect(result).toBe("reclaimed"); expect(callbackExecuted).toBe(true);
    writeFileSync(join(f.root, "full-proc-lock-recovery.json"), JSON.stringify({ holder: identity, killed: true, childrenBeforeKill: [], callbackExecuted, result, enumerationMocked: false, readMocked: false }, null, 2));
  } finally { try { holder.kill("SIGKILL"); } catch {} await holder.exited; }
});

/** Real full-/proc observations may transiently fail closed while an unrelated same-tick process is exiting.
 * Await verifiable readiness/exit; never treat a read error as a successful observation or mock the evidence.
 */
async function waitForOperationState(op: string, holder: ReturnType<typeof processIdentity>, expected: boolean) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const actual = operationInFlight(op, holder.boot_id, holder.starttime);
      if (actual === expected) return actual;
    } catch (error) { lastError = error; }
    await Bun.sleep(5);
  }
  throw new Error(`operation evidence did not reach ${expected ? "in-flight" : "released"} state: ${lastError instanceof Error ? lastError.message : "still pending"}`);
}
