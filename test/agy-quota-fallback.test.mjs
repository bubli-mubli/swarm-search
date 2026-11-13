import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byId } from '../src/providers/index.mjs';
import { swarmSearch } from '../src/swarm.mjs';
import { installBinary, mockAvailable } from './helpers.mjs';

const quota = `process.stderr.write('429 RESOURCE_EXHAUSTED: Individual quota reached'); process.exit(3);`;

test('web: agy exit 3 (429 quota) falls over to claude-cli, and is remembered for the run', async (t) => {
  const dir = await installBinary(t, 'agy', `fs.appendFileSync(process.env.AGY_LOG, 'x');${quota}`);
  process.env.AGY_LOG = `${dir}/calls`;
  t.after(() => { delete process.env.AGY_LOG; });
  mockAvailable(t, ['agy-cli', 'claude-cli']);
  const claude = t.mock.method(byId['claude-cli'], 'complete', async () => ({ text: 'Ans (https://example.org)' }));
  const { report } = await swarmSearch({ query: 'q', provider: 'agy-cli,claude-cli', angles: ['a', 'b', 'c'], workers: 3 });
  assert.equal(report.workers.length, 3);
  assert.ok(report.workers.every((w) => w.ok && w.provider === 'claude-cli'));
  assert.ok(report.workers.some((w) => w.retriedFrom === 'agy-cli'));
  assert.ok(claude.mock.callCount() >= 3);
  const { readFileSync } = await import('node:fs');
  assert.ok(readFileSync(`${dir}/calls`, 'utf8').length <= 3, 'agy must not be retried after the first refusal beyond in-flight workers');
});

test('web auto: arcodex missing (exit 127) and agy quota-exhausted → claude-cli answers', async (t) => {
  await installBinary(t, 'arcodex', `process.stderr.write('zsh: command not found'); process.exit(127);`);
  mockAvailable(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
  t.mock.method(byId['agy-cli'], 'complete', async () => {
    const { ProviderError } = await import('../src/providers/base.mjs');
    throw new ProviderError('agy exited with code 3', { stderr: '429 RESOURCE_EXHAUSTED: Individual quota reached' });
  });
  t.mock.method(byId['claude-cli'], 'complete', async () => ({ text: 'Ans (https://example.org)' }));
  const { report, markdown } = await swarmSearch({ query: 'q', angles: ['a', 'b'] });
  assert.ok(report.workers.every((w) => w.ok && w.provider === 'claude-cli'));
  assert.match(markdown, /claude-cli/);
});
