const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=process.cwd(),source='/source/packages/twenty-server/src';
fs.mkdirSync('src/database/commands/upgrade-version-command/2-52',{recursive:true});
fs.copyFileSync(source+'/database/commands/upgrade-version-command/instance-commands.constant.ts','src/database/commands/upgrade-version-command/instance-commands.constant.ts');
function generate(name){const r=cp.spawnSync('node',['dist/command/command.js','generate:instance-command','--name',name,'--type','fast'],{encoding:'utf8',maxBuffer:40*1024*1024});fs.writeFileSync('/out/'+name+'.log',r.stdout+r.stderr);if(r.status!==0)throw new Error('generator failed: '+name+' '+r.stderr.slice(-700));}
generate('upstream-baseline-check');
if(!fs.readFileSync('/out/upstream-baseline-check.log','utf8').includes('No changes in database schema'))throw new Error('Nonempty baseline diff; stop');
const swc=require('/tools/node_modules/@swc/core');
const dir=source+'/engine/core-modules/omnichannel-storage/entities';
for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.ts'))){const dest=root+'/dist/engine/core-modules/omnichannel-storage/entities/'+name.slice(0,-3)+'.js';fs.mkdirSync(path.dirname(dest),{recursive:true});const result=swc.transformSync(fs.readFileSync(dir+'/'+name,'utf8'),{filename:dest,jsc:{parser:{syntax:'typescript',decorators:true},transform:{legacyDecorator:true,decoratorMetadata:true},target:'es2020',baseUrl:root+'/dist',paths:{'src/*':['./*']}},module:{type:'commonjs'}});fs.writeFileSync(dest,result.code);}
generate('omni-conversation-foundation');
const generated=fs.readdirSync('src/database/commands/upgrade-version-command/2-52').filter(n=>n.includes('omni-conversation-foundation'));
if(generated.length!==1)throw new Error('Expected exactly one generated command');
fs.copyFileSync('src/database/commands/upgrade-version-command/2-52/'+generated[0],'/out/'+generated[0]);
console.log(JSON.stringify({baseline:'empty',generated:generated[0]}));