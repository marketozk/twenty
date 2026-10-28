const fs=require('fs'),path=require('path'),cp=require('child_process'),swc=require('/tools/node_modules/@swc/core');
const root=process.cwd(),source='/source/packages/twenty-server/src';
fs.mkdirSync('src/database/commands/upgrade-version-command/2-52',{recursive:true});
fs.copyFileSync(source+'/database/commands/upgrade-version-command/instance-commands.constant.ts','src/database/commands/upgrade-version-command/instance-commands.constant.ts');
function generate(name){const r=cp.spawnSync('node',['dist/command/command.js','generate:instance-command','--name',name,'--type','fast'],{encoding:'utf8',maxBuffer:40*1024*1024});fs.writeFileSync('/out/'+name+'.log',r.stdout+r.stderr);if(r.status!==0)throw Error('generator failed '+name);}
generate('log090-baseline');
for(const f of fs.readdirSync('src/database/commands/upgrade-version-command/2-52').filter(n=>n.includes('log090-baseline')))fs.copyFileSync('src/database/commands/upgrade-version-command/2-52/'+f,'/out/log090-baseline-generated.ts');
if(!fs.readFileSync('/out/log090-baseline.log','utf8').includes('No changes in database schema'))throw Error('Nonempty baseline schema diff');
const relative='engine/core-modules/crm-audit/entities/crm-audit-entry.entity.ts',dest=root+'/dist/'+relative.slice(0,-3)+'.js';
fs.writeFileSync(dest,swc.transformSync(fs.readFileSync(source+'/'+relative,'utf8'),{filename:dest,jsc:{parser:{syntax:'typescript',decorators:true},transform:{legacyDecorator:true,decoratorMetadata:true},target:'es2020',baseUrl:root+'/dist',paths:{'src/*':['./*']}},module:{type:'commonjs'}}).code);
generate('crm-audit-operation-index');
const files=fs.readdirSync('src/database/commands/upgrade-version-command/2-52').filter(n=>n.includes('crm-audit-operation-index'));if(files.length!==1)throw Error('Expected one generated migration');
fs.copyFileSync('src/database/commands/upgrade-version-command/2-52/'+files[0],'/out/'+files[0]);
console.log(JSON.stringify({baseline:'empty',generated:files[0]}));
