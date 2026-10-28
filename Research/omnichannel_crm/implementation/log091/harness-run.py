import json,os,pathlib,subprocess,shlex,tarfile,uuid,sys,io
ROOT=pathlib.Path(r'C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM');TMP=pathlib.Path(os.environ['TEMP']);HOST='root@176.114.84.194';STATE_FILE=TMP/'twenty-log091-state.json'
def call(args,**kw):return subprocess.run(args,check=True,**kw)
def ssh(args,**kw):return call(['ssh',HOST,shlex.join(args)],**kw)
def state():return json.loads(STATE_FILE.read_text())
def upload():
 s=state();raw=call(['git','status','--porcelain','-uall'],cwd=ROOT,capture_output=True,text=True,encoding='utf-8').stdout
 paths=[line[3:] for line in raw.splitlines() if line[3:].startswith(('packages/','ops/','scripts/')) and (ROOT/line[3:]).is_file()]
 with tarfile.open(TMP/'twenty-log091-overlay.tar','w') as t:
  for p in paths:
   data=(ROOT/p).read_bytes().replace(b'\r\n',b'\n');info=tarfile.TarInfo(p);info.size=len(data);info.mode=0o644;t.addfile(info,io.BytesIO(data))
 call(['scp',str(TMP/'twenty-log091-overlay.tar'),HOST+':'+s['remote']+'/overlay.tar']);ssh(['tar','-xf',s['remote']+'/overlay.tar','-C',s['source']]);return paths
def node(args,env=None,rw=False):
 s=state();cmd=['docker','run','--rm','--user','0:0','--network',s['network'],'--memory','3g','--cpus','2','-v',s['source']+':/source:'+('rw' if rw else 'ro'),'-v',s['tools']+':/tools:ro','-v',s['remote']+'/out:/out:rw','-e','NODE_PATH=/out/tools/node_modules:/tools/node_modules:/app/node_modules']
 for k,v in (env or {}).items():cmd+=['-e',k+'='+v]
 return ssh(cmd+['--entrypoint','node','marketozk/twenty:log088-server-fixed',*args])
def native_env():
 s=state();return dict(PG_DATABASE_URL='postgres://test_owner:isolated-test-only@postgres/'+s['nativeDatabase'],REDIS_URL='redis://redis:6379',APP_SECRET='isolated-test-only-not-production',SERVER_URL='http://server:3000',IS_BILLING_ENABLED='false',NODE_ENV='production',DISABLE_DB_MIGRATIONS='false',DISABLE_CRON_JOBS_REGISTRATION='true',STORAGE_TYPE='local')
if __name__=='__main__':
 mode=sys.argv[1]
 if mode=='setup':
  assert not STATE_FILE.exists();suffix=uuid.uuid4().hex[:16];name='twenty-rob764-'+suffix;remote='/opt/twenty-tests/'+name
  s=dict(name=name,remote=remote,source=remote+'/source',database='twenty_rob764_test_'+suffix,nativeDatabase='twenty_rob764_test_'+uuid.uuid4().hex[:16],network=name+'-net',tools='/opt/twenty-tests/twenty-rob764-e9f2b662ed54420d/tools')
  STATE_FILE.write_text(json.dumps(s));ssh(['mkdir','-p',s['source'],remote+'/out']);ssh(['cp','-a','/opt/twenty-tests/twenty-rob764-7e7bfe25e5a440c8/source/.',s['source']])
  ssh(['docker','network','create','--internal',s['network']]);ssh(['docker','run','-d','--name',name+'-db','--network',s['network'],'--network-alias','postgres','--memory','1g','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw,size=1g','-e','POSTGRES_USER=test_owner','-e','POSTGRES_PASSWORD=isolated-test-only','-e','POSTGRES_DB='+s['database'],'postgres:17-alpine'])
  ssh(['docker','run','-d','--name',name+'-redis','--network',s['network'],'--network-alias','redis','--memory','128m','--cpus','1','redis:7.4-alpine','redis-server','--save','','--appendonly','no'])
  ssh(['docker','exec',name+'-db','createdb','-U','test_owner',s['nativeDatabase']]);print(json.dumps(s))
 elif mode=='upload':upload()
 elif mode=='native':node(['dist/database/commands/fork-upgrade/fork-migrator.cli.js'],native_env())
 elif mode=='pg':
  s=state();node(['/tools/node_modules/jest/bin/jest.js','--config','/source/packages/twenty-server/jest-fork-migration.config.mjs','--runInBand'],{'FORK_MIGRATION_TEST_URL':'postgres://test_owner:isolated-test-only@postgres/'+s['database']})
 elif mode=='format':
  s=state();files=[x for x in upload() if x.endswith(('.ts','.yaml'))];node(['/tools/node_modules/prettier/bin/prettier.cjs','--write','--single-quote','--trailing-comma','all','--end-of-line','lf',*['/source/'+x for x in files]],rw=True)
  ssh(['tar','-cf',s['remote']+'/formatted.tar','-C',s['source'],*files]);call(['scp',HOST+':'+s['remote']+'/formatted.tar',str(TMP/'twenty-log091-formatted.tar')])
  with tarfile.open(TMP/'twenty-log091-formatted.tar') as t:
   for m in t.getmembers():assert m.name in files;(ROOT/m.name).write_bytes(t.extractfile(m).read())
