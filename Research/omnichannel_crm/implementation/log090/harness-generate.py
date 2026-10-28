import pathlib,os,runpy
p=pathlib.Path(os.environ['TEMP']);h=runpy.run_path(str(p/'twenty-log090-run.py'));s=h['state']();h['upload']()
h['call'](['scp',str(p/'twenty-log090-generate.cjs'),h['HOST']+':'+s['remote']+'/out/generate090.cjs'])
h['node'](['/out/generate090.cjs'],h['native_env']())
