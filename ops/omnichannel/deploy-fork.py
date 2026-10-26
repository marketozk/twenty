"""Deploy the verified local fork image to the existing Twenty instance.

This one-shot operation intentionally makes no backup, per the user's request.
It refuses configuration drift and never resets data or downgrades after migration.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request

ROOT = Path('/opt/twenty-demo')
RESULT = ROOT / 'operations' / 'fork-2.52-44e1449c'
SOURCE_SHA = '44e1449cbba2c8d88b2d35a6b343f42ea9640c4b'
IMAGE = 'marketozk/twenty:2.52-44e1449c'
OLD = 'twentycrm/twenty:v2.51.0'
COMPOSE_SHA = '17497f2922b727dce61974293a51951072272f52227566dfd48774555448cb8a'
ENV_SHA = '15d748942d800d8bdf5a1dd859992c0e225365c7f48202d6fcd09ddf0cad1515'
COMPOSE = ['docker', 'compose', '--project-directory', str(ROOT)]
DB = ['docker', 'exec', 'twenty-demo-db-1', 'psql', '-X', '-U', 'postgres', '-d', 'twenty', '-Atc']


def read(args):
    return subprocess.check_output(args, text=True, timeout=180)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(args, name):
    with (RESULT / name).open('wb') as out:
        result = subprocess.run(args, stdout=out, stderr=subprocess.STDOUT, timeout=1200)
    if result.returncode:
        raise RuntimeError(f'{name} failed; inspect private operation log')


def counts():
    rows = read(DB + ["SELECT table_schema,table_name FROM information_schema.tables "
                     "WHERE table_schema LIKE 'workspace_%' AND table_type='BASE TABLE' "
                     "AND table_name IN ('person','company','opportunity','note','task','tender','workflow','workflowVersion') "
                     "ORDER BY table_schema,table_name;"])
    fingerprints = {}
    for row in rows.splitlines():
        schema, table = row.split('|')
        quoted = '.'.join('"' + x.replace('"', '""') + '"' for x in (schema, table))
        fingerprints[f'{schema}.{table}'] = read(DB + [
            "SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),',' ORDER BY id),'')) FROM " + quoted + ' t'
        ]).strip()
    if len(fingerprints) < 5:
        raise RuntimeError('CRM tables missing')
    return fingerprints


def inventory():
    all_containers = json.loads(read(['docker', 'inspect'] + read(['docker', 'ps', '-q']).split()))
    return {x['Name']: x['Id'] for x in all_containers
            if x['Config']['Labels'].get('com.docker.compose.project') != 'twenty-demo'}


def verify_runtime(container, service, config):
    image_config = json.loads(read(['docker', 'image', 'inspect', container['Image']]))[0]['Config']
    actual = container['Config']
    image_env = dict(item.split('=', 1) for item in image_config.get('Env', []))
    expected_env = {**image_env, **{k: str(v) for k, v in service.get('environment', {}).items()}}
    assert dict(item.split('=', 1) for item in actual.get('Env', [])) == expected_env, 'Runtime env drift'
    assert actual['Cmd'] == (service.get('command') if service.get('command') is not None else image_config.get('Cmd'))
    assert actual['Entrypoint'] == (service.get('entrypoint') if service.get('entrypoint') is not None else image_config.get('Entrypoint'))
    assert actual['User'] == service.get('user', image_config.get('User', ''))
    assert actual['WorkingDir'] == service.get('working_dir', image_config.get('WorkingDir', ''))
    expected_mounts = sorted((v['type'], config['volumes'][v['source']]['name'], v['target'], not v.get('read_only', False)) for v in service.get('volumes', []))
    actual_mounts = sorted((v['Type'], v.get('Name', v['Source']), v['Destination'], v['RW']) for v in container['Mounts'])
    assert actual_mounts == expected_mounts, 'Runtime mounts drift'
    host = container['HostConfig']
    expected_ports = {}
    for port in service.get('ports', []):
        expected_ports[f"{port['target']}/{port.get('protocol', 'tcp')}"] = [{'HostIp': port.get('host_ip', ''), 'HostPort': str(port['published'])}]
    assert (host.get('PortBindings') or {}) == expected_ports, 'Runtime ports drift'
    assert host['Memory'] == int(service.get('mem_limit', 0))
    assert host['NanoCpus'] == int(float(service.get('cpus', 0)) * 1_000_000_000)
    assert host['RestartPolicy'] == {'Name': service.get('restart', 'no'), 'MaximumRetryCount': 0}
    assert host['LogConfig'] == {'Type': service['logging']['driver'], 'Config': service['logging'].get('options', {})}
    for runtime_key, compose_key, default in [('Privileged', 'privileged', False), ('ReadonlyRootfs', 'read_only', False), ('CapAdd', 'cap_add', None), ('CapDrop', 'cap_drop', None), ('SecurityOpt', 'security_opt', None), ('Init', 'init', None)]:
        assert host.get(runtime_key) == service.get(compose_key, default), f'Runtime {runtime_key} drift'
    assert host['CpuQuota'] == 0 and host['CpuPeriod'] == 0
    assert set(container['NetworkSettings']['Networks']) == {config['networks'][name]['name'] for name in service['networks']}
    if service.get('healthcheck'):
        check = service['healthcheck']
        expected_health = {'Test': check['test'], 'Interval': int(check['interval'][:-1]) * 1_000_000_000, 'Timeout': int(check['timeout'][:-1]) * 1_000_000_000, 'Retries': check['retries']}
        assert actual.get('Healthcheck') == expected_health


def main():
    os.umask(0o077)
    with (ROOT / '.fork-upgrade.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert digest(ROOT / 'docker-compose.yml') == COMPOSE_SHA, 'Compose drift'
        assert digest(ROOT / '.env') == ENV_SHA, 'Environment drift'
        config = json.loads(read(COMPOSE + ['config', '--format', 'json']))
        assert all(config['services'][x]['image'] == OLD for x in ['server', 'worker'])
        current = json.loads(read(['docker', 'inspect', 'twenty-demo-server-1', 'twenty-demo-worker-1']))
        assert all(x['Config']['Image'] == OLD and x['State']['Running'] for x in current)
        for container, name in zip(current, ['server', 'worker']):
            verify_runtime(container, config['services'][name], config)
        image = json.loads(read(['docker', 'image', 'inspect', IMAGE]))[0]
        assert image['Config']['Labels']['org.opencontainers.image.revision'] == SOURCE_SHA
        assert 'APP_VERSION=v2.52.0' in image['Config']['Env']
        infra = {x: json.loads(read(['docker', 'inspect', 'twenty-demo-' + x + '-1']))[0]['Id'] for x in ['db', 'redis']}
        other = inventory()
        RESULT.mkdir(parents=True, exist_ok=False)
        compose_text = (ROOT / 'docker-compose.yml').read_text()
        assert compose_text.count('image: twentycrm/twenty:${TAG:-latest}') == 2
        compose_text = compose_text.replace('image: twentycrm/twenty:${TAG:-latest}', 'image: marketozk/twenty:${TAG:-latest}')
        env_text, replaced = re.subn(r'^TAG=v2\.51\.0$', 'TAG=2.52-44e1449c', (ROOT / '.env').read_text(), flags=re.MULTILINE)
        assert replaced == 1
        staged_compose = ROOT / 'compose-fork.staged.yml'
        staged_env = ROOT / '.env-fork.staged'
        staged_compose.write_text(compose_text)
        staged_env.write_text(env_text)
        candidate = json.loads(read(['docker', 'compose', '--project-directory', str(ROOT), '--env-file', str(staged_env), '-f', str(staged_compose), 'config', '--format', 'json']))
        expected = json.loads(json.dumps(config))
        for service in ['server', 'worker']:
            expected['services'][service]['image'] = IMAGE
        assert candidate == expected, 'Unexpected changes beyond server/worker image'
        run(COMPOSE + ['stop', '-t', '60', 'worker', 'server'], 'stop.log')
        before = counts()
        staged_compose.replace(ROOT / 'docker-compose.yml')
        staged_env.replace(ROOT / '.env')
        run(COMPOSE + ['up', '-d', '--no-deps', '--pull', 'never', 'server'], 'server-start.log')
        print('SERVER_STARTING', flush=True)
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            state = json.loads(read(['docker', 'inspect', 'twenty-demo-server-1']))[0]['State']
            if state.get('Health', {}).get('Status') == 'healthy':
                break
            time.sleep(5)
        else:
            raise RuntimeError('Server health timeout; do not downgrade migrated data')
        run(['docker', 'exec', 'twenty-demo-server-1', 'yarn', 'command:prod', 'upgrade:status'], 'upgrade-status.log')
        status = re.sub(r'\x1b\[[0-9;]*m', '', (RESULT / 'upgrade-status.log').read_text())
        assert 'APP_VERSION: v2.52.0' in status and 'Instance: Up to date' in status and '0 behind, 0 failed' in status
        after = counts()
        assert before == after, 'CRM content fingerprints changed; worker remains stopped'
        run(COMPOSE + ['up', '-d', '--no-deps', '--pull', 'never', 'worker'], 'worker-start.log')
        with urllib.request.urlopen('http://127.0.0.1:2020/healthz', timeout=15) as response:
            assert response.status == 200
        assert other == inventory(), 'Other containers changed during operation'
        for service, container_id in infra.items():
            assert json.loads(read(['docker', 'inspect', 'twenty-demo-' + service + '-1']))[0]['Id'] == container_id
        apps = json.loads(read(['docker', 'inspect', 'twenty-demo-server-1', 'twenty-demo-worker-1']))
        assert all(x['Image'] == image['Id'] and x['State']['Running'] for x in apps)
        for container, name in zip(apps, ['server', 'worker']):
            verify_runtime(container, candidate['services'][name], candidate)
        summary = {'source': SOURCE_SHA, 'image': IMAGE, 'imageId': image['Id'], 'version': 'v2.52.0',
                   'backupCreated': False, 'crmContentFingerprintsUnchanged': True,
                   'tablesVerified': len(before), 'infraContainersUnchanged': True, 'otherContainersUnchanged': True}
        (RESULT / 'result.json').write_text(json.dumps(summary, indent=2))
        print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
