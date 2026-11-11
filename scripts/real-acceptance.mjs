import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { connect } from '../dist/bridge.js';
import { configSchema, secret } from '../dist/config.js';
import { git } from '../dist/git.js';
import { serve } from '../dist/server.js';
import { executable, environment, invocation, run } from '../dist/process.js';
import { install } from '../dist/install.js';
import { Store } from '../dist/storage.js';
import { redactor } from '../dist/redact.js';

const root = mkdtempSync(join(tmpdir(), 'hivemind-real-'));
const repo = join(root, 'repo');
const home = join(root, 'home');
const openCodeModel = process.env.HIVEMIND_TEST_OPENCODE_MODEL;
const correction = process.argv[2] === 'p002';
const codexWrite = process.argv[2] === 'codex-write';
if (!openCodeModel) throw new Error('Configure HIVEMIND_TEST_OPENCODE_MODEL com um modelo já autorizado.');
const output = data => console.log(JSON.stringify(data));
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const { port } = listener.address();
await new Promise(resolve => listener.close(resolve));
const config = configSchema.parse({
  port, concurrency: 3,
  agents: {
    architecture: { harness: 'opencode', roles: ['architect', 'tester'], model: openCodeModel,
      effort: process.env.HIVEMIND_TEST_OPENCODE_EFFORT },
    delivery: { harness: 'claude-code', roles: ['implementer'], model: process.env.HIVEMIND_TEST_CLAUDE_MODEL,
      effort: process.env.HIVEMIND_TEST_CLAUDE_EFFORT },
    quality: { harness: 'codex', roles: ['reviewer', 'tester'], model: process.env.HIVEMIND_TEST_CODEX_MODEL,
      effort: process.env.HIVEMIND_TEST_CODEX_EFFORT },
  },
  profiles: { demo: { repository: repo, agents: ['architecture', 'delivery', 'quality'], approval: 'delegated', allowWrite: true, timeoutMs: 120_000 } },
});
git(root, 'init', '-b', 'main', repo);
writeFileSync(join(repo, 'README.md'), '# Fixture\n\nHivemind acceptance repository.\n');
git(repo, 'add', '.');
git(repo, '-c', 'user.name=Hivemind Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'fixture');
const initialHead = git(repo, 'rev-parse', 'HEAD');
const initialIndex = git(repo, 'write-tree');
const service = await serve(home, config);
writeFileSync(join(home, 'agents.yaml'), stringify(config));
const client = await connect(port, secret(home, 'access'));
const redact = redactor([secret(home, 'access'), secret(home, 'admin')]);
const sleep = ms => delay(ms);
async function call(name, args = {}) {
  const result = await client.callTool({ name: 'hivemind_' + name, arguments: args });
  assert(!result.isError, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}
async function waitTask(auth) {
  for (let attempt = 0; attempt < 260; attempt++) {
    const task = await call('get_task', auth);
    if (['COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(task.state)) return task;
    await sleep(500);
  }
  throw new Error('Prazo de verificação excedido.');
}
async function runTask(auth) {
  await call('approve_task', auth);
  await call('run_task', auth);
}
function reportTask(task) {
  const attempt = task.attempts.at(-1);
  output({ task: task.id, state: task.state, agent: task.agent, effort: attempt?.effort,
    commit: attempt?.evidence?.commit, files: attempt?.evidence?.files, error: attempt?.error, note: task.mode === 'write' && !attempt?.evidence?.commit ? attempt?.evidence?.output.slice(-1500) : undefined });
}
async function cliOptions(task) {
  const logs = await call('get_logs', { ...task, limit: 100 });
  return logs.flatMap(entry => {
    try {
      const parsed = JSON.parse(entry.message);
      return parsed.event === 'cli-options' ? [parsed] : [];
    } catch { return []; }
  });
}
let nativeMode;
try {
  output(await call('list_harnesses'));
  output(await call('list_agents', { profile: 'demo' }));
  nativeMode = correction || codexWrite ? undefined : process.argv[2];
  if (!nativeMode) {
    const { job, jobKey } = await call('create_job', { profile: 'demo', owner: 'test-driver', objective: 'Analyze, improve and review the README fixture.' });
    const auth = { jobId: job.id, jobKey };
    if (codexWrite) {
      const taskId = 'codex-write';
      const task = { ...auth, taskId };
      await call('decompose_job', { ...auth, tasks: [
        { id: taskId, title: 'Probe de escrita', role: 'tester', mode: 'write', instructions: 'Use a ferramenta de edição para acrescentar P002_CODEX_WRITE ao README.md. Confirme se houve alteração real e informe qualquer bloqueio explícito de ferramenta.' },
      ] });
      await call('assign_task', { ...task, agent: 'quality' });
      await runTask(task);
      const result = await waitTask(task);
      reportTask(result);
      output({ cliOptions: await cliOptions(task) });
      await call('finalize_job', { ...auth, report: 'Probe Codex em sandbox workspace-write.' });
      assert.equal(result.state, 'COMPLETED', result.attempts.at(-1)?.error);
      assert.match(result.attempts.at(-1).evidence.diff, /^\+.*P002_CODEX_WRITE/m);
    } else {
      await call('decompose_job', { ...auth, tasks: [
        { id: 'architecture', title: 'Analyze', role: 'architect', instructions: 'Read README.md, explain its purpose and suggest adding a Usage section.' },
        { id: 'delivery', title: 'Implement', role: 'implementer', mode: 'write', instructions: 'Append a Usage section to README.md with a sentence containing Hivemind. Use tools to edit the file. Do not add a verification marker in this first pass. Do not change anything else.', ...(correction ? { dependsOn: ['architecture'] } : {}) },
        { id: 'quality-smoke', title: 'Inspect', role: 'tester', instructions: 'Read README.md and report its current title.' },
      ] });
      const names = ['architecture', 'delivery', 'quality-smoke'];
      for (const taskId of names) {
        try {
          await call('assign_task', { ...auth, taskId });
          await runTask({ ...auth, taskId });
        } catch (error) {
          output({ task: taskId, state: 'BLOCKED', error: redact(error.message) });
          await call('cancel_task', { ...auth, taskId });
        }
      }
      const tasks = await Promise.all(names.map(taskId => waitTask({ ...auth, taskId })));
      tasks.forEach(reportTask);
      const delivered = tasks.find(task => task.id === 'delivery');
      if (delivered.attempts.at(-1)?.evidence?.files.includes('README.md') && tasks.at(-1).state === 'COMPLETED') {
        await call('review_task', { ...auth, taskId: 'delivery', reviewId: 'review', instructions: correction ? 'Review the supplied Git diff. The acceptance criteria require the exact string P002_VERIFIED in the new Usage section. If absent, explicitly report the missing marker as a required correction and include the exact verdict P002_CORRECTION_REQUIRED. Cite P002_VERIFIED.' : 'Review the supplied Git diff and report the wording of the Usage section.' });
        await runTask({ ...auth, taskId: 'review' });
        tasks.push(await waitTask({ ...auth, taskId: 'review' }));
        reportTask(tasks.at(-1));
        if (correction) {
          const review = tasks.at(-1);
          assert.equal(review.state, 'COMPLETED');
          const feedback = review.attempts.at(-1).evidence.output;
          assert.match(feedback, /P002_VERIFIED/);
          assert.match(feedback, /P002_CORRECTION_REQUIRED/);
          assert.doesNotMatch(delivered.attempts.at(-1).evidence.diff, /P002_VERIFIED/);
          const repair = { ...auth, taskId: 'correction' };
          await call('decompose_job', { ...auth, tasks: [
            { id: repair.taskId, title: 'Apply reviewer feedback', role: 'implementer', mode: 'write', dependsOn: ['review'],
              instructions: 'Apply the recorded review feedback. Add the exact marker P002_VERIFIED to the Usage section. Preserve other content.' },
          ] });
          await call('assign_task', { ...repair, effort: 'high' });
          await runTask(repair);
          const repaired = await waitTask(repair);
          tasks.push(repaired);
          reportTask(repaired);
          assert.equal(repaired.state, 'COMPLETED');
          assert.match(repaired.attempts.at(-1).evidence.diff, /^\+.*P002_VERIFIED/m);
          const finalReview = { ...auth, taskId: 'review-final' };
          await call('review_task', { ...repair, reviewId: finalReview.taskId,
            instructions: 'Verify the correction in the supplied diff. Report whether the added line now contains P002_VERIFIED. If present, include the exact verdict P002_REVIEW_PASS.' });
          await runTask(finalReview);
          const verification = await waitTask(finalReview);
          tasks.push(verification);
          reportTask(verification);
          assert.equal(verification.state, 'COMPLETED');
          assert.match(verification.attempts.at(-1).evidence.output, /P002_VERIFIED/);
          assert.match(verification.attempts.at(-1).evidence.output, /P002_REVIEW_PASS/);
          output({ feedback: 'P002_CORRECTION_REQUIRED', verification: 'P002_REVIEW_PASS' });
          for (const task of tasks) {
            const entries = await cliOptions({ ...auth, taskId: task.id });
            assert.equal(entries.length, 1);
            output({ task: task.id, cliOptions: entries[0] });
          }
          assert.deepEqual((await cliOptions(repair))[0].argv.filter((value, index, args) =>
            value === '--effort' || args[index - 1] === '--effort'), ['--effort', 'high']);
        }
      }
      const finalized = await call('finalize_job', { ...auth, report: 'Acceptance fixture. See task evidence.' });
      output({ job: finalized.id, owner: finalized.owner, state: finalized.state });
      if (finalized.state !== 'COMPLETED' || !delivered.attempts.at(-1)?.evidence?.commit || tasks.length !== (correction ? 6 : 4)) process.exitCode = 1;
    }
  } else {
    const isCodex = nativeMode === 'codex';
    if (!isCodex && nativeMode !== 'opencode') throw new Error('Modo nativo: codex ou opencode.');
    install(nativeMode, repo, home);
    const entry = resolve('dist/cli.js');
    const args = [entry, 'bridge', '--home', home];
    const file = isCodex ? executable('codex', '@openai/codex/bin/codex.js') : executable('opencode', '@opencode/cli/bin/opencode.exe');
    if (!file) throw new Error('CLI indisponível.');
    const prompt = isCodex
      ? 'Leia a skill pelo recurso MCP hivemind://skills/orchestrator e use as ferramentas MCP do servidor hivemind. Perfil demo, owner codex. Analise este projeto, implemente uma melhoria e revise a entrega usando três agentes diferentes. Crie job, planeje architecture (architect, leia README e sugira Usage) e delivery (implementer, write, depende de architecture, acrescente seção Usage no README.md). Atribua, aprove no modo delegated e execute ambos. Aguarde resultados de fato, depois use review_task com quality e instrua: Revise o diff registrado pelo Hivemind, cite a frase de Usage e indique se a alteração atende ao pedido. A revisão do diff é a verificação pedida para esta fixture. Aprove e execute a revisão. Com a revisão concluída, finalize com relatório e evidências. Use o MCP para executar as ações do fluxo.'
      : 'Use as ferramentas MCP do servidor hivemind. Crie um job com perfil demo, owner opencode e objetivo "Liderança OpenCode". Crie uma tarefa de leitura com papel tester para examinar README.md. Atribua a architecture, aprove, execute e aguarde o resultado. Finalize o job com relatório real. Mantenha a chave no contexto e informe o ID.';
    let command;
    if (isCodex) {
      command = invocation(file, ['exec', '--json', '--ephemeral', '--color', 'never', '--sandbox', 'read-only', '--ignore-user-config', '--model', process.env.HIVEMIND_TEST_CODEX_COORDINATOR_MODEL ?? 'gpt-6.1-sol',
        '-c', 'mcp_servers.hivemind.command=' + JSON.stringify(process.execPath),
        '-c', 'mcp_servers.hivemind.args=' + JSON.stringify(args),
        '-c', 'mcp_servers.hivemind.default_tools_approval_mode="approve"',
        '-c', 'mcp_servers.hivemind.disabled_tools=["hivemind_configure_agent"]',
        '-c', 'mcp_servers.hivemind.required=true', '--', prompt], environment());
    } else {
      writeFileSync(join(repo, 'opencode.json'), JSON.stringify({ mcp: { servers: { hivemind: { type: 'local', command: [process.execPath, ...args] } } } }));
      command = invocation(file, ['run', '--standalone', '--format', 'json', '--archived', '--model', openCodeModel, '--', prompt], environment());
    }
    const result = await run(command, repo, new AbortController().signal, 360_000, 12 * 1024 * 1024);
    const diagnostic = value => redact(value).replace(/\b[a-f0-9]{64}\b/gi, '[REDACTED]');
    const items = result.stdout.trim().split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    output({ nativeMode, code: result.code, diagnostics: diagnostic(result.stderr.slice(-2000)),
      toolCalls: items.filter(event => event.item?.type === 'mcp_tool_call').map(event => ({
        server: event.item.server, tool: event.item.tool, status: event.item.status,
      })), final: diagnostic(items.filter(event => event.item?.type === 'agent_message' && event.type === 'item.completed').at(-1)?.item.text ?? '') });
    if (result.code !== 0) output({ diagnostic: redact((result.stdout || result.stderr).slice(-1300)) });
  }
  assert.equal(git(repo, 'rev-parse', 'HEAD'), initialHead);
  assert.equal(git(repo, 'write-tree'), initialIndex);
  assert.match(readFileSync(join(repo, 'README.md'), 'utf8'), /Hivemind acceptance repository/);
  assert(!readFileSync(join(repo, 'README.md'), 'utf8').includes('## Usage'));
} finally {
  await client.close();
  await service.close();
  if (nativeMode) {
    const store = new Store(join(home, 'state.sqlite'));
    const jobs = store.all().filter(job => job.owner === nativeMode);
    jobs.forEach(job => {
      job.tasks.forEach(reportTask);
      output({ job: job.id, owner: job.owner, state: job.finalized?.state ?? 'PENDING' });
    });
    if (!jobs.some(job => job.finalized?.state === 'COMPLETED' &&
      (nativeMode !== 'codex' || (job.tasks.some(task => task.reviewOf) && job.tasks.some(task => task.attempts.at(-1)?.evidence?.commit))))) {
      process.exitCode = 1;
    }
    store.close();
  }
  if (process.env.HIVEMIND_KEEP_FIXTURE === '1') output({ fixture: root });
  else rmSync(root, { recursive: true, force: true, maxRetries: 4 });
}
