import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Fault } from './storage.js';

const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
const hooks = process.platform === 'win32' ? 'NUL' : '/dev/null';
const sha = /^[a-f0-9]{40,64}$/;
export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=' + hooks, '-c', 'commit.gpgsign=false', '-C', dir, ...args], {
    encoding: 'utf8', env: gitEnvironment, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

export function repository(path: string) {
  try {
    const root = realpathSync.native(git(path, 'rev-parse', '--show-toplevel'));
    if (root !== realpathSync.native(path)) throw new Error();
    const head = git(root, 'rev-parse', '--verify', 'HEAD');
    if (!sha.test(head)) throw new Error();
    return { root, head };
  } catch {
    throw new Fault('INVALID_REPOSITORY', 'O perfil deve apontar para a raiz de um repositório Git com commit.');
  }
}

export interface Workspace { path: string; branch: string; }
export interface Evidence {
  base: string; head: string; commit?: string; files: string[]; diff: string; output: string;
}
export function workspace(dir: string, job: string, task: string, attempt: number): Workspace {
  const name = job + '-' + task + '-' + attempt;
  return { path: resolve(realpathSync.native(dir), 'worktrees', name), branch: 'hivemind/' + name };
}

export function prepare(repo: string, ref: string, work: Workspace, commits: string[]): string {
  mkdirSync(resolve(work.path, '..'), { recursive: true, mode: 0o700 });
  git(repo, 'worktree', 'add', '-b', work.branch, work.path, ref);
  for (const commit of commits) {
    try {
      git(work.path, '-c', 'user.name=Hivemind', '-c', 'user.email=hivemind@localhost', 'cherry-pick', '--empty=drop', commit);
    } catch {
      try { git(work.path, 'cherry-pick', '--abort'); } catch { /* preserve the workspace for inspection */ }
      throw new Fault('GIT_CONFLICT', 'Falha ao integrar commit de dependência ' + commit + '. Inspecione a worktree.');
    }
  }
  return git(work.path, 'rev-parse', 'HEAD');
}

export function capture(work: Workspace, base: string, mode: 'read' | 'write', output: string): Evidence {
  const dir = work.path;
  if (git(dir, 'branch', '--show-current') !== work.branch) {
    throw new Fault('GIT_BRANCH_CHANGED', 'O executor mudou a branch da tarefa.');
  }
  const initialHead = git(dir, 'rev-parse', 'HEAD');
  const dirty = git(dir, 'status', '--porcelain', '--untracked-files=all');
  if (mode === 'read' && (dirty || initialHead !== base)) {
    throw new Fault('WRITE_DENIED', 'A tarefa de leitura modificou a worktree.');
  }
  if (mode === 'write') {
    git(dir, 'merge-base', '--is-ancestor', base, initialHead);
    if (initialHead !== base) git(dir, 'reset', '--soft', base);
    git(dir, 'add', '-A', '--');
    if (git(dir, 'diff', '--cached', '--name-only')) {
      git(dir, '-c', 'user.name=Hivemind', '-c', 'user.email=hivemind@localhost', 'commit', '-m', 'Hivemind ' + work.branch);
    }
  }
  const head = git(dir, 'rev-parse', 'HEAD');
  const files = git(dir, 'diff', '--name-only', '-z', base, head, '--').split('\0').filter(Boolean);
  const diff = git(dir, 'diff', '--no-ext-diff', '--no-textconv', base, head, '--');
  return { base, head, commit: head === base ? undefined : head, files, diff, output };
}

export function cleanup(repo: string, work: Workspace): void {
  const lines = git(repo, 'worktree', 'list', '--porcelain', '-z').split('\0');
  const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const registered = lines.some(line => line.startsWith('worktree ') && pathKey(line.slice(9)) === pathKey(work.path));
  if (registered) {
    try { git(repo, 'worktree', 'remove', '--', work.path); }
    catch { throw new Fault('WORKTREE_DIRTY', 'Git preservou a worktree. Verifique arquivos alterados ou ignorados.'); }
  }
}
