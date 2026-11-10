import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swarmSearch } from '../src/swarm.mjs';
import { PROVIDERS, byId, resolveProviders } from '../src/providers/index.mjs';
import { agyCli } from '../src/providers/agy-cli.mjs';
import { geminiCli } from '../src/providers/gemini-cli.mjs';
import { claudeCli } from '../src/providers/claude-cli.mjs';

const mockAvail = (t, ids) => { const s = new Set(ids); for (const p of PROVIDERS) t.mock.method(p, 'detect', () => s.has(p.id)); return s; };

test('files mode auto filters agy before selecting and keeps legacy single-slot', async () => {
  assert.deepEqual(await resolveProviders('auto', { available: [agyCli, geminiCli], mode: 'files' }), [{ provider: geminiCli, model: undefined }]);
});

test('files mode auto selects offline provider over agy-cli', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'f-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prev = process.env.SWARM_PROVIDER; delete process.env.SWARM_PROVIDER;
  t.after(() => { prev ? process.env.SWARM_PROVIDER = prev : delete process.env.SWARM_PROVIDER; });
  for (const p of PROVIDERS) t.mock.method(p, 'detect', () => p === agyCli || p === geminiCli);
  const agy = t.mock.method(agyCli, 'complete', async () => assert.fail());
  const offline = t.mock.method(geminiCli, 'complete', async ({ web, system, prompt }) => {
    assert.equal(web, false);
    if (system.startsWith('You are one worker')) assert.match(prompt, /port = 8787/);
    return { text: 'Port 8787 (s.mjs:1)' };
  });
  await writeFile(join(dir, 's.mjs'), 'const port = 8787;\n');
  const { report } = await swarmSearch({ query: 'port?', mode: 'files', paths: [dir], workers: 1, rank: 'off' });
  assert.equal(report.workers[0].provider, 'gemini-cli');
  assert.equal(report.synthesis.provider, 'gemini-cli');
  assert.equal(agy.mock.callCount(), 0);
  assert.equal(offline.mock.callCount(), 2);
});

test('auto uses arclaude when arcodex unavailable before agy, Claude, API keys', async (t) => {
  mockAvail(t, ['arclaude-cli', 'agy-cli', 'claude-cli', 'anthropic']);
  assert.deepEqual((await resolveProviders('auto', { includeFallbacks: true })).map(s => s.provider.id), ['arclaude-cli', 'agy-cli', 'claude-cli', 'anthropic']);
});

test('auto prefers AgentRouter, then agy-cli, then claude-cli before API keys', async (t) => {
  const order = ['arcodex-cli', 'arclaude-cli', 'agy-cli', 'claude-cli', 'codex-cli', 'gemini-cli', 'anthropic'];
  const enabled = mockAvail(t, order);
  assert.deepEqual((await resolveProviders('auto', { includeFallbacks: true })).map(s => s.provider.id), order.filter(id => id !== 'arclaude-cli'));
  for (const exp of order) {
    const slots = await resolveProviders('auto');
    assert.equal(slots[0].provider.id, exp);
    enabled.delete(exp);
  }
  const firstApi = PROVIDERS.findIndex(p => p.kind === 'api');
  assert.ok(PROVIDERS.slice(firstApi).every(p => p.kind === 'api'));
});

test('AgentRouter wrappers explicit selection and mixed per family', async () => {
  const available = [byId['arcodex-cli'], byId['arclaude-cli'], agyCli, claudeCli];
  assert.equal((await resolveProviders('auto', { available }))[0].provider.id, 'arcodex-cli');
  assert.deepEqual((await resolveProviders('auto', { available, includeFallbacks: true })).map(s => s.provider.id), ['arcodex-cli', 'agy-cli', 'claude-cli']);
  assert.deepEqual((await resolveProviders('mixed', { available })).map(s => s.provider.id), ['arcodex-cli', 'arclaude-cli', 'agy-cli']);
  assert.equal((await resolveProviders('arclaude-cli:haiku', { available }))[0].provider, byId['arclaude-cli']);
  assert.equal((await resolveProviders('auto', { available: [byId['arclaude-cli']], mode: 'files' }))[0].provider.id, 'arclaude-cli');
});

test('provider specs keep legacy ids, comma lists and model overrides', async () => {
  const slots = await resolveProviders('arcodex-cli:gpt-custom,arclaude-cli:sonnet,agy-cli,claude-cli:haiku,codex-cli');
  assert.deepEqual(slots.map(s => [s.provider.id, s.model]), [
    ['arcodex-cli', 'gpt-custom'], ['arclaude-cli', 'sonnet'], ['agy-cli', undefined], ['claude-cli', 'haiku'], ['codex-cli', undefined],
  ]);
});

test('files mode filters before auto selection and mixed family selection', async () => {
  const available = [agyCli, geminiCli, claudeCli];
  assert.equal((await resolveProviders('auto', { available, mode: 'files' }))[0].provider, geminiCli);
  assert.deepEqual((await resolveProviders('mixed', { available, mode: 'files' })).map(s => s.provider.id), ['gemini-cli', 'claude-cli']);
});

test('files mode auto prefers AgentRouter for workers and automatic synthesizer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  mockAvail(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
  const calls = [];
  t.mock.method(byId['arcodex-cli'], 'complete', async ({ web, prompt }) => {
    assert.equal(web, false); calls.push(prompt); return { text: 'Port 8787 (s.mjs:1)' };
  });
  t.mock.method(agyCli, 'complete', () => assert.fail());
  t.mock.method(claudeCli, 'complete', () => assert.fail());
  await writeFile(join(dir, 's.mjs'), 'const port = 8787;\n');
  const { report, markdown } = await swarmSearch({ query: 'port?', paths: [dir], provider: 'auto', synthProvider: 'auto', workers: 1, rank: 'off' });
  assert.equal(report.workers[0].provider, 'arcodex-cli');
  assert.equal(report.synthesis.provider, 'arcodex-cli');
  assert.match(markdown, /mode: files/);
  assert.equal(calls.length, 2);
});

test('files mode without compatible provider gives actionable error', async () => {
  await assert.rejects(resolveProviders('auto', { available: [agyCli], mode: 'files' }), /files mode:.*arcodex.*arclaude.*--provider/s);
  await assert.rejects(swarmSearch({ query: 'q', mode: 'files', paths: ['src'], provider: 'agy-cli' }), /cannot run without web access.*--provider/s);
  await assert.rejects(swarmSearch({ query: 'q', mode: 'files', paths: ['src'], provider: 'claude-cli', synthProvider: 'agy-cli' }), /synthesis on agy-cli.*--synth-provider auto/s);
});

test('remote auto excludes AgentRouter workers with local disk access', async () => {
  const slots = await resolveProviders('auto', { available: [byId['arcodex-cli'], byId['arclaude-cli'], agyCli, claudeCli], remote: true, mode: 'files' });
  assert.equal(slots[0].provider.id, 'arclaude-cli');
  assert.deepEqual((await resolveProviders('auto', { available: [byId['arcodex-cli'], agyCli, claudeCli], remote: true, mode: 'files' })).map(s => s.provider.id), ['claude-cli']);
  assert.ok(byId['arcodex-cli'].localFiles);
  assert.ok(!byId['arclaude-cli'].localFiles);
  await assert.rejects(swarmSearch({ query: 'q', provider: 'arcodex-cli', remote: true, angles: ['a'] }), /can read the server's disk/);
});

test('SWARM_PROVIDER remains explicit and --provider auto overrides it', async (t) => {
  const prev = process.env.SWARM_PROVIDER; process.env.SWARM_PROVIDER = 'agy-cli';
  t.after(() => { prev ? process.env.SWARM_PROVIDER = prev : delete process.env.SWARM_PROVIDER; });
  mockAvail(t, ['arcodex-cli', 'agy-cli']);
  assert.equal((await resolveProviders())[0].provider, agyCli);
  assert.equal((await resolveProviders('auto', { mode: 'files' }))[0].provider.id, 'arcodex-cli');
  await assert.rejects(swarmSearch({ query: 'q', paths: ['src'] }), /cannot run without web access/);
});

test('remote files validate permitted paths before consulting any provider', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'r-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const p of PROVIDERS) t.mock.method(p, 'detect', () => assert.fail());
  await assert.rejects(swarmSearch({ query: 'q', mode: 'files', paths: ['src'], filesRoots: [dir], remote: true }), /outside SWARM_FILES_ROOTS/);
});
