import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { matches, opaque, secret } from './config.js';
import { Fault } from './storage.js';
import { version } from './version.js';

export const endpoint = (port: number) => 'http://127.0.0.1:' + port;
const identitySchema = z.strictObject({
  instance: z.uuid(), database: opaque, pid: z.number().int().positive(), startedAt: z.iso.datetime(),
  port: z.number().int().min(1024).max(65535), version: z.string(), protocol: z.string(),
});
type Identity = z.infer<typeof identitySchema>;
type State = { state: 'inactive' | 'unverified' | 'starting'; port: number }
  | { state: 'active' | 'stopping'; port: number; identity: Identity; running: number; queued: number };
const receipt = (dir: string) => join(dir, 'service.json');
function databaseId(dir: string) {
  const path = realpathSync.native(dir);
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
}
export function identity(dir: string, port: number): Identity {
  return { instance: randomUUID(), database: databaseId(dir), pid: process.pid,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    port, version, protocol: LATEST_PROTOCOL_VERSION };
}
export function saveIdentity(dir: string, value: Identity) {
  const temp = join(dir, '.service-' + value.instance + '.tmp');
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(temp, receipt(dir));
  } finally {
    rmSync(temp, { force: true });
  }
}
export function removeIdentity(dir: string, instance: string) {
  try {
    const current = identitySchema.parse(JSON.parse(readFileSync(receipt(dir), 'utf8')));
    if (current.instance === instance) rmSync(receipt(dir));
  } catch { /* missing or already replaced */ }
}
function ownsReceipt(dir: string, instance: string) {
  try { return identitySchema.parse(JSON.parse(readFileSync(receipt(dir), 'utf8'))).instance === instance; }
  catch { return false; }
}
export function lifecycleLog(dir: string, event: string, reason?: string) {
  // Replace the last event. This file never contains subprocess output or request data.
  try {
    writeFileSync(join(dir, 'service.log'), JSON.stringify({ time: new Date().toISOString(), event, reason }) + '\n',
      { mode: 0o600 });
  } catch { /* diagnostic only */ }
}

function signature(key: string, purpose: string, payload: unknown) {
  return createHmac('sha256', key).update(JSON.stringify([purpose, payload])).digest('hex');
}
export function signedIdentity(key: string, value: Identity, challenge: string, stopping: boolean, starting: boolean, running: number, queued: number) {
  const data = { identity: value, stopping, starting, running, queued };
  return { ...data, proof: signature(key, 'identity', [challenge, data]) };
}
function stopProof(key: string, instance: string) {
  return signature(key, 'stop', instance);
}
export function verifyStop(key: string, instance: string, proof: string) {
  return matches(stopProof(key, instance), proof);
}

async function probe(dir: string, port: number): Promise<State> {
  const challenge = randomUUID();
  let response: Response;
  try {
    response = await fetch(endpoint(port) + '/service/identity?challenge=' + challenge,
      { redirect: 'manual', signal: AbortSignal.timeout(1500), headers: { Connection: 'close' } });
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return { state: code === 'ECONNREFUSED' ? 'inactive' : 'unverified', port };
  }
  try {
    if (!response.ok) return { state: 'unverified', port };
    const { proof, ...data } = z.strictObject({
      identity: identitySchema, stopping: z.boolean(), starting: z.boolean(), running: z.number().int().nonnegative(),
      queued: z.number().int().nonnegative(), proof: opaque,
    }).parse(await response.json());
    const key = secret(dir, 'admin');
    if (data.identity.port !== port || data.identity.database !== databaseId(dir) ||
        !matches(signature(key, 'identity', [challenge, data]), proof)) return { state: 'unverified', port };
    return data.starting ? { state: 'starting', port } : {
      state: data.stopping ? 'stopping' : 'active', port,
      identity: data.identity, running: data.running, queued: data.queued,
    };
  } catch { return { state: 'unverified', port }; }
}

export async function serviceStatus(dir: string, port: number): Promise<State> {
  let previous: Identity | undefined;
  try { previous = identitySchema.parse(JSON.parse(readFileSync(receipt(dir), 'utf8'))); }
  catch { /* recovery can still use the configured endpoint */ }
  if (previous && previous.port !== port) {
    const old = await probe(dir, previous.port);
    if (old.state === 'active' || old.state === 'stopping' || old.state === 'starting') return old;
  }
  return probe(dir, port);
}

const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
export async function startService(dir: string, port: number) {
  const before = await serviceStatus(dir, port);
  if (before.state === 'active') return { ...before, alreadyRunning: true };
  if (before.state === 'unverified' || before.state === 'stopping') {
    throw new Fault('SERVICE_UNVERIFIED', 'Porta ocupada ou serviço encerrando. Verifique com status antes de iniciar.');
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (before.state === 'inactive') {
    const child = spawn(process.execPath, [cli, 'serve', '--home', dir], {
      cwd: dir, detached: true, windowsHide: true, stdio: 'ignore', shell: false,
    });
    const spawned = await new Promise<boolean>(resolve => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    child.unref();
    if (!spawned) throw new Fault('START_FAILED', 'Não foi possível lançar o processo residente.');
  }
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const current = await serviceStatus(dir, port);
    if (current.state === 'active') return current;
    if (current.state === 'unverified') break;
    await delay(200);
  }
  throw new Fault('START_FAILED', 'O serviço não confirmou a inicialização. Consulte service.log e hivemind doctor.');
}
export async function stopService(dir: string, port: number) {
  const current = await serviceStatus(dir, port);
  if (current.state === 'inactive') return current;
  if (current.state !== 'active' && current.state !== 'stopping') {
    throw new Fault('SERVICE_UNVERIFIED', 'Não foi possível identificar o serviço. Nenhum processo foi encerrado.');
  }
  const instance = current.identity.instance;
  if (current.state === 'active') {
    const response = await fetch(endpoint(current.port) + '/service/stop', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(4000),
      headers: { 'X-Hivemind-Stop': stopProof(secret(dir, 'admin'), instance), Connection: 'close' },
    });
    if (response.status === 409) {
      throw new Fault('SERVICE_BUSY', 'Há tarefas em execução ou na fila. Aguarde ou cancele explicitamente pelo MCP.');
    }
    if (response.status !== 202) throw new Fault('SERVICE_UNVERIFIED', 'O serviço não aceitou o encerramento autenticado.');
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = await probe(dir, current.port);
    if (status.state === 'inactive' && !ownsReceipt(dir, instance)) return status;
    if (status.state === 'unverified' || ('identity' in status && status.identity.instance !== instance)) {
      throw new Fault('SERVICE_UNVERIFIED', 'A identidade do serviço mudou durante o encerramento.');
    }
    await delay(100);
  }
  throw new Fault('STOP_TIMEOUT', 'O serviço ainda está encerrando. Consulte status.');
}
