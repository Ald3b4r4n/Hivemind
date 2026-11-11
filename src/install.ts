import { copyFileSync, constants, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'hivemind-orchestrator';
const location = fileURLToPath(new URL('../skills/' + name + '/SKILL.md', import.meta.url));
export function install(harness: string, root: string, home: string) {
  const entry = fileURLToPath(new URL('./cli.js', import.meta.url));
  const args = [entry, 'bridge', '--home', home];
  const config = { command: process.execPath, args };
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const powershell = [process.execPath, ...args].map(quote).join(' ');
  const setups: Record<string, { folder: string; instructions: unknown }> = {
    codex: {
      folder: '.agents/skills',
      instructions: 'codex mcp add hivemind -- ' + powershell,
    },
    'claude-code': {
      folder: '.claude/skills',
      instructions: 'claude mcp add --scope local --transport stdio hivemind -- ' + powershell,
    },
    opencode: {
      folder: '.agents/skills',
      instructions: { file: 'opencode.json', merge: { mcp: { servers: { hivemind: { type: 'local', command: [process.execPath, ...args] } } } } },
    },
    antigravity: {
      folder: '.agents/skills',
      instructions: { file: '.agents/mcp_config.json', merge: { mcpServers: { hivemind: config } } },
    },
  };
  if (!Object.hasOwn(setups, harness)) throw new Error('Harness inválido. Use codex, claude-code, opencode ou antigravity.');
  const setup = setups[harness];
  const dir = resolve(root, setup.folder, name);
  const target = join(dir, 'SKILL.md');
  mkdirSync(dir, { recursive: true });
  let copied = true;
  try {
    copyFileSync(location, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    copied = false;
  }
  return {
    skill: target, copied, sameVersion: copied || readFileSync(location, 'utf8') === readFileSync(target, 'utf8'),
    mcp: setup.instructions,
  };
}
