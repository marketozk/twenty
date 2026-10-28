import os,runpy,json,subprocess,shlex
from pathlib import Path
t=Path(os.environ['TEMP']);m=runpy.run_path(str(t/'twenty-log091-run.py'));s=m['state']()
raw=subprocess.check_output(['git','status','--porcelain','-uall'],cwd=m['ROOT']).decode()
paths=[x[3:] for x in raw.splitlines() if x[3:].startswith('packages/')]
(t/'twenty-log091-changed-source-files.json').write_text(json.dumps(paths))
cmd=['docker','run','--rm','--user','0:0','--network',s['network'],'--memory','6g','--cpus','2','-v',s['source']+':/source:ro','-v',s['remote']+'/baseline091:/baseline:ro','-v',s['tools']+':/tools:ro','-v',s['remote']+'/out:/out:rw','-v','/opt/twenty-tests/twenty-rob764-3f5fc8d7b68e4cda/type-tools:/type-tools:ro','--entrypoint','node','marketozk/twenty:log088-server-fixed','--expose-gc','--max-old-space-size=4608','/out/typecheck091-diff.cjs']
req={'out':s['remote']+'/out','source':(t/'twenty-log091-typecheck-diff.cjs').read_text(),'paths':paths,'command':cmd}
code='''import sys,json,pathlib,subprocess
r=json.load(sys.stdin);out=pathlib.Path(r['out']).resolve();assert str(out).startswith('/opt/twenty-tests/twenty-rob764-') and out.name=='out'
(out/'typecheck091-diff.cjs').write_text(r['source']);(out/'changed-source-files.json').write_text(json.dumps(r['paths']))
raise SystemExit(subprocess.run(r['command']).returncode)
'''
result=subprocess.run(['ssh',m['HOST'],shlex.join(['python3','-c',code])],input=json.dumps(req).encode())
raise SystemExit(result.returncode)
