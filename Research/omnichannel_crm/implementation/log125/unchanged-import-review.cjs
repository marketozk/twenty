const fs=require('fs');const ts=require('/tools/node_modules/typescript');
const r=JSON.parse(fs.readFileSync('/out/typecheck-differential.json','utf8'));
const key=d=>JSON.stringify([d.file,d.code,d.message]);
function importAt(root,d) {
 const filename=root+'/packages/twenty-server/'+d.file;
 const source=ts.createSourceFile(filename,fs.readFileSync(filename,'utf8'),ts.ScriptTarget.Latest,true);
 return source.statements.filter(ts.isImportDeclaration).find(n=>
  source.getLineAndCharacterOfPosition(n.getStart(source)).line+1<=d.line &&
  source.getLineAndCharacterOfPosition(n.end).line+1>=d.line)?.getText(source);
}
r.baselineOnlyUnchangedImportDiagnostics=r.changedCodeDiagnostics.filter(d=>{
 if(d.code!==7016)return false;
 const after=importAt('/source',d);return after && r.baselineDiagnostics.some(b=>key(b)===key(d)&&importAt('/baseline',b)===after);
});
r.changedCodeDiagnostics=r.changedCodeDiagnostics.filter(d=>!r.baselineOnlyUnchangedImportDiagnostics.includes(d));
r.status=r.newDiagnostics.length===0&&r.changedCodeDiagnostics.length===0?'pass-no-new-diagnostics':'fail';
fs.writeFileSync('/out/typecheck-differential.json',JSON.stringify(r,null,2));
console.log(JSON.stringify({status:r.status,baselineRootFiles:r.baselineRootFiles,currentRootFiles:r.currentRootFiles,baselineDiagnostics:r.baselineDiagnostics.length,currentDiagnostics:r.currentDiagnostics.length,newDiagnostics:r.newDiagnostics.length,unchangedImportDiagnostics:r.baselineOnlyUnchangedImportDiagnostics.length,unchangedMethodDiagnostics:r.baselineOnlyUnchangedMethodDiagnostics.length,changedCodeDiagnostics:r.changedCodeDiagnostics}));
if(r.status!=='pass-no-new-diagnostics')process.exitCode=1;
