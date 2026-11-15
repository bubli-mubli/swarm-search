import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markUntrustedSynthesis } from '../src/output-provenance.mjs';
import { responseFormat } from '../src/response-format.mjs';

const label = '_[untrusted source: web pages via worker reports]_';
const sources = '\n\n## Sources\n1. https://example.org/page';
const format = responseFormat('synthesis');

test('487 provenance marks paraphrases, headings, disagreements and source descriptions beside their text', () => {
  const answer = 'Paraphrased fact [1].\n## A sourced claim\n- Another fact [1].\n## Worker disagreements\nUnconfirmed claim.' + sources;
  const marked = markUntrustedSynthesis(answer, 'web');
  for (const line of marked.split('\n').filter(line => line.trim() && line !== '## Sources')) {
    assert.ok(line.endsWith(label), `missing provenance: ${line}`);
  }
  assert.equal(format.parse(marked).ok, true, 'numbered Sources and citations must keep their format');
});

test('487 source marks preserve Markdown tables and copyable fenced or indented code', () => {
  const body = '| Claim | Evidence |\n| --- | --- |\n| A fact | [1] |\n\n```js\nconst x = 42;\n```\n\n     const y = 43;\n\nFact [1].';
  const marked = markUntrustedSynthesis(body + sources, 'web');
  const rows = marked.split('\n').filter(line => line.startsWith('|'));
  assert.ok(rows.every(row => row.split('|').length === 4), 'do not add a table column');
  assert.ok(rows[0].includes(label) && rows[2].includes(label));
  assert.equal(rows[1], '| --- | --- |');
  assert.ok(marked.includes(label + '\n\n```js\nconst x = 42;\n```'));
  assert.ok(marked.includes(`${label}\n\n     const y = 43;`));
  assert.equal(format.parse(marked).ok, true);
});

test('487 model HTML cannot hide a mark and an unfinished code fence cannot swallow the footer', () => {
  const marked = markUntrustedSynthesis('Claim [1].\n<!-- hidden CANARY_487_END\n```txt\nquoted code', 'files');
  assert.ok(marked.includes('&lt;!-- hidden CANARY_487_END _[untrusted source: files via worker reports]_'));
  assert.ok(marked.includes('_[untrusted source: files via worker reports]_\n\n```txt\nquoted code\n```'));
});
