import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as dns } from 'node:dns';
import { swarmSearch } from '../src/swarm.mjs';
import { byId } from '../src/providers/index.mjs';
import { callTool } from '../src/mcp.mjs';
import { verifyWorkerSources } from '../src/web-verification.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const available = 'https://sources.example/articles/available?lang=ru#quote';
const unavailable = 'https://sources.example/articles/unavailable?lang=ru#quote';
const secret = 'CONTROL_FACT_481: reserve is 918273 units';
const workerText = `## Findings\n- Public fact (${available}) — Quote: "Public fact"\n- ${secret} (${unavailable}) — Quote: "${secret}"`;

function fixture(t, { text = workerText, sources, status, rounds = 1 } = {}) {
  const requests = [];
  const prompts = [];
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    return new Response(url === available ? 'Public fact' : 'Service unavailable', { status: url === available ? 200 : 503 });
  });
  const id = 'provenance-fixture';
  byId[id] = {
    id, defaultModel: 'free-fixture',
    async complete(request) {
      if (request.system.startsWith('You are one worker')) return { text, sources, status };
      prompts.push(request);
      if (request.system.startsWith('You audit')) return { text: '{"followups":["Check the missing source"]}' };
      if (request.system.includes('critique round')) return { text, sources, status };
      // This synthesizer echoes supplied claims and deliberately omits a completeness warning.
      // The pipeline must withhold the unavailable claim and make the gap visible itself.
      return { text: `Public fact [1].${request.prompt.includes(secret) ? `\n${secret}` : ''}\n## Sources\n1. ${available}` };
    },
  };
  t.after(() => { delete byId[id]; });
  return { requests, prompts, options: { query: 'What is known?', provider: id, angles: ['Check sources'], rounds } };
}

for (const round2 of ['single', 'gaps', 'critique']) {
  test(`FAILS_ON_OLD 481: ${round2} withholds an unavailable fact and reports incomplete coverage`, async (t) => {
    const { prompts, options } = fixture(t, { rounds: round2 === 'single' ? 1 : 2 });
    const { markdown, report } = await swarmSearch({ ...options, round2: round2 === 'single' ? 'gaps' : round2 });
    assert.doesNotMatch(markdown, /CONTROL_FACT_481/);
    assert.match(markdown, /incomplete/i);
    assert.ok(markdown.includes(unavailable));
    assert.match(markdown, /Public fact/);
    assert.ok(prompts.length > 0);
    for (const { system, prompt } of prompts) {
      assert.ok(!prompt.includes(secret), 'an unavailable claim must not reach audit, critique or synthesis');
      assert.ok(prompt.includes(unavailable), 'the missing source itself stays visible');
      if (system.startsWith('You are the synthesizer')) {
        assert.match(prompt, /Unavailable sources/);
        assert.match(system, /do not guess/i);
      }
    }
    assert.equal(report.status, 'partial');
    assert.equal(report.unavailableSources.length, round2 === 'single' ? 1 : 2);
    assert.ok(report.unavailableSources.every(s => s.source_url === unavailable && s.status === 'unavailable'));
  });
}

test('FAILS_ON_OLD 481: facts carry code-produced URL, fetch time and availability; HTTP status survives', async (t) => {
  const { options, requests } = fixture(t);
  const started = Date.now();
  const { report } = await swarmSearch(options);
  const ended = Date.now();
  const worker = report.workers[0];
  assert.ok(Array.isArray(worker.facts));
  assert.equal(worker.facts.length, 2);
  assert.deepEqual(worker.facts.map(f => [f.source_url, f.status]), [[available, 'ok'], [unavailable, 'unavailable']]);
  for (const fact of worker.facts) {
    assert.equal(new Date(fact.fetched_at).toISOString(), fact.fetched_at);
    assert.ok(Date.parse(fact.fetched_at) >= started && Date.parse(fact.fetched_at) <= ended);
  }
  assert.equal(worker.status, 'partial');
  assert.equal(worker.source_url, null); // Multiple sources: use each fact's URL.
  assert.ok(Date.parse(worker.fetched_at) >= started);
  assert.equal(worker.sourceVerification[0].status, 200);
  assert.equal(worker.sourceVerification[1].status, 503);
  assert.deepEqual(worker.sources, [{ url: available, title: '' }, { url: unavailable, title: '' }]);
  assert.deepEqual(requests, [available, unavailable]);
  assert.ok(worker.text.includes(secret), 'legacy diagnostic text is retained with an unavailable status');
});

test('FAILS_ON_OLD 481: worker-declared unavailable source is retained without fetching or inventing a timestamp', async (t) => {
  const { options, requests } = fixture(t, { text: `- ${secret} (${unavailable})`, sources: [{ url: unavailable, status: 'unavailable' }] });
  const { report, markdown } = await swarmSearch(options);
  assert.equal(report.workers[0].status, 'unavailable');
  assert.equal(report.workers[0].source_url, unavailable);
  assert.equal(report.workers[0].facts[0].fetched_at, null);
  assert.equal(report.unavailableSources[0].reason, 'provider_unavailable');
  assert.doesNotMatch(markdown, /CONTROL_FACT_481/);
  assert.match(markdown, /incomplete/i);
  assert.deepEqual(requests, []);
});

test('FAILS_ON_OLD 481: no quote and a missing quote are partial, never a false successful fetch', async (t) => {
  fixture(t);
  const checked = await verifyWorkerSources(`- No quote (${available})\n- Wrong quote (${available}) — Quote: "Not on page"`);
  assert.ok(Array.isArray(checked.facts));
  assert.equal(checked.facts[0].status, 'partial');
  assert.equal(checked.facts[0].fetched_at, null);
  assert.equal(checked.facts[1].status, 'partial');
  assert.ok(checked.facts[1].fetched_at);
  assert.equal(checked.facts[1].reason, 'quote_not_found');
});

test('FAILS_ON_OLD 481: MCP preserves text content and exposes source gaps in the structured report', async (t) => {
  const { options } = fixture(t);
  const result = await callTool('swarm_search', options);
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /incomplete/i);
  assert.doesNotMatch(result.content[0].text, /CONTROL_FACT_481/);
  assert.equal(result.structuredContent.unavailableSources[0].source_url, unavailable);
  assert.equal(result.structuredContent.workers[0].facts[0].status, 'ok');
});

test('FAILS_ON_OLD 481: CLI JSON extends the existing envelope and keeps unavailable claims out of markdown', async () => {
  const setup = `import { byId } from ${JSON.stringify(new URL('../src/providers/index.mjs', import.meta.url).href)};
    byId['provenance-cli'] = { id: 'provenance-cli', defaultModel: 'free-fixture', async complete({ system, prompt }) {
      if (system.startsWith('You split')) return { text: '["Check"]' };
      if (system.startsWith('You are one worker')) return { text: ${JSON.stringify(`- ${secret} (${unavailable})`)}, status: 'unavailable' };
      return { text: prompt.includes('CONTROL_FACT_481') ? ${JSON.stringify(secret)} : 'No supported fact.' };
    } };`;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(setup)}`, 'bin/swarm-search.mjs',
    'run', 'Что известно?', '--provider', 'provenance-cli', '--workers', '1', '--json',
  ]);
  const result = JSON.parse(stdout);
  assert.deepEqual(Object.keys(result).sort(), ['markdown', 'report']);
  assert.match(result.markdown, /Ответ неполный/);
  assert.doesNotMatch(result.markdown, /CONTROL_FACT_481/);
  assert.equal(result.report.unavailableSources[0].source_url, unavailable);
  const worker = result.report.workers[0];
  for (const key of ['id', 'label', 'provider', 'model', 'ok', 'text', 'error', 'sources', 'sourceVerification', 'sourceIssues']) {
    assert.ok(Object.hasOwn(worker, key), `legacy worker field ${key}`);
  }
  assert.equal(worker.status, 'unavailable');
  assert.equal(worker.source_url, unavailable);
  assert.equal(worker.facts[0].fetched_at, null);
});

test('FAILS_ON_OLD 481: unavailable multiline findings are withheld through blank lines and after rejected retractions', async (t) => {
  const text = `## Confirmed\n- Public fact (${available}) — Quote: "Public fact"\n## Retracted\n- unsupported retraction\n## Missing\n+ ${secret}\n  Source: ${unavailable}\n\n  ${secret}`;
  const { options, prompts } = fixture(t, { text, sources: [{ url: unavailable, status: 'unavailable' }], rounds: 2 });
  const { markdown, report } = await swarmSearch({ ...options, round2: 'critique' });
  assert.doesNotMatch(markdown, /CONTROL_FACT_481/);
  assert.ok(prompts.every(p => !p.prompt.includes(secret)));
  assert.equal(report.retractions.dropped, 1);
  assert.ok(report.unavailableSources.some(s => s.worker_id === report.round2[0].id));
});

test('FAILS_ON_OLD 481: an entirely unavailable empty report still yields an explicit data gap', async (t) => {
  const { options } = fixture(t, { text: '', status: 'unavailable' });
  const { markdown, report } = await swarmSearch(options);
  assert.equal(report.workers[0].status, 'unavailable');
  assert.match(markdown, /incomplete/i);
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.unavailableSources, [{ worker_id: 1, source_url: null, fetched_at: null,
    status: 'unavailable', reason: 'provider_unavailable' }]);
});

test('FAILS_ON_OLD 481: unassigned claims cannot borrow a good URL when provider metadata also contains an unavailable source', async (t) => {
  const { options, prompts } = fixture(t, {
    text: `## Findings\n- Public fact (${available}) — Quote: "Public fact"\n- ${secret}`,
    sources: [{ url: available }, { url: unavailable, status: 'unavailable' }],
  });
  const { markdown } = await swarmSearch(options);
  assert.doesNotMatch(markdown, /CONTROL_FACT_481/);
  assert.ok(prompts.every(p => !p.prompt.includes(secret)));
  assert.match(markdown, /Public fact/);
  assert.match(markdown, /incomplete/);
});

test('FAILS_ON_OLD 481: text-only workers can explicitly report an unavailable URL', async (t) => {
  const { options, requests } = fixture(t, { text: `## Uncertain\n- status=unavailable (${unavailable})` });
  const { markdown, report } = await swarmSearch(options);
  assert.equal(report.workers[0].status, 'unavailable');
  assert.equal(report.unavailableSources[0].source_url, unavailable);
  assert.match(markdown, /incomplete/);
  assert.deepEqual(requests, []);
});

test('FAILS_ON_OLD 481: network failures and timeouts have unavailable provenance, not merely an unverified quote', async (t) => {
  fixture(t);
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    if (url.endsWith('/offline')) throw new TypeError('offline');
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  });
  for (const path of ['offline', 'slow']) {
    const url = `https://sources.example/${path}`;
    const checked = await verifyWorkerSources(`- Claim (${url}) — Quote: "Claim"`, { timeoutMs: 10 });
    assert.equal(checked.facts?.[0].status, 'unavailable');
    assert.equal(checked.facts[0].source_url, url);
    assert.ok(checked.facts[0].fetched_at);
    assert.equal(checked.sourceVerification[0].reason, 'no_fetch'); // Legacy receipt reason.
  }
});

test('FAILS_ON_OLD 481: availability words inside a URL or quote do not declare a source unavailable', async (t) => {
  fixture(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('status=unavailable'));
  const url = 'https://sources.example/article?status=unavailable';
  const checked = await verifyWorkerSources(`- Public fact (${url}) — Quote: "status=unavailable"`);
  assert.equal(checked.facts?.[0].status, 'ok');
  assert.equal(checked.facts[0].source_url, url);
  assert.equal(checked.sourceVerification[0].status, 200);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('FAILS_ON_OLD 481: a supported multiline finding survives alongside an unavailable finding', async (t) => {
  const text = workerText.replace('\n- CONTROL_FACT', '\n  Context belonging to the public finding.\n- CONTROL_FACT');
  const { options, prompts } = fixture(t, { text });
  const { markdown } = await swarmSearch(options);
  const prompt = prompts.find(p => p.system.startsWith('You are the synthesizer')).prompt;
  assert.ok(prompt.includes(`Public fact (${available})`));
  assert.ok(prompt.includes('Context belonging to the public finding.'));
  assert.doesNotMatch(markdown, /CONTROL_FACT_481/);
  assert.match(markdown, /incomplete/i);
});
