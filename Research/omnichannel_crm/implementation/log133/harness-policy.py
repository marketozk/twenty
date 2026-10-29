import os,runpy
from pathlib import Path
m=runpy.run_path(str(Path(os.environ['TEMP'])/'twenty-log133-run.py'))
m['node'](['/tools/node_modules/jest/bin/jest.js','--config','/source/packages/twenty-server/jest-fork-migration.config.mjs','--runInBand','--testMatch=**/compute-target-reconciliation-operations.util.spec.ts'])
