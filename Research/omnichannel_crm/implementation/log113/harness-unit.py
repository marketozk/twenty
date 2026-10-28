import os,runpy
from pathlib import Path
m=runpy.run_path(str(Path(os.environ['TEMP'])/'twenty-log113-run.py'))
script='''(async()=>{const {default:config}=await import('/source/packages/twenty-server/jest.config.mjs');config.rootDir='/source/packages/twenty-server';config.testRegex='role-tools\\.spec\\.ts$';for(const entry of Object.values(config.transform)){entry[1].swcrc=false;entry[1].jsc.experimental.plugins[0][0]=require.resolve('@lingui/swc-plugin');} const result=await require('/tools/node_modules/jest').runCLI({config:JSON.stringify(config),runInBand:true,testPathPattern:'role-tools.spec'},[config.rootDir]);process.exitCode=result.results.success?0:1;})();'''
m['node'](['-e',script])
