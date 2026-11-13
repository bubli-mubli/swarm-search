import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { arcodexCli } from '../src/providers/agentrouter-cli.mjs';
import { byId } from '../src/providers/index.mjs';
import { ProviderError, mergeSystem } from '../src/providers/base.mjs';
import { swarmSearch, isRetryable } from '../src/swarm.mjs';
import { installBinary, mockAvailable } from './helpers.mjs';

const request = { system: 'S', prompt: 'P', model: 'm', timeoutMs: 5000 };
const fail = (body, code = 1, stream = 'stderr') => `process.${stream}.write(${JSON.stringify(body)}); process.exit(${code});`;

test('arcodex: builds read-only argv with the prompt last', () => {
  const args = arcodexCli.buildArgs({ ...request, web: false, outFile: '/tmp/o' });
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.equal(args[args.indexOf('-m') + 1], 'm');
  assert.deepEqual(args.slice(-2), ['--', mergeSystem('S', 'P')]);
  assert.ok(!arcodexCli.buildArgs({ prompt: 'P', outFile: '/tmp/o' }).includes('-m'));
});

test('arcodex: parses the answer file and keeps stdin empty', async (t) => {
  const dir = await installBinary(t, 'arcodex', `
fs.writeFileSync(process.env.ARGV_LOG, fs.readFileSync(0, 'utf8'));
fs.writeFileSync(args[args.indexOf('-o') + 1], ' ANSWER\\n');
process.stderr.write('Reconnecting... 1/5');`);
  process.env.ARGV_LOG = join(dir, 'stdin');
  t.after(() => { delete process.env.ARGV_LOG; });
  assert.equal((await arcodexCli.complete(request)).text, 'ANSWER');
  assert.equal(await readFile(join(dir, 'stdin'), 'utf8'), '');
});

const routerErrors = [
  ['rate limit exceeded', 429, /rate limit/i],
  ['fetch failed: ECONNRESET', 503, /network/i],
  ['getaddrinfo ENOTFOUND router', 503, /network/i],
  ['<head><title>403</title></head>', 503, /HTML|WAF/],
  ['<body>Cloudflare</body>', 503, /HTML|WAF/],
  ['<!doctype html><html><body>captcha</body></html>', 503, /HTML|WAF/],
];
for (const [body, status, message] of routerErrors) {
  test(`arcodex error is retryable: ${body.slice(0, 30)}`, async (t) => {
    await installBinary(t, 'arcodex', fail(body));
    await assert.rejects(arcodexCli.complete(request), (e) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.provider, 'arcodex-cli');
      assert.equal(e.status, status);
      assert.match(e.message, /AgentRouter/);
      assert.match(e.message, message);
      assert.ok(isRetryable(e));
      return true;
    });
  });
}

test('arcodex: a generic "connection" message is not classed as network', async (t) => {
  await installBinary(t, 'arcodex', fail('bad connection string in config'));
  await assert.rejects(arcodexCli.complete(request), (e) => e.status === undefined && !isRetryable(e));
});

test('arcodex: HTML in the answer file is rejected', async (t) => {
  await installBinary(t, 'arcodex', `fs.writeFileSync(args[args.indexOf('-o') + 1], '<head></head>');`);
  await assert.rejects(arcodexCli.complete(request), (e) => isRetryable(e) && /HTML|WAF/.test(e.message));
});

test('network error falls back to agy-cli, then claude-cli', async (t) => {
  await installBinary(t, 'arcodex', fail('fetch failed: ETIMEDOUT'));
  mockAvailable(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
  const agy = t.mock.method(byId['agy-cli'], 'complete', async () => ({ text: 'Ans (https://example.org)' }));
  t.mock.method(byId['claude-cli'], 'complete', async () => assert.fail('claude is the last resort'));
  const { report } = await swarmSearch({ query: 'q', angles: ['a'] });
  assert.equal(report.workers[0].provider, 'agy-cli');
  assert.equal(report.workers[0].retriedFrom, 'arcodex-cli');
  assert.equal(report.synthesis.provider, 'agy-cli');
  assert.equal(agy.mock.callCount(), 2);
});

test('healthy router answers every call without fallback', async (t) => {
  mockAvailable(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
  const router = t.mock.method(arcodexCli, 'complete', async () => ({ text: 'Ans (https://example.org)' }));
  t.mock.method(byId['agy-cli'], 'complete', async () => assert.fail('no fallback expected'));
  const { report } = await swarmSearch({ query: 'q', angles: ['a', 'b'] });
  assert.ok(report.workers.every((w) => w.provider === 'arcodex-cli'));
  assert.equal(report.retried, 0);
  assert.equal(router.mock.callCount(), 3);
});

test('files mode falls back from arcodex to claude, never agy', async (t) => {
  mockAvailable(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
  t.mock.method(arcodexCli, 'complete', async () => { throw new ProviderError('AgentRouter: down', { status: 503 }); });
  t.mock.method(byId['agy-cli'], 'complete', async () => assert.fail('agy cannot run offline'));
  t.mock.method(byId['claude-cli'], 'complete', async ({ web }) => {
    assert.equal(web, false);
    return { text: 'Port 8787 (bin/swarm-search.mjs:1)' };
  });
  const { report } = await swarmSearch({ query: 'port?', mode: 'files', paths: ['bin'], workers: 1, rank: 'off' });
  assert.equal(report.workers[0].provider, 'claude-cli');
  assert.equal(report.workers[0].retriedFrom, 'arcodex-cli');
});
