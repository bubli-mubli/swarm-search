import assert from 'node:assert/strict';
import { test, ss, mockAvail, cx, cd, ProviderError, okAns } from './helpers.mjs';

const paid = (text = okAns().text) => ({
  text,
  usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.04 },
});

test('planner timeout with fallback: usage counts 4 calls and leaves total cost unknown', async t => {
  mockAvail(t, [cx.id, cd.id]);
  t.mock.method(cx, 'complete', async ({ system }) => {
    if (system.startsWith('You split')) throw new ProviderError('arcodex timed out');
    return paid();
  });
  t.mock.method(cd, 'complete', async () => paid('["angle"]'));

  const { report, markdown } = await ss({ query: 'q', provider: 'auto', workers: 1 });
  assert.equal(cx.complete.mock.callCount(), 3);
  assert.equal(cd.complete.mock.callCount(), 1);
  assert.equal(report.workers[0].label, 'angle');
  assert.deepEqual(report.usage, {
    calls: 4, pricedCalls: 3, inputTokens: 30, outputTokens: 6,
    costUsd: null, usefulAnswers: 1, costPerUsefulUsd: null,
  });
  assert.doesNotMatch(markdown, /\$0\.120/);
});

test('explicit fallback synthesis inherits sonnet from the worker slots', async t => {
  mockAvail(t, [cx.id, cd.id]);
  t.mock.method(cx, 'complete', async () => { throw new ProviderError('network failure', { status: 503 }); });
  t.mock.method(cd, 'complete', async () => paid());

  const { report } = await ss({
    query: 'q', angles: ['angle'], provider: 'arcodex-cli,claude-cli', model: 'sonnet',
  });
  const requests = cd.complete.mock.calls.map(call => call.arguments[0]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, 'sonnet');
  assert.ok(requests[1].system.startsWith('You are the synthesizer'));
  assert.equal(requests[1].model, 'sonnet');
  assert.deepEqual(report.synthesis, { provider: cd.id, model: 'sonnet' });
});

for (const stage of ['planner', 'worker', 'audit']) {
  test(`${stage} error without fallback: each actual attempt is counted once with unknown cost`, async t => {
    mockAvail(t, [cx.id]);
    const prefixes = {
      planner: 'You split', worker: 'You are one worker',
      audit: 'You audit',
    };
    let failed = false;
    t.mock.method(cx, 'complete', async ({ system }) => {
      if (!failed && system.startsWith(prefixes[stage])) {
        failed = true;
        throw new ProviderError('invalid request', { status: 400 });
      }
      return paid(system.startsWith('You split') ? '["a","b"]' : undefined);
    });
    const { report } = await ss({
      query: 'q', provider: cx.id, workers: 2,
      ...(stage === 'planner' ? {} : { angles: ['a', 'b'] }),
      rounds: stage === 'audit' ? 2 : 1,
    });
    assert.ok(failed);
    assert.equal(report.usage.calls, cx.complete.mock.callCount());
    assert.equal(report.usage.calls, stage === 'planner' || stage === 'audit' ? 4 : 3);
    assert.equal(report.usage.pricedCalls, report.usage.calls - 1);
    assert.equal(report.usage.costUsd, null);
    assert.equal(report.usage.costPerUsefulUsd, null);
  });
}

test('synthesis timeout with fallback counts the failed attempt once', async t => {
  mockAvail(t, [cx.id, cd.id]);
  t.mock.method(cx, 'complete', async ({ system }) => {
    if (system.startsWith('You are the synthesizer')) throw new ProviderError('arcodex timed out');
    return paid();
  });
  t.mock.method(cd, 'complete', async () => paid());
  const { report } = await ss({ query: 'q', angles: ['a'], provider: 'arcodex-cli,claude-cli' });
  assert.equal(report.usage.calls, 3);
  assert.equal(report.usage.pricedCalls, 2);
  assert.equal(report.usage.costUsd, null);
  assert.equal(report.synthesis.provider, cd.id);
});

for (const overrides of [
  { provider: 'arcodex-cli:primary,claude-cli:reserve', model: 'sonnet', expected: 'reserve' },
  { provider: 'arcodex-cli,claude-cli', model: 'sonnet', synthProvider: 'arcodex-cli,claude-cli', expected: cd.defaultModel },
  { provider: 'auto', model: 'gpt-worker', synthModel: 'gpt-synthesis', expected: cd.defaultModel },
]) {
  test(`synthesis fallback preserves model precedence: ${JSON.stringify(overrides)}`, async t => {
    mockAvail(t, [cx.id, cd.id]);
    t.mock.method(cx, 'complete', async () => { throw new ProviderError('network failure', { status: 503 }); });
    t.mock.method(cd, 'complete', async () => paid());
    const { expected, ...opts } = overrides;
    const { report } = await ss({ query: 'q', angles: ['a'], ...opts });
    assert.equal(cd.complete.mock.calls.at(-1).arguments[0].model, expected);
    assert.deepEqual(report.synthesis, { provider: cd.id, model: expected });
  });
}
