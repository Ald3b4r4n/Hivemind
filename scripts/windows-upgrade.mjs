import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { connect } from '../dist/bridge.js';
import { git } from '../dist/git.js';
import { secret } from '../dist/config.js';

assert.equal(process.platform, 'win32');
const npm = process.env.npm_execpath;
assert(npm, 'Execute via npm run test:upgrade -- <pacote-candidato>.');
const candidate = resolve(process.argv[2]);
assert(existsSync(candidate));
const previous = 'https://github.com/Ald3b4r4n/Hivemind/releases/download/v0.1.0-preview.1/hivemind-orchestrator-0.1.0-preview.1.tgz';
const root = mkdtempSync(join(tmpdir(), 'hivemind-upgrade-'));
const prefix = join(root, 'npm global');
const home = join(root, 'state with spaces');
const repo = join(root, 'repository');
const entry = join(prefix, 'node_modules', 'hivemind-orchestrator', 'dist', 'cli.js');
const env = { ...process.env, HIVEMIND_HOME: home };
const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = prefix + delimiter + env[pathKey];

function run(file, args) {
  const result = spawnSync(file, args, { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 90_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}
function install(spec) {
  run(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', spec]);
  assert(existsSync(join(prefix, 'hivemind.cmd')));
}
function shim(...args) {
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'hivemind.cmd', ...args]);
}
async function call(client, name, args) {
  const result = await client.callTool({ name: 'hivemind_' + name, arguments: args });
  assert(!result.isError, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}
async function withService(port, expectedVersion, action) {
  const child = spawn(process.execPath, [entry, 'serve'], { env, cwd: repo, windowsHide: true, stdio: 'ignore' });
  const closed = once(child, 'close');
  let client;
  try {
    for (let attempt = 0; attempt < 150 && !client; attempt++) {
      if (child.exitCode !== null) assert.fail('Serviço encerrou antes da conexão.');
      try { client = await connect(port, secret(home, 'access')); }
      catch { await delay(100); }
    }
    assert(client, 'Serviço não iniciou.');
    assert.equal(client.getServerVersion().version, expectedVersion);
    assert.equal(JSON.parse(shim('status')).service, 'hivemind');
    return await action(client);
  } finally {
    await client?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}

try {
  git(root, 'init', '-b', 'main', repo);
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture');
  const listener = createServer();
  await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const { port } = listener.address();
  await new Promise(done => listener.close(done));
  install(previous);
  const init = JSON.parse(shim('init'));
  writeFileSync(init.config, stringify({
    port, agents: { design: { harness: 'codex', roles: ['architect'] } },
    profiles: { upgrade: { repository: repo, agents: ['design'] } },
  }));
  const installed = JSON.parse(shim('install', 'antigravity', '.'));
  const priorSkill = readFileSync(installed.skill, 'utf8');
  const created = await withService(port, '0.1.0-preview.1', async client => {
    const result = await call(client, 'create_job', { profile: 'upgrade', owner: 'test', objective: 'Upgrade fixture' });
    const auth = { jobId: result.job.id, jobKey: result.jobKey };
    await call(client, 'decompose_job', { ...auth, tasks: [{ id: 'plan', title: 'Plan', instructions: 'Inspect', role: 'architect' }] });
    return auth;
  });
  const priorAccess = secret(home, 'access');
  const priorConfig = readFileSync(init.config, 'utf8');
  install(candidate);
  const updated = JSON.parse(shim('install', 'antigravity', '.'));
  assert.equal(updated.copied, false);
  assert.equal(readFileSync(updated.skill, 'utf8'), priorSkill);
  assert.deepEqual(updated.mcp, installed.mcp);
  assert.equal(secret(home, 'access'), priorAccess);
  assert.equal(readFileSync(init.config, 'utf8'), priorConfig);
  await withService(port, '0.1.0-preview.2', async client => {
    const recovered = await call(client, 'get_job', created);
    assert.equal(recovered.state, 'PLANNED');
    assert.equal(recovered.tasks[0].id, 'plan');
    assert.equal(recovered.tasks[0].state, 'PLANNED');
  });
  console.log('PASS: instalação global preview.1, upgrade preview.2, shim, skill, configuração e job preservados.');
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 4 });
}
