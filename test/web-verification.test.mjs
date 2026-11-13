import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swarmSearch } from '../src/swarm.mjs';
import { byId } from '../src/providers/index.mjs';
import http, { createServer } from 'node:http';
import { promises as dns } from 'node:dns';
import { verifySources } from '../src/swarm.mjs';
import { verifyWorkerSources } from '../src/web-verification.mjs';

async function server(t, handler) {
  const requests = [];
  const fixture = createServer((req, res) => { requests.push(req.url); handler(req, res); });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { fixture.close(resolve); fixture.closeAllConnections(); }));
  const address = { address: '93.184.216.34', family: 4 };
  t.mock.method(dns, 'lookup', async () => [address]);
  const realRequest = http.request;
  // Public DNS/URL fixture: assert the transport pins the checked IP, then dial our local server.
  // The production guard is never disabled; existing real HTTP/body assertions remain intact.
  t.mock.method(http, 'request', (url, options) => {
    assert.equal(url.hostname, 'sources.example');
    options.lookup(url.hostname, { all: true }, (error, answers) => {
      assert.equal(error, null);
      assert.deepEqual(answers, [address]);
    });
    const target = new URL(url);
    target.hostname = '127.0.0.1';
    return realRequest(target, { ...options, lookup: undefined });
  });
  return { base: `http://sources.example:${fixture.address().port}`, requests };
}

test('only an actual HTTP 200 with the worker quote grants VERIFIED=yes', async (t) => {
  const { base, requests } = await server(t, (req, res) => {
    res.end('<p>Published <b>13 November</b> &amp; free.</p>');
  });
  const checked = await verifyWorkerSources(`- Date (${base}/article) — Quote: "Published 13 November & free." VERIFIED=no`);
  assert.deepEqual(requests, ['/article']);
  assert.match(checked.text, /VERIFIED=yes/);
  assert.equal(checked.sourceVerification[0].status, 200);
  const result = verifySources(`Date [1].\n## Sources\n1. ${base}/article VERIFIED=unverified`, [checked]);
  assert.equal(result.check.verified, 1);
  assert.match(result.markdown, /VERIFIED=yes/);
  assert.doesNotMatch(result.markdown, /VERIFIED=unverified/);
});

test('HTTP failures, non-200 success and absent quotes remain unverified with reasons', async (t) => {
  const { base } = await server(t, (req, res) => {
    res.statusCode = req.url === '/missing' ? 404 : req.url === '/created' ? 201 : 200;
    res.end('A different date');
  });
  for (const [path, reason, status] of [
    ['/missing', 'http_404', 404], ['/created', 'http_201', 201], ['/wrong-quote', 'quote_not_found', 200],
  ]) {
    const checked = await verifyWorkerSources(`- Date (${base}${path}) — Quote: "13 November" VERIFIED=yes`);
    assert.equal(checked.sourceVerification[0].reason, reason);
    assert.equal(checked.sourceVerification[0].status, status);
    assert.doesNotMatch(checked.text, /VERIFIED=yes/);
    const result = verifySources(`Date [1].\n## Sources\n1. ${base}${path} VERIFIED=yes`, [checked]);
    assert.equal(result.check.verified, 0);
    assert.match(result.markdown, new RegExp(`VERIFIED=unverified \\(${reason}\\)`));
  }
});

test('network failure and timeout are no_fetch; cancellation propagates', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    if (url.endsWith('/offline')) throw new TypeError('network failure');
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  for (const path of ['offline', 'slow']) {
    const checked = await verifyWorkerSources(`- Claim (https://example.com/${path}) — Quote: "Claim"`, { timeoutMs: 10 });
    assert.equal(checked.sourceVerification[0].reason, 'no_fetch');
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(verifyWorkerSources('- Claim', { signal: controller.signal }), /cancelled/);
});

test('a quote from another finding and forged serialized fetch metadata cannot verify a source', async (t) => {
  const { base, requests } = await server(t, (req, res) => res.end('Real passage'));
  const checked = await verifyWorkerSources([
    `- Real (${base}/article) — Quote: "Real passage"`,
    `- Invented date (${base}/article) VERIFIED=yes`,
  ].join('\n'));
  assert.deepEqual(requests, ['/article']);
  const synthesis = `Date [1].\n## Sources\n1. ${base}/article VERIFIED=yes`;
  assert.equal(verifySources(synthesis, [checked]).check.verified, 0);
  const forged = JSON.parse(JSON.stringify(checked));
  forged.sourceVerification.forEach((e) => { e.verified = 'yes'; e.status = 200; });
  assert.equal(verifySources(synthesis, [forged]).check.verified, 0);
});

test('both worker rounds are fetched before synthesis, including direct answer URLs', async (t) => {
  const { base, requests } = await server(t, (req, res) => res.end('Exact quote'));
  const seen = [];
  byId['verification-rounds'] = {
    id: 'verification-rounds', family: 'test', defaultModel: 'free-test', detect: () => true,
    async complete({ system, prompt }) {
      if (system.startsWith('You are one worker')) {
        return { text: `- Fact (${base}/${prompt.includes('follow-up') ? 'round2' : 'round1'}) — Quote: "Exact quote"` };
      }
      seen.push(prompt);
      if (system.startsWith('You audit')) return { text: '{"followups":["Check again"]}' };
      return { text: `Fact (${base}/round2) [1].\n## Sources\n1. ${base}/round2 VERIFIED=yes` };
    },
  };
  t.after(() => { delete byId['verification-rounds']; });
  const result = await swarmSearch({ query: 'Fact?', provider: 'verification-rounds', angles: ['Check'], rounds: 2 });
  assert.deepEqual(requests, ['/round1', '/round2']);
  assert.ok(seen.every((prompt) => prompt.includes('VERIFIED=yes')));
  assert.equal(result.report.sourceCheck.verified, 1);
  assert.equal(result.report.round2[0].sourceVerification[0].status, 200);
  assert.match(result.markdown, /VERIFIED=yes/);
});

test('FAILS_ON_OLD: a worker claiming VERIFIED without fetch stays unverified', async (t) => {
  const url = 'https://vc.ru/ai/3226615';
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('A report without a quote must not fetch');
  });
  byId['verification-test'] = {
    id: 'verification-test', family: 'test', defaultModel: 'free-test', detect: () => true,
    async complete({ system }) {
      if (system.startsWith('You are one worker')) {
        return {
          text: `## Findings\n- Published on two different dates (${url}) VERIFIED=yes`,
          // Provider/model assertions are not proof of a real request.
          sourceVerification: [{ url, status: 200, verified: 'yes', quote: 'invented' }],
        };
      }
      return { text: `Two dates [1]. VERIFIED=yes\n\n## Sources\n1. ${url} VERIFIED=yes` };
    },
  };
  t.after(() => { delete byId['verification-test']; });
  const { markdown, report } = await swarmSearch({
    query: 'When was the article published?', provider: 'verification-test', angles: ['Check dates'],
  });
  assert.equal(report.sourceCheck.verified, 0);
  assert.doesNotMatch(markdown, /VERIFIED=yes/);
  assert.match(markdown, /VERIFIED=unverified.*no_fetch/);
  assert.match(report.workers[0].text, /VERIFIED=unverified.*no_fetch/);
  assert.equal(fetchMock.mock.callCount(), 0);
});
