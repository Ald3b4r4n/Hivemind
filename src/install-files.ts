import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function readText(path: string): string | undefined {
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size > 8 * 1024 * 1024) throw new Error('Arquivo especial ou maior que 8 MiB.');
    const bytes = readFileSync(path);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new Error('O arquivo não está em UTF-8.');
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function replaceText(path: string, before: string | undefined, after: string, home: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + '.hivemind.lock';
  writeFileSync(lock, '', { flag: 'wx', mode: 0o600 });
  const suffix = randomUUID();
  const temp = join(dirname(path), '.hivemind-' + suffix + '.tmp');
  try {
    if (readText(path) !== before) throw new Error('O arquivo mudou durante a instalação. Refaça a prévia.');
    let backup: string | undefined;
    if (before !== undefined) {
      const folder = join(home, 'backups');
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (!lstatSync(folder).isDirectory()) throw new Error('Diretório de backups inválido.');
      backup = join(folder, basename(path) + '.' + suffix + '.bak');
      writeFileSync(backup, before, { flag: 'wx', mode: 0o600 });
    }
    const mode = before === undefined ? 0o600 : lstatSync(path).mode & 0o777;
    writeFileSync(temp, after, { flag: 'wx', mode });
    if (readText(path) !== before) throw new Error('O arquivo mudou durante a instalação. Refaça a prévia.');
    renameSync(temp, path);
    return backup;
  } finally {
    rmSync(temp, { force: true });
    rmSync(lock, { force: true });
  }
}
