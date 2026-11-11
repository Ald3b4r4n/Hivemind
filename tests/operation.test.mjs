import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { stringify } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc } from 'jsonc-parser';
import { connect } from '../dist/bridge.js';
import { configSchema, secret } from '../dist/config.js';
import { git } from '../dist/git.js';
import { serve } from '../dist/server.js';
import { serviceStatus, stopService } from '../dist/service-control.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const exec = promisify(execFile);
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hivemind P003 '));
  const repo = join(root, 'test project');
  const home = join(root, 'service data');
  const user = join(root, 'client home');
  mkdirSync(repo);
  const env = {
    ...process.env, HOME: user, USERPROFILE: user, CODEX_HOME: join(user, '.codex'),
    XDG_CONFIG_HOME: join(user, '.config'), CLAUDE_CONFIG_DIR: join(user, '.claude'),
    OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '',
  };
  const command = async (...args) => {
    const [name, ...tail] = args;
    const result = await exec(process.execPath, [cli, name, '--home', home, ...tail],
      { env, cwd: repo, timeout: 55_000, windowsHide: true });
    return JSON.parse(result.stdout);
  };
  t.after(async () => {
    try { await command('stop'); } catch { /* fixture might have no service */ }
    rmSync(root, { recursive: true, force: true, maxRetries: 6 });
  });
  return { repo, home, user, env, command, root };
}
function config(f, port, approval = 'required') {
  return configSchema.parse({
    port,
    harnesses: Object.fromEntries(['codex', 'opencode', 'claude-code'].map(name => [name, { executable: join(f.root, 'unused.exe') }])),
    agents: { design: { harness: 'fake', roles: ['architect'] } },
    profiles: { fixture: { repository: f.repo, agents: ['design'], approval } },
  });
}
function initRepo(repo) {
  git(repo, 'init', '-b', 'main');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture');
}
async function call(client, name, args = {}) {
  const response = await client.callTool({ name: 'hivemind_' + name, arguments: args });
  assert(!response.isError, JSON.stringify(response.content));
  return JSON.parse(response.content[0].text);
}
async function createJob(client, profile = 'fixture') {
  const { job, jobKey } = await call(client, 'create_job', { profile, owner: 'test', objective: 'Inspect fixture' });
  const auth = { jobId: job.id, jobKey };
  await call(client, 'decompose_job', { ...auth, tasks: [{ id: 'inspect', title: 'Inspect', instructions: 'Inspect', role: 'architect' }] });
  return auth;
}

test('start concorrente, dois clientes, reconexão, restart e persistência em caminhos com espaços', async t => {
  const f = fixture(t);
  initRepo(f.repo);
  const port = await freePort();
  const configPath = join(f.home, 'agents.yaml');
  const settings = config(f, port);
  for (const approval of ['delegated', 'unattended']) {
    settings.profiles[approval] = { ...settings.profiles.fixture, approval };
  }
  write(configPath, stringify(settings));
  const stdio = new Client({ name: 'p003-stdio', version: '1' });
  t.after(() => stdio.close());
  await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'bridge', '--home', f.home] }));
  await assert.rejects(stdio.listTools());
  const [first, second] = await Promise.all([f.command('start'), f.command('start')]);
  assert.equal(first.state, 'active');
  assert.equal(second.identity.instance, first.identity.instance);
  assert.equal((await f.command('start')).alreadyRunning, true);
  const token = secret(f.home, 'access');
  const before = readFileSync(configPath, 'utf8');
  const http = await connect(port, token);
  try {
    const auth = await createJob(http);
    const delegated = await createJob(http, 'delegated');
    const unattended = await createJob(http, 'unattended');
    assert.equal((await call(stdio, 'get_job', auth)).state, 'PLANNED');
    const restarted = await f.command('restart');
    assert.notEqual(restarted.identity.instance, first.identity.instance);
    assert.equal((await call(stdio, 'get_job', auth)).state, 'PLANNED');
    assert.equal((await call(http, 'get_job', auth)).policy.approval, 'required');
    assert.equal((await call(http, 'get_job', delegated)).policy.approval, 'delegated');
    assert.equal((await call(http, 'get_job', unattended)).policy.approval, 'unattended');
    assert.equal(secret(f.home, 'access'), token);
    assert.equal(readFileSync(configPath, 'utf8'), before);
    const doctor = await f.command('doctor', f.repo);
    assert.equal(doctor.service.state, 'active');
    assert.equal(doctor.mcp.tools, 18);
    assert.match(doctor.mcp.protocol, /^\d{4}-\d{2}-\d{2}$/);
    assert(!JSON.stringify(doctor).includes(token));
    assert.equal((await f.command('stop')).state, 'inactive');
    assert.equal((await f.command('status')).state, 'inactive');
    assert(!JSON.stringify(readFileSync(join(f.home, 'service.log'), 'utf8')).includes(token));
  } finally {
    await stdio.close();
    await http.close();
  }
});

test('stop recusa trabalho ativo e um segundo listener não obtém o banco', async t => {
  const f = fixture(t);
  initRepo(f.repo);
  const port = await freePort();
  const options = config(f, port, 'delegated');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fake = { name: 'fake', availability: () => true, doctor: async () => ({}),
    efforts: () => ({ levels: {}, source: 'fake' }),
    async execute() { await gate; return 'done'; },
  };
  const adapters = new Map([[fake.name, fake]]);
  const service = await serve(f.home, options, adapters);
  try {
    const otherPort = await freePort();
    await assert.rejects(serve(f.home, { ...options, port: otherPort }, adapters), /locked|busy/i);
    const client = await connect(port, secret(f.home, 'access'));
    try {
      const auth = { ...await createJob(client), taskId: 'inspect' };
      await call(client, 'assign_task', auth);
      await call(client, 'approve_task', auth);
      await call(client, 'run_task', auth);
      await assert.rejects(stopService(f.home, port), { code: 'SERVICE_BUSY' });
      assert.equal((await call(client, 'get_task', auth)).state, 'RUNNING');
      release();
      for (let n = 0; n < 100 && (await serviceStatus(f.home, port)).running; n++) await delay(50);
      assert.equal((await call(client, 'get_task', auth)).state, 'COMPLETED');
      assert.equal((await stopService(f.home, port)).state, 'inactive');
    } finally { await client.close(); }
  } finally {
    release();
    await service.close();
  }
});

test('porta de outro processo não recebe token ou pedido de encerramento', async t => {
  const f = fixture(t);
  const { createServer } = await import('node:http');
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  write(join(f.home, 'agents.yaml'), stringify({ port }));
  secret(f.home, 'admin', true);
  try {
    assert.equal((await f.command('status')).state, 'unverified');
    await assert.rejects(f.command('stop'), /identificar/);
    await assert.rejects(f.command('start'), /ocupada/);
    assert(seen.every(request => request.method === 'GET' && !request.auth && request.url.startsWith('/service/identity?')));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('prévia, aplicação e repetição preservam configuração dos quatro clientes', async t => {
  const f = fixture(t);
  const fixtures = {
    codex: [join(f.user, '.codex', 'config.toml'), '# pessoal\n[mcp_servers.other]\ncommand = "old"\n', parseToml],
    'claude-code': [join(f.repo, '.mcp.json'), '{"mcpServers":{"other":{"url":"https://example.test"}}}\n', JSON.parse],
    opencode: [join(f.repo, 'opencode.jsonc'), '{\n  // pessoal\n  "mcp": {"servers":{"other":{"type":"local","command":["old"]}}},\n}\n', parseJsonc],
    antigravity: [join(f.repo, '.agents', 'mcp_config.json'), '{"mcpServers":{"other":{"command":"old"}}}\n', JSON.parse],
  };
  for (const [harness, [path, original, parse]] of Object.entries(fixtures)) {
    write(path, original);
    const plan = await f.command('install', harness, f.repo, '--dry-run');
    assert.equal(plan.config.status, 'missing', JSON.stringify(plan.config));
    assert.equal(readFileSync(path, 'utf8'), original);
    const applied = await f.command('install', harness, f.repo, '--apply');
    assert.equal(applied.config.status, 'updated', JSON.stringify(applied.config));
    assert.equal(readFileSync(applied.config.backup, 'utf8'), original);
    const updated = readFileSync(path, 'utf8');
    const config = parse(updated);
    const map = applied.mcp.path.slice(0, -1).reduce((value, key) => value[key], config);
    assert(Object.hasOwn(map, 'other'));
    assert.deepEqual(JSON.parse(JSON.stringify(map.hivemind)), applied.mcp.entry);
    if (original.includes('pessoal')) assert(updated.includes('pessoal'));
    const repeated = await f.command('install', harness, f.repo, '--apply');
    assert.equal(repeated.config.status, 'configured');
    assert.equal(repeated.config.backup, undefined);
    assert.equal(readFileSync(path, 'utf8'), updated);
  }
});

test('conflito, formatos ambíguos e credenciais existentes ficam fora da prévia', async t => {
  const f = fixture(t);
  const path = join(f.repo, '.mcp.json');
  const marker = 'secret-fixture-' + randomUUID();
  const original = JSON.stringify({ mcpServers: { hivemind: { url: 'https://example.test', headers: { Authorization: marker } } } });
  write(path, original);
  const preview = await f.command('install', 'claude-code', f.repo);
  assert.equal(preview.config.status, 'conflict');
  assert(!JSON.stringify(preview).includes(marker));
  await assert.rejects(f.command('install', 'claude-code', f.repo, '--apply', '--repair'));
  assert.equal(readFileSync(path, 'utf8'), original);
  write(join(f.repo, 'opencode.json'), '{}');
  write(join(f.repo, 'opencode.jsonc'), '{}');
  assert.equal((await f.command('install', 'opencode', f.repo)).config.status, 'manual');
});

test('atualização exige flag e preserva uma skill personalizada', async t => {
  const f = fixture(t);
  const target = (await f.command('install', 'antigravity', f.repo)).skill;
  const baseline = readFileSync(new URL('./fixtures/skill-preview2.md', import.meta.url), 'utf8');
  write(target, baseline);
  assert.equal((await f.command('install', 'antigravity', f.repo, '--apply')).skillStatus.status, 'update-available');
  assert.equal(readFileSync(target, 'utf8'), baseline);
  const upgraded = await f.command('install', 'antigravity', f.repo, '--apply', '--update-skill');
  assert.equal(upgraded.skillStatus.status, 'updated');
  assert.equal(readFileSync(upgraded.skillStatus.backup, 'utf8'), baseline);
  const customized = readFileSync(target, 'utf8') + '\nRegras locais.\n';
  write(target, customized);
  const result = await f.command('install', 'antigravity', f.repo, '--apply', '--update-skill');
  assert.equal(result.skillStatus.status, 'customized');
  assert.equal(readFileSync(target, 'utf8'), customized);
});

test('queda do residente deixa identificação obsoleta e permite nova instância', async t => {
  const f = fixture(t);
  initRepo(f.repo);
  const port = await freePort();
  write(join(f.home, 'agents.yaml'), stringify(config(f, port)));
  const original = await f.command('start');
  const client = await connect(port, secret(f.home, 'access'));
  try {
    const auth = await createJob(client);
    const verified = await serviceStatus(f.home, port);
    assert.deepEqual(verified.identity, original.identity);
    process.kill(verified.identity.pid, 'SIGKILL'); // Only the authenticated subprocess created by this fixture.
    let inactive = false;
    for (let i = 0; i < 100 && !inactive; i++) {
      inactive = (await serviceStatus(f.home, port)).state === 'inactive';
      if (!inactive) await delay(50);
    }
    assert(inactive);
    assert(existsSync(join(f.home, 'service.json')));
    const replacement = await f.command('start');
    assert.notEqual(replacement.identity.instance, original.identity.instance);
    assert.equal((await call(client, 'get_job', auth)).tasks[0].attempts.length, 0);
  } finally { await client.close(); }
});
