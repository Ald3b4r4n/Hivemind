import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { stringify } from 'yaml';
import { z } from 'zod';
import { agentSchema, configSchema, id, loadConfig, matches, secret, type Agent, type Config } from './config.js';
import { createAdapters, type Adapter } from './adapters.js';
import { Engine } from './engine.js';
import { errorData, mcp, tools } from './mcp.js';
import { redactor } from './redact.js';
import { Fault, Store } from './storage.js';

export const endpoint = (port: number) => 'http://127.0.0.1:' + port;
function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += (chunk as Buffer).length;
    if (length > 256_000) throw new Fault('PAYLOAD_LIMIT', 'Limite de 256 KB por requisição.');
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new Fault('INVALID_JSON', 'JSON inválido.'); }
}
function saveAgent(dir: string, config: Config, name: string, agent: Agent, redact: (value: string) => string) {
  if (agent.instructions && redact(agent.instructions) !== agent.instructions) {
    throw new Fault('SECRET_IN_CONFIG', 'Retire credenciais das instruções.');
  }
  const current = loadConfig(dir);
  if (JSON.stringify(current) !== JSON.stringify(config)) {
    throw new Fault('CONFIG_CHANGED', 'agents.yaml mudou no disco. Reinicie o serviço antes de salvar.');
  }
  const next = configSchema.safeParse({ ...config, agents: { ...config.agents, [name]: agent } });
  if (!next.success) throw next.error;
  const target = join(dir, 'agents.yaml');
  const temp = join(dir, '.agents-' + randomUUID() + '.tmp');
  try {
    writeFileSync(temp, stringify(next.data), { flag: 'wx', mode: 0o600 });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  config.agents = next.data.agents;
  return { id: name, ...agent };
}
export async function serve(dir: string, config: Config, adapters: Map<string, Adapter> = createAdapters(config)) {
  const access = secret(dir, 'access', true);
  const admin = secret(dir, 'admin', true);
  const redact = redactor([access, admin]);
  const harnesses = await Promise.all([...adapters.values()].map(adapter => adapter.doctor()));
  const store = new Store<ConstructorParameters<typeof Engine>[1] extends Store<infer Job> ? Job : never>(join(dir, 'state.sqlite'));
  let engine: Engine;
  try { engine = new Engine(dir, store, config, adapters, access, redact); }
  catch (error) { store.close(); throw error; }
  const registry = tools(engine, () => harnesses, (key, name, agent) => {
    if (!matches(admin, key)) throw new Fault('FORBIDDEN', 'Chave administrativa inválida.');
    return saveAgent(dir, config, name, agent, redact);
  });

  const server = createServer(async (req, response) => {
    const origin = endpoint(config.port);
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
      json(response, 403, { error: { code: 'ORIGIN_DENIED' } });
      return;
    }
    const isMcp = req.url === '/mcp';
    const auth = req.headers.authorization ?? '';
    if (!matches('Bearer ' + (isMcp ? access : admin), auth)) {
      json(response, 401, { error: { code: 'AUTH_REQUIRED' } });
      return;
    }
    try {
      if (isMcp) {
        if (req.method !== 'POST') {
          response.writeHead(405, { Allow: 'POST' }).end();
          return;
        }
        const input = await body(req);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        const server = mcp(registry);
        try {
          await server.connect(transport);
          await transport.handleRequest(req, response, input);
        } finally {
          await server.close();
        }
      } else if (req.url === '/admin/jobs' && req.method === 'GET') {
        json(response, 200, engine.list());
      } else if (req.url === '/admin/approve' && req.method === 'POST') {
        const input = z.strictObject({ jobId: id, taskId: id }).parse(await body(req));
        json(response, 200, engine.approve(input.jobId, input.taskId));
      } else if (req.url === '/admin/clean' && req.method === 'POST') {
        const input = z.strictObject({ jobId: id }).parse(await body(req));
        json(response, 200, engine.clean(input.jobId));
      } else if (req.url === '/admin/agent' && req.method === 'POST') {
        const input = z.strictObject({ agentId: id, agent: agentSchema }).parse(await body(req));
        json(response, 200, saveAgent(dir, config, input.agentId, input.agent, redact));
      } else {
        json(response, 404, { error: { code: 'NOT_FOUND' } });
      }
    } catch (error) {
      if (!response.headersSent) json(response, 400, { error: errorData(error) });
      else response.end();
    }
  });
  server.requestTimeout = 15_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await engine.close();
    throw error;
  }
  let shutdown: Promise<void> | undefined;
  return {
    url: endpoint(config.port) + '/mcp',
    close: () => shutdown ??= new Promise<void>(resolve => server.close(() => resolve())).then(() => engine.close()),
  };
}
