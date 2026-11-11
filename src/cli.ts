#!/usr/bin/env node
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parse } from 'yaml';
import { createAdapters, resolveEffort } from './adapters.js';
import { bridge, connect } from './bridge.js';
import { agentSchema, complexity, configSchema, dataDir, id, loadConfig, secret } from './config.js';
import { git, repository } from './git.js';
import { clientNames, install } from './install.js';
import { serve, endpoint } from './server.js';
import { version } from './version.js';
import { serviceStatus, startService, stopService } from './service-control.js';

const [command, ...flags] = process.argv.slice(2);
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
async function main() {
  const dir = flags[0] === '--home' && flags[1] ? resolve(flags.splice(0, 2)[1]) : dataDir();
  let configError: string | undefined;
  const config = (() => {
    try { return loadConfig(dir); }
    catch {
      if (!['doctor', 'status', 'stop'].includes(command)) throw new Error('agents.yaml inválido. Use hivemind doctor.');
      configError = 'agents.yaml inválido ou inacessível.';
      return configSchema.parse({});
    }
  })();
  async function admin(action: string, input?: unknown) {
    const response = await fetch(endpoint(config.port) + '/admin/' + action, {
      method: input ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + secret(dir, 'admin'), 'Content-Type': 'application/json' },
      body: input ? JSON.stringify(input) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const value = await response.json() as { error?: { code: string; message?: string } };
    if (!response.ok) throw new Error((value.error?.code ?? response.status) + ' ' + (value.error?.message ?? ''));
    print(value);
  }
  async function query(name: string, args: Record<string, unknown> = {}) {
    const client = await connect(config.port, secret(dir, 'access'));
    try {
      const result = await client.callTool({ name: 'hivemind_' + name, arguments: args });
      const content = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(result.content);
      if (result.isError) throw new Error(content[0]?.text);
      print(JSON.parse(content[0]?.text ?? 'null'));
    } finally { await client.close(); }
  }
  switch (command) {
    case 'init': {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const configPath = join(dir, 'agents.yaml');
      copyFileSync(fileURLToPath(new URL('../configs/agents.example.yaml', import.meta.url)), configPath, constants.COPYFILE_EXCL);
      print({ config: configPath });
      break;
    }
    case 'serve': {
      const service = await serve(dir, config);
      print({ mcp: service.url, home: dir });
      const close = () => { void service.close().catch(() => { process.exitCode = 1; }); };
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
      break;
    }
    case 'bridge':
      await bridge(config.port, secret(dir, 'access'));
      break;
    case 'start':
      print(await startService(dir, config.port));
      break;
    case 'stop':
      print(await stopService(dir, config.port));
      break;
    case 'restart':
      await stopService(dir, config.port);
      print(await startService(dir, config.port));
      break;
    case 'status': {
      const status = await serviceStatus(dir, config.port);
      print({ service: 'hivemind', ...status, configError });
      break;
    }
    case 'profiles':
      await query('list_profiles');
      break;
    case 'agents':
      await query('list_agents', flags[0] ? { profile: id.parse(flags[0]) } : {});
      break;
    case 'jobs':
      await admin('jobs');
      break;
    case 'approve':
      await admin('approve', { jobId: id.parse(flags[0]), taskId: id.parse(flags[1]) });
      break;
    case 'clean':
      await admin('clean', { jobId: id.parse(flags[0]) });
      break;
    case 'configure-agent':
      await admin('agent', { agentId: id.parse(flags[0]), agent: agentSchema.parse(parse(readFileSync(flags[1], 'utf8'))) });
      break;
    case 'doctor': {
      const adapters = createAdapters(config);
      const status = await serviceStatus(dir, config.port);
      let mcp: { status: string; serverVersion?: string; protocol?: string; tools?: number } = {
        status: status.state === 'inactive' ? 'unavailable' : 'not-tested',
      };
      if (status.state === 'active') {
        let client: Awaited<ReturnType<typeof connect>> | undefined;
        try {
          client = await connect(status.port, secret(dir, 'access'));
          const catalog = await client.listTools(undefined, { timeout: 3000 });
          mcp = { status: 'reachable', serverVersion: client.getServerVersion()?.version,
            protocol: status.identity.protocol, tools: catalog.tools.length };
        } catch { mcp = { status: 'error' }; }
        finally { await client?.close(); }
      }
      const reports = await Promise.all([...adapters.values()].map(async adapter => ({
        harness: adapter.name, detection: await adapter.doctor(),
        authentication: await adapter.authenticate?.() ?? 'not-tested',
      })));
      let gitVersion: string | undefined;
      try { gitVersion = git(process.cwd(), '--version'); } catch { /* report absence */ }
      const profiles = Object.entries(config.profiles).map(([id, profile]) => {
        try { return { id, ...repository(profile.repository) }; }
        catch { return { id, error: 'Repositório ausente, sem commit ou fora da raiz.' }; }
      });
      const agents = Object.entries(config.agents).map(([id, agent]) => {
        const adapter = adapters.get(agent.harness);
        if (!adapter?.availability()) return { id, harness: agent.harness, available: false };
        try {
          const resolved = complexity.options.map(level => resolveEffort(adapter, agent, undefined, level));
          return { id, effortSupport: adapter.efforts(agent), resolved };
        } catch (error) { return { id, error: (error as Error).message }; }
      });
      const clients = clientNames.map(name => {
        const report = install(name, flags[0] ?? process.cwd(), dir);
        return { harness: name, detected: report.detected, config: report.config, skill: report.skillStatus,
          skillVersion: report.skillVersion, canonicalSkillVersion: report.canonicalSkillVersion };
      });
      print({ version, node: process.version, git: gitVersion, service: status, mcp,
        configuration: configError ? { state: 'error', detail: configError }
          : { state: existsSync(join(dir, 'agents.yaml')) ? 'valid' : 'missing' },
        profiles, harnesses: reports, agents, clients });
      break;
    }
    case 'install': {
      const [harness, ...args] = flags;
      const switches = args.filter(arg => arg.startsWith('--'));
      const paths = args.filter(arg => !arg.startsWith('--'));
      if (paths.length > 1 || switches.some(arg => !['--apply', '--dry-run', '--update-skill', '--repair'].includes(arg)) ||
          switches.includes('--apply') && switches.includes('--dry-run')) throw new Error('Opções de instalação inválidas.');
      const result = install(harness, paths[0] ?? process.cwd(), dir, {
        apply: switches.includes('--apply'), updateSkill: switches.includes('--update-skill'), repair: switches.includes('--repair'),
      });
      print(result);
      if (result.applied && [result.config.status, result.skillStatus.status].some(state => ['error', 'conflict', 'manual'].includes(state))) {
        process.exitCode = 1;
      }
      break;
    }
    case 'coordinate': {
      const [profileId, agentId, objective] = flags;
      const profile = Object.hasOwn(config.profiles, profileId) ? config.profiles[profileId] : undefined;
      const agent = profile?.agents.includes(agentId) ? config.agents[agentId] : undefined;
      if (!profile || !agent?.roles.includes('orchestrator') || !objective) throw new Error('Informe perfil, agente com papel orchestrator e objetivo.');
      const adapter = createAdapters(config).get(agent.harness);
      if (!adapter?.coordinate) throw new Error('Abra este harness e carregue a skill manualmente.');
      await adapter.doctor();
      const effort = resolveEffort(adapter, agent, undefined, 'complex');
      process.stderr.write('Effort do coordenador ' + JSON.stringify(effort) + '\n');
      await adapter.coordinate({
        cwd: repository(profile.repository).root, agent, effort, mode: 'read',
        signal: new AbortController().signal, timeout: profile.timeoutMs, log: () => {},
        prompt: ['Use a skill hivemind-orchestrator e o MCP Hivemind. Perfil: ' + profileId + '.', agent.instructions, objective].filter(Boolean).join('\n'),
      });
      break;
    }
    default:
      process.stdout.write('hivemind <init|doctor|start|stop|restart|serve|bridge|agents|profiles|jobs|status|install|approve|clean|configure-agent|coordinate>\n');
      if (command && !['help', '--help'].includes(command)) process.exitCode = 1;
  }
}
main().catch(error => {
  process.stderr.write('Hivemind: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
