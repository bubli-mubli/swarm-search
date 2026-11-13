import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byId, resolveProviders } from '../src/providers/index.mjs';
import { swarmSearch } from '../src/swarm.mjs';
import { ProviderError } from '../src/providers/base.mjs';
import { mockAvailable } from './helpers.mjs';

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
  t.mock.method(byId['claude-cli'], 'complete', async () => { calls.push('claude-cli'); return { text: 'Answer' }; });
  for (const id of ['anthropic', 'openai', 'google', 'openrouter']) {
    t.mock.method(byId[id], 'complete', async () => assert.fail(`${id} must not be called`));
  }
  const { report } = await swarmSearch({ query: 'q', angles: ['a'] });
  assert.equal(report.workers[0].provider, 'claude-cli');
  assert.equal(report.synthesis.provider, 'claude-cli');
  assert.deepEqual(calls, ['claude-cli', 'claude-cli']);
});
