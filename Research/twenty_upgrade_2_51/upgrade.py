import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.request


ROOT = Path('/opt/twenty-demo')
OLD_IMAGE = 'twentycrm/twenty:v2.50.0'
NEW_IMAGE = 'twentycrm/twenty:v2.51.0'
COMPOSE_SHA = '17497f2922b727dce61974293a51951072272f52227566dfd48774555448cb8a'
ENV_SHA = '5fbb1f497de3e48b9bc936ab567c54a67b67cb7adfc42244d919702e30e4a87b'
COMPOSE = ['docker', 'compose', '--project-directory', str(ROOT)]
DB = ['docker', 'exec', 'twenty-demo-db-1', 'psql', '-X', '-U', 'postgres', '-d', 'twenty', '-Atc']
APP_NAMES = ['twenty-demo-server-1', 'twenty-demo-worker-1']


def read(args, timeout=90):
    return subprocess.check_output(args, text=True, timeout=timeout)


def logged(args, destination, timeout=900):
    with destination.open('wb') as output:
        result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Command failed ({result.returncode}); inspect {destination}')


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def inventory():
    containers = json.loads(read(['docker', 'inspect'] + read(['docker', 'ps', '-q']).split()))
    return {c['Name']: c['Id'] for c in containers
            if c['Config']['Labels'].get('com.docker.compose.project') != 'twenty-demo'}


def snapshot():
    tables = read(DB + ["SELECT table_schema,table_name FROM information_schema.tables "
                        "WHERE table_schema LIKE 'workspace_%' AND table_type='BASE TABLE' "
                        "AND table_name IN ('person','company','note','task','opportunity','tender') "
                        "ORDER BY table_schema,table_name;"])
    result = {}
    for line in tables.splitlines():
        schema, table = line.split('|')
        quoted = '.'.join('"' + part.replace('"', '""') + '"' for part in (schema, table))
        result[f'{schema}.{table}'] = read(DB + [
            "SELECT count(*),md5(coalesce(string_agg(id::text,',' ORDER BY id),'')) FROM " + quoted
        ]).strip()
    if len(result) < 5:
        raise RuntimeError('Expected CRM tables not found')
    return result


def main():
    os.umask(0o077)
    with (ROOT / '.upgrade-2-51.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if digest(ROOT / 'docker-compose.yml') != COMPOSE_SHA or digest(ROOT / '.env') != ENV_SHA:
            raise RuntimeError('Configuration changed since preflight')
        config = json.loads(read(COMPOSE + ['config', '--format', 'json']))
        if config['services']['server']['image'] != OLD_IMAGE or config['services']['worker']['image'] != OLD_IMAGE:
            raise RuntimeError('Unexpected source version')
        containers = json.loads(read(['docker', 'inspect'] + APP_NAMES))
        if any(c['Config']['Image'] != OLD_IMAGE or not c['State']['Running'] for c in containers):
            raise RuntimeError('Unexpected running containers')
        target_image = json.loads(read(['docker', 'image', 'inspect', NEW_IMAGE]))[0]
        if NEW_IMAGE not in target_image['RepoTags']:
            raise RuntimeError('Target image missing')
        if shutil.disk_usage(ROOT).free < 2 * 1024**3:
            raise RuntimeError('Insufficient backup space')
        volume = json.loads(read(['docker', 'volume', 'inspect', 'twenty-demo_server-local-data']))[0]
        storage = Path(volume['Mountpoint'])
        if not storage.is_dir() or storage.name != '_data':
            raise RuntimeError('Unexpected storage mount')
        others = inventory()
        backup = ROOT / 'backups' / ('before-2.51.0-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        backup.mkdir(mode=0o700)
        print('BACKUP', backup, flush=True)
        for name in ['.env', 'docker-compose.yml']:
            shutil.copy2(ROOT / name, backup / name)
            (backup / name).chmod(0o600)
        (backup / 'images.json').write_text(json.dumps({
            'old': [{'name': c['Name'], 'imageId': c['Image']} for c in containers],
            'newImageId': target_image['Id'], 'newRepoDigests': target_image['RepoDigests'],
            'unrelatedContainers': others,
        }, indent=2))
        changed = False
        try:
            logged(COMPOSE + ['stop', '-t', '60', 'worker', 'server'], backup / 'stop.log')
            before = snapshot()
            (backup / 'records-before.json').write_text(json.dumps(before, indent=2))
            with (backup / 'twenty.dump').open('wb') as output:
                subprocess.run(['docker', 'exec', 'twenty-demo-db-1', 'pg_dump', '-U', 'postgres', '-Fc', 'twenty'],
                               stdout=output, check=True, timeout=180)
            with (backup / 'twenty.dump').open('rb') as source, (backup / 'dump-list.txt').open('wb') as output:
                subprocess.run(['docker', 'exec', '-i', 'twenty-demo-db-1', 'pg_restore', '--list'],
                               stdin=source, stdout=output, check=True, timeout=90)
            if (backup / 'twenty.dump').stat().st_size < 10000:
                raise RuntimeError('Database dump unexpectedly small')
            logged(['tar', '-czf', str(backup / 'local-storage.tar.gz'), '-C', str(storage), '.'], backup / 'tar.log')
            logged(['tar', '-tzf', str(backup / 'local-storage.tar.gz')], backup / 'storage-list.txt')
            logged(['docker', 'exec', 'twenty-demo-redis-1', 'redis-cli', 'SAVE'], backup / 'redis-save.log')
            logged(['docker', 'cp', 'twenty-demo-redis-1:/data/dump.rdb', str(backup / 'redis.rdb')], backup / 'redis-copy.log')
            hashes = {name: digest(backup / name) for name in ['twenty.dump', 'local-storage.tar.gz', 'redis.rdb', '.env', 'docker-compose.yml']}
            (backup / 'sha256.json').write_text(json.dumps(hashes, indent=2))
            print('BACKUP_VERIFIED', len(before), 'CRM tables; dump/storage readable', flush=True)
            original = (ROOT / '.env').read_text()
            updated, count = re.subn(r'^TAG=v2\.50\.0$', 'TAG=v2.51.0', original, flags=re.MULTILINE)
            if count != 1 or digest(ROOT / '.env') != ENV_SHA:
                raise RuntimeError('TAG or environment changed')
            temporary = ROOT / '.env.upgrade-2-51'
            temporary.write_text(updated)
            temporary.chmod(0o600)
            temporary.replace(ROOT / '.env')
            changed = True
            logged(COMPOSE + ['config', '--quiet'], backup / 'compose-validation.log')
            logged(COMPOSE + ['up', '-d', '--no-deps', '--pull', 'never', 'server'], backup / 'server-start.log')
            print('SERVER_STARTING', flush=True)
            deadline = time.monotonic() + 900
            while time.monotonic() < deadline:
                state = json.loads(read(['docker', 'inspect', 'twenty-demo-server-1']))[0]['State']
                if state.get('Health', {}).get('Status') == 'healthy':
                    break
                time.sleep(5)
            else:
                raise RuntimeError('Server health timeout; inspect migration logs')
            logged(['docker', 'exec', 'twenty-demo-server-1', 'yarn', 'command:prod',
                    'upgrade:2-51:migrate-rich-text-to-tiptap'], backup / 'rich-text-migration.log')
            logged(['docker', 'exec', 'twenty-demo-server-1', 'yarn', 'command:prod', 'upgrade:status'], backup / 'upgrade-status.log')
            status = re.sub(r'\x1b\[[0-9;]*m', '', (backup / 'upgrade-status.log').read_text())
            status = status[status.index('APP_VERSION:'):]
            if 'APP_VERSION: v2.51.0' not in status or 'Instance: Up to date' not in status or '0 behind, 0 failed' not in status:
                raise RuntimeError('Upgrade is not fully current; inspect upgrade-status.log')
            after = snapshot()
            (backup / 'records-after.json').write_text(json.dumps(after, indent=2))
            if before != after:
                raise RuntimeError('CRM record counts or ID sets changed; review before starting worker')
            logged(COMPOSE + ['up', '-d', '--no-deps', '--pull', 'never', 'worker'], backup / 'worker-start.log')
            with urllib.request.urlopen('http://127.0.0.1:2020/healthz', timeout=15) as response:
                if response.status != 200:
                    raise RuntimeError('Health endpoint failed')
            if others != inventory():
                raise RuntimeError('Unrelated container inventory changed; investigate')
            summary = {'status': 'upgraded', 'version': '2.51.0', 'backup': str(backup),
                       'imageId': target_image['Id'], 'repoDigests': target_image['RepoDigests'],
                       'verifiedCrmTables': len(before), 'recordCountsAndIdsUnchanged': True,
                       'unrelatedContainersUnchanged': True}
            (backup / 'result.json').write_text(json.dumps(summary, indent=2))
            print(json.dumps(summary), flush=True)
            print(status.split('Summary')[0][-900:], flush=True)
        except Exception:
            if not changed:
                logged(COMPOSE + ['up', '-d', '--no-deps', 'server', 'worker'], backup / 'resume-old.log')
            print('FAILED; backup and logs:', backup, 'version_changed:', changed, flush=True)
            raise


if __name__ == '__main__':
    main()
