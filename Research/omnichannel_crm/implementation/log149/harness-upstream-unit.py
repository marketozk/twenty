import os
import runpy
from pathlib import Path

m = runpy.run_path(str(Path(os.environ['TEMP']) / 'twenty-log149-run.py'))
m['call'](['scp', str(Path(os.environ['TEMP']) / 'twenty-log149-upstream-unit.config.mjs'), m['HOST'] + ':' + m['state']()['remote'] + '/out/upstream149.config.mjs'])
m['node']([
    '/tools/node_modules/jest/bin/jest.js',
    '--config', '/out/upstream149.config.mjs',
    '--runInBand',
    '--testPathPattern=send-email.resolver.spec|send-email-tool.spec|send-email.workflow-action.spec|draft-email.workflow-action.spec',
])
