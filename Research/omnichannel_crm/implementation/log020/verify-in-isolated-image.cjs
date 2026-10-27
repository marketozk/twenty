const fs=require('fs'),path=require('path'),assert=require('assert/strict'),child=require('child_process');
const swc=require('/tools/node_modules/@swc/core');
const root=process.cwd(),source='/source/packages/twenty-server/src';
assert.match(new URL(process.env.PG_DATABASE_URL).pathname,/^\/twenty_rob764_test_[a-f0-9]{16}$/);
const folders=['engine/core-modules/omnichannel-storage','database/commands/fork-upgrade'];
const sourceFiles=[];
for(const folder of folders)for(const entry of fs.readdirSync(source+'/'+folder,{recursive:true})){
  if(!/\.(ts|json)$/.test(entry))continue;
  const input=source+'/'+folder+'/'+entry,dest=root+'/dist/'+folder+'/'+entry.replace(/\.ts$/,'.js');
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  if(entry.endsWith('.json'))fs.copyFileSync(input,dest);
  else {sourceFiles.push(input);fs.writeFileSync(dest,swc.transformSync(fs.readFileSync(input,'utf8'),{filename:dest,jsc:{parser:{syntax:'typescript',decorators:true},transform:{legacyDecorator:true,decoratorMetadata:true},target:'es2020',baseUrl:root+'/dist',paths:{'src/*':['./*']}},module:{type:'commonjs'}}).code);}
}
const config={compilerOptions:{strict:true,strictPropertyInitialization:false,noEmit:true,skipLibCheck:true,target:'ES2022',module:'commonjs',moduleResolution:'node',esModuleInterop:true,resolveJsonModule:true,experimentalDecorators:true,emitDecoratorMetadata:true,baseUrl:source,paths:{'src/*':['*'],'typeorm':['/app/node_modules/typeorm'],'pg':['/app/node_modules/pg']},typeRoots:['/tools/node_modules/@types'],types:['node','jest']},files:[...sourceFiles,...fs.readdirSync('/source/packages/twenty-server/test/fork-migration').filter(n=>n.endsWith('.ts')).map(n=>'/source/packages/twenty-server/test/fork-migration/'+n)]};
fs.writeFileSync('/tmp/log020-tsconfig.json',JSON.stringify(config));
const typecheck=child.spawnSync('node',['/tools/node_modules/typescript/bin/tsc','-p','/tmp/log020-tsconfig.json'],{encoding:'utf8'});
fs.writeFileSync('/out/typecheck.txt',typecheck.stdout+typecheck.stderr);
if(typecheck.status!==0)throw Error('Focused typecheck failed: '+typecheck.stdout.slice(0,4000));
console.log('Focused strict typecheck: PASS');
require('reflect-metadata');const{DataSource}=require('typeorm');
const cli=root+'/dist/database/commands/fork-upgrade/fork-upgrade.cli.js';
const run=(args,expected=0)=>{const r=child.spawnSync('node',[cli,...args],{encoding:'utf8'});assert.equal(r.status,expected,r.stdout+r.stderr);return r;};
(async()=>{
 const ds=new DataSource({type:'postgres',url:process.env.PG_DATABASE_URL});await ds.initialize();
 try{
  const before=await ds.query('SELECT * FROM core."upgradeMigration" ORDER BY id');
  assert(before.length>0,'Genuine upstream migration history required');
  const initialLedger=await ds.query(`SELECT to_regclass('core."forkMigrationLedger"') AS ledger`);
  if(!initialLedger[0].ledger){const missing=run(['verify'],1);assert.match(missing.stderr,/Missing or incompatible/);}
  run(['apply']);run(['verify']);
  const ledgerBefore=await ds.query('SELECT * FROM core."forkMigrationLedger"');
  assert.equal(ledgerBefore.length,1);run(['apply']);run(['verify']);
  assert.deepEqual(await ds.query('SELECT * FROM core."forkMigrationLedger"'),ledgerBefore);
  assert.deepEqual(await ds.query('SELECT * FROM core."upgradeMigration" ORDER BY id'),before);
  run(['down'],1);
  const script='/tmp/start-runtime.sh';fs.writeFileSync(script,fs.readFileSync('/source/ops/omnichannel/start-runtime.sh','utf8').replace(/\r\n/g,'\n'));
  const launch=(extra,expected)=>{const result=child.spawnSync('sh',[script,'node','-e','process.stdout.write("RUNTIME_STARTED")'],{encoding:'utf8',env:{...process.env,...extra}});assert.equal(result.status,expected,result.stdout+result.stderr);return result;};
  assert.match(launch({DISABLE_DB_MIGRATIONS:'true'},0).stdout,/RUNTIME_STARTED/);
  assert.doesNotMatch(launch({DISABLE_DB_MIGRATIONS:'false'},1).stdout,/RUNTIME_STARTED/);
  await ds.query('ALTER TABLE core."omniAccountBinding" ALTER COLUMN status SET DEFAULT \'active\'');
  try{assert.doesNotMatch(launch({DISABLE_DB_MIGRATIONS:'true'},1).stdout,/RUNTIME_STARTED/);}finally{await ds.query('ALTER TABLE core."omniAccountBinding" ALTER COLUMN status SET DEFAULT \'inactive\'');}
  run(['verify']);
  const result={focusedTypecheck:'pass',upstreamHistoryRows:before.length,upstreamHistoryUnchanged:true,initialLedgerExisted:!!initialLedger[0].ledger,missingLedgerRejected:initialLedger[0].ledger?null:true,applyVerifyReplay:'pass',ledgerRows:ledgerBefore.length,wrapperReadyExec:'pass',wrapperUnsafeConfigRefused:'pass',wrapperSchemaDriftRefused:'pass',downCliRejected:true,nativeFixture:'real upstream core initialization; no native workspace seeded',fullBuild:false,actualServerWorkerRestart:false};
  fs.writeFileSync('/out/upstream-verification.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{await ds.destroy();}
})().catch(e=>{console.error(e);process.exitCode=1});
