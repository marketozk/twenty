import os,runpy,json
from pathlib import Path
m=runpy.run_path(str(Path(os.environ['TEMP'])/'twenty-log136-run.py'));s=m['state']()
config="""import upstream from '/source/packages/twenty-server/jest.config.mjs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
for(const [,options] of Object.values(upstream.transform)) options.jsc.experimental.plugins[0][0]=require.resolve('@lingui/swc-plugin');
export default {...upstream,rootDir:'/source/packages/twenty-server',setupFilesAfterEnv:['/source/packages/twenty-server/setupTests.ts']};
"""
m['ssh'](['python3','-c','from pathlib import Path;Path('+repr(s['remote']+'/out/log136-unit.config.mjs')+').write_text('+repr(config)+')'])
m['node'](['/tools/node_modules/jest/bin/jest.js','--config','/out/log136-unit.config.mjs','--runInBand','--runTestsByPath','/source/packages/twenty-server/src/engine/metadata-modules/connected-account/utils/__tests__/is-connected-account-usable-by-caller.util.spec.ts','/source/packages/twenty-server/src/modules/messaging/message-outbound-manager/resolvers/__tests__/send-email.resolver.spec.ts'])
