from pathlib import Path
import os,json,subprocess,shlex,time,sys,hashlib
out=Path(os.environ['TEMP']);s=json.loads((out/'twenty-log088-state.json').read_text());image=s['image']
def ssh(args,**kw):return subprocess.run(['ssh',s['host'],shlex.join(args)],check=True,**kw)
def sql(database,query):return ssh(['docker','exec',s['name']+'-db','psql','-X','-v','ON_ERROR_STOP=1','-U','test_owner','-d',database,'-Atc',query],capture_output=True,text=True).stdout.strip()
def env(database,runtime=False):
 return {'PG_DATABASE_URL':('postgres://runtime_log088:isolated-runtime-only@postgres/' if runtime else 'postgres://test_owner:isolated-test-only@postgres/')+database,'REDIS_URL':'redis://redis:6379/'+('1' if database==s['freshDatabase'] else '2'),'APP_SECRET':'isolated-test-only-not-production','SERVER_URL':'http://server:3000','IS_BILLING_ENABLED':'false','IS_MULTIWORKSPACE_ENABLED':'true','APP_VERSION':'v2.52.0','NODE_ENV':'production','DISABLE_DB_MIGRATIONS':'true' if runtime else 'false','DISABLE_CRON_JOBS_REGISTRATION':'true','STORAGE_TYPE':'local','NODE_PORT':'3000','NODE_OPTIONS':'--max-old-space-size=2048'}
def args(database,name,runtime=False):
 a=['docker','run','--name',s['name']+'-'+name,'--network',s['network'],'--memory','3g','--cpus','2','--stop-timeout','360']
 for key,value in env(database,runtime).items():a+=['-e',key+'='+value]
 return a
def run(database,name,command,expected=0,runtime=False,override=None,entrypoint=None,overrides=None):
 a=args(database,name,runtime)+['--rm'];a+=['--entrypoint',entrypoint] if entrypoint else []
 for key,value in (overrides or {}).items():a+=['-e',key+'='+value]
 a+=[override or image,*command]
 with (out/('twenty-log088-'+name+'.log')).open('w',encoding='utf-8') as log:
  try:result=subprocess.run(['ssh',s['host'],shlex.join(a)],stdout=log,stderr=subprocess.STDOUT,timeout=600)
  except subprocess.TimeoutExpired:
   subprocess.run(['ssh',s['host'],shlex.join(['docker','stop','--time','20',s['name']+'-'+name])],stdout=log,stderr=subprocess.STDOUT,timeout=40)
   raise
 assert result.returncode==expected,(name,result.returncode)
 print(name+': PASS',flush=True)
def fingerprints(database):
 tables=sql(database,"SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema LIKE 'workspace_%' AND table_name IN ('company','person','opportunity') ORDER BY 1").splitlines();result={}
 for table in tables:
  schema,name=table.split('.');result[table]=sql(database,'SELECT count(*)::text||\':\'||coalesce(md5(string_agg(to_jsonb(t)::text,\'\' ORDER BY id)),\'empty\') FROM "'+schema+'"."'+name+'" t')
 result['upstreamHistory']=sql(database,'SELECT count(*)::text FROM core.workspace')
 result['upgradeMigration']=sql(database,"SELECT count(*)::text||':'||coalesce(md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)),'empty') FROM core.\"upgradeMigration\" t")
 return result
def grant(database):
 for schema in sql(database,"SELECT nspname FROM pg_namespace WHERE nspname='core' OR nspname LIKE 'workspace_%'").splitlines():
  sql(database,'GRANT USAGE ON SCHEMA "'+schema+'" TO runtime_log088; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "'+schema+'" TO runtime_log088; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "'+schema+'" TO runtime_log088')
 sql(database,'REVOKE INSERT,UPDATE,DELETE ON core."forkMigrationLedger" FROM runtime_log088; GRANT USAGE ON SCHEMA crm_audit TO runtime_log088; GRANT SELECT,INSERT ON crm_audit."crmAuditEntry" TO runtime_log088')
def readiness(database,label):
 server=s['name']+'-'+label+'-server';worker=s['name']+'-'+label+'-worker'
 for attempt in range(90):
  health=subprocess.run(['ssh',s['host'],shlex.join(['docker','exec',server,'curl','-fsS','http://localhost:3000/healthz'])],capture_output=True,text=True)
  info=json.loads(ssh(['docker','inspect',worker],capture_output=True,text=True).stdout)[0]
  if not info['State']['Running']:raise RuntimeError('Worker exited: '+label)
  ip=info['NetworkSettings']['Networks'][s['network']]['IPAddress']
  raw=ssh(['docker','exec',s['name']+'-redis','redis-cli','CLIENT','LIST'],capture_output=True,text=True).stdout
  clients=[dict(part.split('=',1) for part in line.split() if '=' in part) for line in raw.splitlines()]
  subscribed=[x for x in clients if x.get('addr','').startswith(ip+':') and x.get('db')==('1' if database==s['freshDatabase'] else '2') and x.get('name','').startswith('bull:') and x.get('cmd') in ('bzpopmin','brpoplpush','blmove')]
  if health.returncode==0 and subscribed:
   print(label+' health200 / actual worker queues: '+str(len(subscribed)),flush=True);return {'health':json.loads(health.stdout),'workerQueueSubscriptions':len(subscribed)}
  time.sleep(1)
 raise RuntimeError('Runtime readiness timeout: '+label)
def runtime(database,label):
 names=[]
 try:
  for role,command in [('server',['node','dist/main.js']),('worker',['node','dist/queue-worker/queue-worker.js'])]:
   name=label+'-'+role;names.append(s['name']+'-'+name);ssh(args(database,name,True)+['-d',image,*command],capture_output=True)
  initial=readiness(database,label)
  for name in names:
   info=json.loads(ssh(['docker','inspect',name],capture_output=True,text=True).stdout)[0];assert info['Config']['Entrypoint']==['/app/omnichannel/entrypoint.sh'] and not info['HostConfig']['PortBindings']
  def stop():
   start=time.monotonic();ssh(['docker','stop',*names],capture_output=True)
   infos=json.loads(ssh(['docker','inspect',*names],capture_output=True,text=True).stdout)
   for item in infos:assert item['State']['ExitCode']==0 and not item['State']['OOMKilled'] and item['Config']['StopTimeout']==360
   return {'seconds':round(time.monotonic()-start,2),'exitCodes':[x['State']['ExitCode'] for x in infos],'oomKilled':False}
  stopped=stop();ssh(['docker','start',*names],capture_output=True);restarted=readiness(database,label);finalStop=stop()
  return {'initial':initial,'firstStop':stopped,'restart':restarted,'finalStop':finalStop}
 finally:
  cleanup_errors=[]
  for name in names:
   assert name.startswith(s['name']+'-'+label+'-')
   try:
    check=subprocess.run(['ssh',s['host'],shlex.join(['docker','inspect',name])],capture_output=True,text=True)
    if check.returncode!=0:
     if 'No such object' in check.stderr:continue
     raise RuntimeError('Could not inspect '+name)
    info=json.loads(check.stdout)[0]
    if info['State']['Running']:ssh(['docker','stop',name],capture_output=True)
    logs=ssh(['docker','logs',name],capture_output=True,text=True);(out/('twenty-log088-'+name.removeprefix(s['name']+'-')+'.log')).write_text(logs.stdout+logs.stderr,encoding='utf-8')
   except Exception as error:cleanup_errors.append(str(error))
  if cleanup_errors:raise RuntimeError('Runtime cleanup unconfirmed: '+repr(cleanup_errors))
if __name__=='__main__':
 mode=sys.argv[1]
 if mode=='old':
  script="const cp=require('child_process');for(const args of [['dist/database/scripts/setup-db.js'],['dist/command/command.js','run-instance-commands','--force','--include-slow'],['dist/command/command.js','workspace:seed:dev','--light']]){const r=cp.spawnSync('node',args,{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}"
  run(s['upgradedDatabase'],'old-upstream-seed',['-e',script],override='marketozk/twenty:log022-candidate',entrypoint='node')
  run(s['upgradedDatabase'],'old-fork-migrate',['migrate'],override='marketozk/twenty:log022-candidate')
  assert sql(s['upgradedDatabase'],'SELECT count(*) FROM core."forkMigrationLedger"')=='2'
  before=fingerprints(s['upgradedDatabase']);assert int(before['upstreamHistory'])>=1
  assert sql(s['upgradedDatabase'],"SELECT count(*) FROM core.workspace WHERE \"activationStatus\"='ACTIVE'")!='0'
  for name in ['company','person','opportunity']:
   matches=[value for key,value in before.items() if key.endswith('.'+name)];assert matches and all(int(value.split(':')[0])>0 for value in matches),(name,matches)
  (out/'twenty-log088-upgrade-before.json').write_text(json.dumps(before,indent=2));print('Two-migration populated old fixture ready',flush=True)
 elif mode=='migrate':
  for label,key in [('fresh','freshDatabase'),('upgraded','upgradedDatabase')]:
   run(s[key],'migrate-'+label,['migrate']);assert sql(s[key],'SELECT count(*) FROM core."forkMigrationLedger"')=='9'
  before=json.loads((out/'twenty-log088-upgrade-before.json').read_text());assert fingerprints(s['upgradedDatabase'])==before
  run(s['upgradedDatabase'],'migrate-replay',['migrate']);assert fingerprints(s['upgradedDatabase'])==before
  sql(s['freshDatabase'],"CREATE ROLE runtime_log088 LOGIN PASSWORD 'isolated-runtime-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT")
  for key in ['freshDatabase','upgradedDatabase']:
   grant(s[key]);run(s[key],'runtime-db-status-'+key,['node','dist/command/command.js','upgrade:status','--strict'],0,True)
  print('Nine migrations, replay and preserved CRM fingerprints: PASS',flush=True)
 elif mode=='runtime':
  result={}
  for label,key in [('fresh','freshDatabase'),('upgraded','upgradedDatabase')]:
   result[label]=runtime(s[key],label);(out/'twenty-log088-runtime.json').write_text(json.dumps(result,indent=2))
 elif mode=='negative':
  database=s['upgradedDatabase'];rows=json.loads(sql(database,'SELECT json_agg(row) FROM (SELECT * FROM core."forkMigrationLedger" ORDER BY "migrationId" DESC LIMIT 1) row'));row=rows[0]
  sql(database,'DELETE FROM core."forkMigrationLedger" WHERE "migrationId"=\''+row['migrationId']+'\'')
  try:
   run(database,'missing-ledger-sentinel',['node','-e',"process.stdout.write('UNEXPECTED_RUNTIME')"],1,True)
   sentinel=(out/'twenty-log088-missing-ledger-sentinel.log').read_text().strip();assert 'Omnichannel message persistence schema does not match its manifest' in sentinel and 'UNEXPECTED_RUNTIME' not in sentinel
   for role,command in [('server',['node','dist/main.js']),('worker',['node','dist/queue-worker/queue-worker.js'])]:run(database,'missing-ledger-'+role,command,1,True);assert (out/('twenty-log088-missing-ledger-'+role+'.log')).read_text().strip()==sentinel
  finally:
   payload=json.dumps(row).replace("'","''");sql(database,'INSERT INTO core."forkMigrationLedger" SELECT * FROM json_populate_record(NULL::core."forkMigrationLedger",\''+payload+'\'::json)')
  sql(database,'ALTER TABLE core."omniAccountBinding" ALTER COLUMN status SET DEFAULT \'active\'')
  try:
   run(database,'schema-drift-sentinel',['node','-e',"process.stdout.write('UNEXPECTED_RUNTIME')"],1,True)
   sentinel=(out/'twenty-log088-schema-drift-sentinel.log').read_text().strip();assert 'Omnichannel conversation schema does not match its manifest' in sentinel and 'UNEXPECTED_RUNTIME' not in sentinel
   run(database,'schema-drift',['node','dist/main.js'],1,True);assert (out/'twenty-log088-schema-drift.log').read_text().strip()==sentinel
  finally:sql(database,'ALTER TABLE core."omniAccountBinding" ALTER COLUMN status SET DEFAULT \'inactive\'')
  run(database,'restored-gate',['node','-e',"process.stdout.write('READY')"],0,True)
  assert 'READY' in (out/'twenty-log088-restored-gate.log').read_text()
  run(database,'owner-role',['node','dist/main.js'],1,True,overrides={'PG_DATABASE_URL':env(database,False)['PG_DATABASE_URL']})
  assert 'append-only privileges' in (out/'twenty-log088-owner-role.log').read_text()
  print('Runtime refuses incomplete ledger/schema/owner role: PASS',flush=True)
