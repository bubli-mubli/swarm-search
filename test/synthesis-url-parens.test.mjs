import assert from 'node:assert/strict';
import { promises as dns } from 'node:dns';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { PROVIDERS, byId } from '../src/providers/index.mjs';
import { ProviderError } from '../src/providers/base.mjs';
import { swarmSearch, DEFAULTS } from '../src/swarm.mjs';
import { mockAvailable } from './helpers.mjs';

for (const [scenario, reference, verified] of [
  ['keeps a separate file citation after a URL with parentheses', 'https://example.org/page(v2), package.json:6', 1],
  ['does not verify a file citation embedded in a URL with parentheses', 'https://example.org/page(v2),ghost.txt:1,package.json:6', 0],
  ['keeps a separate file citation after a backtick-quoted URL', '`https://example.org/page(v2)`,package.json:6', 1],
  ['keeps a separate file citation after an angle-bracketed URL', '<https://example.org/page(v2(beta))>,package.json:6', 1],
]) {
  test(`1331: file synthesis fallback ${scenario}`, async t => {
    mockAvailable(t, ['arcodex-cli']);
    const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('unexpected fetch in files mode'));
    const lookup = t.mock.method(dns, 'lookup', async () => assert.fail('unexpected DNS call in files mode'));
    const finding = `- Package metadata (${reference})`;
    const complete = t.mock.method(byId['arcodex-cli'], 'complete', async request => {
      assert.equal(request.web, false);
      if (request.system.startsWith('You are the synthesizer')) throw new Error('fixture synthesis unavailable');
      assert.match(request.prompt, /===== FILE: package\.json =====\n(?:[^\n]*\n){5} +6\|/);
      return { text: `## Findings\n${finding}\n## Not found\n- none` };
    });

    const result = await swarmSearch({
      query: 'Check package metadata', mode: 'files', provider: 'arcodex-cli',
      paths: ['package.json'], workers: 1, rounds: 1, rank: 'off',
    });
    assert.equal(result.report.synthesisFailure?.stage, 'synthesis');
    assert.equal(complete.mock.callCount(), 2);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(lookup.mock.callCount(), 0);
    const [summary, raw] = result.markdown.split('## Raw worker reports');
    assert.ok(raw?.includes(finding));
    assert.equal(result.report.sourceCheck.verified, verified);
    assert.equal(result.report.sourceCheck.total, verified);
    assert.doesNotMatch(summary, /https:\/\/|ghost\.txt:1/);
    if (verified) {
      assert.match(summary, /Package metadata \[1\]/);
      assert.match(summary, /^1\. package\.json:6(?=\s|$)/m);
    } else {
      assert.doesNotMatch(summary, /## Sources|Package metadata|package\.json:6/);
      assert.match(summary, /No checked file citations/);
    }
  });
}

function fixture(context, { available = ['arcodex-cli', 'codex-cli'], limits = {} } = {}) {
  mockAvailable(context, available);
  for (const [key, value] of Object.entries({
    synthesisAttemptTimeoutMs: 30, synthesisTimeoutMs: 180, synthesisCorrectionTimeoutMs: 90, ...limits,
  })) {
    const existed = Object.hasOwn(DEFAULTS, key);
    const previous = DEFAULTS[key];
    DEFAULTS[key] = value;
    context.after(() => { if (existed) DEFAULTS[key] = previous; else delete DEFAULTS[key]; });
  }
  const fetch = context.mock.method(globalThis, 'fetch', async () => assert.fail('no real network calls in this regression'));
  for (const provider of PROVIDERS) {
    context.mock.method(provider, 'complete', async () => assert.fail(`unexpected provider ${provider.id}`));
  }
  context.after(() => assert.equal(fetch.mock.callCount(), 0));
  return {
    options: {
      query: 'Check synthesis timeout', mode: 'files', workers: 1, rounds: 1, rank: 'off',
      paths: ['src/providers/base.mjs'], provider: 'arcodex-cli', timeoutMs: 900_000,
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

for (const confirmed of [true, false]) {
  test(`1307: files synthesis failure ${confirmed ? 'keeps a checked citation' : 'reports no checked citations'}`, async t => {
    const f = fixture(t);
    const lookup = t.mock.method(dns, 'lookup', async () => assert.fail('no DNS calls in files mode'));
    const text = '## Findings\n' +
      (confirmed ? '- LOCAL_1307 (output-provenance.mjs:3-5, invented.mjs:1)\n' : '') +
      '- OVERSIZED_1307 (output-provenance.mjs:3-9000)\n' +
      '- OUTSIDE_1307 (output-provenance.mjs:55-99)\n' +
      '- REVERSED_1307 (output-provenance.mjs:9-2)\n' +
      '- ABSOLUTE_1307 (/output-provenance.mjs:7)\n' +
      '- UNSEEN_1307 (base.mjs:35)\n## Not found\n- UNCERTAIN_1307 (output-provenance.mjs:1)';
    const primary = t.mock.method(byId['arcodex-cli'], 'complete', async request => {
      assert.equal(request.web, false);
      if (request.system.startsWith('You are the synthesizer')) throw new Error('fixture connection refused');
      assert.match(request.prompt, /===== FILE: output-provenance\.mjs =====\n +1\|/);
      return { text };
    });
    const backup = t.mock.method(byId['codex-cli'], 'complete', async request => {
      assert.equal(request.web, false);
      assert.match(request.system, /^You are the synthesizer/);
      throw new ProviderError('fixture no credits', { status: 402 });
    });
    const result = await within(t, swarmSearch({ ...f.options, paths: ['src/output-provenance.mjs'] }));
    assertRaw(result, 'synthesis');
    assert.equal(result.report.status, 'partial');
    assert.equal(result.report.workers.length, 1);
    assert.equal(result.report.workers[0].text, text);
    assert.equal(primary.mock.callCount(), 2, 'one worker and one synthesis attempt');
    assert.equal(backup.mock.callCount(), 1, 'one existing backup synthesis attempt');
    assert.equal(lookup.mock.callCount(), 0);
    const summary = result.markdown.split('## Raw worker reports')[0];
    assert.equal(result.report.sourceCheck.verified, Number(confirmed));
    assert.equal(result.report.sourceCheck.total, Number(confirmed));
    assert.match(summary, /incomplete/i);
    assert.doesNotMatch(summary, /OVERSIZED_1307|OUTSIDE_1307|REVERSED_1307|ABSOLUTE_1307|UNSEEN_1307|UNCERTAIN_1307|invented\.mjs:1/);
    if (confirmed) {
      assert.match(summary, /LOCAL_1307[^\n]*\[1\]/);
      assert.match(summary, /^1\. output-provenance\.mjs:3-5\b/m);
      assert.match(summary, /claims (?:were |are )?not verified/i);
    } else {
      assert.match(summary, /no checked file citations/i);
    }
  });
}

async function fileCitationFallback(t, path, reference, status = 'ok', otherFindings = '') {
  const f = fixture(t, { available: ['arcodex-cli'] });
  const lookup = t.mock.method(dns, 'lookup', async () => assert.fail('no DNS calls in files mode'));
  const text = `## Findings\n- FINDING_1307 (${reference})\n${otherFindings}## Not found\n- none`;
  const complete = t.mock.method(byId['arcodex-cli'], 'complete', async request => {
    assert.equal(request.web, false);
    if (request.system.startsWith('You are the synthesizer')) throw new Error('fixture connection refused');
    assert.ok(request.prompt.includes(`===== FILE: ${path.split('/').at(-1)} =====\n`));
    return { text, status };
  });
  const result = await within(t, swarmSearch({ ...f.options, paths: [path] }));
  assert.equal(result.report.status, 'partial');
  assert.equal(result.report.synthesisFailure.stage, 'synthesis');
  assert.equal(result.report.workers[0].text, text);
  assert.equal(complete.mock.callCount(), 2, 'one worker and one synthesis attempt');
  assert.equal(lookup.mock.callCount(), 0);
  const summary = result.markdown.split('## Raw worker reports')[0];
  assert.match(summary, /incomplete/i);
  return { report: result.report, summary };
}

for (const [scenario, path, reference, verified] of [
  ['does not match a path by suffix', 'src/output-provenance.mjs', 'archive/old output-provenance.mjs:3-5', 0],
  ['does not match a path after collapsing unshown segments', 'src/output-provenance.mjs', 'archive/../output-provenance.mjs:3-5', 0],
  ['checks the end of a spaced line range', 'src/output-provenance.mjs', 'output-provenance.mjs:3 - 9000', 0],
  ['accepts a displayed file without an extension', 'LICENSE', 'LICENSE:1-3', 1],
]) {
  test(`FAILS_ON_OLD 1307: files fallback ${scenario}`, async t => {
    const { report, summary } = await fileCitationFallback(t, path, reference);
    assert.equal(report.sourceCheck.verified, verified, reference);
    assert.equal(report.sourceCheck.total, verified);
    if (verified) {
      assert.match(summary, /FINDING_1307[^\n]*\[1\]/);
      assert.match(summary, /^1\. LICENSE:1-3\b/m);
    } else {
      assert.doesNotMatch(summary, /FINDING_1307/);
      assert.match(summary, /no checked file citations/i);
    }
  });
}

test('FAILS_ON_OLD 1307: files fallback checks findings individually in a partial report', async t => {
  const { report, summary } = await fileCitationFallback(t, 'src/output-provenance.mjs', 'output-provenance.mjs:3-5', 'partial',
    '- status=unavailable: MISSING_1307 (output-provenance.mjs:7)\n');
  assert.equal(report.workers[0].ok, true);
  assert.equal(report.workers[0].status, 'partial');
  assert.equal(report.sourceCheck.verified, 1);
  assert.equal(report.sourceCheck.total, 1);
  assert.match(summary, /FINDING_1307[^\n]*\[1\]/);
  assert.doesNotMatch(summary, /MISSING_1307|output-provenance\.mjs:7/);
});

test('FAILS_ON_OLD 1307: files fallback omits unavailable reports even when the call succeeded', async t => {
  const { report, summary } = await fileCitationFallback(t, 'src/output-provenance.mjs', 'output-provenance.mjs:3-5', 'unavailable');
  assert.equal(report.workers[0].ok, true);
  assert.equal(report.workers[0].status, 'unavailable');
  assert.equal(report.sourceSummary.found, 0);
  assert.equal(report.sourceSummary.failed, 1);
  assert.equal(report.sourceCheck.verified, 0);
  assert.equal(report.sourceCheck.total, 0);
  assert.doesNotMatch(summary, /FINDING_1307/);
  assert.match(summary, /no checked file citations/i);
});

test('FAILS_ON_OLD 1307 review: a real part suffix does not authorize a different file name', async t => {
  const dir = await mkdtemp('.file-fallback-1307-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'memo.txt (part 1)');
  await writeFile(path, 'first\nsecond\n');
  const { report, summary } = await fileCitationFallback(t, path, 'memo.txt:2', 'ok',
    '- EXACT_FILENAME (memo.txt (part 1):2)\n');
  assert.doesNotMatch(summary, /FINDING_1307|memo\.txt:2/);
  assert.equal(report.sourceCheck.verified, 1);
  assert.equal(report.sourceCheck.total, 1);
  assert.match(summary, /EXACT_FILENAME[^\n]*\[1\]/);
  assert.match(summary, /^1\. memo\.txt \(part 1\):2\b/m);
});

test('FAILS_ON_OLD 1307 review: a follow-up can cite across adjacent file fragments', async t => {
  const f = fixture(t, { available: ['arcodex-cli'], limits: { shardChars: 8_000, fixedShardChars: 8_000 } });
  const complete = t.mock.method(byId['arcodex-cli'], 'complete', async request => {
    assert.equal(request.web, false);
    if (request.system.startsWith('You audit')) return { text: '{"followups":["Check the fragment boundary"]}' };
    if (request.system.startsWith('You are the synthesizer')) throw new Error('fixture connection refused');
    const seesFirst = /^ +174\|/m.test(request.prompt);
    const seesSecond = /^ +175\|/m.test(request.prompt);
    if (request.prompt.includes('files of relevant shards')) {
      assert.ok(seesFirst && seesSecond, 'the follow-up sees both sides of the boundary');
      return { text: '## Findings\n- FOLLOWUP_BOUNDARY (base.mjs:174-175)\n## Not found\n- none' };
    }
    assert.notEqual(seesFirst, seesSecond, 'the initial worker only sees one side');
    return { text: '## Findings\n- SHARD_BOUNDARY (base.mjs:174-175)\n## Not found\n- none' };
  });
  const result = await within(t, swarmSearch({ ...f.options, rounds: 2, round2: 'gaps' }));
  assertRaw(result, 'synthesis');
  assert.equal(complete.mock.callCount(), 5, 'two workers, audit, follow-up, synthesis');
  assert.equal(result.report.sourceCheck.verified, 1);
  assert.equal(result.report.sourceCheck.total, 1);
  const summary = result.markdown.split('## Raw worker reports')[0];
  assert.match(summary, /FOLLOWUP_BOUNDARY[^\n]*\[1\]/);
  assert.match(summary, /^1\. base\.mjs:174-175\b/m);
  assert.doesNotMatch(summary, /SHARD_BOUNDARY/);
});

test('FAILS_ON_OLD 1307 review: unchecked inline Makefile references do not leak into findings', async t => {
  const { report, summary } = await fileCitationFallback(t, 'LICENSE', 'LICENSE:1-3', 'ok',
    '- INLINE_1307 mentions Makefile:999, `archive/Makefile:1 - 999` and LICENSE:2 (LICENSE:1-3)\n');
  assert.equal(report.sourceCheck.verified, 1);
  assert.equal(report.sourceCheck.total, 1);
  assert.match(summary, /INLINE_1307[^\n]*\[1\]/);
  assert.doesNotMatch(summary, /Makefile:|LICENSE:2/);
  assert.deepEqual(report.sourceCheck.bodyUnverified, ['Makefile:999', 'archive/Makefile:1 - 999']);
});

test('FAILS_ON_OLD 1307 review: a comma inside a quoted file reference cannot authorize its suffix', async t => {
  const { report, summary } = await fileCitationFallback(t, 'LICENSE', '`draft,LICENSE:1`');
  assert.equal(report.sourceCheck.verified, 0);
  assert.equal(report.sourceCheck.total, 0);
  assert.doesNotMatch(summary, /FINDING_1307|LICENSE:1\b/);
  assert.match(summary, /no checked file citations/i);
});

test('FAILS_ON_OLD 1307 review: a trailing URL verification mark preserves the file citation', async t => {
  const f = fixture(t, { available: ['arcodex-cli'] });
  const lookup = t.mock.method(dns, 'lookup', async () => assert.fail('no DNS calls in files mode'));
  const url = 'https://sources.example/article';
  const finding = `- WITH_URL_1307 mentions ${url} (package.json:6)`;
  const complete = t.mock.method(byId['arcodex-cli'], 'complete', async request => {
    assert.equal(request.web, false);
    if (request.system.startsWith('You are the synthesizer')) throw new Error('fixture connection refused');
    assert.match(request.prompt, /===== FILE: package\.json =====\n(?:[^\n]*\n){5} +6\|/);
    return { text: `## Findings\n${finding}\n## Not found\n- none` };
  });
  const result = await within(t, swarmSearch({ ...f.options, paths: ['package.json'] }));
  assertRaw(result, 'synthesis');
  assert.equal(result.report.status, 'partial');
  assert.ok(result.report.workers[0].text.includes(`${finding} — VERIFIED=unverified (no_fetch_files_mode)`));
  assert.equal(complete.mock.callCount(), 2, 'one worker and one synthesis attempt');
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(result.report.sourceCheck.verified, 1);
  assert.equal(result.report.sourceCheck.total, 1);
  assert.deepEqual(result.report.sourceCheck.bodyUnverified, [url]);
  const summary = result.markdown.split('## Raw worker reports')[0];
  assert.match(summary, /incomplete/i);
  assert.match(summary, /WITH_URL_1307[^\n]*\[1\]/);
  assert.match(summary, /^1\. package\.json:6\b/m);
  assert.doesNotMatch(summary, /https:\/\/|no_fetch_files_mode/);
});

const parenUrl = 'https://example.org/page(v2)';
const detailUrl = `${parenUrl}/details`;

for (const [scenario, finding, unverified, claim = 'Inspect'] of [
  ['keeps the file citation after a double-quoted URL', `- Inspect ("${parenUrl}",package.json:6)`, []],
  ['keeps the full URL from a finding body', `- Inspect ${detailUrl} (package.json:6)`, [detailUrl]],
  ['keeps the file citation after a single-quoted URL', `- Inspect ('${parenUrl}',package.json:6)`, []],
  ['reads a backtick-quoted URL in the body', `- Inspect \`${detailUrl}\` (package.json:6)`, [detailUrl]],
  ['reads an angle-bracketed URL in the body', `- Inspect <${detailUrl}> (package.json:6)`, [detailUrl]],
  ['handles a comma after a URL with parentheses',
    `- Inspect ${detailUrl}, then compare (${parenUrl}, package.json:6)`, [detailUrl], 'Inspect then compare'],
]) {
  test(`1331 review: file fallback ${scenario}`, async t => {
    const f = fixture(t, { available: ['arcodex-cli'] });
    const lookup = t.mock.method(dns, 'lookup', async () => assert.fail('no DNS calls in files mode'));
    t.mock.method(byId['arcodex-cli'], 'complete', async request => {
      assert.equal(request.web, false);
      if (request.system.startsWith('You are the synthesizer')) throw new Error('fixture connection refused');
      assert.match(request.prompt, /===== FILE: package\.json =====\n(?:[^\n]*\n){5} +6\|/);
      return { text: `## Findings\n${finding}\n## Not found\n- none` };
    });
    const result = await within(t, swarmSearch({ ...f.options, paths: ['package.json'] }));
    assertRaw(result, 'synthesis');
    assert.ok(result.report.workers[0].text.includes(`${finding} — VERIFIED=unverified (no_fetch_files_mode)`));
    assert.equal(lookup.mock.callCount(), 0);
    const { verified, total, bodyUnverified } = result.report.sourceCheck;
    assert.equal(verified, 1);
    assert.equal(total, 1);
    assert.deepEqual(bodyUnverified, unverified);
    const summary = result.markdown.split('## Raw worker reports')[0];
    const lines = summary.split('\n');
    const mark = '_[untrusted source: files via worker reports]_';
    const item = lines.find(line => line.startsWith('- Inspect '));
    assert.equal(item?.replace(/ +/g, ' '), `- ${claim} [1] ${mark}`);
    assert.ok(lines.includes(`1. package.json:6 ${mark}`));
  });
}

const urlWithFileSuffixes = `${parenUrl},ghost.txt:1,package.json:6`;

for (const [scenario, reference, wrappedReference, sourceLine, acceptsPlain = true] of [
  ['keeps the file citation after a parenthesized URL',
    `${parenUrl}, package.json:6`, `((${parenUrl})),package.json:6`, 6],
  ['does not verify comma suffixes within a URL',
    urlWithFileSuffixes, `"(${urlWithFileSuffixes})",package.json:7`, 7, false],
  ['keeps the file citation after a quoted URL',
    `"${parenUrl}",package.json:6`, `( ("${parenUrl}") ),package.json:6`, 6],
]) {
  test(`1336: ${scenario}`, async t => {
    const f = fixture(t, { available: ['arcodex-cli'] });
    const lookup = t.mock.method(dns, 'lookup', async () => assert.fail('no DNS calls in files mode'));
    const findings = [`- PLAIN_1336 (${reference})`, `- WRAPPED_1336 (${wrappedReference})`];
    t.mock.method(byId['arcodex-cli'], 'complete', async request => {
      assert.equal(request.web, false);
      if (request.system.startsWith('You are the synthesizer')) throw new Error('fixture connection refused');
      assert.match(request.prompt, /===== FILE: package\.json =====\n(?:[^\n]*\n){5} +6\|[^\n]*\n +7\|/);
      return { text: `## Findings\n${findings.join('\n')}\n## Not found\n- none` };
    });
    const result = await within(t, swarmSearch({ ...f.options, paths: ['package.json'] }));
    assertRaw(result, 'synthesis');
    assert.equal(lookup.mock.callCount(), 0);
    for (const finding of findings) {
      assert.ok(result.report.workers[0].text.includes(`${finding} — VERIFIED=unverified (no_fetch_files_mode)`));
    }
    assert.equal(result.report.sourceCheck.verified, 1);
    assert.equal(result.report.sourceCheck.total, 1);
    const summary = result.markdown.split('## Raw worker reports')[0];
    assert.match(summary, /^- WRAPPED_1336 \[1\]/m);
    assert.match(summary, new RegExp(String.raw`^1\. package\.json:${sourceLine}\b`, 'm'));
    assert.doesNotMatch(summary, /https:\/\/|ghost\.txt:1/);
    if (acceptsPlain) assert.match(summary, /^- PLAIN_1336 \[1\]/m);
    else assert.doesNotMatch(summary, /PLAIN_1336|package\.json:6\b/);
  });
}

for (const [scenario, reference, verified] of [
  ['does not verify the comma suffix of a URL', 'https://example.org/draft,package.json:6', 0],
  ['keeps the real file citation after a URL with a fake citation in it', 'https://example.org/draft,package.json:7 package.json:6', 1],
]) {
  test(`1317 URL: ${scenario}`, async t => {
    const f = fixture(t, { available: ['arcodex-cli'] });
    const lookup = t.mock.method(dns, 'lookup', async () => assert.fail('no DNS calls in files mode'));
    const finding = `- FINDING_URL_1317 (${reference})`;
    const nested = verified ? '- NESTED_URL_1317 ((https://example.org/draft,package.json:7), package.json:6)\n' : '';
    const complete = t.mock.method(byId['arcodex-cli'], 'complete', async request => {
      assert.equal(request.web, false);
      if (request.system.startsWith('You are the synthesizer')) throw new Error('fixture connection refused');
      assert.match(request.prompt, /===== FILE: package\.json =====\n(?:[^\n]*\n){5} +6\|[^\n]*\n +7\|/);
      return { text: `## Findings\n${finding}\n${nested}## Not found\n- none` };
    });
    const result = await within(t, swarmSearch({ ...f.options, paths: ['package.json'] }));
    assertRaw(result, 'synthesis');
    assert.ok(result.report.workers[0].text.includes(`${finding} — VERIFIED=unverified (no_fetch_files_mode)`));
    assert.equal(complete.mock.callCount(), 2);
    assert.equal(lookup.mock.callCount(), 0);
    assert.equal(result.report.sourceCheck.verified, verified);
    assert.equal(result.report.sourceCheck.total, verified);
    const summary = result.markdown.split('## Raw worker reports')[0];
    assert.doesNotMatch(summary, /https:\/\/|package\.json:7\b/);
    if (verified) {
      assert.match(summary, /FINDING_URL_1317[^\n]*\[1\]/);
      assert.match(summary, /NESTED_URL_1317[^\n]*\[1\]/);
      assert.match(summary, /^1\. package\.json:6(?=\s|$)/m);
    } else {
      assert.doesNotMatch(summary, /FINDING_URL_1317|package\.json:6\b/);
      assert.match(summary, /no checked file citations/i);
    }
  });
}

test('1317 filename: preserves a displayed quoted comma filename', async t => {
  const dir = await mkdtemp('.file-fallback-1317-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'draft,LICENSE');
  await writeFile(path, 'first\n');
  const { report, summary } = await fileCitationFallback(t, path, '`draft,LICENSE:1`', 'ok',
    '- BARE_1317 (draft,LICENSE:1)\n');
  assert.equal(report.sourceCheck.verified, 1);
  assert.equal(report.sourceCheck.total, 1);
  assert.match(summary, /FINDING_1307[^\n]*\[1\]/);
  assert.match(summary, /BARE_1317[^\n]*\[1\]/);
  assert.match(summary, /^1\. draft,LICENSE:1(?=\s|$)/m);
});

test('1317 filename: does not verify the suffix of an unshown comma filename', async t => {
  const { report, summary } = await fileCitationFallback(t, 'LICENSE', '`draft,LICENSE:1`', 'ok',
    '- WITH_REAL_1317 (draft,LICENSE:1,LICENSE:2)\n');
  assert.equal(report.sourceCheck.verified, 1);
  assert.equal(report.sourceCheck.total, 1);
  assert.match(summary, /WITH_REAL_1317[^\n]*\[1\]/);
  assert.match(summary, /^1\. LICENSE:2(?=\s|$)/m);
  assert.doesNotMatch(summary, /FINDING_1307|LICENSE:1\b/);
});

test('1307: files format failure checks references against each worker’s displayed slice', async t => {
  const f = fixture(t, { available: ['arcodex-cli'], limits: { shardChars: 100, fixedShardChars: 8_000 } });
  const calls = [];
  t.mock.method(byId['arcodex-cli'], 'complete', async request => {
    if (request.system.startsWith('You audit')) {
      calls.push('audit');
      return { text: '{"followups":["Check context"]}' };
    }
    if (request.system.startsWith('You are the synthesizer')) {
      calls.push('synthesis');
      return { text: 'MALFORMED_1307 [2].\n## Sources\n1. base.mjs:178' };
    }
    if (request.prompt.includes('files of relevant shards')) {
      calls.push('follow-up');
      assert.match(request.prompt, / +2\|.*\n/);
      assert.doesNotMatch(request.prompt, / +35\|/);
      return { text: '## Findings\n- FOLLOWUP_1307 (base.mjs:2)\n- CUT_1307 (base.mjs:35)\n## Not found\n- none' };
    }
    calls.push('worker');
    if (request.prompt.includes('base.mjs (part 2)')) {
      assert.match(request.prompt, / +178\|/);
      return { text: 'NOTHING RELEVANT.' };
    }
    assert.match(request.prompt, /base\.mjs \(part 1\)/);
    assert.doesNotMatch(request.prompt, / +178\|/);
    return { text: '## Findings\n- SHARD_1307 (base.mjs:1)\n- OTHER_SHARD_1307 (base.mjs:178)\n## Not found\n- none' };
  });
  const result = await within(t, swarmSearch({ ...f.options, rounds: 2, round2: 'gaps' }));
  assertRaw(result, 'synthesis format correction');
  assert.equal(result.report.synthesisFailure.code, 'SYNTHESIS_FORMAT');
  assert.deepEqual(calls, ['worker', 'worker', 'audit', 'follow-up', 'synthesis', 'synthesis']);
  assert.equal(result.report.sourceCheck.verified, 2);
  assert.equal(result.report.sourceCheck.total, 2);
  const summary = result.markdown.split('## Raw worker reports')[0];
  assert.match(summary, /SHARD_1307[^\n]*\[1\]/);
  assert.match(summary, /FOLLOWUP_1307[^\n]*\[2\]/);
  assert.doesNotMatch(summary, /MALFORMED_1307|OTHER_SHARD_1307|CUT_1307|base\.mjs:(35|178)\b/);
});
