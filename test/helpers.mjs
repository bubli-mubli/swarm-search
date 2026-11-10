import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS } from '../src/providers/index.mjs';
import { DEFAULTS, swarmSearch, isRetryable } from '../src/swarm.mjs';
import { ProviderError } from '../src/providers/base.mjs';
import { agyCli } from '../src/providers/agy-cli.mjs';
import { claudeCli } from '../src/providers/claude-cli.mjs';

export const okAns = (text = 'Ans (https://example.org)') => ({ text });
export const waf = '<!doctype html><html><body>Cloudflare captcha challenge</body></html>';
export const ids = (s) => s.map(x => x.provider.id);

export const checkErr = (e, id, st, re) =>
  e instanceof ProviderError && e.provider === id && e.status === st && isRetryable(e) && /AgentRouter/.test(e.message) && re.test(e.message);

export const mockFail = (t, ...p) => p.forEach(x => t.mock.method(x, 'complete', () => assert.fail()));

export async function tmp(t, p = 's-') {
  const d = await mkdtemp(join(tmpdir(), p));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

export async function writeServer(d) {
  const p = join(d, 's.mjs');
  await writeFile(p, 'const port = 8787;\n');
  return p;
}

export async function fixture(t, name, body) {
  const d = await tmp(t, 'a-');
  await writeFile(join(d, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  const prev = process.env.PATH; process.env.PATH = d;
  t.after(() => { prev ? process.env.PATH = prev : delete process.env.PATH; });
  return d;
}

export function mockAvail(t, idList) {
  const s = new Set(idList);
  for (const p of PROVIDERS) t.mock.method(p, 'detect', () => s.has(p.id));
  const prev = process.env.SWARM_PROVIDER; delete process.env.SWARM_PROVIDER;
  const backoff = DEFAULTS.retryBackoffMs; DEFAULTS.retryBackoffMs = 1;
  t.after(() => { DEFAULTS.retryBackoffMs = backoff; prev ? process.env.SWARM_PROVIDER = prev : delete process.env.SWARM_PROVIDER; });
  return s;
}

export async function testFallback(t, { bin = 'arcodex', script, avail = ['arcodex-cli', 'agy-cli', 'claude-cli'], setup, angles = ['a'] }) {
  await fixture(t, bin, script); mockAvail(t, avail);
  const msgs = [], ctx = setup ? await setup(t) : {};
  const res = await swarmSearch({ query: 'q', angles: ctx.angles || angles, onProgress: (m) => msgs.push(m) });
  return { ...res, ...ctx, msgs };
}

export function checkFallback(r, w, f, s = w, ret = 1) {
  assert.equal(r.workers[0].provider, w); assert.equal(r.workers[0].retriedFrom, f);
  assert.equal(r.synthesis.provider, s); assert.equal(r.retried, ret);
}

export function mockAgyFindings(t) {
  const used = [];
  t.mock.method(agyCli, 'complete', async ({ system, web }) => {
    used.push([system.startsWith('You are one worker') ? 'w' : 's', web]);
    return okAns('## Findings\n- Ans (https://example.org)');
  });
  mockFail(t, claudeCli);
  return { used, angles: ['a', 'b'] };
}

export function assertRouterFallback({ report, markdown, msgs, used }) {
  assert.deepEqual(report.workers.map(w => [w.provider, w.ok, w.retriedFrom]), [['agy-cli', true, 'arcodex-cli'], ['agy-cli', true, 'arcodex-cli']]);
  assert.equal(report.retried, 2); assert.equal(report.synthesis.provider, 'agy-cli');
  assert.equal(used.filter(([s]) => s === 'w').length, 2);
  assert.match(markdown, /synthesis: agy-cli:/);
  assert.ok(msgs.some(m => /arcodex-cli failed.*AgentRouter.*retrying on agy-cli/.test(m)));
}
