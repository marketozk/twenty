from pathlib import Path
import os,json,subprocess,shlex
p=Path(os.environ['TEMP']);s=json.loads((p/'twenty-log088-state.json').read_text());t=json.loads((p/'twenty-log088-fix-state.json').read_text())
command=['docker','run','--rm','--user','0:0','--network',t['network'],'--memory','3g','--cpus','2','-v',s['source']+':/source:ro','-v',t['tools']+':/tools:ro','-v',t['remote']+'/out:/out:rw','-e','NODE_PATH=/out/tools/node_modules:/tools/node_modules:/app/node_modules','-e','FORK_MIGRATION_TEST_URL=postgres://test_owner:isolated-test-only@postgres/'+t['database'],'--entrypoint','node',s['image'],'/tools/node_modules/jest/bin/jest.js','--config','/source/packages/twenty-server/jest-fork-migration.config.mjs','--runInBand']
with (p/'twenty-log088-full.log').open('w',encoding='utf-8') as log:
 r=subprocess.run(['ssh',s['host'],shlex.join(command)],stdout=log,stderr=subprocess.STDOUT)
raise SystemExit(r.returncode)
