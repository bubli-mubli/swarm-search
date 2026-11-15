import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swarmSearch } from '../src/swarm.mjs';
import { byId } from '../src/providers/index.mjs';

const valid = 'Answer [1].\n\n## Sources\n1. src/a.mjs:1';
const listRule = 'Finish with a numbered Sources list under one of these headings: Sources, References, Источники, Ссылки.';
const numbersRule = 'Number sources consecutively from [1], without duplicates or gaps; put each source on its own numbered line.';

function fake(t, answer) {
  const requests = [];
  byId['format-fake'] = {
    id: 'format-fake', family: 'fake', defaultModel: 'm', detect: () => true,
    async complete(request) {
      if (request.system.startsWith('You are one worker')) {
        return { text: '## Findings\n- Fact (src/a.mjs:1)\n## Uncertain\n- none', usage: { inputTokens: 2 } };
      }
      requests.push(request);
      return { text: answer(requests.length, request), usage: { inputTokens: requests.length === 1 ? 3 : 5 } };
    },
  };
  t.after(() => { delete byId['format-fake']; });
  return requests;
}

const options = { query: 'q', provider: 'format-fake', angles: ['a'] };

test('FAILS_ON_OLD: synthesis retries once with the exact violated rule and an unchanged rules block', async (t) => {
  const requests = fake(t, n => n === 1 ? 'Answer [1].' : valid);
  const { markdown, report } = await swarmSearch(options);
  assert.equal(requests.length, 2, 'a malformed synthesis must get one correction request');
  assert.ok(requests[1].prompt.includes(`Violated format rule [synthesis.sources-list]: ${listRule}`));
  assert.ok(!requests[0].prompt.includes('Violated format rule'));
  assert.ok(requests[1].prompt.startsWith(requests[0].prompt));
  assert.equal(requests[1].system, requests[0].system, 'format correction must not rewrite the rules');
  assert.ok(requests[0].system.includes(`FORMAT_RULES_BLOCK synthesis\n`));
  assert.ok(requests[0].system.includes(listRule));
  assert.equal(report.usage.calls, 3, 'both synthesis calls must be counted');
  assert.equal(report.usage.inputTokens, 10);
  assert.equal(report.sourceCheck.hasList, true);
  assert.deepEqual(report.sourceCheck.missingRefs, []);
  assert.doesNotMatch(markdown, /Format check|no Sources list/);
});

test('FAILS_ON_OLD: the correction names the numbering rule, not a generic format warning', async (t) => {
  const requests = fake(t, n => n === 1 ? 'Answer [2].\n## Sources\n2. src/a.mjs:1' : valid);
  await swarmSearch(options);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].prompt.includes(`Violated format rule [synthesis.source-numbers]: ${numbersRule}`));
  assert.ok(!requests[1].prompt.includes(`Violated format rule [synthesis.sources-list]`));
  assert.match(requests[1].prompt, /Expected source 1, found 2/);
});

test('FAILS_ON_OLD: repeated malformed synthesis stops after one retry and remains visibly marked', async (t) => {
  const requests = fake(t, () => 'Answer [2].\n## Sources\n2. src/a.mjs:1');
  const { markdown, report } = await swarmSearch(options);
  assert.equal(requests.length, 2, 'no unbounded format retry loop');
  assert.equal(report.usage.calls, 3);
  assert.match(markdown, /Format check:.*synthesis.source-numbers/);
  assert.ok(markdown.includes(numbersRule));
  assert.match(markdown, /Answer \[2\]/, 'preserve the answer and existing CLI/MCP envelope on exhaustion');
  assert.deepEqual(Object.keys(report.synthesis).sort(), ['model', 'provider']);
});

test('valid synthesis does not spend a correction call', async (t) => {
  const requests = fake(t, () => valid);
  const { markdown, report } = await swarmSearch(options);
  assert.equal(requests.length, 1);
  assert.equal(report.usage.calls, 2);
  assert.doesNotMatch(markdown, /Format check/);
});

test('changing the heading rule in one place changes both the prompt block and parser', async () => {
  const { responseFormat } = await import('../src/response-format.mjs');
  const defaultFormat = responseFormat('synthesis');
  const headings = ['Evidence'];
  const changed = responseFormat('synthesis', { sourceHeadings: headings });
  headings.push('Sources'); // The schema captures an immutable snapshot.
  const evidenceAnswer = valid.replace('## Sources', '## Evidence');
  const changedRule = changed.rules.find(rule => rule.id === 'synthesis.sources-list');
  assert.equal(changedRule.text, 'Finish with a numbered Sources list under one of these headings: Evidence.');
  assert.ok(changed.block.includes(`[${changedRule.id}] ${changedRule.text}`));
  assert.equal(changed.parse(evidenceAnswer).ok, true);
  assert.equal(changed.parse(valid).ok, false);
  assert.equal(changed.parse(valid).violation.text, changedRule.text);
  assert.equal(defaultFormat.parse(valid).ok, true);
  assert.equal(defaultFormat.parse(evidenceAnswer).ok, false);
  assert.ok(Object.isFrozen(changed) && Object.isFrozen(changed.rules));
  assert.ok(changed.rules.every(Object.isFrozen));
  const renumbered = responseFormat('synthesis', { firstSource: 3 });
  assert.match(renumbered.block, /consecutively from \[3\]/);
  assert.equal(renumbered.parse('Answer [3].\n## Sources\n3. src/a.mjs:1').ok, true);
  assert.equal(renumbered.parse(valid).violation.id, 'synthesis.source-numbers');
});

test('synthesis rejects each malformed rule with its own instruction', async () => {
  const { responseFormat } = await import('../src/response-format.mjs');
  const format = responseFormat('synthesis');
  const cases = [
    ['', 'answer'],
    ['Answer [1].', 'sources-list'],
    ['Answer [1].\n## Sources\n1. src/a.mjs:1\n## References\n1. src/a.mjs:1', 'sources-list'],
    ['Answer [1].\n## Sources\n1. src/a.mjs:1\n1. src/b.mjs:2', 'source-numbers'],
    ['Answer [1].\n## Sources\n1. src/a.mjs:1\ntrailing prose', 'source-numbers'],
    ['Answer [1].\n## Sources\n1. Official documentation', 'source-ref'],
    ['Answer [2].\n## Sources\n1. src/a.mjs:1', 'citations'],
    ['Answer.\n## Sources\n1. src/a.mjs:1', 'citations'],
    ['Answer [0].\n## Sources\n1. src/a.mjs:1', 'citations'],
    ['Answer [2-1].\n## Sources\n1. src/a.mjs:1', 'citations'],
    ['Answer [1-51].\n## Sources\n1. src/a.mjs:1', 'citations'],
    ['Answer [9007199254740992].\n## Sources\n1. src/a.mjs:1', 'citations'],
  ];
  for (const [answer, id] of cases) {
    const parsed = format.parse(answer);
    assert.equal(parsed.ok, false, answer);
    assert.equal(parsed.violation.id, `synthesis.${id}`, answer);
    assert.equal(parsed.violation.text, format.rules.find(rule => rule.id === parsed.violation.id).text);
  }
  for (const heading of ['Sources', 'References', 'Источники', 'Ссылки', '**Sources:**']) {
    assert.equal(format.parse(valid.replace('## Sources', heading)).ok, true, heading);
  }
});

test('worker and synthesis schemas are independent; legacy per-line evidence keeps exact quotes', async () => {
  const { responseFormat } = await import('../src/response-format.mjs');
  const web = responseFormat('worker');
  const files = responseFormat('worker', { mode: 'files' });
  const worker = '## Findings\n- Fact (https://example.org/page) — Quote: "Exact quote"\n## Uncertain\n- none';
  assert.equal(web.parse(worker).ok, true);
  assert.equal(web.parse(worker.replace(' — Quote: "Exact quote"', '')).violation.id, 'worker.quote');
  assert.equal(web.parse(worker.replace('## Uncertain', '## Not found')).violation.id, 'worker.structure');
  assert.equal(responseFormat('synthesis').parse(worker).violation.id, 'synthesis.sources-list');
  assert.doesNotMatch(web.block, /synthesis\.|numbered Sources/);
  assert.equal(files.parse('## Findings\n- Fact (src/a.mjs:1)\n## Not found\n- none').ok, true);
  assert.equal(files.parse('NOTHING RELEVANT').ok, true);
  assert.equal(files.parse('## Findings\n- Fact\n## Not found\n- none').violation.id, 'worker.finding-source');
  for (const quote of ['"Exact quote"', '«Exact quote»', '`Exact quote`']) {
    assert.equal(web.parseLine(`https://example.org/page Quote: ${quote}`).quote, 'Exact quote');
  }
  assert.equal(web.parseLine('https://example.org/page https://example.org/other Quote: "Exact quote"').quote, '');
  assert.equal(web.parseLine('https://example.org/page https://example.org/page Quote: "Exact quote"').quote, 'Exact quote');
});
