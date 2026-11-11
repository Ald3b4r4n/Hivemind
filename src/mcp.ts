import { version } from './version.js';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { agentSchema, complexity, effort, id, modes, opaque, text } from './config.js';
import type { Engine } from './engine.js';
import { Fault } from './storage.js';

const skill = new URL('../skills/hivemind-orchestrator/SKILL.md', import.meta.url);
const job = { jobId: id, jobKey: opaque };
const task = { ...job, taskId: id };
const plan = z.strictObject({
  id, title: text(200), instructions: text(6500), role: id,
  mode: modes.default('read'), dependsOn: z.array(id).max(30).default([]),
  capabilities: z.array(id).max(30).default([]), complexity: complexity.default('normal'), effort: effort.optional(), expectChanges: z.boolean().optional(),
});

type Tool = { description: string; inputSchema: z.ZodObject; run: (input: unknown) => unknown };
function tool<S extends z.ZodObject>(description: string, inputSchema: S, run: (input: z.infer<S>) => unknown): Tool {
  return { description, inputSchema, run: input => run(inputSchema.parse(input)) };
}

export function tools(engine: Engine, harnesses: () => unknown, configure: (key: string, name: string, agent: z.infer<typeof agentSchema>) => unknown) {
  return {
    hivemind_status: tool('Consulta o serviço local.', z.strictObject({}), () => engine.status()),
    hivemind_list_harnesses: tool('Lista harnesses detectados e funções disponíveis.', z.strictObject({}), harnesses),
    hivemind_list_profiles: tool('Lista perfis de projeto permitidos.', z.strictObject({}), () => engine.profiles()),
    hivemind_list_agents: tool('Lista papéis, modelos, disponibilidade e suporte de effort por agente.', z.strictObject({ profile: id.optional() }), x => engine.agents(x.profile)),
    hivemind_configure_agent: tool('Salva um agente no YAML. Requer chave administrativa e afeta novos jobs.', z.strictObject({
      configurationKey: opaque, agentId: id, agent: agentSchema,
    }), x => configure(x.configurationKey, x.agentId, x.agent)),
    hivemind_create_job: tool('Cria um job e devolve sua chave de liderança. Guarde a chave apenas neste contexto.', z.strictObject({
      profile: id, owner: id, objective: text(3000), agents: z.array(id).min(1).max(50).optional(), requestKey: opaque.optional(),
    }), x => engine.create(x)),
    hivemind_transfer_job: tool('Transfere a liderança e revoga a chave anterior.', z.strictObject({
      ...job, owner: id, nextKey: opaque,
    }), x => engine.transfer(x, x.owner, x.nextKey)),
    hivemind_decompose_job: tool('Grava tarefas e dependências sem iniciar execução.', z.strictObject({
      ...job, tasks: z.array(plan).min(1).max(100),
    }), x => engine.decompose(x, x.tasks)),
    hivemind_assign_task: tool('Seleciona executor por perfil. Pode sobrescrever o effort nesta tarefa.', z.strictObject({
      ...task, agent: id.optional(), effort: effort.optional(),
    }), x => engine.assign(x, x.agent, x.effort)),
    hivemind_approve_task: tool('Aprova explicitamente uma tarefa no modo delegated.', z.strictObject(task), x => engine.approve(x.jobId, x.taskId, x)),
    hivemind_run_task: tool('Coloca uma tarefa aprovada na fila. Retorna antes de terminar.', z.strictObject(task), x => engine.enqueue(x)),
    hivemind_get_job: tool('Consulta o estado e as evidências do job autorizado.', z.strictObject(job), x => engine.get(x)),
    hivemind_get_task: tool('Consulta tentativas, effort e evidências da tarefa.', z.strictObject(task), x => engine.getTask(x)),
    hivemind_get_logs: tool('Lê os logs paginados do job.', z.strictObject({
      ...job, taskId: id.optional(), after: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20),
    }), x => engine.logs(x, x.taskId, x.after, x.limit)),
    hivemind_cancel_task: tool('Solicita cancelamento da tarefa.', z.strictObject(task), x => engine.cancel(x)),
    hivemind_retry_task: tool('Prepara nova tentativa. Aprovação e execução são ações separadas.', z.strictObject(task), x => engine.retry(x)),
    hivemind_review_task: tool('Planeja revisão com outro agente em worktree isolada, a partir do resultado.', z.strictObject({
      ...task, reviewId: id, instructions: text(6500), agent: id.optional(), effort: effort.optional(),
    }), x => engine.review(x, x.reviewId, x.instructions, x.agent, x.effort)),
    hivemind_finalize_job: tool('Encerra o job e grava relatório com evidências.', z.strictObject({ ...job, report: text(12_000) }), x => engine.finalize(x, x.report)),
  };
}

export function errorData(error: unknown) {
  return error instanceof Fault ? { code: error.code, message: error.message }
    : error instanceof z.ZodError ? { code: 'INVALID_INPUT', message: 'Parâmetros inválidos.',
      fields: error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })) }
    : { code: 'INTERNAL_ERROR', message: 'Falha interna. Consulte o operador local.' };
}

export function mcp(registry: Record<string, Tool>, available = () => true) {
  const server = new McpServer({ name: 'hivemind', version });
  server.registerResource('hivemind-orchestrator', 'hivemind://skills/orchestrator', {
    title: 'Skill Hivemind Orchestrator', mimeType: 'text/markdown',
  }, uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readFileSync(skill, 'utf8') }] }));
  const readOnly = new Set(['status', 'list_harnesses', 'list_profiles', 'list_agents', 'get_job', 'get_task', 'get_logs']);
  for (const [name, entry] of Object.entries(registry)) {
    server.registerTool(name, { description: entry.description, inputSchema: entry.inputSchema,
      annotations: { readOnlyHint: readOnly.has(name.slice('hivemind_'.length)), openWorldHint: name === 'hivemind_run_task' } }, input => {
      try {
        if (!available()) throw new Fault('SERVICE_UNAVAILABLE', 'O serviço está encerrando.');
        const data = entry.run(input);
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (error) {
        const data = errorData(error);
        return { isError: true, structuredContent: { error: data }, content: [{ type: 'text', text: JSON.stringify({ error: data }) }] };
      }
    });
  }
  return server;
}
