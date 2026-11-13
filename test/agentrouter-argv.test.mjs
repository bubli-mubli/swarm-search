import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { arcodexCli } from '../src/providers/agentrouter-cli.mjs';
import { mergeSystem } from '../src/providers/base.mjs';
import { installBinary } from './helpers.mjs';

test('arcodex: prompt is one literal argument and stdin is empty', async (t) => {
  const dir = await installBinary(t, 'arcodex', `
fs.writeFileSync(process.env.ARGV_LOG, JSON.stringify({ args, input: fs.readFileSync(0, 'utf8') }));
fs.writeFileSync(args[args.indexOf('-o') + 1], 'answer');`);
  const log = join(dir, 'argv.json');
  process.env.ARGV_LOG = log;
  t.after(() => { delete process.env.ARGV_LOG; });
  const prompt = '--flag-looking текст\n"quotes" \'single\' `literal` $(literal) $HOME';

  const withSystem = await arcodexCli.complete({ prompt, system: 'system instructions', model: 'custom', timeoutMs: 5000 });
  assert.equal(withSystem.text, 'answer');
  let seen = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(seen.input, '', 'prompt goes through argv, stdin stays empty');
  assert.deepEqual(seen.args.slice(-2), ['--', mergeSystem('system instructions', prompt)]);
  assert.ok(!seen.args.includes('-'), 'no stdin prompt marker');

  await arcodexCli.complete({ prompt, model: 'custom', timeoutMs: 5000 });
  seen = JSON.parse(await readFile(log, 'utf8'));
  assert.deepEqual(seen.args.slice(-2), ['--', mergeSystem(undefined, prompt)]);
});
