import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PROVIDERS } from '../src/providers/index.mjs';
import { DEFAULTS } from '../src/swarm.mjs';

export function setEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

export async function tempDir(t) {
  const scratch = fileURLToPath(new URL('../.scratch/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'swarm-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Кладёт в пустой PATH исполняемый node-скрипт `name`; в body доступен массив args.
export async function installBinary(t, name, body) {
  const dir = await tempDir(t);
  await writeFile(join(dir, name), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
${body}
`, { mode: 0o755 });
  setEnv(t, { PATH: dir, TMPDIR: dir });
  return dir;
}

// Подменяет detect() у всех провайдеров: доступны только перечисленные id.
export function mockAvailable(t, ids) {
  const backoff = DEFAULTS.retryBackoffMs;
  setEnv(t, { SWARM_PROVIDER: undefined });
  for (const provider of PROVIDERS) t.mock.method(provider, 'detect', () => ids.includes(provider.id));
  DEFAULTS.retryBackoffMs = 1;
  t.after(() => { DEFAULTS.retryBackoffMs = backoff; });
}
