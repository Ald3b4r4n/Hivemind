import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { connect } from '../dist/bridge.js';
import { git } from '../dist/git.js';
import { secret } from '../dist/config.js';

const windows = process.platform === 'win32';
const npm = process.env.npm_execpath;
assert(npm && process.argv[2], 'Execute npm run test:package -- <pacote-candidato>.');
const candidate = resolve(process.argv[2]);
assert(existsSync(candidate));
const previous = 'https://github.com/Ald3b4r4n/Hivemind/releases/download/v0.1.0-preview.2/hivemind-orchestrator-0.1.0-preview.2.tgz';
const root = mkdtempSync(join(tmpdir(), 'hivemind P003 package '));
const prefix = join(root, 'npm global');
const home = join(root, 'service state');
const user = join(root, 'isolated user');
const repo = join(root, 'repository');
const bin = windows ? prefix : join(prefix, 'bin');
const modules = windows ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
const entry = join(modules, 'hivemind-orchestrator', 'dist', 'cli.js');
const env = { ...process.env, HIVEMIND_HOME: home, HOME: user, USERPROFILE: user, CODEX_HOME: join(user, '.codex'),
  XDG_CONFIG_HOME: join(user, '.config'), CLAUDE_CONFIG_DIR: join(user, '.claude'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '' };
const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = bin + delimiter + env[pathKey];

function run(file, args) {
  return execFileSync(file, args, { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function install(spec) {
  run(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', spec]);
  assert(existsSync(join(bin, windows ? 'hivemind.cmd' : 'hivemind')));
}
function shim(...args) {
  return windows ? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'hivemind.cmd', ...args])
    : run(join(bin, 'hivemind'), args);
}
async function call(client, name, args) {
  const result = await client.callTool({ name: 'hivemind_' + name, arguments: args });
  assert(!result.isError, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}
async function withService(port, expected, action) {
  const resident = expected === '0.1.0-preview.3';
  const child = resident ? undefined : spawn(process.execPath, [entry, 'serve'], { env, cwd: repo, windowsHide: true, stdio: 'ignore' });
  const closed = child && once(child, 'close');
  let client;
  try {
    if (resident) assert.equal(JSON.parse(shim('start')).state, 'active');
    for (let attempt = 0; attempt < 200 && !client; attempt++) {
      if (child && child.exitCode !== null) assert.fail('Serviço encerrou antes da conexão.');
      try { client = await connect(port, secret(home, 'access')); }
      catch { await delay(100); }
    }
    assert(client, 'Serviço não iniciou.');
    assert.equal(client.getServerVersion().version, expected);
    assert.equal(JSON.parse(shim('status')).service, 'hivemind');
    return await action(client);
  } finally {
    await client?.close();
    if (resident) assert.equal(JSON.parse(shim('stop')).state, 'inactive');
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}

try {
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture');
  const listener = createServer();
  await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const { port } = listener.address();
  await new Promise(done => listener.close(done));

  install(candidate);
  const init = JSON.parse(shim('init'));
  const initialConfig = stringify({
    port,
    harnesses: Object.fromEntries(['codex', 'claude-code', 'opencode'].map(name => [name, { executable: join(root, 'unused.exe') }])),
    agents: { design: { harness: 'codex', roles: ['architect'], model: 'fixture-model', effort: 'auto' } },
    profiles: { upgrade: { repository: repo, agents: ['design'], approval: 'required' } },
  });
  writeFileSync(init.config, initialConfig);
  await withService(port, '0.1.0-preview.3', async client => {
    assert.equal((await client.listTools()).tools.length, 18);
  });

  install(previous);
  const installed = JSON.parse(shim('install', 'antigravity', '.'));
  const customized = readFileSync(installed.skill, 'utf8') + '\nRegras locais preservadas.\n';
  writeFileSync(installed.skill, customized);
  const work = join(home, 'worktrees', 'fixture');
  git(repo, 'worktree', 'add', '-b', 'fixture-work', work);
  writeFileSync(join(work, 'local.txt'), 'persist');
  const reference = git(work, 'rev-parse', 'HEAD');
  const auth = await withService(port, '0.1.0-preview.2', async client => {
    const result = await call(client, 'create_job', { profile: 'upgrade', owner: 'test', objective: 'Upgrade fixture' });
    const auth = { jobId: result.job.id, jobKey: result.jobKey };
    await call(client, 'decompose_job', { ...auth, tasks: [{ id: 'plan', title: 'Plan', instructions: 'Inspect', role: 'architect' }] });
    return auth;
  });
  const priorAccess = secret(home, 'access');
  const priorAdmin = secret(home, 'admin');
  const verify = async client => {
    const job = await call(client, 'get_job', auth);
    assert.equal(job.tasks[0].state, 'PLANNED');
    assert.equal(job.policy.approval, 'required');
    assert.equal(job.team.design.effort, 'auto');
    assert.equal(secret(home, 'access'), priorAccess);
    assert.equal(secret(home, 'admin'), priorAdmin);
    assert.equal(readFileSync(init.config, 'utf8'), initialConfig);
    assert.equal(readFileSync(installed.skill, 'utf8'), customized);
    assert.equal(git(work, 'rev-parse', 'HEAD'), reference);
    assert.equal(git(work, 'branch', '--show-current'), 'fixture-work');
    assert.equal(readFileSync(join(work, 'local.txt'), 'utf8'), 'persist');
  };
  install(candidate);
  const updated = JSON.parse(shim('install', 'antigravity', '.', '--apply', '--update-skill'));
  assert.equal(updated.skillStatus.status, 'customized');
  await withService(port, '0.1.0-preview.3', verify);
  install(previous);
  await withService(port, '0.1.0-preview.2', verify);
  console.log('PASS: instalação limpa, start residente, upgrade e rollback em prefixo global isolado.');
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 6 });
}
