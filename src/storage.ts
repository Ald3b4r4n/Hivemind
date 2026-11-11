import { DatabaseSync } from 'node:sqlite';

export const states = ['CREATED', 'PLANNED', 'QUEUED', 'RUNNING', 'REVIEWING', 'BLOCKED', 'FAILED', 'COMPLETED', 'CANCELLED'] as const;
export type State = typeof states[number];
const transitions: Record<State, State[]> = {
  CREATED: ['PLANNED', 'CANCELLED'],
  PLANNED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['RUNNING', 'BLOCKED', 'CANCELLED'],
  RUNNING: ['REVIEWING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'],
  REVIEWING: ['COMPLETED', 'CANCELLED'],
  BLOCKED: ['QUEUED', 'PLANNED', 'CANCELLED'],
  FAILED: ['QUEUED', 'PLANNED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: ['PLANNED'],
};
export class Fault extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function transition(item: { state: State }, next: State): void {
  if (!transitions[item.state].includes(next)) {
    throw new Fault('INVALID_STATE', 'Transição inválida: ' + item.state + ' → ' + next);
  }
  item.state = next;
}
export class Store<T extends { id: string }> {
  private db: DatabaseSync;

  constructor(path: string) {
    const db = new DatabaseSync(path);
    this.db = db;
    try {
      db.exec(`
        PRAGMA busy_timeout = 500;
        PRAGMA locking_mode = EXCLUSIVE;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS logs (
          seq INTEGER PRIMARY KEY, job TEXT NOT NULL, task TEXT NOT NULL,
          time TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS logs_job_seq ON logs(job, seq);
        COMMIT;
      `);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  atomic<R>(action: () => R): R {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get(id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id = ?').get(id);
    return row && JSON.parse(String(row.data)) as T;
  }
  all(): T[] {
    return this.db.prepare('SELECT data FROM jobs ORDER BY rowid').all().map(row => JSON.parse(String(row.data)) as T);
  }
  save(job: T): void {
    this.db.prepare('INSERT INTO jobs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(job.id, JSON.stringify(job));
  }
  log(job: string, task: string, type: string, message: string): void {
    this.db.prepare('INSERT INTO logs(job, task, time, type, message) VALUES (?, ?, ?, ?, ?)')
      .run(job, task, new Date().toISOString(), type, message);
  }
  logs(job: string, task: string | undefined, after: number, limit: number) {
    return this.db.prepare(`
      SELECT seq, task, time, type, message FROM logs WHERE job = ? AND seq > ?
      AND (? IS NULL OR task = ?) ORDER BY seq LIMIT ?
    `).all(job, after, task ?? null, task ?? null, limit);
  }
  close(): void { this.db.close(); }
}
