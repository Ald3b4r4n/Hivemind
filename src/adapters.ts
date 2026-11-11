import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, Config } from './config.js';
import { id } from './config.js';
import { executable, environment, invocation, run, type Invocation, type ProcessResult } from './process.js';
import { Fault } from './storage.js';

export interface Effort {
  requested: string;
  applied: string;
  native?: string;
  source: string;
  fallback: boolean;
}
export interface Execution {
  cwd: string; prompt: string; agent: Agent; effort: Effort; mode: 'read' | 'write';
  signal: AbortSignal; timeout: number; log: (message: string) => void;
}
type Levels = Record<string, string>;
export interface Adapter {
  name: string;
  availability(): boolean;
  doctor(): Promise<unknown>;
  efforts(agent: Agent): { levels: Levels; source: string };
  execute?: (request: Execution) => Promise<string>;
  coordinate?: (request: Execution) => Promise<void>;
}

export function resolveEffort(adapter: Adapter, agent: Agent, override: string | undefined, complexity: 'simple' | 'normal' | 'complex'): Effort {
  const requested = override ?? agent.effort;
  const { levels, source } = adapter.efforts(agent);
  const suggested = { simple: 'low', normal: 'medium', complex: 'high' }[complexity];
  const automatic = Object.hasOwn(levels, suggested) ? suggested : 'auto';
  const chosen = requested === 'auto' ? agent.autoEffort?.[complexity] ?? automatic : requested;
  const applies = (level: string) => level === 'auto' || Object.hasOwn(levels, level);
  const applied = applies(chosen) ? chosen : agent.effortFallback;
  if (!applied || !applies(applied)) {
    throw new Fault('EFFORT_UNSUPPORTED', 'Effort ' + chosen + ' sem suporte confirmado para ' +
      adapter.name + '/' + (agent.model ?? '(modelo padrão)') + '. Opções: auto' +
      Object.keys(levels).map(level => ', ' + level).join('') + '.');
  }
  return {
    requested, applied: applied === 'auto' ? 'harness-default' : applied,
    native: applied === 'auto' ? undefined : levels[applied],
    source: applied === 'auto' ? 'harness-default' : source,
    fallback: chosen !== applied,
  };
}

const claudeLevels: Record<string, string[]> = Object.fromEntries([
  ...['claude-opus-4-6', 'claude-sonnet-4-6'].map(model => [model, ['low', 'medium', 'high', 'max']]),
  ...['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5',
    'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(model =>
    [model, ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']]),
]);
const levelMap = (levels: string[]): Levels => Object.fromEntries(levels.filter(level => id.safeParse(level).success).map(level => [level, level]));

interface CliSpec {
  name: string; bin: string; target: string; help: string[]; markers: string[];
  args?: (req: Execution) => string[];
  coord?: (req: Execution) => string[];
  output?: (result: ProcessResult) => string;
  env?: (req: Execution) => NodeJS.ProcessEnv;
}
const codexOptions = (req: Execution) => [
  ...(req.agent.model ? ['--model', req.agent.model] : []),
  ...(req.agent.provider ? ['-c', 'model_provider=' + JSON.stringify(req.agent.provider)] : []),
  ...(req.effort.native ? ['-c', 'model_reasoning_effort=' + JSON.stringify(req.effort.native)] : []),
];
const claudeOptions = (req: Execution) => [
  ...(req.agent.model ? ['--model', req.agent.model] : []),
  ...(req.effort.native ? ['--effort', req.effort.native] : []),
];
const openCodeOptions = (req: Execution) => req.agent.model
  ? ['--model', req.agent.model + (req.effort.native ? '#' + req.effort.native : '')] : [];

function events(output: string): Record<string, unknown>[] {
  return output.trim().split('\n').flatMap(line => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}
function codexOutput(result: ProcessResult): string {
  const lines = events(result.stdout);
  if (lines.some(line => line.type === 'turn.failed')) throw new Fault('EXECUTOR_FAILED', JSON.stringify(lines.find(line => line.type === 'turn.failed')));
  return lines.flatMap(line => {
    const item = line.item as { type?: string; text?: string } | undefined;
    return line.type === 'item.completed' && item?.type === 'agent_message' ? [item.text ?? ''] : [];
  }).join('\n');
}
function claudeOutput(result: ProcessResult): string {
  const body = JSON.parse(result.stdout) as { is_error?: boolean; result?: string };
  if (body.is_error) throw new Fault('EXECUTOR_FAILED', body.result ?? 'Claude Code retornou uma falha.');
  return body.result ?? '';
}
function openCodeOutput(result: ProcessResult): string {
  const lines = events(result.stdout);
  const failed = lines.find(line => line.type === 'error');
  if (failed) throw new Fault('EXECUTOR_FAILED', JSON.stringify(failed));
  return lines.flatMap(line => {
    const part = line.part as { text?: string } | undefined;
    return line.type === 'text' ? [part?.text ?? ''] : [];
  }).join('\n');
}

const specs: CliSpec[] = [
  {
    name: 'codex', bin: 'codex', target: '@openai/codex/bin/codex.js',
    help: ['exec', '--help'], markers: ['--json', '--sandbox'],
    args: req => ['exec', '--json', '--ephemeral', '--color', 'never', '--sandbox',
      req.mode === 'read' ? 'read-only' : 'workspace-write', ...(!req.agent.provider ? ['--ignore-user-config'] : []),
      ...(process.platform === 'win32' && !req.agent.provider ? ['--enable', 'prefer_mxc'] : []),
      ...codexOptions(req), '--', req.prompt],
    coord: req => [...codexOptions(req), '--sandbox', 'read-only', '--', req.prompt],
    output: codexOutput,
  },
  {
    name: 'claude-code', bin: 'claude', target: '@anthropic-ai/claude-code/bin/claude.exe',
    help: ['--help'], markers: ['--print', '--output-format', '--effort', '--strict-mcp-config'],
    args: req => ['--print', '--output-format', 'json', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '',
      '--settings', '{"disableAllHooks":true}',
      '--tools', req.mode === 'read' ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write',
      ...(req.mode === 'write' ? ['--permission-mode', 'acceptEdits'] : []), ...claudeOptions(req), '--', req.prompt],
    coord: req => [...claudeOptions(req), '--', req.prompt],
    output: claudeOutput,
  },
  {
    name: 'opencode', bin: 'opencode', target: '@opencode/cli/bin/opencode.exe',
    help: ['run', '--help'], markers: ['--format', '--standalone'],
    args: req => ['run', '--standalone', '--format', 'json', '--archived', ...openCodeOptions(req), '--', req.prompt],
    coord: req => [...openCodeOptions(req), '--prompt', req.prompt],
    output: openCodeOutput,
    env: req => ({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          ...['read', 'glob', 'grep', ...(req.mode === 'write' ? ['edit'] : [])].map(action =>
            ({ action, resource: '*', effect: 'allow' })),
          { action: 'external_directory', resource: '*', effect: 'deny' },
        ],
      }),
    }),
  },
  { name: 'antigravity', bin: 'agy', target: '@google/antigravity/bin/agy.exe', help: ['--help'], markers: [] },
];

function createAdapter(spec: CliSpec, config: Config): Adapter {
  const settings = Object.hasOwn(config.harnesses, spec.name) ? config.harnesses[spec.name] : undefined;
  const file = settings?.executable ?? executable(spec.bin, spec.target);
  let probed = false;
  let version: string | undefined;
  let compatible = true;
  let catalogByModel: Record<string, Levels> = {};
  const inspect = async (args: string[]) => {
    if (!file) throw new Error('CLI ausente');
    return run(invocation(file, args, environment(settings?.forwardEnv)), process.cwd(), new AbortController().signal, 12_000, 8 * 1024 * 1024);
  };
  const adapter: Adapter = {
    name: spec.name,
    availability: () => Boolean(file && existsSync(file) && compatible && spec.args),
    async doctor() {
      if (!file || !existsSync(file)) {
        const appInstalled = spec.name === 'antigravity' && process.platform === 'win32' &&
          existsSync(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'));
        return { harness: spec.name, installed: appInstalled, execution: false, mcpClient: spec.name === 'antigravity' };
      }
      try {
        const result = await inspect(['--version']);
        version = result.stdout.trim().split('\n')[0];
        const help = await inspect(spec.help);
        compatible = result.code === 0 && help.code === 0 && spec.markers.every(marker => help.stdout.includes(marker));
        probed = true;
        if (spec.name === 'codex' && compatible) {
          try {
            const raw = await inspect(['debug', 'models']);
            const body = JSON.parse(raw.stdout) as { models: { slug: string; supported_reasoning_levels?: { effort: string }[] }[] };
            catalogByModel = Object.fromEntries(body.models.map(model =>
              [model.slug, levelMap((model.supported_reasoning_levels ?? []).map(level => level.effort))]));
          } catch { /* unknown capabilities remain unsupported */ }
        }
        if (spec.name === 'opencode' && compatible) {
          try {
            const raw = await inspect(['api', '--standalone', 'GET', '/api/model']);
            const body = JSON.parse(raw.stdout) as { data: { id: string; providerID: string; variants?: { id: string }[] }[] };
            catalogByModel = Object.fromEntries(body.data.map(model => [
              model.providerID + '/' + model.id, levelMap((model.variants ?? []).map(variant => variant.id)),
            ]));
          } catch { /* unknown capabilities remain unsupported */ }
        }
        return { harness: spec.name, installed: true, version, execution: adapter.availability(), cliCompatible: compatible };
      } catch {
        compatible = false;
        return { harness: spec.name, installed: true, execution: false, cliCompatible: false };
      }
    },
    efforts(agent) {
      if (!agent.model) return { levels: {}, source: 'modelo-não-especificado' };
      if (spec.name === 'codex' && !agent.provider && Object.hasOwn(catalogByModel, agent.model)) {
        return { levels: catalogByModel[agent.model], source: 'codex-model-catalog' };
      }
      const baseModel = agent.model.replace(/\[1m\]$/, '');
      const claudeVersion = Number(version?.match(/^2\.1\.(\d+)/)?.[1] ?? 0);
      const minimum = baseModel === 'claude-fable-5-2' ? 321 : baseModel === 'claude-fable-5-1' ? 257 : 0;
      if (spec.name === 'claude-code' && probed && compatible && !agent.provider &&
          Object.hasOwn(claudeLevels, baseModel) && claudeVersion >= minimum) {
        return { levels: levelMap(claudeLevels[baseModel].filter(level => level !== 'ultracode' || claudeVersion >= 203)),
          source: 'claude-code-official-model-table' };
      }
      if (spec.name === 'opencode' && Object.hasOwn(catalogByModel, agent.model)) {
        return { levels: catalogByModel[agent.model], source: 'opencode-model-catalog' };
      }
      const catalog = config.effortCatalog[spec.name];
      return {
        levels: catalog && Object.hasOwn(catalog, agent.model) ? catalog[agent.model] : {},
        source: 'operator-verified',
      };
    },
  };
  if (spec.args && spec.output) {
    const args = spec.args;
    const output = spec.output;
    adapter.execute = async req => {
      if (!file || !adapter.availability()) throw new Fault('HARNESS_UNAVAILABLE', 'Harness indisponível.');
      if (spec.name === 'opencode' && req.agent.model && (!req.agent.model.includes('/') || (req.agent.provider && !req.agent.model.startsWith(req.agent.provider + '/')))) {
        throw new Fault('MODEL_INVALID', 'OpenCode requer um modelo no formato provider/model.');
      }
      const cliArgs = args(req);
      // Only record options before the positional prompt and omit arbitrary configuration.
      const flags = cliArgs.slice(0, cliArgs.indexOf('--'));
      const option = (name: string) => {
        const index = flags.indexOf(name);
        return index < 0 ? [] : [name, flags[index + 1]];
      };
      const reasoning = flags.find(value => value.startsWith('model_reasoning_effort='));
      req.log(JSON.stringify({
        event: 'cli-options', harness: spec.name,
        argv: [...option('--model'), ...option('--effort'), ...option('--sandbox'), ...option('--enable'), ...(reasoning ? ['-c', reasoning] : [])],
      }));
      const command = invocation(file, cliArgs, { ...environment(settings?.forwardEnv), ...spec.env?.(req) });
      const result = await run(command, req.cwd, req.signal, req.timeout);
      if (result.stderr.trim()) req.log(result.stderr.trim().slice(-12_000));
      if (result.code !== 0) {
        throw new Fault('EXECUTOR_FAILED', 'Executor saiu com código ' + result.code + '. ' +
          (result.stdout.trim() || result.stderr.trim()).slice(-4000));
      }
      const answer = output(result).trim();
      if (!answer) throw new Fault('NO_OUTPUT', 'O executor encerrou sem mensagem final.');
      return answer;
    };
  }
  if (spec.coord) {
    const coord = spec.coord;
    adapter.coordinate = async req => {
      if (!file || !adapter.availability()) throw new Fault('HARNESS_UNAVAILABLE', 'Harness indisponível.');
      const command: Invocation = invocation(file, coord(req));
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command.file, command.args, { cwd: req.cwd, stdio: 'inherit', shell: false });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(new Error('Coordenador saiu com código ' + code)));
      });
    };
  }
  return adapter;
}
export function createAdapters(config: Config): Map<string, Adapter> {
  return new Map(specs.map(spec => [spec.name, createAdapter(spec, config)]));
}
