import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as dns } from 'node:dns';
import { fileURLToPath } from 'node:url';
import { swarmSearch } from '../src/swarm.mjs';
import { byId } from '../src/providers/index.mjs';
import { verifyWorkerSources } from '../src/web-verification.mjs';

const url = 'https://sources.example/article';
const finding = `- External claim (${url}) — Quote: "Exact quote" VERIFIED=yes`;

test('FAILS_ON_OLD: files source verification performs zero fetch and DNS calls', async (t) => {
  const lookupMock = t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('Exact quote'));
  const checked = await verifyWorkerSources(finding, { mode: 'files' });
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(lookupMock.mock.callCount(), 0);
  assert.equal(checked.sourceVerification[0].reason, 'no_fetch_files_mode');
  assert.equal(checked.sourceVerification[0].verified, 'unverified');
  assert.match(checked.text, /VERIFIED=unverified \(no_fetch_files_mode\)/);
  assert.doesNotMatch(checked.text, /VERIFIED=yes/);
});

for (const round2 of ['gaps', 'critique']) {
  test(`FAILS_ON_OLD: files ${round2} rounds preserve no-fetch receipts through synthesis`, async (t) => {
    const lookupMock = t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('Exact quote'));
    const requests = [];
    const id = 'files-verification-test';
    byId[id] = {
      id, family: 'test', defaultModel: 'free-test', detect: () => true,
      async complete(request) {
        requests.push(request);
        if (request.system.startsWith('You audit')) return { text: '{"followups":["Check again"]}' };
        if (request.system.startsWith('You are the synthesizer')) {
          return { text: `Local fact [1]. External claim [2].\n## Sources\n1. src/swarm.mjs:1\n2. ${url} VERIFIED=yes` };
        }
        return { text: `## Findings\n- Local fact (src/swarm.mjs:1)\n${finding}` };
      },
    };
    t.after(() => { delete byId[id]; });
    const result = await swarmSearch({
      query: 'Find claims', mode: 'files', provider: id, workers: 1, rounds: 2, round2, rank: 'off',
      paths: [fileURLToPath(new URL('../src/swarm.mjs', import.meta.url))],
    });
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(lookupMock.mock.callCount(), 0);
    assert.ok(requests.every((request) => request.web === false));
    assert.equal(result.report.round2.length, 1);
    for (const worker of [...result.report.workers, ...result.report.round2]) {
      assert.equal(worker.sourceVerification?.[0]?.reason, 'no_fetch_files_mode');
      assert.doesNotMatch(worker.text, /VERIFIED=yes/);
    }
    assert.equal(result.report.sourceCheck.verified, 1); // Local path:line still verifies.
    assert.equal(result.report.sourceCheck.verification[0].reason, 'no_fetch_files_mode');
    assert.match(result.markdown, /VERIFIED=unverified \(no_fetch_files_mode\)/);
    assert.doesNotMatch(result.markdown, /VERIFIED=yes/);
  });
}
