from pathlib import Path
import os,json,subprocess,shlex,runpy
p=Path(os.environ['TEMP']);m=runpy.run_path(str(p/'twenty-log088-smoke.py'));s=m['s'];ssh=m['ssh']
info=json.loads(ssh(['docker','image','inspect',s['image']],capture_output=True,text=True).stdout)[0]
assert info['Config']['Labels']['org.opencontainers.image.revision']==s['sourceCommit'];assert info['Config']['Entrypoint']==['/app/omnichannel/entrypoint.sh']
code="const a=require('twenty-shared/application-runtime');if(a.TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER!=='20202020-64aa-4b6f-b003-9c74b97cee20'||a.STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person!=='20202020-e674-48e5-a542-72570eee7213')throw Error('Bad constants');const fs=require('fs'),crypto=require('crypto');const paths=['dist/main.js','dist/queue-worker/queue-worker.js','dist/modules/omnichannel/services/destroy-omni-crm-parent.js','dist/database/commands/fork-upgrade/fork-upgrade.cli.js','dist/engine/core-modules/omnichannel-storage/migrations/fork-schema-manifest.json'];const hashes=Object.fromEntries(paths.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));const manifest=JSON.parse(fs.readFileSync(paths[4]));if(manifest.length!==9)throw Error('Bad manifest');const types=fs.readFileSync('/app/packages/twenty-shared/dist/application-runtime/index.d.ts','utf8');for(const key of ['TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER','STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS'])if(!types.includes(key))throw Error('Missing declared export');console.log(JSON.stringify({cjsExports:true,typeExports:true,migrationCount:manifest.length,hashes}));"
base=['docker','run','--rm','--network','none','--memory','128m','--cpus','1','--entrypoint','node',s['image']]
a=json.loads(ssh(base+['-e',code],capture_output=True,text=True).stdout)
esm="import {TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER as a,STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS as b} from 'twenty-shared/application-runtime'; if(a!=='20202020-64aa-4b6f-b003-9c74b97cee20'||b.person!=='20202020-e674-48e5-a542-72570eee7213')throw Error('Bad constants');console.log('ESM PASS');"
assert ssh(base+['--input-type=module','-e',esm],capture_output=True,text=True).stdout.strip()=='ESM PASS';a['esmExports']=True;a['image']=info['Id'];a['sourceCommit']=s['sourceCommit'];(p/'twenty-log088-fixed-assets.json').write_text(json.dumps(a,indent=2));print(json.dumps(a))
# Only the explicitly-created failed fresh fixture is reset; the populated old fixture is retained.
assert s['freshDatabase']=='twenty_rob764_test_9c6efcb22b2b48db';assert s['name']=='twenty-rob764-runtime-0f04670661f04e63'
assert m['sql'](s['freshDatabase'],"SELECT to_regclass('core.\"forkMigrationLedger\"') IS NULL")=='t'
ssh(['docker','exec',s['name']+'-db','dropdb','-U','test_owner',s['freshDatabase']]);ssh(['docker','exec',s['name']+'-db','createdb','-U','test_owner',s['freshDatabase']])
print('Only failed fresh test fixture reset; old populated fixture retained')
