import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { arcodexCli } from '../src/providers/agentrouter-cli.mjs';
import { mergeSystem } from '../src/providers/base.mjs';

for (const [binary, provider] of [['arcodex', arcodexCli]]) {
  test(`${binary}: prompt is one literal argument and stdin is empty`, async (t) => {
    const scratch = fileURLToPath(new URL('../.scratch/', import.meta.url));
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(join(scratch, 'router-argv-'));
    const log = join(dir, 'argv.json');
    const previous = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
    t.after(async () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    });
    await writeFile(join(dir, binary), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input: fs.readFileSync(0, 'utf8') }));
fs.writeFileSync(args[args.indexOf('-o') + 1], 'answer');
`, { mode: 0o755 });
    process.env.PATH = dir;
    process.env.TMPDIR = dir;
    const prompt = '--flag-looking текст\n"quotes" \'single\' `literal` $(literal) $HOME';
    for (const system of ['system instructions', undefined]) {
      const response = await provider.complete({ prompt, system, model: 'custom', timeoutMs: 5000 });
      assert.equal(response.text, 'answer');
      const { args, input } = JSON.parse(await readFile(log, 'utf8'));
      assert.equal(input, '', 'AgentRouter receives the prompt through argv, without changing runProcess stdin');
      assert.deepEqual(args.slice(-2), ['--', mergeSystem(system, prompt)]);
      assert.ok(!args.includes('-'), 'no stdin prompt marker');
    }
  });
}
