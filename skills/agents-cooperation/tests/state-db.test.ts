import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {openState,openConfiguredState,defaultStatePath,listBlocks,upsertBlock,removeBlock,transaction,migrateAvailability,STATE_VERSION,stateWarnings} from '../scripts/lib/state-db.ts';
import {run,DEFAULT_CONFIG,validateConfig} from '../scripts/agents-config.ts';
const roots:string[]=[];afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'state-db-'));roots.push(root);const env={HOME:root};const path=defaultStatePath(env);mkdirSync(join(path,'..'),{recursive:true});return {root,env,path,source:join(path,'..','availability.json')};}
const K={engine:'codex',reason:'quota',since:'2026-10-16T00:00:00Z'};
const legacy=JSON.stringify({version:1,blocks:[K]});
const version=(db:Database)=>(db.query('PRAGMA user_version').get() as any).user_version;
const modulePath=resolve(import.meta.dir,'../scripts/lib/state-db.ts');
test('empty install, partial unique keys, transaction rollback and repeat opening use real SQLite',()=>{
 const f=fixture();let db=openState(f.path);expect(version(db)).toBe(STATE_VERSION);
 transaction(db,()=>{upsertBlock(db,K);upsertBlock(db,{...K,reason:'replacement'});upsertBlock(db,{...K,model:'m'});});
 expect(listBlocks(db)).toHaveLength(2);
 expect(()=>transaction(db,()=>{upsertBlock(db,{...K,engine:'claude'});throw new Error('abort');})).toThrow('abort');
 expect(listBlocks(db).map(b=>b.engine)).toEqual(['codex','codex']);db.close();
 db=openState(f.path);expect(version(db)).toBe(STATE_VERSION);expect(listBlocks(db)).toHaveLength(2);db.close();
 expect(statSync(f.path).mode&0o777).toBe(0o600);
});
test('historical v1 blocks upgrade in-place, preserving history and validating it',()=>{
 const f=fixture();let db=new Database(f.path);db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('app','agents-cooperation'); CREATE TABLE blocks(engine TEXT NOT NULL,model TEXT,reason TEXT NOT NULL,since TEXT NOT NULL,release_at TEXT,by TEXT); CREATE UNIQUE INDEX blocks_engine ON blocks(engine) WHERE model IS NULL;CREATE UNIQUE INDEX blocks_model ON blocks(engine,model) WHERE model IS NOT NULL; PRAGMA user_version=1;");upsertBlock(db,K);db.close();
 db=openState(f.path);expect(listBlocks(db)).toEqual([K]);expect(db.query('SELECT * FROM runs').all()).toEqual([]);db.close();
 db=openState(f.path);expect(listBlocks(db)).toEqual([K]);db.close();
});
test('reject foreign/future databases and JSON without changing their permissions',()=>{
 for(const kind of ['foreign','future','json']){const f=fixture();if(kind==='json')writeFileSync(f.path,legacy);else {const db=new Database(f.path);db.exec(kind==='foreign'?'CREATE TABLE unrelated(k TEXT)':'PRAGMA user_version=999');db.close();}chmodSync(f.path,0o644);expect(()=>openState(f.path)).toThrow();expect(statSync(f.path).mode&0o777).toBe(0o644);}
});
test('existing shared parent permissions remain unchanged; custom state never consumes adjacent JSON',()=>{
 const f=fixture();chmodSync(f.root,0o755);const path=join(f.root,'custom.sqlite'),source=join(f.root,'availability.json');writeFileSync(source,legacy);
 const db=openConfiguredState(path,f.env);expect(listBlocks(db)).toEqual([]);db.close();expect(readFileSync(source,'utf8')).toBe(legacy);expect(statSync(f.root).mode&0o777).toBe(0o755);
});
test('R3 recovers a snapshot after rename and after an uncommitted import, unblock never resurrects it',async()=>{
 for(const insert of [false,true]){
  const f=fixture();const db=openState(f.path);db.close();writeFileSync(f.source,legacy);const snapshot=f.source+'.importing-crash';
  const script=`import {Database} from 'bun:sqlite';import {renameSync} from 'node:fs';import {upsertBlock} from ${JSON.stringify(modulePath)};const db=new Database(${JSON.stringify(f.path)});db.exec('BEGIN IMMEDIATE');renameSync(${JSON.stringify(f.source)},${JSON.stringify(snapshot)});${insert?`upsertBlock(db,${JSON.stringify(K)});db.query("INSERT INTO meta VALUES('availability_imports',?)").run(JSON.stringify([{source:${JSON.stringify(f.source)},snapshot:${JSON.stringify(snapshot)},sha256:'not-committed'}]));`:''}process.exit(9);`;
  const child=Bun.spawn([process.execPath,'--eval',script],{stdout:'pipe',stderr:'pipe'});expect(await child.exited).toBe(9);
  writeFileSync(f.source,JSON.stringify({version:1,blocks:[{...K,engine:'claude'}]}));
  let recovered=openConfiguredState(undefined,f.env);expect(listBlocks(recovered)).toEqual([K]);expect(stateWarnings(recovered)[0]).toContain('preserved');transaction(recovered,()=>removeBlock(recovered,'codex'));recovered.close();
  expect(existsSync(snapshot)).toBe(false);expect(existsSync(f.source)).toBe(true);
  recovered=openConfiguredState(undefined,f.env);expect(listBlocks(recovered)).toEqual([]);expect(stateWarnings(recovered)[0]).toContain('preserved');recovered.close();
 }
});
test('committed snapshot cleanup after interruption does not replay an already unblocked block',()=>{
 const f=fixture();writeFileSync(f.source,legacy);let db=openConfiguredState(undefined,f.env);
 const records=JSON.parse((db.query("SELECT value FROM meta WHERE key='availability_imports'").get() as any).value);transaction(db,()=>removeBlock(db,'codex'));writeFileSync(records[0].snapshot,legacy);db.close();
 db=openConfiguredState(undefined,f.env);expect(listBlocks(db)).toEqual([]);expect(existsSync(records[0].snapshot)).toBe(false);db.close();
});
test('multiple or invalid unknown snapshots fail visibly and preserve every file',()=>{
 for(const mode of ['multiple','invalid']){const f=fixture();writeFileSync(f.source,legacy);writeFileSync(f.source+'.importing-a',mode==='invalid'?'{':legacy);if(mode==='multiple')writeFileSync(f.source+'.importing-b',legacy);
 const result=run(['status','--config',DEFAULT_CONFIG],f.env);expect(result.code).toBe(1);expect(result.stderr).toMatch(/snapshot|JSON/);expect(existsSync(f.source)).toBe(true);expect(existsSync(f.source+'.importing-a')).toBe(true);}
});
test('concurrent default migrations serialize claiming and cleanup; recreated source is retained and reported',async()=>{
 const f=fixture();writeFileSync(f.source,legacy);
 const script=`import {openConfiguredState} from ${JSON.stringify(modulePath)}; const db=openConfiguredState(undefined,{HOME:${JSON.stringify(f.root)}});db.close();`;
 const children=Array.from({length:5},()=>Bun.spawn([process.execPath,'--eval',script],{stdout:'pipe',stderr:'pipe'}));
 for(const c of children){const error=await new Response(c.stderr).text();expect({code:await c.exited,error}).toEqual({code:0,error:''});}
 const db=openState(f.path);expect(listBlocks(db)).toEqual([K]);expect(JSON.parse((db.query("SELECT value FROM meta WHERE key='availability_imports'").get() as any).value)).toHaveLength(1);db.close();
 writeFileSync(f.source,legacy);const result=run(['status','--config',DEFAULT_CONFIG],f.env);expect(JSON.parse(result.stdout).state_warnings[0]).toContain('preserved');expect(existsSync(f.source)).toBe(true);
});
test('explicit imports are keyed by hash; same bytes do not replay after unblock',()=>{
 const f=fixture(),db=openState(f.path),source=join(f.root,'manual.json');writeFileSync(source,legacy);expect(migrateAvailability(db,source).imported).toBe(1);transaction(db,()=>removeBlock(db,'codex'));writeFileSync(source,legacy);expect(migrateAvailability(db,source).imported).toBe(0);expect(listBlocks(db)).toEqual([]);
 writeFileSync(source,JSON.stringify({version:1,blocks:[{...K,engine:'claude'}]}));expect(migrateAvailability(db,source).imported).toBe(1);expect(listBlocks(db).map(b=>b.engine)).toEqual(['claude']);db.close();
});
test('config schema errors for primitive herdr values remain diagnostic, without throwing',()=>{
 for(const value of ['bad',7,true,null]){const c=JSON.parse(readFileSync(DEFAULT_CONFIG,'utf8'));c.herdr=value;expect(validateConfig(c).map(i=>i.path)).toContain('$.herdr');}
});
