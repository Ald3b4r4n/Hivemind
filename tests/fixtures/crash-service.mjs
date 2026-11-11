import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../../dist/config.js';
import { serve } from '../../dist/server.js';

const home = process.argv[2];
const adapter = {
  name: 'fake',
  availability: () => true,
  doctor: async () => ({ installed: true, execution: true }),
  efforts: () => ({ levels: { low: 'l', medium: 'm', high: 'h' }, source: 'fake' }),
  async execute({ cwd, signal }) {
    writeFileSync(join(cwd, 'running.marker'), 'started');
    await delay(30_000, undefined, { signal });
    return 'done';
  },
};
await serve(home, loadConfig(home), new Map([[adapter.name, adapter]]));
process.send?.('ready');
