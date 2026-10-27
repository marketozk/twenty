const fs = require('fs');
const path = require('path');
const ts = require('/tools/node_modules/typescript');
const folders = ['src/engine/core-modules/crm-audit', 'src/engine/core-modules/omnichannel-storage', 'src/database/commands/fork-upgrade', 'src/modules/omnichannel', 'test/fork-migration'];
const extraFiles = ['src/engine/trash-cleanup/services/trash-cleanup.service.ts',"src/engine/metadata-modules/connected-account/connected-account-metadata.service.ts","src/engine/metadata-modules/message-channel/message-channel-metadata.service.ts","src/engine/metadata-modules/message-channel/services/application-message-channels.service.ts","src/modules/messaging/common/services/message-channel-sync-status.service.ts","src/modules/messaging/message-import-manager/services/messaging-process-folder-actions.service.ts","src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service.ts","src/modules/messaging/message-import-manager/services/messaging-delete-folder-messages.service.ts","src/modules/messaging/blocklist-manager/jobs/messaging-blocklist-item-delete-messages.job.ts",'src/modules/match-participant/match-participant.service.ts','src/modules/match-participant/participant-target-reconciliation.service.ts','src/engine/metadata-modules/message-channel/services/application-message-ingestion.service.ts',"src/database/commands/fork-upgrade/steps/omni-audit-bootstrap.migration.ts","src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts","src/engine/core-modules/crm-audit/crm-audit-transaction-executor.ts","src/engine/metadata-modules/field-metadata/utils/compute-column-name.util.ts","src/engine/metadata-modules/flat-entity/constant/create-empty-flat-entity-maps.constant.ts","src/engine/twenty-orm/datasource/workspace-data-source.ts","src/engine/twenty-orm/interfaces/workspace-internal-context.interface.ts","src/engine/twenty-orm/table-shape/utils/build-workspace-table-shape.util.ts","src/engine/twenty-orm/types/workspace-transaction-scope.type.ts","src/engine/twenty-orm/utils/build-system-auth-context.util.ts","src/engine/twenty-orm/workspace-orm.manager.ts","src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-enum-manager.service.ts","src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-foreign-key-manager.service.ts","src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-index-manager.service.ts","src/engine/twenty-orm/workspace-schema-manager/services/workspace-schema-table-manager.service.ts","src/engine/workspace-datasource/utils/get-workspace-schema-name.util.ts","src/engine/workspace-manager/twenty-standard-application/utils/field-metadata/build-standard-flat-field-metadata-maps.util.ts","src/engine/workspace-manager/twenty-standard-application/utils/get-standard-object-metadata-related-entity-ids.util.ts","src/engine/workspace-manager/twenty-standard-application/utils/index/build-standard-flat-index-metadata-maps.util.ts","src/engine/workspace-manager/twenty-standard-application/utils/object-metadata/build-standard-flat-object-metadata-maps.util.ts","src/engine/workspace-manager/workspace-migration/utils/compute-postgres-enum-name.util.ts","src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/index/utils/index-action-handler.utils.ts","src/engine/workspace-manager/workspace-migration/workspace-migration-runner/utils/generate-column-definitions.util.ts","src/modules/match-participant/match-participant.service.ts","src/modules/messaging/common/enums/message-direction.enum.ts","src/modules/messaging/common/standard-objects/message-participant.workspace-entity.ts","src/modules/messaging/message-import-manager/services/messaging-message.service.ts","src/modules/messaging/message-import-manager/types/message.type.ts","src/modules/messaging/message-participant-manager/services/messaging-message-participant.service.ts","src/modules/omnichannel/services/with-omni-repository-options.ts",'src/engine/twenty-orm/datasource/workspace-data-source.ts', 'src/engine/twenty-orm/workspace-orm.manager.ts', 'src/engine/twenty-orm/datasource/utils/__tests__/run-in-rollback-safe-transaction.util.spec.ts', 'src/engine/twenty-orm/datasource/__tests__/workspace-data-source-transaction.spec.ts'];
function check(root) {
  const files = [...new Set([...folders.flatMap(folder => fs.readdirSync(root+'/'+folder,{recursive:true}).filter(x=>x.endsWith('.ts')).map(x=>root+'/'+folder+'/'+x)), ...extraFiles.map(x=>root+'/'+x).filter(x=>fs.existsSync(x))])];
  const config = {compilerOptions:{strict:true,strictPropertyInitialization:false,noEmit:true,skipLibCheck:true,target:'ES2022',module:'commonjs',moduleResolution:'node',esModuleInterop:true,resolveJsonModule:true,experimentalDecorators:true,emitDecoratorMetadata:true,baseUrl:root+'/src',paths:{'lodash.chunk':['/type-tools/node_modules/@types/lodash.chunk'],'lodash':['/type-tools/node_modules/@types/lodash'],'src/*':['*'],'test/*':['../test/*'],'typeorm':['/app/node_modules/typeorm'],'class-validator':['/app/node_modules/class-validator'],'zod':['/app/node_modules/zod'],'twenty-shared/*':['/app/packages/twenty-shared/dist/*'],'pg':['/type-tools/node_modules/@types/pg'],'*':['/app/node_modules/*','/type-tools/node_modules/@types/*']},typeRoots:['/tools/node_modules/@types','/type-tools/node_modules/@types','/app/node_modules/@types'],types:['node','jest']},files};
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program).map(d=>({file:d.file?path.relative(root,d.file.fileName):null,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n'),line:d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start).line+1:null}));
  return {rootFiles:files.length,diagnostics};
}
console.log('Checking baseline');
const baseline = check('/baseline/packages/twenty-server');
console.log('Baseline complete',baseline.rootFiles,baseline.diagnostics.length);
if (global.gc) global.gc();
console.log('Checking current');
const current = check('/source/packages/twenty-server');
const key = d=>JSON.stringify([d.file,d.code,d.message]);
const old = new Set(baseline.diagnostics.map(key));
const wordingChanges = current.diagnostics.filter(d=>!old.has(key(d)) && baseline.diagnostics.some(b=>b.file===d.file&&b.code===d.code&&b.line===d.line) && d.file && fs.readFileSync('/source/packages/twenty-server/'+d.file,'utf8')===fs.readFileSync('/baseline/packages/twenty-server/'+d.file,'utf8'));
const added = current.diagnostics.filter(d=>!old.has(key(d))&&!wordingChanges.includes(d));
const changed = JSON.parse(fs.readFileSync('/out/changed-source-files.json','utf8')).map(f=>f.replace(/^packages\/twenty-server\//,''));
const changedFileDiagnostics = current.diagnostics.filter(d=>changed.includes(d.file));
const baselineOnlyUnchangedMethodDiagnostics = changedFileDiagnostics.filter(d => {
  if (!old.has(key(d)) || !d.file || !d.line) return false;
  const enclosingMethod = (root, line) => {
    const filename=root+'/'+d.file;
    const source=ts.createSourceFile(filename,fs.readFileSync(filename,'utf8'),ts.ScriptTarget.Latest,true);
    let found=null;
    function visit(node) {
      if (ts.isMethodDeclaration(node) && node.name && source.getLineAndCharacterOfPosition(node.getStart(source)).line+1<=line && source.getLineAndCharacterOfPosition(node.end).line+1>=line) found={name:node.name.getText(source),text:node.getText(source)};
      ts.forEachChild(node,visit);
    }
    visit(source);return found;
  };
  const currentMethod=enclosingMethod('/source/packages/twenty-server',d.line);
  return currentMethod && baseline.diagnostics.some(b=>key(b)===key(d) && b.line && (()=>{const before=enclosingMethod('/baseline/packages/twenty-server',b.line);return before && before.name===currentMethod.name && before.text===currentMethod.text;})());
});
const changedCodeDiagnostics = changedFileDiagnostics.filter(d=>!baselineOnlyUnchangedMethodDiagnostics.includes(d));

const report = {baselineRootFiles:baseline.rootFiles,currentRootFiles:current.rootFiles,baselineDiagnostics:baseline.diagnostics,currentDiagnostics:current.diagnostics,unchangedSourceDiagnosticWordingChanges:wordingChanges,newDiagnostics:added,changedFileDiagnostics,baselineOnlyUnchangedMethodDiagnostics,changedCodeDiagnostics,status:added.length===0&&changedCodeDiagnostics.length===0?'pass-no-new-diagnostics':'fail',fullServerTypecheck:false};
fs.writeFileSync('/out/typecheck-differential.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,baselineDiagnostics:baseline.diagnostics.length,currentDiagnostics:current.diagnostics.length,newDiagnostics:added,changedFileDiagnostics,baselineOnlyUnchangedMethodDiagnostics,changedCodeDiagnostics,currentRootFiles:current.rootFiles}));
if(report.status!=='pass-no-new-diagnostics')process.exitCode=1;
