import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/);
export const opaque = z.string().regex(/^[a-f0-9]{64}$/);
export const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !value.includes('\0'));
export const modes = z.enum(['read', 'write']);
const absolute = z.string().refine(value => isAbsolute(value) && !value.includes('\0'));
const builtInRoles = ['orchestrator', 'architect', 'implementer', 'reviewer', 'tester', 'researcher', 'debugger'];
export const effort = id;
export const complexity = z.enum(['simple', 'normal', 'complex']);
export const agentSchema = z.strictObject({
  harness: id, roles: z.array(id).min(1), capabilities: z.array(id).default([]),
  provider: id.optional(), model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}(?:\[1m\])?$/).optional(),
  effort: effort.default('auto'),
  effortFallback: effort.optional(),
  autoEffort: z.strictObject({ simple: effort, normal: effort, complex: effort }).optional(),
  instructions: text(3000).optional(),
  priority: z.number().int().default(0), estimatedCost: z.number().nonnegative().optional(),
});
const profile = z.strictObject({
  repository: absolute, agents: z.array(id).min(1),
  approval: z.enum(['required', 'delegated', 'unattended']).default('required'),
  allowWrite: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(3_600_000).default(300_000),
  maxAttempts: z.number().int().min(1).max(10).default(2),
});
export const configSchema = z.strictObject({
  port: z.number().int().min(1024).max(65535).default(17844),
  concurrency: z.number().int().min(1).max(16).default(2),
  roles: z.array(id).default([]),
  effortCatalog: z.record(id, z.record(z.string().min(1), z.record(id, id))).default({}),
  harnesses: z.record(id, z.strictObject({
    executable: absolute.optional(),
    forwardEnv: z.array(z.string().regex(/^[A-Z_][A-Z_0-9]*$/)).default([]),
  })).default({}),
  agents: z.record(id, agentSchema).default({}),
  profiles: z.record(id, profile).default({}),
}).superRefine((config, ctx) => {
  for (const [name, entry] of Object.entries(config.agents)) {
    if (entry.roles.some(role => ![...builtInRoles, ...config.roles].includes(role))) {
      ctx.addIssue({ code: 'custom', path: ['agents', name, 'roles'], message: 'Papel não cadastrado' });
    }
  }
  for (const [name, entry] of Object.entries(config.profiles)) {
    if (new Set(entry.agents).size !== entry.agents.length ||
        entry.agents.some(key => !Object.hasOwn(config.agents, key))) {
      ctx.addIssue({ code: 'custom', path: ['profiles', name, 'agents'], message: 'Equipe inválida' });
    }
  }
});

export type Config = z.infer<typeof configSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Profile = z.infer<typeof profile>;
export const dataDir = () => resolve(process.env.HIVEMIND_HOME ?? join(homedir(), '.hivemind'));

export function loadConfig(dir: string): Config {
  try {
    return configSchema.parse(parse(readFileSync(join(dir, 'agents.yaml'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return configSchema.parse({});
    if (error instanceof z.ZodError) throw new Error(error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('\n'));
    throw new Error('Não foi possível ler agents.yaml. Verifique o YAML e as permissões.');
  }
}

export function secret(dir: string, name: 'access' | 'admin', create = false): string {
  const path = join(dir, name + '.token');
  if (create) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return opaque.parse(readFileSync(path, 'utf8').trim());
}

export function matches(expected: string, candidate: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(candidate);
  return left.length === right.length && timingSafeEqual(left, right);
}
