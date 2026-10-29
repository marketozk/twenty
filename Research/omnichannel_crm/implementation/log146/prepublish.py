from pathlib import Path
import hashlib,json,re,subprocess
root=Path.cwd()
evidence=root/'Research/omnichannel_crm/implementation/log146'
snapshot=json.loads((evidence/'source-snapshot.json').read_text(encoding='utf-8'))
for name,digest in snapshot['lfSha256'].items():
    if digest is None:
        assert not (root/name).exists(),name
        continue
    content=(root/name).read_bytes().replace(b'\r\n',b'\n')
    assert hashlib.sha256(content).hexdigest()==digest, name
files=subprocess.check_output(['git','diff','--name-only','-z']).decode().split('\0')
files+=subprocess.check_output(['git','ls-files','--others','--exclude-standard','-z']).decode().split('\0')
files=sorted(set(filter(None,files)))
broken=[];sensitive=[]
for name in files:
    p=root/name
    if not p.exists():continue
    text=p.read_text(encoding='utf-8')
    for pattern in [r'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----',r'gh[pousr]_[A-Za-z0-9]{30,}',r'lin_api_[A-Za-z0-9]{20,}',r'sk-(?:proj-)?[A-Za-z0-9_-]{40,}']:
        if re.search(pattern,text):sensitive.append(name)
    if p.suffix!='.md':continue
    for match in re.finditer(r'\[[^\]]*\]\(([^\n]+?)\)',text):
        link=match.group(1).strip().strip('<>')
        if re.match(r'^[a-zA-Z][\w+.-]*:',link) or link.startswith('#'):continue
        target=link.split('#',1)[0]
        if target and not (p.parent/target).exists():broken.append((name,target))
assert not sensitive, sensitive
assert not broken, broken
subprocess.run(['git','diff','--check'],check=True)
print(json.dumps({'changedFiles':len(files),'verifiedSourceHashes':len(snapshot['lfSha256']),'brokenLocalMarkdownLinks':broken,'secretPatternHits':sensitive}))
