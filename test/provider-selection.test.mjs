import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swarmSearch as ss } from '../src/swarm.mjs';
import { PROVIDERS, byId, resolveProviders as rp } from '../src/providers/index.mjs';
import { agyCli as ag, geminiCli as gm, claudeCli as cd } from '../src/providers/index.mjs';
import { tmp, mockAvail, ids, writeServer } from './helpers.mjs';

const [CX, CL, AG, CD, GM] = ['arcodex-cli', 'arclaude-cli', 'agy-cli', 'claude-cli', 'gemini-cli'];
const [cx, cl] = [byId[CX], byId[CL]];

test('files mode auto filters agy before selecting and keeps legacy single-slot', async () => {
  assert.deepEqual(await rp('auto', { available: [ag, gm], mode: 'files' }), [{ provider: gm, model: undefined }]);
});

test('files mode auto selects offline provider over agy-cli', async (t) => {
  const dir = await tmp(t, 'f-'); mockAvail(t, [AG, GM]);
  const a = t.mock.method(ag, 'complete', async () => assert.fail());
  const o = t.mock.method(gm, 'complete', async ({ web, system, prompt }) => {
    assert.equal(web, false); if (system.startsWith('You are one worker')) assert.match(prompt, /port = 8787/);
    return { text: 'Port 8787 (s.mjs:1)' };
  });
  await writeServer(dir);
  const { report: r } = await ss({ query: 'port?', mode: 'files', paths: [dir], workers: 1, rank: 'off' });
  assert.equal(r.workers[0].provider, GM); assert.equal(r.synthesis.provider, GM);
  assert.equal(a.mock.callCount(), 0); assert.equal(o.mock.callCount(), 2);
});

test('auto uses arclaude when arcodex unavailable before agy, Claude, API keys', async (t) => {
  mockAvail(t, [CL, AG, CD, 'anthropic']);
  assert.deepEqual(ids(await rp('auto', { includeFallbacks: true })), [CL, AG, CD, 'anthropic']);
});

test('auto prefers AgentRouter, then agy-cli, then claude-cli before API keys', async (t) => {
  const order = [CX, CL, AG, CD, 'codex-cli', GM, 'anthropic'], en = mockAvail(t, order);
  assert.deepEqual(ids(await rp('auto', { includeFallbacks: true })), order.filter(id => id !== CL));
  for (const exp of order) { assert.equal((await rp('auto'))[0].provider.id, exp); en.delete(exp); }
  assert.ok(PROVIDERS.slice(PROVIDERS.findIndex(p => p.kind === 'api')).every(p => p.kind === 'api'));
});

test('AgentRouter wrappers explicit selection and mixed per family', async () => {
  const av = [cx, cl, ag, cd];
  assert.equal((await rp('auto', { available: av }))[0].provider.id, CX);
  assert.deepEqual(ids(await rp('auto', { available: av, includeFallbacks: true })), [CX, AG, CD]);
  assert.deepEqual(ids(await rp('mixed', { available: av })), [CX, CL, AG]);
  assert.equal((await rp('arclaude-cli:haiku', { available: av }))[0].provider, cl);
  assert.equal((await rp('auto', { available: [cl], mode: 'files' }))[0].provider.id, CL);
});

test('provider specs keep legacy ids, comma lists and model overrides', async () => {
  assert.deepEqual((await rp('arcodex-cli:gpt-custom,arclaude-cli:sonnet,agy-cli,claude-cli:haiku,codex-cli')).map(s => [s.provider.id, s.model]),
    [[CX, 'gpt-custom'], [CL, 'sonnet'], [AG, undefined], [CD, 'haiku'], ['codex-cli', undefined]]);
});

test('files mode filters before auto selection and mixed family selection', async () => {
  const av = [ag, gm, cd];
  assert.equal((await rp('auto', { available: av, mode: 'files' }))[0].provider, gm);
  assert.deepEqual(ids(await rp('mixed', { available: av, mode: 'files' })), [GM, CD]);
});

test('files mode auto prefers AgentRouter for workers and automatic synthesizer', async (t) => {
  const dir = await tmp(t, 'rf-'), calls = []; mockAvail(t, [CX, AG, CD]);
  t.mock.method(cx, 'complete', async ({ web, prompt }) => { assert.equal(web, false); calls.push(prompt); return { text: 'Port 8787 (s.mjs:1)' }; });
  t.mock.method(ag, 'complete', () => assert.fail()); t.mock.method(cd, 'complete', () => assert.fail());
  await writeServer(dir);
  const { report: r, markdown: m } = await ss({ query: 'port?', paths: [dir], provider: 'auto', synthProvider: 'auto', workers: 1, rank: 'off' });
  assert.equal(r.workers[0].provider, CX); assert.equal(r.synthesis.provider, CX); assert.match(m, /mode: files/); assert.equal(calls.length, 2);
});

test('files mode without compatible provider gives actionable error', async () => {
  await assert.rejects(rp('auto', { available: [ag], mode: 'files' }), /files mode:.*arcodex.*arclaude.*--provider/s);
  await assert.rejects(ss({ query: 'q', mode: 'files', paths: ['src'], provider: AG }), /cannot run without web access.*--provider/s);
  await assert.rejects(ss({ query: 'q', mode: 'files', paths: ['src'], provider: CD, synthProvider: AG }), /synthesis on agy-cli.*--synth-provider auto/s);
});

test('remote auto excludes AgentRouter workers with local disk access', async () => {
  assert.equal((await rp('auto', { available: [cx, cl, ag, cd], remote: true, mode: 'files' }))[0].provider.id, CL);
  assert.deepEqual(ids(await rp('auto', { available: [cx, ag, cd], remote: true, mode: 'files' })), [CD]);
  assert.ok(cx.localFiles); assert.ok(!cl.localFiles);
  await assert.rejects(ss({ query: 'q', provider: CX, remote: true, angles: ['a'] }), /can read the server's disk/);
});

test('SWARM_PROVIDER remains explicit and --provider auto overrides it', async (t) => {
  mockAvail(t, [CX, AG]); process.env.SWARM_PROVIDER = AG;
  assert.equal((await rp())[0].provider, ag);
  assert.equal((await rp('auto', { mode: 'files' }))[0].provider.id, CX);
  await assert.rejects(ss({ query: 'q', paths: ['src'] }), /cannot run without web access/);
});

test('remote files validate permitted paths before consulting any provider', async (t) => {
  const dir = await tmp(t, 'r-');
  for (const p of PROVIDERS) t.mock.method(p, 'detect', () => assert.fail());
  await assert.rejects(ss({ query: 'q', mode: 'files', paths: ['src'], filesRoots: [dir], remote: true }), /outside SWARM_FILES_ROOTS/);
});
