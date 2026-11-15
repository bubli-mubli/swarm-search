// Run explicitly: node test/response-format-mutation.mjs. Never edit the working implementation.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = join(root, '.task-483');
await mkdir(scratch, { recursive: true });
const mutations = [
  ['no-correction', 'src/swarm.mjs', 'if (!parsed.ok) {', 'if (false) {', 'FAILS_ON_OLD: synthesis retries once'],
  ['generic-correction', 'src/swarm.mjs', 'Violated format rule [${id}]: ${text}', 'Violated format rule: invalid response', 'FAILS_ON_OLD: the correction names the numbering rule'],
  ['prompt-drift', 'src/response-format.mjs', "headings.join(', ')", "'Sources, References, Источники, Ссылки'", 'changing the heading rule'],
  ['parser-drift', 'src/response-format.mjs', "headings.map(escapeRegex).join('|')", "'Sources|References|Источники|Ссылки'", 'changing the heading rule'],
];

for (const [name, file, before, after, pattern] of mutations) {
  const dir = await mkdtemp(join(scratch, `mutation-${name}-`));
  try {
    await cp(join(root, 'src'), join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'test'));
    await cp(join(root, 'test/response-format.test.mjs'), join(dir, 'test/response-format.test.mjs'));
    const path = join(dir, file);
    const original = await readFile(path, 'utf8');
    assert.equal(original.split(before).length, 2, `mutation ${name} must change exactly one occurrence`);
    await writeFile(path, original.replace(before, after));
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, join(dir, 'test/response-format.test.mjs')],
      { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    const output = result.stdout + result.stderr;
    await writeFile(join(scratch, `mutation-${name}.log`), output);
    assert.equal(result.status, 1, `mutation ${name} should fail assertions, not hang or crash: ${output}`);
    assert.match(output, /ERR_ASSERTION/, `mutation ${name} must be killed by an assertion`);
    assert.match(output, /# fail 1/);
    console.log(`${name}: KILLED (1 assertion failure)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
