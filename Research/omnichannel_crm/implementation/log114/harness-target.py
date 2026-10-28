import os,runpy,sys
from pathlib import Path
m=runpy.run_path(str(Path(os.environ['TEMP'])/'twenty-log114-run.py'))
s=m['state']()
pattern=sys.argv[1] if len(sys.argv)>1 else 'omni-human-command-recovery|crm-audit-human-command-recovery|omni-human-command-lease|omni-connector-acceptance|omni-sent-apply|omni-human-text-command'
m['node'](['/tools/node_modules/jest/bin/jest.js','--config','/source/packages/twenty-server/jest-fork-migration.config.mjs','--runInBand','--testPathPattern='+pattern],{'FORK_MIGRATION_TEST_URL':'postgres://test_owner:isolated-test-only@postgres/'+s['database']})
