import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runProcess } from '../src/providers/base.mjs';

test('files CLI auto skips agy and selects an available offline provider', async t => {
  const scratch = fileURLToPath(new URL('../.scratch/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'files-regression-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'server.mjs'), 'const port = 8787;\n');
  await writeFile(join(dir, 'agy'), `#!${process.execPath}\nthrow new Error('files must skip agy');\n`, { mode: 0o755 });
  await writeFile(join(dir, 'gemini'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const policy = fs.readFileSync(args[args.indexOf('--policy') + 1], 'utf8');
if (!/google_web_search/.test(policy) || !/web_fetch/.test(policy) || !/decision = "deny"/.test(policy)) throw new Error('web must be disabled');
let input = ''; for await (const chunk of process.stdin) input += chunk;
if (!input.includes('8787')) throw new Error('missing corpus or worker answer');
process.stdout.write(JSON.stringify({ response: 'Port 8787 (server.mjs:1)' }));
`, { mode: 0o755 });
  const { stdout } = await runProcess(process.execPath, [
    fileURLToPath(new URL('../bin/swarm-search.mjs', import.meta.url)), 'run', 'port?',
    '--mode', 'files', '--paths', join(dir, 'server.mjs'), '--workers', '1', '--rounds', '1', '--rank', 'off', '--json',
  ], { timeoutMs: 10000, env: {
    PATH: dir, TMPDIR: scratch, SWARM_PROVIDER: 'auto',
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENROUTER_API_KEY: '',
  } });
  const { report, markdown } = JSON.parse(stdout);
  assert.equal(report.mode, 'files');
  assert.equal(report.workers[0].provider, 'gemini-cli');
  assert.equal(report.workers[0].ok, true);
  assert.equal(report.synthesis.provider, 'gemini-cli');
  assert.match(markdown, /_swarm-search · mode: files/);
});
