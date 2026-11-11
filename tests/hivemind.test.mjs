import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { configSchema, secret } from '../dist/config.js';
import { connect } from '../dist/bridge.js';
import { git } from '../dist/git.js';
import { serve } from '../dist/server.js';
import { invocation, run } from '../dist/process.js';
import { resolveEffort } from '../dist/adapters.js';
import { Store } from '../dist/storage.js';
import { redactor } from '../dist/redact.js';

const key = () => randomBytes(32).toString('hex');
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function call(client, tool, args = {}, expected) {
  const result = await client.callTool({ name: 'hivemind_' + tool, arguments: args });
  if (expected) {
    assert.equal(result.isError, true);
    if (expected !== true) assert.equal(result.structuredContent?.error.code, expected);
    return;
  }
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(40);
  }
  assert.fail('Timed out waiting for expected state');
}
async function fixture(t, approval = 'delegated') {
  const root = mkdtempSync(join(tmpdir(), 'hivemind-test-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  git(root, 'init', '-b', 'main', repo);
  writeFileSync(join(repo, 'README.md'), 'original\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'fixture');
  const config = configSchema.parse({
    port: await port(),
    agents: {
      design: { harness: 'fake', roles: ['architect'], effort: 'auto', autoEffort: { simple: 'low', normal: 'medium', complex: 'high' } },
      dev: { harness: 'fake', roles: ['implementer'] },
      quality: { harness: 'fake', roles: ['reviewer'], effort: 'max', effortFallback: 'high' },
    },
    profiles: { demo: { repository: repo, agents: ['design', 'dev', 'quality'], approval, allowWrite: true } },
  });
  const stats = { active: 0, max: 0, runs: 0 };
  let releaseParallel;
  const bothStarted = new Promise(resolve => { releaseParallel = resolve; });
  const fake = {
    name: 'fake', availability: () => true, doctor: async () => ({ installed: true, execution: true }),
    efforts: () => ({ levels: { low: 'l', medium: 'm', high: 'h' }, source: 'fake' }),
    async execute({ cwd, prompt, signal, log, mode }) {
      stats.runs++;
      stats.max = Math.max(++stats.active, stats.max);
      try {
        if (prompt.includes('PARALLEL_MARKER')) {
          if (stats.active === 2) releaseParallel();
          await Promise.race([bothStarted, delay(5000, undefined, { signal })]);
        }
        await delay(prompt.includes('WAIT_MARKER') ? 5000 : 200, undefined, { signal });
        if (prompt.includes('FAIL_MARKER')) throw new Error('private error');
        if (prompt.includes('REVIEW_MARKER')) assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8').trim(), 'modified');
        if (mode === 'write') writeFileSync(join(cwd, 'README.md'), 'modified\n');
        log('authorization: Bearer fake_secret_token_value');
        return 'Evidence sk-fake_secret_key_value';
      } finally { stats.active--; }
    },
  };
  const adapters = new Map([['fake', fake]]);
  const service = await serve(home, config, adapters);
  writeFileSync(join(home, 'agents.yaml'), stringify(config));
  const client = await connect(config.port, secret(home, 'access'));
  t.after(async () => {
    await client.close();
    await service.close();
    rmSync(root, { force: true, recursive: true, maxRetries: 4 });
  });
  const create = async (extra = {}) => {
    const result = await call(client, 'create_job', { profile: 'demo', owner: 'codex', objective: 'Improve README', ...extra });
    return { jobId: result.job.id, jobKey: result.jobKey };
  };
  const runTask = async auth => {
    await call(client, 'approve_task', auth);
    await call(client, 'run_task', auth);
  };
  return { client, service, config, adapters, create, runTask, home, repo, stats };
}

test('HTTP e STDIO compartilham jobs, ACL, DAG paralelo, revisão Git e evidências', async t => {
  const { client, create, config, runTask, repo, home, stats } = await fixture(t);
  const bridge = new Client({ name: 'test-stdio', version: '1' });
  await bridge.connect(new StdioClientTransport({
    command: process.execPath, args: [join(process.cwd(), 'dist', 'cli.js'), 'bridge', '--home', home], stderr: 'pipe',
  }));
  t.after(() => bridge.close());
  const list = await bridge.listTools();
  assert.equal(list.tools.length, 18);
  const resources = await bridge.listResources();
  assert.equal(resources.resources[0].uri, 'hivemind://skills/orchestrator');
  const skill = await bridge.readResource({ uri: 'hivemind://skills/orchestrator' });
  assert.match(skill.contents[0].text, /hivemind_create_job/);
  const requestKey = key();
  const job = await create({ requestKey });
  const update = {
    configurationKey: key(), agentId: 'design',
    agent: { harness: 'fake', roles: ['architect'], model: 'other-model', effort: 'medium', instructions: 'Review evidence.' },
  };
  await call(client, 'configure_agent', update, 'FORBIDDEN');
  await call(client, 'configure_agent', { ...update, configurationKey: secret(home, 'admin') });
  const agents = await call(client, 'list_agents', { profile: 'demo' });
  assert.equal(agents.find(agent => agent.id === 'design').model, 'other-model');
  assert.match(readFileSync(join(home, 'agents.yaml'), 'utf8'), /model: other-model/);
  assert.equal((await call(client, 'get_job', job)).team.design.effort, 'auto');
  assert.deepEqual(await create({ requestKey }), job);
  assert.equal((await call(bridge, 'get_job', job)).state, 'CREATED');
  await call(bridge, 'get_job', { ...job, jobKey: key() }, 'JOB_NOT_FOUND');
  await call(client, 'create_job', { profile: 'demo', owner: 'bad', objective: 'x', command: 'whoami' }, true);
  await call(client, 'decompose_job', { ...job, tasks: [
    { id: 'cyclic', title: 'Cycle', role: 'architect', instructions: 'x', dependsOn: ['cyclic'] },
  ] }, 'DEPENDENCY_INVALID');
  const tasks = [
    { id: 'a', title: 'A', role: 'architect', instructions: 'PARALLEL_MARKER Inspect project', complexity: 'simple' },
    { id: 'b', title: 'B', role: 'architect', instructions: 'PARALLEL_MARKER Inspect project', effort: 'high' },
    { id: 'c', title: 'C', role: 'implementer', instructions: 'Implement change', mode: 'write', dependsOn: ['a', 'b'] },
  ];
  await call(client, 'decompose_job', { ...job, tasks });
  await call(client, 'decompose_job', { ...job, tasks });
  assert.equal(stats.runs, 0);
  const auth = id => ({ ...job, taskId: id });
  await call(client, 'assign_task', { ...auth('a'), effort: 'max' }, 'EFFORT_UNSUPPORTED');
  for (const id of ['a', 'b', 'c']) await call(client, 'assign_task', auth(id));
  await call(client, 'run_task', auth('a'), 'APPROVAL_REQUIRED');
  await runTask(auth('c'));
  assert.equal((await call(client, 'get_task', auth('c'))).state, 'QUEUED');
  for (const id of ['a', 'b']) await runTask(auth(id));
  const task = await until(async () => {
    const task = await call(bridge, 'get_task', auth('c'));
    if (['FAILED', 'BLOCKED', 'CANCELLED'].includes(task.state)) assert.fail(JSON.stringify(task));
    return task.state === 'COMPLETED' && task;
  });
  assert.equal(stats.max, 2);
  assert.equal((await call(client, 'get_task', auth('a'))).attempts[0].effort.native, 'l');
  assert.equal((await call(client, 'get_task', auth('b'))).attempts[0].effort.native, 'h');
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'original\n');
  assert.match(task.attempts[0].evidence.diff, /\+modified/);
  assert.equal(task.attempts[0].evidence.output, 'Evidence [REDACTED]');
  await call(client, 'review_task', { ...auth('c'), reviewId: 'review', instructions: 'REVIEW_MARKER' });
  await runTask(auth('review'));
  const review = await until(async () => {
    const task = await call(client, 'get_task', auth('review'));
    if (['FAILED', 'BLOCKED', 'CANCELLED'].includes(task.state)) assert.fail(JSON.stringify(task));
    return task.state === 'COMPLETED' && task;
  });
  assert.equal(review.attempts[0].effort.applied, 'high');
  assert.equal(review.attempts[0].effort.fallback, true);
  const nextKey = key();
  await call(client, 'transfer_job', { ...job, owner: 'opencode', nextKey });
  await call(bridge, 'get_job', job, 'JOB_NOT_FOUND');
  const updated = { ...job, jobKey: nextKey };
  assert.equal((await call(bridge, 'finalize_job', { ...updated, report: 'Implementação revisada.' })).state, 'COMPLETED');
  const logs = await call(bridge, 'get_logs', { ...updated, limit: 100 });
  assert(logs.some(row => row.message.includes('[REDACTED]')));
  assert(!JSON.stringify(logs).includes('fake_secret_token_value'));
  const headers = { Authorization: 'Bearer ' + secret(home, 'admin'), 'Content-Type': 'application/json' };
  const clean = await fetch('http://127.0.0.1:' + config.port + '/admin/clean', {
    method: 'POST', headers, body: JSON.stringify({ jobId: job.jobId }),
  });
  assert((await clean.json()).every(item => item.clean));
  const denied = await fetch('http://127.0.0.1:' + config.port + '/mcp', { headers: { Origin: 'https://attacker.invalid' } });
  assert.equal(denied.status, 403);
});

test('aprovação administrativa, cancelamento, falha, retry e recuperação após restart', async t => {
  const { client, create, config, adapters, service, home } = await fixture(t, 'required');
  const job = await create();
  const auth = taskId => ({ ...job, taskId });
  await call(client, 'decompose_job', { ...job, tasks: [
    { id: 'wait', title: 'Wait', role: 'architect', instructions: 'WAIT_MARKER' },
    { id: 'fail', title: 'Fail', role: 'architect', instructions: 'FAIL_MARKER' },
    { id: 'dependent', title: 'Blocked', role: 'architect', instructions: 'Dependent', dependsOn: ['fail'] },
    { id: 'interrupt', title: 'Interrupt', role: 'architect', instructions: 'WAIT_MARKER' },
  ] });
  const headers = { Authorization: 'Bearer ' + secret(home, 'admin'), 'Content-Type': 'application/json' };
  const approve = async taskId => {
    const response = await fetch('http://127.0.0.1:' + config.port + '/admin/approve', {
      method: 'POST', headers, body: JSON.stringify({ jobId: job.jobId, taskId }),
    });
    assert(response.ok);
  };
  for (const taskId of ['wait', 'fail', 'dependent', 'interrupt']) await call(client, 'assign_task', auth(taskId));
  await call(client, 'approve_task', auth('wait'), 'ADMIN_APPROVAL_REQUIRED');
  for (const taskId of ['dependent', 'wait', 'fail']) {
    await approve(taskId);
    await call(client, 'run_task', auth(taskId));
  }
  await call(client, 'cancel_task', auth('wait'));
  await until(async () => (await call(client, 'get_task', auth('wait'))).state === 'CANCELLED');
  await until(async () => (await call(client, 'get_task', auth('dependent'))).state === 'BLOCKED');
  await call(client, 'retry_task', auth('fail'));
  await call(client, 'run_task', auth('fail'), 'APPROVAL_REQUIRED');
  await approve('fail');
  await call(client, 'run_task', auth('fail'));
  await until(async () => (await call(client, 'get_task', auth('fail'))).state === 'FAILED');
  await call(client, 'retry_task', auth('fail'), 'RETRY_UNAVAILABLE');
  await approve('interrupt');
  await call(client, 'run_task', auth('interrupt'));
  await client.close();
  await service.close();

  const store = new Store(join(home, 'state.sqlite'));
  const record = store.get(job.jobId);
  record.tasks.find(task => task.id === 'interrupt').state = 'RUNNING';
  store.save(record); // Reproduces the durable state of a process killed during execution.
  store.close();
  const restarted = await serve(home, config, adapters);
  const other = await connect(config.port, secret(home, 'access'));
  try {
    const interrupted = await call(other, 'get_task', auth('interrupt'));
    assert.equal(interrupted.state, 'BLOCKED');
    assert.match(interrupted.attempts[0].error, /reinicialização/);
    assert.equal((await call(other, 'get_task', auth('fail'))).attempts.length, 2);
  } finally {
    await other.close();
    await restarted.close();
  }
});

test('timeout e cancelamento encerram a árvore de subprocessos', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hivemind-tree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 4 }));
  const descendant = "setTimeout(()=>require('node:fs').writeFileSync('escaped','yes'), 2200)";
  const source = "require('node:child_process').spawn(process.execPath,['-e'," + JSON.stringify(descendant) +
    "],{stdio:'inherit'}); setInterval(()=>{},1000)";
  const command = invocation(process.execPath, ['-e', source]);
  await assert.rejects(run(command, dir, new AbortController().signal, 1200), { code: 'TIMEOUT' });
  const stop = new AbortController();
  const running = run(command, dir, stop.signal, 8000);
  setTimeout(() => stop.abort(), 1300);
  await assert.rejects(running, { code: 'CANCELLED' });
  await delay(2300);
  assert.throws(() => readFileSync(join(dir, 'escaped')), { code: 'ENOENT' });
});

test('validação de perfis e redação', () => {
  assert.throws(() => configSchema.parse({ agents: { tester: { harness: 'codex', roles: ['unknown'] } } }));
  assert.throws(() => configSchema.parse({ profiles: { demo: { repository: '.', agents: ['missing'] } } }));
  assert.equal(redactor(['secret-fixture'])('api_key=abcdef password: more secret-fixture'), 'api_key=[REDACTED] password: [REDACTED] [REDACTED]');
  assert.throws(() => resolveEffort({ name: 'demo', efforts: () => ({ levels: {}, source: 'unknown' }) },
    { effort: 'high' }, undefined, 'normal'), { code: 'EFFORT_UNSUPPORTED' });
});
