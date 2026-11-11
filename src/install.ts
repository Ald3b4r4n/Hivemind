import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, type Node } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { readText, replaceText } from './install-files.js';
import { environment, executable, invocation } from './process.js';

const name = 'hivemind-orchestrator';
const location = new URL('../skills/' + name + '/SKILL.md', import.meta.url);
const canonical = readFileSync(location, 'utf8');
const previousSkill = '7b6f63c5c641c34f57a64333255f4382ee30761f83d0cc7009feca02e6594a49';
const entry = fileURLToPath(new URL('./cli.js', import.meta.url));
export const clientNames = ['codex', 'claude-code', 'opencode', 'antigravity'] as const;
type Harness = typeof clientNames[number];
type Options = { apply?: boolean; updateSkill?: boolean; repair?: boolean; skillOnly?: boolean };
type Outcome = 'missing' | 'configured' | 'update-available' | 'customized' | 'conflict' | 'manual' | 'installed' | 'updated' | 'error';
type Plan = { status: Outcome; path: string; before?: string; after?: string; detail?: string };
type Report = Omit<Plan, 'before' | 'after'> & { backup?: string };
type Mapping = Record<string, unknown>;
const object = (value: unknown): value is Mapping => typeof value === 'object' && value !== null && !Array.isArray(value);
const child = (value: unknown, key: string) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const skillVersion = (text: string) => text.match(/^<!-- hivemind-skill: ([^ \r\n]+) -->\r?$/m)?.[1];

function jsonTree(text: string, jsonc: boolean): Node {
  const errors: { error: number; offset: number; length: number }[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: jsonc, disallowComments: !jsonc });
  if (!tree || tree.type !== 'object' || errors.length) throw new Error('JSON/JSONC inválido.');
  function validate(node: Node) {
    if (node.type === 'object') {
      const keys = node.children?.map(property => String(property.children?.[0]?.value)) ?? [];
      if (new Set(keys).size !== keys.length) throw new Error('JSON/JSONC com chaves duplicadas.');
    }
    node.children?.forEach(validate);
  }
  validate(tree);
  return tree;
}
const withoutBom = (value: string) => value.replace(/^\uFEFF/, '');
const clientExecutable = (name: Harness) => {
  switch (name) {
    case 'codex': return executable('codex', '@openai/codex/bin/codex.js');
    case 'claude-code': return executable('claude', '@anthropic-ai/claude-code/bin/claude.exe');
    case 'opencode': return executable('opencode', '@opencode/cli/bin/opencode.exe');
    case 'antigravity': {
      const app = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe');
      return executable('agy', '@google/antigravity/bin/agy.exe') ?? executable('antigravity') ??
        (process.platform === 'win32' && existsSync(app) ? app : undefined);
    }
  }
};

function openCodeMajor(file: string | undefined) {
  if (!file) return undefined;
  try {
    const command = invocation(file, ['--version'], environment());
    const version = execFileSync(command.file, command.args, {
      encoding: 'utf8', env: command.env, timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    return Number(version.match(/\b[vV]?(\d+)\.\d+\.\d+\b/)?.[1]) || undefined;
  } catch { return undefined; }
}

function layout(harness: Harness, root: string, home: string, executable: string | undefined) {
  const args = [entry, 'bridge', '--home', home];
  const standard = { command: process.execPath, args };
  const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  const opencodeFiles = ['opencode.json', 'opencode.jsonc'].map(file => join(root, file));
  const selected = opencodeFiles.filter(path => existsSync(path));
  const files = {
    codex: { path: join(codexHome, 'config.toml'), keys: ['mcp_servers', 'hivemind'], value: standard },
    'claude-code': { path: join(root, '.mcp.json'), keys: ['mcpServers', 'hivemind'], value: { type: 'stdio', ...standard } },
    opencode: {
      path: selected[0] ?? opencodeFiles[0], keys: ['mcp', 'servers', 'hivemind'],
      value: { type: 'local', command: [process.execPath, ...args] },
    },
    antigravity: { path: join(root, '.agents', 'mcp_config.json'), keys: ['mcpServers', 'hivemind'], value: standard },
  };
  return { ...files[harness], ambiguous: harness === 'opencode' && selected.length > 1,
    unsupported: harness === 'opencode' && executable !== undefined && openCodeMajor(executable) !== 2,
    skill: join(root, harness === 'claude-code' ? '.claude' : '.agents', 'skills', name, 'SKILL.md') };
}
type Layout = ReturnType<typeof layout>;

function inheritedConflict(harness: Harness, root: string, layout: Layout) {
  const user = homedir();
  const folders = [join(process.env.XDG_CONFIG_HOME ?? join(user, '.config'), 'opencode')];
  const paths = harness === 'opencode' ? [
    ...folders.flatMap(dir => [join(dir, 'opencode.json'), join(dir, 'opencode.jsonc')]),
    ...(process.env.OPENCODE_CONFIG ? [resolve(process.env.OPENCODE_CONFIG)] : []),
  ] : harness === 'antigravity' ? [
    join(user, '.gemini', 'config', 'mcp_config.json'), join(user, '.gemini', 'antigravity', 'mcp_config.json'),
    ...['.agent', '_agents', '_agent'].map(dir => join(root, dir, 'mcp_config.json')),
  ] : harness === 'claude-code' ? [
    join(user, '.claude.json'), ...(process.env.CLAUDE_CONFIG_DIR ? [join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')] : []),
  ] : [];
  for (const path of new Set(paths)) {
    if (path === layout.path) continue;
    const source = readText(path);
    if (source === undefined) continue;
    const tree = jsonTree(withoutBom(source), harness === 'opencode');
    const data: unknown = getNodeValue(tree);
    const inherited = layout.keys.reduce(child, data);
    const legacy = harness === 'opencode' ? child(child(data, 'mcp'), 'hivemind') : undefined;
    const projects = child(data, 'projects');
    const normalized = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
    const local = harness === 'claude-code' && object(projects)
      ? Object.entries(projects).find(([folder]) => isAbsolute(folder) && normalized(folder) === normalized(root))?.[1]
      : undefined;
    if ([inherited, legacy, child(child(local, 'mcpServers'), 'hivemind')]
      .some(value => value !== undefined && !sameEntry(value, layout.value))) return true;
  }
  return false;
}

function equivalent(left: unknown, right: unknown): boolean {
  if (object(left) && object(right)) {
    const keys = Object.keys(right);
    return keys.length === Object.keys(left).length && keys.every(key =>
      Object.hasOwn(left, key) && equivalent(left[key], right[key]));
  }
  return isDeepStrictEqual(left, right);
}

function sameEntry(left: unknown, right: unknown) {
  if (equivalent(left, right)) return true;
  // Claude accepts both explicit and implicit stdio type.
  if (object(left) && object(right) && right.type === 'stdio' && !Object.hasOwn(left, 'type')) {
    return equivalent({ ...left, type: 'stdio' }, right);
  }
  return false;
}

function repairable(existing: unknown, value: Layout['value']) {
  if (!object(existing)) return false;
  const current = object(value) && Array.isArray(value.command) ? value.command : [value.command, ...('args' in value ? value.args : [])];
  const old = Array.isArray(existing.command) ? existing.command
    : typeof existing.command === 'string' && Array.isArray(existing.args) ? [existing.command, ...existing.args] : [];
  const oldEntry = old[1];
  if (typeof oldEntry !== 'string' || !isAbsolute(oldEntry) ||
      !/[/\\]node_modules[/\\]hivemind-orchestrator[/\\]dist[/\\]cli\.js$/i.test(oldEntry) ||
      !isDeepStrictEqual(old.slice(2), current.slice(2))) return false;
  const expected = Array.isArray(value.command)
    ? { type: 'local', command: old }
    : { ...value, command: old[0], args: old.slice(1) };
  return typeof old[0] === 'string' && isAbsolute(old[0]) && sameEntry(existing, expected);
}

function configPlan(harness: Harness, root: string, setup: Layout, repair: boolean): Plan {
  const { path, keys, value } = setup;
  if (setup.unsupported) return { path, status: 'manual', detail: 'Instalação automática requer OpenCode 2 detectável.' };
  if (setup.ambiguous) return { path, status: 'manual', detail: 'opencode.json e opencode.jsonc coexistem.' };
  try {
    const before = readText(path);
    const source = withoutBom(before ?? '');
    const bom = before?.startsWith('\uFEFF') ? '\uFEFF' : '';
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const toml = harness === 'codex';
    const tree = toml ? undefined : jsonTree(source || '{}', path.endsWith('.jsonc'));
    const data: unknown = tree ? getNodeValue(tree) : parseToml(source);
    const exists = keys.reduce(child, data);
    const parent = keys.slice(0, -1).reduce(child, data);
    if ((parent !== undefined && !object(parent)) || (harness === 'opencode' &&
      (child(data, 'mcp') !== undefined && !object(child(data, 'mcp')) || child(child(data, 'mcp'), 'hivemind') !== undefined))) {
      return { path, status: 'manual', detail: 'Estrutura MCP incompatível. Confira o esquema do cliente.' };
    }
    if (inheritedConflict(harness, root, setup)) return { path, status: 'conflict', detail: 'Uma configuração herdada já define hivemind.' };
    if (sameEntry(exists, value)) return { path, status: 'configured' };
    if (exists !== undefined && (!repair || toml || !repairable(exists, value))) {
      return { path, status: 'conflict', detail: 'Já existe uma entrada hivemind diferente. Revise-a no cliente.' };
    }
    let after: string;
    if (toml && 'args' in value) {
      const lines = ['[mcp_servers.hivemind]', 'command = ' + JSON.stringify(value.command), 'args = ' + JSON.stringify(value.args)];
      after = source + (source && !source.endsWith('\n') ? eol : '') + (source ? eol : '') + lines.join(eol) + eol;
      const patched = parseToml(after);
      if (!sameEntry(keys.reduce(child, patched), value)) throw new Error('Edição TOML ambígua.');
    } else if (tree) {
      // Reject scalar or array ancestors before the editor tries to replace them.
      for (let size = 1; size < keys.length; size++) {
        const node = findNodeAtLocation(tree, keys.slice(0, size));
        if (node && node.type !== 'object') throw new Error('Contêiner MCP inválido.');
      }
      after = applyEdits(source || '{}', modify(source || '{}', keys, value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol },
      }));
      if (!sameEntry(keys.reduce(child, getNodeValue(jsonTree(after, path.endsWith('.jsonc')))), value)) throw new Error('Edição JSON ambígua.');
      if (before === undefined) after += eol;
    } else {
      throw new Error('Formato de configuração inesperado.');
    }
    return { path, status: before === undefined || exists === undefined ? 'missing' : 'update-available', before, after: bom + after };
  } catch {
    return { path, status: 'manual', detail: 'Arquivo, formato ou configuração herdada ambíguos. Use a entrada sugerida manualmente.' };
  }
}

function skillPlan(path: string, update: boolean): Plan {
  try {
    const before = readText(path);
    if (before === undefined) return { path, status: 'missing', after: canonical };
    const normalized = before.replaceAll('\r\n', '\n');
    if (normalized === canonical.replaceAll('\r\n', '\n')) return { path, status: 'configured' };
    if (createHash('sha256').update(normalized).digest('hex') === previousSkill) {
      return { path, status: 'update-available', before, after: update ? canonical : undefined,
        detail: 'Cópia oficial da Preview 1/2. Use --apply --update-skill.' };
    }
    return { path, status: 'customized', detail: 'Conteúdo local preservado. Compare com a skill canônica do pacote.' };
  } catch {
    return { path, status: 'manual', detail: 'Arquivo local inacessível ou formato inválido.' };
  }
}
function apply(plan: Plan, home: string, authorized: boolean): Report {
  const { before, after, ...report } = plan;
  if (!authorized || after === undefined) return report;
  try {
    const backup = replaceText(plan.path, before, after, home);
    return { path: plan.path, status: before === undefined ? 'installed' : 'updated', backup };
  } catch {
    return { path: plan.path, status: 'error', detail: 'A escrita não foi concluída. Revise permissões, bloqueios e alterações concorrentes.' };
  }
}

export function install(harness: string, root: string, home: string, options: Options = {}) {
  if (!clientNames.some(name => name === harness)) throw new Error('Harness inválido. Use codex, claude-code, opencode ou antigravity.');
  const client = harness as Harness;
  root = resolve(root);
  if (options.apply && !statSync(root).isDirectory()) throw new Error('O projeto precisa ser um diretório existente.');
  const file = clientExecutable(client);
  const setup = layout(client, root, home, file);
  const plannedSkill = skillPlan(setup.skill, options.updateSkill === true);
  const plan = options.skillOnly ? { path: setup.path, status: 'manual' as const } : configPlan(client, root, setup, options.repair === true);
  const skill = apply(plannedSkill, home, options.apply === true);
  const config = apply(plan, home, options.apply === true);
  let installedVersion: string | undefined;
  try {
    const content = readText(setup.skill);
    installedVersion = content === undefined ? undefined : skillVersion(content) ??
      (createHash('sha256').update(content.replaceAll('\r\n', '\n')).digest('hex') === previousSkill ? 'preview.1/2' : 'unknown');
  } catch { /* diagnostic only */ }
  return {
    harness: client, detected: file !== undefined, applied: options.apply === true,
    config, skill: setup.skill, skillStatus: skill, skillVersion: installedVersion,
    canonicalSkillVersion: skillVersion(canonical),
    copied: skill.status === 'installed', sameVersion: ['installed', 'updated', 'configured'].includes(skill.status),
    mcp: { file: setup.path, path: setup.keys, entry: setup.value },
  };
}
