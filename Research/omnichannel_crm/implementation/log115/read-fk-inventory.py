import os,runpy,json
from pathlib import Path
m=runpy.run_path(str(Path(os.environ['TEMP'])/'twenty-log115-run.py')); s=m['state']()
code="""const {Client}=require('pg');
(async()=>{const client=new Client({connectionString:process.env.FORK_MIGRATION_TEST_URL});await client.connect();
try { const result=await client.query(`SELECT p.relname AS parent,n.nspname AS schema,c.relname AS child,f.conname,f.confdeltype,f.confupdtype,
 ARRAY(SELECT a.attname FROM unnest(f.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num ORDER BY k.ord) AS columns,
 ARRAY(SELECT a.attname FROM unnest(f.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=p.oid AND a.attnum=k.num ORDER BY k.ord) AS parentcolumns
 FROM pg_constraint f JOIN pg_class p ON p.oid=f.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE f.contype='f' AND pn.nspname='core' AND p.relname=ANY($1::text[]) ORDER BY p.relname,n.nspname,c.relname,f.conname`,[['userWorkspace','roleTarget','workflow','view','userSession','applicationAuthorization','userApplicationVariableValue','twoFactorAuthenticationMethod','navigationMenuItem']]);console.log(JSON.stringify(result.rows,null,2)); }finally{await client.end();}})().catch(e=>{console.error(e.message);process.exitCode=1});"""
m['node'](['-e',code],{'FORK_MIGRATION_TEST_URL':'postgres://test_owner:isolated-test-only@postgres/'+s['nativeDatabase']})
