import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { byId, resolveProviders } from '../src/providers/index.mjs';
import { swarmSearch } from '../src/swarm.mjs';
import { ProviderError } from '../src/providers/base.mjs';
import { mockAvailable, tempDir, setEnv } from './helpers.mjs';

const ids = (slots) => slots.map((s) => s.provider.id);

test('priority without arcodex', async (t) => {
  mockAvailable(t, ['agy-cli', 'claude-cli', 'anthropic', 'codex-cli']);
  // Как в origin/main: claude-cli, anthropic, codex-cli, agy-cli.
  const all = await resolveProviders('auto', { includeFallbacks: true });
  assert.deepEqual(ids(all), ['claude-cli']);
  mockAvailable(t, ['agy-cli', 'claude-cli']);
  assert.equal((await resolveProviders('auto'))[0].provider.id, 'claude-cli');
  mockAvailable(t, ['agy-cli', 'anthropic']);
  assert.equal((await resolveProviders('auto'))[0].provider.id, 'anthropic');
  mockAvailable(t, ['agy-cli', 'codex-cli']);
  assert.equal((await resolveProviders('auto'))[0].provider.id, 'codex-cli');
});

test('priority with arcodex: arcodex, agy, claude only', async (t) => {
  mockAvailable(t, ['claude-cli', 'anthropic', 'codex-cli', 'gemini-cli', 'agy-cli', 'arcodex-cli']);
  const chain = await resolveProviders('auto', { includeFallbacks: true });
  assert.deepEqual(ids(chain), ['arcodex-cli', 'agy-cli', 'claude-cli']);
  assert.deepEqual(ids(await resolveProviders('auto')), ['arcodex-cli']);
});

test('files mode skips agy and keeps arcodex before claude', async () => {
  const available = ['arcodex-cli', 'agy-cli', 'claude-cli'].map((id) => byId[id]);
  const slots = await resolveProviders('auto', { available, mode: 'files', includeFallbacks: true });
  assert.deepEqual(ids(slots), ['arcodex-cli', 'claude-cli']);
});

test('files mode picks an offline provider over agy', async (t) => {
  mockAvailable(t, ['agy-cli', 'gemini-cli']);
  const slots = await resolveProviders('auto', { mode: 'files' });
  assert.equal(slots[0].provider.id, 'gemini-cli');
});

test('files mode with only agy gives an actionable error', async () => {
  await assert.rejects(
    resolveProviders('auto', { available: [byId['agy-cli']], mode: 'files' }),
    /files mode:.*cannot run without web access.*--provider/s,
  );
});

test('router failure never reaches paid API providers', async (t) => {
  mockAvailable(t, ['arcodex-cli', 'agy-cli', 'claude-cli', 'anthropic', 'openai', 'google', 'openrouter']);
  const calls = [];
  t.mock.method(byId['arcodex-cli'], 'complete', async () => { throw new ProviderError('AgentRouter: down', { status: 503 }); });
  t.mock.method(byId['agy-cli'], 'complete', async () => { throw new ProviderError('agy: down', { status: 503 }); });
  t.mock.method(byId['claude-cli'], 'complete', async ({ system }) => {
    calls.push('claude-cli');
    return { text: system.startsWith('You are the synthesizer') ? 'Answer [1].\n## Sources\n1. https://example.org/page' : 'Answer' };
  });
  for (const id of ['anthropic', 'openai', 'google', 'openrouter']) {
    t.mock.method(byId[id], 'complete', async () => assert.fail(`${id} must not be called`));
  }
  const { report } = await swarmSearch({ query: 'q', angles: ['a'] });
  assert.equal(report.workers[0].provider, 'claude-cli');
  assert.equal(report.synthesis.provider, 'claude-cli');
  assert.deepEqual(calls, ['claude-cli', 'claude-cli']);
});

test('FAILS_ON_OLD: files without --provider runs on arcodex-cli when available', async (t) => {
  mockAvailable(t, ['arcodex-cli', 'agy-cli']);
  setEnv(t, { SWARM_PROVIDER: 'agy-cli' });
  const calls = [];
  t.mock.method(byId['arcodex-cli'], 'complete', async () => {
    calls.push('arcodex-cli');
    return { text: 'Findings: test (server.mjs:1)' };
  });
  t.mock.method(byId['agy-cli'], 'complete', async () => {
    calls.push('agy-cli');
    throw new Error('agy must not be called in files mode');
  });
  const dir = await tempDir(t);
  const file = join(dir, 'server.mjs');
  await writeFile(file, 'const port = 8787;\n');
  const progressMessages = [];
  const { report, markdown } = await swarmSearch({
    query: 'port?',
    mode: 'files',
    paths: [file],
    workers: 1,
    rank: 'off',
    onProgress: (m) => progressMessages.push(m),
  });
  assert.equal(report.workers[0].provider, 'arcodex-cli');
  assert.equal(report.synthesis.provider, 'arcodex-cli');
  assert.ok(calls.includes('arcodex-cli'));
  assert.ok(!calls.includes('agy-cli'));
  assert.match(markdown, /arcodex-cli/);
  assert.match(markdown, /skipped: agy-cli \(web access cannot be disabled\)/);
  assert.ok(progressMessages.some((m) => m.includes('skipping agy-cli (web access cannot be disabled)')));
  assert.ok(progressMessages.some((m) => m.includes('provider arcodex-cli chosen')));
});

test('explicit --provider agy-cli in files mode throws actionable error with reason', async (t) => {
  mockAvailable(t, ['arcodex-cli', 'agy-cli']);
  const dir = await tempDir(t);
  const file = join(dir, 'server.mjs');
  await writeFile(file, 'const port = 8787;\n');
  await assert.rejects(
    swarmSearch({
      query: 'port?',
      mode: 'files',
      paths: [file],
      provider: 'agy-cli',
      workers: 1,
      rank: 'off',
    }),
    /files mode: agy-cli cannot run without web access; choose --provider arcodex-cli, claude-cli, codex-cli or gemini-cli/
  );
});
