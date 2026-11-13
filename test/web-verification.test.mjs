import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swarmSearch } from '../src/swarm.mjs';
import { byId } from '../src/providers/index.mjs';

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
