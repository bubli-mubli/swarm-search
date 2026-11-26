import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { swarmSearch, DEFAULTS } from '../src/swarm.mjs';
import { PROVIDERS, byId } from '../src/providers/index.mjs';
import { ProviderError } from '../src/providers/base.mjs';
import { callTool } from '../src/mcp.mjs';
import { mockAvailable } from './helpers.mjs';

const valid = 'Finding [1].\n## Sources\n1. src/providers/base.mjs:35';
const malformed = 'Finding [2].\n## Sources\n1. src/providers/base.mjs:35';
const workerText = (mode, followup = false) =>
  `## Findings\n- RAW_986${followup ? '_FOLLOWUP' : ''} (src/providers/base.mjs:35)\n## ${mode === 'files' ? 'Not found' : 'Uncertain'}\n- none`;

function fixture(t, { mode = 'files', available = ['arcodex-cli', 'codex-cli'], limits = {} } = {}) {
  mockAvailable(t, available);
  for (const [key, value] of Object.entries({
    synthesisAttemptTimeoutMs: 30, synthesisTimeoutMs: 180, synthesisCorrectionTimeoutMs: 90, ...limits,
  })) {
    const existed = Object.hasOwn(DEFAULTS, key);
    const previous = DEFAULTS[key];
    DEFAULTS[key] = value;
    t.after(() => { if (existed) DEFAULTS[key] = previous; else delete DEFAULTS[key]; });
  }
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('no real network calls in this regression'));
  const requests = [];
  const messages = [];
  const synthesize = (id, answer) => t.mock.method(byId[id], 'complete', async request => {
    if (request.system.startsWith('You audit')) return { text: '{"followups":["Check another finding"]}' };
    if (!request.system.startsWith('You are the synthesizer')) {
      return { text: workerText(mode, request.prompt.includes('Your sub-question (follow-up)')), usage: { inputTokens: 2 } };
    }
    requests.push({ id, request });
    return answer(request);
  });
  for (const provider of PROVIDERS) {
    t.mock.method(provider, 'complete', async () => assert.fail(`unexpected provider ${provider.id}`));
  }
  t.after(() => assert.equal(fetch.mock.callCount(), 0));
  return {
    requests, messages, synthesize,
    options: {
      query: 'Check synthesis timeout', mode, workers: 1, rounds: 1, rank: 'off',
      ...(mode === 'files' ? { paths: ['src/providers/base.mjs'], provider: 'arcodex-cli' } : { angles: ['Check a finding'] }),
      timeoutMs: 900_000, onProgress: message => messages.push(message),
    },
  };
}

async function within(t, pending, watchdogMs = 1000) {
  const started = performance.now();
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`swarm did not return within ${watchdogMs}ms; test watchdog ended the hang`)), watchdogMs);
    })]);
  } finally {
    clearTimeout(timer);
    t.diagnostic(`elapsedMs=${Math.round(performance.now() - started)}; watchdogMs=${watchdogMs}`);
  }
}

function assertRaw(result, stage) {
  assert.deepEqual(Object.keys(result).sort(), ['markdown', 'report']);
  assert.equal(result.report.synthesisFailure.stage, stage);
  assert.equal(typeof result.report.synthesisFailure.reason, 'string');
  assert.ok(result.report.synthesisFailure.reason.length);
  assert.match(result.markdown, /Synthesis failed|Синтез не выполнен/);
  assert.match(result.markdown, /Raw worker reports|Исходные отчёты воркеров/);
  assert.deepEqual(Object.keys(result.report.synthesis).sort(), ['model', 'provider']);
  for (const report of [...result.report.workers, ...result.report.round2]) {
    if (report.ok) assert.ok(result.markdown.includes(report.text), `raw report ${report.id} must be retained intact`);
  }
}

test('FAILS_ON_OLD 986: arcodex failure, citations violation and unresponsive correction return raw reports', async t => {
  const f = fixture(t);
  f.synthesize('arcodex-cli', async () => { throw new Error('fixture first synthesis failed'); });
  f.synthesize('codex-cli', request => request.prompt.includes('Violated format rule')
    ? new Promise(() => {}) : { text: malformed });
  const result = await within(t, swarmSearch(f.options));
  assertRaw(result, 'synthesis format correction');
  assert.equal(result.report.workers[0].text, workerText('files'));
  assert.match(result.report.synthesisFailure.reason, /timed out/);
  assert.deepEqual(f.requests.map(r => r.id), ['arcodex-cli', 'codex-cli', 'codex-cli']);
  assert.ok(f.messages.includes('synthesis: arcodex-cli failed, trying next offline provider'));
  assert.ok(f.messages.includes('synthesis: format rule synthesis.citations violated; one correction request'));
  assert.ok(f.messages.some(message => /returning raw worker reports/.test(message)));
  assert.ok(f.requests.at(-1).request.signal.aborted, 'the correction provider must also be cancelled');
  assert.ok(result.report.providerAttempts.some(a => a.stage === 'synthesis format correction' && a.sourceResult.status === 'timeout'));
});

test('FAILS_ON_OLD 986: an unresponsive first synthesis has its own attempt deadline', async t => {
  const f = fixture(t, { available: ['arcodex-cli'] });
  f.synthesize('arcodex-cli', () => new Promise(() => {}));
  const result = await within(t, swarmSearch(f.options));
  assertRaw(result, 'synthesis');
  assert.match(result.report.synthesisFailure.reason, /arcodex-cli.*timed out/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].request.timeoutMs, 30);
  assert.ok(f.requests[0].request.signal.aborted);
});

test('FAILS_ON_OLD 986: exhausted synthesis providers preserve both worker rounds', async t => {
  const f = fixture(t);
  for (const id of ['arcodex-cli', 'codex-cli']) {
    f.synthesize(id, async () => { throw new Error(`fixture ${id} synthesis failed`); });
  }
  const result = await within(t, swarmSearch({ ...f.options, rounds: 2 }));
  assertRaw(result, 'synthesis');
  assert.equal(result.report.workers[0].text, workerText('files'));
  assert.equal(result.report.round2[0].text, workerText('files', true));
  assert.match(result.report.synthesisFailure.reason, /arcodex-cli/);
  assert.match(result.report.synthesisFailure.reason, /codex-cli/);
  assert.match(result.markdown, /RAW_986_FOLLOWUP/);
});

test('a timed-out synthesis attempt can still use the next web provider', async t => {
  const f = fixture(t, { mode: 'web', available: ['arcodex-cli', 'agy-cli', 'claude-cli'] });
  f.synthesize('arcodex-cli', () => new Promise(() => {}));
  f.synthesize('agy-cli', () => ({ text: valid }));
  const result = await within(t, swarmSearch(f.options));
  assert.equal(result.report.synthesis.provider, 'agy-cli');
  assert.equal(result.report.synthesisFailure, undefined);
  assert.deepEqual(f.requests.map(r => r.id), ['arcodex-cli', 'agy-cli']);
  assert.ok(f.requests[0].request.signal.aborted);
  assert.equal(f.requests[1].request.signal.aborted, false);
  assert.match(result.markdown, /Finding \[1\]/);
});

test('the synthesis chain deadline bounds retry backoff and prevents a later provider call', async t => {
  const f = fixture(t, { mode: 'web', available: ['arcodex-cli', 'agy-cli', 'claude-cli'], limits: { synthesisTimeoutMs: 60 } });
  DEFAULTS.retryBackoffMs = 5000;
  f.synthesize('arcodex-cli', async () => { throw new ProviderError('fixture rate limit', { status: 429 }); });
  const result = await within(t, swarmSearch(f.options));
  assertRaw(result, 'synthesis');
  assert.equal(result.report.synthesisFailure.code, 'ETIMEDOUT');
  assert.match(result.report.synthesisFailure.reason, /synthesis.*60ms/);
  assert.deepEqual(f.requests.map(r => r.id), ['arcodex-cli']);
  assert.equal(result.report.status, 'partial');
});

test('the correction chain has a separate deadline even when attempt limits are larger', async t => {
  const f = fixture(t, { available: ['arcodex-cli'], limits: { synthesisAttemptTimeoutMs: 200, synthesisCorrectionTimeoutMs: 40 } });
  f.synthesize('arcodex-cli', request => request.prompt.includes('Violated format rule')
    ? new Promise(() => {}) : { text: malformed });
  const result = await within(t, swarmSearch(f.options));
  assertRaw(result, 'synthesis format correction');
  assert.equal(result.report.synthesisFailure.code, 'ETIMEDOUT');
  assert.match(result.report.synthesisFailure.reason, /synthesis format correction.*40ms/);
  assert.equal(f.requests.length, 2, 'one correction only');
  assert.ok(f.requests[1].request.signal.aborted);
});

test('external cancellation interrupts an unresponsive synthesizer without starting fallback', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  let timer;
  f.synthesize('arcodex-cli', () => {
    timer = setTimeout(() => controller.abort(), 10);
    return new Promise(() => {});
  });
  t.after(() => clearTimeout(timer));
  await assert.rejects(within(t, swarmSearch({ ...f.options, signal: controller.signal })), /cancelled/);
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].request.signal.aborted);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('late provider rejection after a deadline is handled and cancellation listeners are removed', async t => {
  const f = fixture(t, { available: ['arcodex-cli'] });
  const controller = new AbortController();
  f.synthesize('arcodex-cli', request => new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('fixture late rejection')), 5), { once: true });
  }));
  const result = await within(t, swarmSearch({ ...f.options, signal: controller.signal }));
  assertRaw(result, 'synthesis');
  await delay(15);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a lower existing timeout remains effective and successful synthesis keeps its envelope', async t => {
  const f = fixture(t, { available: ['arcodex-cli'] });
  f.synthesize('arcodex-cli', () => ({ text: valid }));
  const controller = new AbortController();
  const result = await within(t, swarmSearch({ ...f.options, timeoutMs: 12, signal: controller.signal }));
  assert.equal(f.requests[0].request.timeoutMs, 12);
  assert.deepEqual(Object.keys(result.report.synthesis).sort(), ['model', 'provider']);
  assert.equal(result.report.synthesisFailure, undefined);
  // The source fixture may span several shards; compare with actual provider calls.
  assert.equal(result.report.usage.calls, byId['arcodex-cli'].complete.mock.callCount());
  await delay(25);
  assert.equal(f.requests[0].request.signal.aborted, false, 'successful calls must not be aborted by a stale timer');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('MCP returns nonempty content and its existing structured report after synthesis timeout', async t => {
  const f = fixture(t, { available: ['arcodex-cli'] });
  f.synthesize('arcodex-cli', () => new Promise(() => {}));
  const result = await within(t, callTool('swarm_search', {
    query: f.options.query, mode: 'files', paths: f.options.paths, provider: 'arcodex-cli', workers: 1, rank: 'off', rounds: 1,
  }));
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /RAW_986/);
  assert.match(result.content[0].text, /Synthesis failed/);
  assert.equal(result.structuredContent.synthesisFailure.stage, 'synthesis');
  assert.equal(result.structuredContent.workers[0].text, workerText('files'));
});

test('CLI --json exits with worker reports after a mocked synthesis timeout', async t => {
  const script = `
    import { DEFAULTS } from ${JSON.stringify(new URL('../src/swarm.mjs', import.meta.url).href)};
    import { PROVIDERS, byId } from ${JSON.stringify(new URL('../src/providers/index.mjs', import.meta.url).href)};
    DEFAULTS.synthesisAttemptTimeoutMs = 30;
    DEFAULTS.synthesisTimeoutMs = 90;
    for (const p of PROVIDERS) {
      p.detect = () => p.id === 'arcodex-cli';
      p.complete = async () => { throw new Error('unexpected fixture provider'); };
    }
    globalThis.fetch = async () => { throw new Error('no real network calls'); };
    byId['arcodex-cli'].complete = async ({ system }) => system.startsWith('You are the synthesizer')
      ? new Promise(() => {}) : { text: ${JSON.stringify(workerText('files'))} };
    process.argv = [process.execPath, 'swarm-search', 'run', 'Check synthesis timeout', '--paths', 'src/providers/base.mjs',
      '--provider', 'arcodex-cli', '--workers', '1', '--rounds', '1', '--rank', 'off', '--json'];
    await import(${JSON.stringify(new URL('../bin/swarm-search.mjs', import.meta.url).href)});
  `;
  const started = performance.now();
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 2000,
  });
  t.diagnostic(`CLI exitAfterMs=${Math.round(performance.now() - started)}`);
  const result = JSON.parse(stdout);
  assertRaw(result, 'synthesis');
  assert.match(stderr, /returning raw worker reports/);
  assert.equal(result.report.workers[0].text, workerText('files'));
});

for (const { round2, entirelyUnavailable, correctionTimeout } of [
  { round2: 'gaps', entirelyUnavailable: false, correctionTimeout: false },
  { round2: 'critique', entirelyUnavailable: false, correctionTimeout: true },
  { round2: 'gaps', entirelyUnavailable: true, correctionTimeout: false },
]) {
  test(`FAILS_ON_OLD 986: ${round2} fallback filters ${entirelyUnavailable ? 'entirely unavailable' : 'mixed'} sources while retaining full structured reports`, async t => {
    const f = fixture(t, { mode: 'web', available: ['arcodex-cli'] });
    const available = 'https://example.com/public-986';
    const unavailable = 'https://example.com/missing-986';
    t.mock.method(byId['arcodex-cli'], 'complete', async request => {
      if (request.system.startsWith('You audit')) return { text: '{"followups":["Check another finding"]}' };
      if (request.system.startsWith('You are the synthesizer')) {
        if (!correctionTimeout) throw new Error('fixture synthesis failure');
        return request.prompt.includes('Violated format rule') ? new Promise(() => {}) : { text: malformed };
      }
      const followup = request.system.includes('critique round') || request.prompt.includes('Your sub-question (follow-up)');
      const suffix = followup ? '_FOLLOWUP' : '';
      return {
        text: `## ${request.system.includes('critique round') ? 'Confirmed' : 'Findings'}\n` +
          (entirelyUnavailable ? '' : `- PUBLIC_986${suffix} (${available})\n`) +
          `- CONTROL_FACT_986${suffix} (${unavailable})\n\n  CONTROL_CONTINUATION_986${suffix}\n` +
          (entirelyUnavailable ? '' : `- UNATTRIBUTED_986${suffix}\n`) +
          '## Uncertain\n- none',
        sources: [{ url: unavailable, status: 'unavailable' }],
        ...(entirelyUnavailable ? { status: 'unavailable' } : {}),
      };
    });
    const result = await within(t, swarmSearch({ ...f.options, rounds: 2, round2 }));
    assert.equal(result.report.synthesisFailure.stage, correctionTimeout ? 'synthesis format correction' : 'synthesis');
    assert.equal(result.report.status, 'partial');
    assert.match(result.markdown, /Synthesis failed/);
    assert.match(result.markdown, /incomplete/i);
    assert.doesNotMatch(result.markdown, /CONTROL_FACT_986|CONTROL_CONTINUATION_986|UNATTRIBUTED_986/);
    assert.ok(result.markdown.includes(unavailable), 'the unavailable URL must remain visible as a data gap');
    assert.equal(result.report.workers.length, 1);
    assert.equal(result.report.round2.length, 1);
    for (const [index, report] of [...result.report.workers, ...result.report.round2].entries()) {
      const suffix = index ? '_FOLLOWUP' : '';
      assert.ok(report.text.includes(`CONTROL_FACT_986${suffix} (${unavailable})`));
      assert.ok(report.text.includes(`\n\n  CONTROL_CONTINUATION_986${suffix}\n`));
      assert.ok(report.facts.some(fact => fact.source_url === unavailable && fact.status === 'unavailable'));
      assert.equal(report.status, entirelyUnavailable ? 'unavailable' : 'partial');
      if (!entirelyUnavailable) {
        assert.ok(report.text.includes(`UNATTRIBUTED_986${suffix}`));
        assert.ok(result.markdown.includes(`PUBLIC_986${suffix} (${available})`));
      }
    }
  });
}
