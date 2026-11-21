import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as dns } from 'node:dns';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { swarmSearch } from '../src/swarm.mjs';
import { byId } from '../src/providers/index.mjs';
import { ProviderError, postJson } from '../src/providers/base.mjs';
import { callTool } from '../src/mcp.mjs';
import { mockAvailable, tempDir } from './helpers.mjs';

const url = 'https://fixture.example/articles/fact';
const found = { text: `## Findings\n- Fact (${url})` };
const answer = `Fact [1].\n## Sources\n1. ${url}`;
const failures = {
  auth: () => new ProviderError('HTTP 401 unauthorized', { status: 401 }),
  rate_limit: () => new ProviderError('HTTP 429 quota exhausted', { status: 429 }),
  http_error: () => new ProviderError('HTTP 503 service unavailable', { status: 503 }),
  timeout: () => new ProviderError('fixture timed out after 1s'),
  parse_error: () => new ProviderError('fixture: could not parse JSON output'),
};

function fixture(t, overrides = {}) {
  mockAvailable(t, []);
  // Neither the provider nor source verification may reach the network.
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const lookup = t.mock.method(dns, 'lookup', async () => { throw new Error('unexpected DNS'); });
  t.after(() => {
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(lookup.mock.callCount(), 0);
  });
  const prompts = [];
  const calls = [];
  const id = 'source-result-871';
  byId[id] = {
    id, defaultModel: 'stub',
    async complete(request) {
      if (request.system.startsWith('You are one worker')) {
        const angle = request.prompt.split('Your sub-question: ').at(-1);
        calls.push(angle);
        if (Object.hasOwn(overrides, angle)) return overrides[angle]();
        if (angle === 'empty') return { text: '  ' };
        if (angle === 'nothing') return { text: 'NOTHING RELEVANT' };
        if (failures[angle]) throw failures[angle]();
        return found;
      }
      prompts.push(request);
      if (request.system.startsWith('You audit')) return { text: '{"followups": ["Check timeout"]}' };
      return { text: answer };
    },
  };
  t.after(() => { delete byId[id]; });
  return { calls, prompts, options: { query: 'What is known?', provider: id, workers: 1 } };
}

for (const status of ['ok_empty', ...Object.keys(failures)]) {
  test(`FAILS_ON_OLD 871: ${status} survives worker, synthesis and final output`, async (t) => {
    const { options, prompts } = fixture(t);
    const { report, markdown } = await swarmSearch({ ...options, angles: [status === 'ok_empty' ? 'empty' : status, 'found'] });
    const worker = report.workers[0];
    assert.equal(worker.sourceResult?.status, status);
    assert.equal(worker.ok, status === 'ok_empty');
    assert.equal(worker.text.trim(), '');
    assert.equal(worker.status, status === 'ok_empty' ? 'partial' : 'unavailable', 'legacy availability is retained');
    assert.deepEqual(report.sourceSummary, {
      total: 2, found: 1, empty: status === 'ok_empty' ? 1 : 0,
      failed: status === 'ok_empty' ? 0 : 1,
      reasons: status === 'ok_empty' ? {} : { [status]: 1 },
    });
    const synthesis = prompts.find(p => p.system.startsWith('You are the synthesizer'));
    assert.match(synthesis.prompt, /Source outcomes/);
    assert.ok(synthesis.prompt.includes(`"status":"${status}"`));
    assert.match(markdown, /found=1, empty=\d, failed=\d/);
    assert.ok(markdown.includes(status));
    if (status !== 'ok_empty') assert.match(markdown, /incomplete/i);
    assert.deepEqual(worker.sourceAttempts.map(a => a.sourceResult.status), [status]);
  });
}

test('FAILS_ON_OLD 871: wholly empty results are successful and distinct from failure', async (t) => {
  const { options, prompts } = fixture(t, { headings: () => ({ text: '## Findings\n- none\n## Uncertain\n- none' }) });
  const { report, markdown } = await swarmSearch({ ...options, angles: ['empty', 'nothing', 'headings'] });
  assert.deepEqual(report.workers.map(w => [w.ok, w.sourceResult.status]), Array.from({ length: 3 }, () => [true, 'ok_empty']));
  assert.deepEqual(report.sourceSummary, { total: 3, found: 0, empty: 3, failed: 0, reasons: {} });
  assert.equal(report.status, 'ok');
  assert.equal(report.unavailableSources.length, 0);
  assert.match(markdown, /found=0, empty=3, failed=0/);
  assert.doesNotMatch(markdown, /Answer is incomplete/);
  assert.ok(prompts.every(p => !p.prompt.includes('source coverage incomplete')));
});

test('FAILS_ON_OLD 871: mixed page availability is counted per URL, with HTTP reasons separate from findings', async (t) => {
  mockAvailable(t, []);
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  const codes = [200, 401, 429, 503];
  t.mock.method(globalThis, 'fetch', async source => {
    const code = Number(new URL(source).pathname.split('/').at(-1));
    return new Response(code === 200 ? 'Fact' : 'unavailable', { status: code });
  });
  const id = 'pages-871';
  byId[id] = { id, defaultModel: 'stub', async complete({ system }) {
    return { text: system.startsWith('You are one worker')
      ? codes.map(c => `- Fact (https://fixture.example/articles/${c}) — Quote: "Fact"`).join('\n') : answer };
  } };
  t.after(() => { delete byId[id]; });
  const { report, markdown } = await swarmSearch({ query: 'q', provider: id, angles: ['test'] });
  assert.deepEqual(report.workers[0].sourceResults?.map(s => s.status), ['ok', 'auth', 'rate_limit', 'http_error']);
  assert.deepEqual(report.sourceSummary, { total: 4, found: 1, empty: 0, failed: 3,
    reasons: { auth: 1, rate_limit: 1, http_error: 1 } });
  assert.equal(report.status, 'partial');
  assert.match(markdown, /found=1, empty=0, failed=3/);
  for (const code of codes) assert.ok(markdown.includes(`https://fixture.example/articles/${code}`));
});

test('FAILS_ON_OLD 871: files workers distinguish each failure class and successful emptiness without fetching', async (t) => {
  const { options } = fixture(t);
  const path = join(await tempDir(t), 'fixture.txt');
  await writeFile(path, 'fixture corpus');
  for (const status of ['ok_empty', ...Object.keys(failures)]) {
    let calls = 0;
    byId['source-result-871'].complete = async ({ system }) => {
      if (system.startsWith('You are one worker')) {
        calls++;
        if (status === 'ok_empty') return { text: '' };
        throw failures[status]();
      }
      return { text: 'No relevant findings.\n## Sources\n1. fixture.txt:1' };
    };
    const request = { ...options, mode: 'files', paths: [path] };
    if (status === 'ok_empty') {
      const { report } = await swarmSearch(request);
      assert.equal(report.workers[0].sourceResult?.status, 'ok_empty');
      assert.equal(report.workers[0].ok, true);
      assert.equal(report.sourceSummary.failed, 0);
      assert.equal(report.sourceSummary.empty, 1);
      assert.equal(calls, 1);
      calls = 0;
      const alt = 'empty-files-alt-871';
      byId[alt] = { id: alt, defaultModel: 'stub', async complete() { throw failures.auth(); } };
      t.after(() => { delete byId[alt]; });
      const fallback = await swarmSearch({ ...request, provider: `${options.provider},${alt}` });
      assert.equal(fallback.report.workers[0].ok, true);
      assert.deepEqual(fallback.report.sourceSummary, { total: 2, found: 0, empty: 1, failed: 1, reasons: { auth: 1 } });
      assert.deepEqual(fallback.report.workers[0].sourceAttempts.map(a => a.sourceResult.status), ['ok_empty', 'auth']);
    } else {
      await assert.rejects(swarmSearch(request), error => {
        assert.equal(error.workers?.[0].sourceResult.status, status);
        assert.equal(error.sourceSummary.reasons[status], 1);
        return true;
      });
    }
    assert.equal(calls, 1);
  }
});

test('FAILS_ON_OLD 871: all five failures expose structured diagnostics and explicit counts even when all workers fail', async (t) => {
  const { options, calls } = fixture(t);
  await assert.rejects(swarmSearch({ ...options, angles: Object.keys(failures) }), error => {
    assert.equal(error.status, 'partial');
    assert.deepEqual(error.sourceSummary, { total: 5, found: 0, empty: 0, failed: 5,
      reasons: { auth: 1, rate_limit: 1, http_error: 1, timeout: 1, parse_error: 1 } });
    assert.deepEqual(error.workers.map(w => w.sourceResult.status), Object.keys(failures));
    assert.match(error.message, /incomplete/i);
    assert.match(error.message, /empty=0, failed=5/);
    for (const status of Object.keys(failures)) assert.ok(error.message.includes(`${status}=1`));
    return true;
  });
  assert.deepEqual(calls, Object.keys(failures), 'single provider is never retried');
});

test('FAILS_ON_OLD 871: malformed replies and explicit unavailability cannot masquerade as empty', async (t) => {
  const { options } = fixture(t, {
    malformed: () => ({ text: { unexpected: true } }),
    unavailable: () => ({ text: '', status: 'unavailable' }),
    structured: () => ({ text: '', sourceResult: { status: 'auth', http_status: 403 } }),
  });
  const { report } = await swarmSearch({ ...options, angles: ['malformed', 'unavailable', 'structured', 'found'] });
  assert.deepEqual(report.workers.map(w => w.sourceResult.status), ['parse_error', 'unknown_error', 'auth', 'ok']);
  assert.equal(report.sourceSummary.empty, 0);
  assert.equal(report.sourceSummary.failed, 3);
  assert.equal(report.workers[2].sourceResult.http_status, 403);
});

test('FAILS_ON_OLD 871: actual JSON transport preserves empty, HTTP, timeout and decoding outcomes with a fake fetch', async (t) => {
  mockAvailable(t, []);
  let mode;
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'timeout') throw new DOMException('aborted', 'AbortError');
    if (mode === 'parse_error') return new Response('<html>not JSON</html>');
    if (mode === 'ok_empty') return new Response('{"text":""}');
    return new Response('fake upstream failure', { status: Number(mode) });
  });
  const id = 'transport-871';
  byId[id] = { id, defaultModel: 'stub', async complete({ system, prompt }) {
    if (!system.startsWith('You are one worker')) return { text: answer };
    if (prompt.endsWith('found')) return found;
    return postJson('https://fixture.example/api', { provider: id, body: {} });
  } };
  t.after(() => { delete byId[id]; });
  for (const [input, status] of [['ok_empty', 'ok_empty'], ['401', 'auth'], ['403', 'auth'],
    ['429', 'rate_limit'], ['503', 'http_error'], ['timeout', 'timeout'], ['parse_error', 'parse_error']]) {
    mode = input;
    const { report } = await swarmSearch({ query: 'q', provider: id, angles: ['test', 'found'], workers: 1 });
    assert.equal(report.workers[0].sourceResult?.status, status, input);
    if (/^\d/.test(input)) assert.equal(report.workers[0].sourceResult.http_status, Number(input));
  }
});

test('FAILS_ON_OLD 871: an adapter admitting failure cannot feed its diagnostic claims to synthesis', async (t) => {
  const { options, prompts } = fixture(t, {
    rejected: () => ({ text: 'CONTROL_REJECTED_CLAIM', sourceResult: { status: 'auth' } }),
  });
  const { report } = await swarmSearch({ ...options, angles: ['rejected', 'found'] });
  assert.equal(report.workers[0].sourceResult?.status, 'auth');
  assert.equal(report.workers[0].status, 'unavailable');
  assert.ok(prompts.every(p => !p.prompt.includes('CONTROL_REJECTED_CLAIM')));
});

for (const round2 of ['gaps', 'critique']) {
  test(`FAILS_ON_OLD 871: ${round2} carries first-round and follow-up failures into synthesis`, async (t) => {
    const { options, prompts } = fixture(t);
    const complete = byId['source-result-871'].complete;
    byId['source-result-871'].complete = async request => {
      if (request.system.includes('critique round') || request.prompt.includes('auditor proposal')) throw failures.timeout();
      return complete(request);
    };
    const { report, markdown } = await swarmSearch({ ...options, angles: ['auth', 'found'], rounds: 2, round2 });
    assert.equal(report.round2[0].sourceResult?.status, 'timeout');
    assert.deepEqual(report.sourceSummary.reasons, { auth: 1, timeout: 1 });
    const synthesis = prompts.find(p => p.system.startsWith('You are the synthesizer'));
    assert.ok(synthesis.prompt.includes('"status":"auth"'));
    assert.ok(synthesis.prompt.includes('"status":"timeout"'));
    assert.match(markdown, /failed=2/);
  });
}

for (const status of Object.keys(failures)) {
  test(`FAILS_ON_OLD 871: ${status} retains the existing retry policy and records failed attempts`, async (t) => {
    const { options } = fixture(t);
    let first = 0, second = 0;
    byId['source-result-871'].complete = async ({ system }) => {
      if (system.startsWith('You are one worker')) { first++; throw failures[status](); }
      return { text: answer };
    };
    byId['source-result-871-alt'] = {
      id: 'source-result-871-alt', defaultModel: 'stub-alt',
      async complete({ system }) {
        if (system.startsWith('You are one worker')) second++;
        return system.startsWith('You are one worker') ? found : { text: answer };
      },
    };
    t.after(() => { delete byId['source-result-871-alt']; });
    const request = { ...options, provider: 'source-result-871,source-result-871-alt', angles: ['test'] };
    const retryable = ['rate_limit', 'http_error', 'timeout'].includes(status);
    if (retryable) {
      const { report, markdown } = await swarmSearch(request);
      assert.equal(report.workers[0].sourceResult.status, 'ok');
      assert.deepEqual(report.workers[0].sourceAttempts.map(a => a.sourceResult.status), [status, 'ok']);
      assert.equal(report.sourceSummary.failed, 1);
      assert.equal(report.sourceSummary.reasons[status], 1);
      assert.equal(report.retried, 1);
      assert.ok(markdown.includes(status));
    } else {
      await assert.rejects(swarmSearch(request), error => {
        assert.equal(error.workers?.[0].sourceResult.status, status);
        return true;
      });
    }
    assert.equal(first, 1);
    assert.equal(second, retryable ? 1 : 0);
  });
}

test('FAILS_ON_OLD 871: fallback exhaustion names the provider that actually failed last', async (t) => {
  const { options } = fixture(t);
  byId['source-result-871'].complete = async () => { throw failures.timeout(); };
  byId['source-result-871-alt'] = { id: 'source-result-871-alt', defaultModel: 'stub-alt',
    async complete() { throw failures.http_error(); } };
  t.after(() => { delete byId['source-result-871-alt']; });
  await assert.rejects(swarmSearch({ ...options, provider: 'source-result-871,source-result-871-alt', angles: ['test'] }), error => {
    assert.equal(error.workers?.[0].provider, 'source-result-871-alt');
    assert.equal(error.workers[0].sourceResult.status, 'http_error');
    assert.deepEqual(error.workers[0].sourceAttempts.map(a => a.sourceResult.status), ['timeout', 'http_error']);
    return true;
  });
});

test('FAILS_ON_OLD 871: MCP keeps its envelope and adds the same summary and per-worker status', async (t) => {
  const { options } = fixture(t);
  const result = await callTool('swarm_search', { ...options, angles: ['empty', ...Object.keys(failures), 'found'] });
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.structuredContent.sourceSummary.failed, 5);
  assert.equal(result.structuredContent.sourceSummary.empty, 1);
  assert.deepEqual(result.structuredContent.workers.map(w => w.sourceResult.status), ['ok_empty', ...Object.keys(failures), 'ok']);
  for (const status of Object.keys(failures)) assert.ok(result.content[0].text.includes(status));
});

test('FAILS_ON_OLD 871: CLI JSON keeps legacy fields and distinguishes all five classes without real models', async () => {
  const setup = `import { byId, PROVIDERS } from ${JSON.stringify(new URL('../src/providers/index.mjs', import.meta.url).href)};
    import { ProviderError } from ${JSON.stringify(new URL('../src/providers/base.mjs', import.meta.url).href)};
    for (const p of PROVIDERS) p.detect = () => false;
    globalThis.fetch = async () => { throw new Error('unexpected network'); };
    byId.fixture871 = { id: 'fixture871', defaultModel: 'stub', async complete({ system, prompt }) {
      if (system.startsWith('You split')) return { text: '["empty","auth","rate_limit","http_error","timeout","parse_error","found"]' };
      if (system.startsWith('You are one worker')) {
        const angle = prompt.split('Your sub-question: ').at(-1);
        if (angle === 'empty') return { text: '' };
        if (angle === 'auth') throw new ProviderError('HTTP 401', { status: 401 });
        if (angle === 'rate_limit') throw new ProviderError('HTTP 429', { status: 429 });
        if (angle === 'http_error') throw new ProviderError('HTTP 503', { status: 503 });
        if (angle === 'timeout') throw new ProviderError('timed out');
        if (angle === 'parse_error') throw new ProviderError('non-JSON response');
        return ${JSON.stringify(found)};
      }
      return { text: ${JSON.stringify(answer)} };
    } };`;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(setup)}`, 'bin/swarm-search.mjs',
    'run', 'What is known?', '--provider', 'fixture871', '--workers', '7', '--json',
  ]);
  const result = JSON.parse(stdout);
  assert.deepEqual(Object.keys(result).sort(), ['markdown', 'report']);
  assert.equal(result.report.sourceSummary.failed, 5);
  assert.equal(result.report.sourceSummary.empty, 1);
  const worker = result.report.workers.at(-1);
  for (const key of ['id', 'label', 'provider', 'model', 'ok', 'text', 'error', 'usage', 'source_url', 'fetched_at',
    'status', 'facts', 'sources', 'sourceVerification', 'sourceIssues']) {
    // Optional undefined usage remains optional after JSON serialization, as before.
    if (key !== 'usage') assert.ok(Object.hasOwn(worker, key), key);
  }
  assert.deepEqual(result.report.workers.map(w => w.sourceResult.status), ['ok_empty', ...Object.keys(failures), 'ok']);
});
