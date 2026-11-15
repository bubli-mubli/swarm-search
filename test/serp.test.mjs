import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { swarmSearch } from '../src/swarm.mjs';
import { byId } from '../src/providers/index.mjs';
import { callTool, TOOLS } from '../src/mcp.mjs';
import { googleApi } from '../src/providers/google-api.mjs';
import { anthropicApi } from '../src/providers/anthropic-api.mjs';
import { openaiApi } from '../src/providers/openai-api.mjs';

const page = 'https://example.org/articles/start%20here?lang=ru&part=2#first';
const fetched_at = '2026-11-15T00:00:00.000Z';
function fake(t, extra = {}) {
  const provider = {
    id: 'serp-test', defaultModel: 'free-fixture',
    async complete() { return { text: 'A useful report with https://example.org' }; },
    ...extra,
  };
  byId[provider.id] = provider;
  t.after(() => { delete byId[provider.id]; });
  return provider;
}
const options = { query: 'как начать вайбкодинг с нуля', provider: 'serp-test', angles: ['Find the article'], rounds: 1 };

test('FAILS_ON_OLD 486: worker retains page paths supplied as provider sources', async (t) => {
  fake(t, { async complete({ system }) {
    if (system.startsWith('You are one worker')) return {
      text: 'A useful report; the source is supplied separately.', sources: [{ url: page, title: 'Start here' }],
    };
    return { text: `Start [1].\n## Sources\n1. ${page}` };
  } });
  const { report, markdown } = await swarmSearch(options);
  assert.ok(report.workers[0].text.includes(page));
  assert.deepEqual(report.workers[0].sources, [{ url: page, title: 'Start here' }]);
  assert.equal(report.workers[0].status, 'ok');
  assert.ok(markdown.includes(page));
});

test('FAILS_ON_OLD 486: provider without positions returns unavailable, never numbered domains', async (t) => {
  let calls = 0;
  fake(t, { async complete() { calls++; return { text: '1. https://example.org' }; } });
  const { report, markdown } = await swarmSearch({ ...options, mode: 'serp', topN: 3, region: 'RU' });
  assert.equal(report.serp?.status, 'unavailable');
  assert.equal(report.status, 'unavailable');
  assert.match(report.serp.reason, /positions/);
  assert.deepEqual(report.serp.results, []);
  assert.equal(report.serp.region, 'RU');
  assert.equal(calls, 0);
  assert.match(markdown, /unavailable/);
  assert.doesNotMatch(markdown, /https:\/\/example/);
});

test('FAILS_ON_OLD 486: bare domain makes web worker and overall report partial', async (t) => {
  fake(t);
  const { report, markdown } = await swarmSearch(options);
  assert.equal(report.workers[0].status, 'partial');
  assert.equal(report.status, 'partial');
  assert.ok(report.workers[0].sourceIssues.some(x => x.reason === 'page_url_required'));
  assert.match(markdown, /partial/);
});

test('web text URLs preserve paths, query strings and fragments in worker source records', async (t) => {
  fake(t, { async complete() { return { text: `A useful report (${page})` }; } });
  const { report } = await swarmSearch(options);
  assert.deepEqual(report.workers[0].sources, [{ url: page, title: '' }]);
  assert.equal(report.workers[0].status, 'ok');
});

test('API adapters retain page URL/title metadata without treating citation order as SERP rank', async (t) => {
  const cases = [
    [googleApi, { candidates: [{ content: { parts: [{ text: 'Summary' }] }, groundingMetadata: {
      groundingChunks: [{ web: { uri: page, title: 'Start here' } }],
    } }] }],
    [anthropicApi, { content: [{ type: 'text', text: 'Summary', citations: [{ url: page, title: 'Start here' }] },
      { type: 'web_search_tool_result', content: [{ url: page, title: 'Start here' }] }] }],
    [openaiApi, { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Summary',
      annotations: [{ type: 'url_citation', url: page, title: 'Start here' }] }] }] }],
  ];
  let response;
  const mockedFetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(response), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  for (const [provider, data] of cases) {
    response = data;
    const result = await provider.complete({ prompt: 'Find a page', web: true });
    assert.deepEqual(result.sources, [{ url: page, title: 'Start here' }]);
    assert.equal(provider.searchSerp, undefined);
  }
  assert.equal(mockedFetch.mock.callCount(), 3);
});

test('SERP preserves explicit positions and URLs, forwards exact query/topN/region, skips synthesis', async (t) => {
  const rows = [
    { position: 2, url: 'https://example.org/page/two', title: 'Two', fetched_at },
    { position: 1, url: page, title: 'One', fetched_at },
    { position: 3, url: 'https://example.org/page/three', title: 'Three', fetched_at },
  ];
  fake(t, {
    async complete() { assert.fail('SERP must not call an LLM'); },
    async searchSerp(request) {
      assert.equal(request.query, options.query);
      assert.equal(request.topN, 2);
      assert.equal(request.region, 'RU');
      return { results: rows, region: 'RU' };
    },
  });
  const { report } = await swarmSearch({ ...options, mode: 'serp', topN: 2, region: 'RU' });
  assert.equal(report.serp.status, 'ok');
  assert.deepEqual(report.serp.results, [rows[1], rows[0]]);
});

test('SERP rejects missing/invalid/duplicate positions, region mismatch, domain URLs and missing timestamps', async (t) => {
  const row = { position: 1, url: page, title: 'One', fetched_at };
  let response;
  fake(t, { async searchSerp() { return response; } });
  for (const result of [
    { ...row, position: undefined }, { ...row, position: 0 }, { ...row, position: '1' },
    { ...row, url: 'https://example.org/' }, { ...row, fetched_at: undefined },
    { ...row, fetched_at: 'not a date' },
  ]) {
    response = { region: 'RU', results: [result] };
    const { report } = await swarmSearch({ ...options, mode: 'serp', region: 'RU', topN: 1 });
    assert.equal(report.serp.status, 'unavailable');
    assert.ok(report.serp.reason);
    assert.deepEqual(report.serp.results, []);
  }
  for (const data of [{ results: [row, row], region: 'RU' }, { results: [row], region: 'US' }, { results: [row] }]) {
    response = data;
    const { report } = await swarmSearch({ ...options, mode: 'serp', region: 'RU', topN: 2 });
    assert.equal(report.serp.status, 'unavailable');
    assert.deepEqual(report.serp.results, []);
  }
});

test('SERP incomplete ranks are partial and retain real positions; unknown region stays null', async (t) => {
  fake(t, { async searchSerp() { return { results: [{ position: 2, url: page, title: 'Second', fetched_at }] }; } });
  const { report } = await swarmSearch({ ...options, mode: 'serp', topN: 3 });
  assert.equal(report.serp.status, 'partial');
  assert.equal(report.serp.region, null);
  assert.equal(report.serp.results[0].position, 2);
});

test('SERP markdown keeps gaps in native positions visible without ordered-list renumbering', async (t) => {
  fake(t, { async searchSerp() { return { results: [
    { position: 1, url: page, title: 'First', fetched_at },
    { position: 3, url: 'https://example.org/third', title: 'Third', fetched_at },
  ] }; } });
  const { markdown, report } = await swarmSearch({ ...options, mode: 'serp', topN: 3 });
  assert.equal(report.serp.status, 'partial');
  assert.deepEqual(report.serp.results.map(r => r.position), [1, 3]);
  assert.match(markdown, /^- position: 1 /m);
  assert.match(markdown, /^- position: 3 /m);
  assert.doesNotMatch(markdown, /^\d+\. /m);
});

test('SERP validates options before invoking a provider and propagates cancellation', async (t) => {
  fake(t, { async searchSerp() { assert.fail('invalid request'); } });
  for (const topN of [0, 101, 1.5, 'bad', true]) {
    await assert.rejects(swarmSearch({ ...options, mode: 'serp', topN }), /topN/);
  }
  await assert.rejects(swarmSearch({ ...options, mode: 'serp', paths: ['.'] }), /paths/);
  await assert.rejects(swarmSearch({ ...options, mode: 'serp', region: true }), /region/);
  await assert.rejects(swarmSearch({ ...options, mode: 'serp', signal: AbortSignal.abort() }), /cancelled/);
});

test('SERP provider failures are unavailable and in-flight cancellation still throws', async (t) => {
  const controller = new AbortController();
  let cancel = false;
  fake(t, { async searchSerp() { if (cancel) controller.abort(); throw new Error('offline'); } });
  const result = await swarmSearch({ ...options, mode: 'serp' });
  assert.equal(result.report.serp.status, 'unavailable');
  assert.match(result.report.serp.reason, /offline/);
  cancel = true;
  await assert.rejects(swarmSearch({ ...options, mode: 'serp', signal: controller.signal }), /cancelled/);
});

test('MCP exposes SERP parameters and preserves text content plus structured report', async (t) => {
  fake(t);
  const schema = TOOLS.find(x => x.name === 'swarm_search').inputSchema.properties;
  assert.ok(schema.mode.enum.includes('serp'));
  assert.equal(schema.top_n.type, 'integer');
  assert.equal(schema.region.type, 'string');
  const result = await callTool('swarm_search', { query: options.query, provider: 'serp-test', mode: 'serp', top_n: 3, region: 'RU' });
  assert.match(result.content[0].text, /unavailable/);
  assert.equal(result.structuredContent.serp.topN, 3);
  assert.equal(result.structuredContent.serp.region, 'RU');
});

test('CLI --serp accepts flag before query and preserves the JSON envelope', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    'bin/swarm-search.mjs', 'run', '--serp', 'как начать вайбкодинг с нуля',
    '--top-n', '3', '--region', 'RU', '--provider', 'agy-cli', '--json',
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.report.mode, 'serp');
  assert.equal(result.report.serp.status, 'unavailable');
  assert.equal(result.report.serp.topN, 3);
  assert.equal(result.report.serp.region, 'RU');
  assert.equal(typeof result.markdown, 'string');
});
