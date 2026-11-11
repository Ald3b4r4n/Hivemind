import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fault } from './storage.js';

const windows = process.platform === 'win32';
export interface Invocation { file: string; args: string[]; env?: NodeJS.ProcessEnv; }
export const script = fileURLToPath(new URL('../scripts/process-tree.ps1', import.meta.url));
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export function executable(name: string, npmTarget?: string): string | undefined {
  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const dir = entry.replace(/^"|"$/g, '');
    const candidates = windows
      ? [join(dir, name + '.exe'), ...(npmTarget && existsSync(join(dir, name + '.cmd')) ? [join(dir, 'node_modules', npmTarget)] : [])]
      : [join(dir, name)];
    const found = candidates.find(path => existsSync(path) && statSync(path).isFile());
    if (found) return found;
  }
}
export function invocation(file: string, args: string[], env?: NodeJS.ProcessEnv): Invocation {
  const extension = extname(file).toLowerCase();
  if (extension === '.js' || extension === '.mjs') return { file: process.execPath, args: [file, ...args], env };
  if (windows && extension !== '.exe') throw new Fault('INVALID_EXECUTABLE', 'Informe um executável .exe ou um ponto de entrada Node.');
  return { file, args, env };
}

const base = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'XDG_CACHE_HOME', 'LANG', 'LC_ALL', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
]);
export function environment(allow: string[] = []): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    base.has(key.toUpperCase()) || allow.includes(key.toUpperCase())));
}

export interface ProcessResult { code: number | null; stdout: string; stderr: string; }
export function run(command: Invocation, cwd: string, signal: AbortSignal, timeout: number, limit = 2 * 1024 * 1024): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Fault('CANCELLED', 'Execução cancelada.'));
    const child = spawn(windows ? powershell : command.file, windows
      ? ['-NoProfile', '-NonInteractive', '-File', script]
      : command.args, {
      cwd, env: command.env ?? environment(), shell: false, detached: !windows,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let fault: Fault | undefined;
    let size = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stop = (code: string, message: string) => {
      if (fault) return;
      fault = new Fault(code, message);
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (windows) child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => stop('TIMEOUT', 'O executor excedeu o tempo limite.'), timeout);
    const cancel = () => stop('CANCELLED', 'Execução cancelada.');
    signal.addEventListener('abort', cancel, { once: true });
    const collect = (destination: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) stop('OUTPUT_LIMIT', 'O executor excedeu o limite de saída.');
      else destination.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', () => { /* close reports the process result */ });
    child.on('error', () => { fault ??= new Fault('SPAWN_FAILED', 'Não foi possível iniciar o executor.'); });
    child.on('exit', () => {
      // Kill background descendants that kept the pipes open on POSIX.
      if (!windows && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already exited */ }
      }
    });
    child.on('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (fault) reject(fault);
      else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(windows ? Buffer.from(JSON.stringify({ ...command, env: undefined, parent: process.pid })).toString('base64') + '\n' : undefined);
  });
}
