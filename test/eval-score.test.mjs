import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scoreSaved, scoreText } from '../eval/score.js';

const load = name => JSON.parse(readFileSync(new URL(`./fixtures/eval-${name}.json`, import.meta.url), 'utf8'));
const questions = JSON.parse(readFileSync(new URL('../eval/questions.json', import.meta.url), 'utf8'));
const dns = questions.find(q => q.id === 'dns-transport');
const script = fileURLToPath(new URL('../eval/score.js', import.meta.url));

test('eval corpus has exactly 20 sourced questions with 1–3 required fact strings', () => {
  assert.equal(questions.length, 20);
  assert.equal(new Set(questions.map(q => q.id)).size, 20);
  assert.equal(new Set(questions.map(q => q.query)).size, 20);
  assert.equal(questions.reduce((sum, q) => sum + q.facts.length, 0), 31);
  for (const q of questions) {
    assert.ok(q.facts.length >= 1 && q.facts.length <= 3);
    assert.ok(q.facts.every(f => typeof f === 'string' && f.trim()));
    assert.ok(q.allowedUrls.includes(q.source), q.id);
    assert.ok(q.allowedUrls.every(url => new URL(url).protocol === 'https:'), q.id);
  }
});

test('FAILS_ON_OLD 874: full fixture finds all facts and scores worker rounds separately', () => {
  const result = scoreSaved(load('all'), questions);
  const answer = result.questions[0];
  assert.equal(answer.found, 3);
  assert.equal(answer.total, 3);
  assert.equal(answer.coverage, 1);
  assert.equal(answer.success, true);
  assert.deepEqual(answer.workers.map(w => [w.id, w.round, w.found]), [
    ['w1', 1, 2], ['w2', 1, 1], ['r2-1', 2, 0], ['r2-2', 2, 0],
  ]);
  assert.equal(answer.incorrectClaims.rate, 0);
  assert.deepEqual(answer.sources, { allowed: ['https://www.rfc-editor.org/rfc/rfc1035'], unexpected: [] });
  assert.equal(result.judge.factAgreement, 1);
});

test('FAILS_ON_OLD 874: partial fixture has 1/3 coverage and 1/2 manually incorrect claims', () => {
  const result = scoreSaved(load('partial'), questions, { judgeDiff: true });
  const answer = result.questions[0];
  assert.equal(answer.coverage, 1 / 3);
  assert.equal(answer.success, false);
  assert.deepEqual(answer.facts.filter(f => !f.found).map(f => f.fact), ['UDP', 'TCP']);
  assert.equal(result.overall.incorrectClaims.rate, 1 / 2);
  assert.equal(result.judge.agreement, 0);
  assert.equal(result.judge.factAgreement, 2 / 3);
  assert.deepEqual(result.judge.differences[0].differences, [{ fact: 'UDP', expected: false, judge: true }]);
});

test('FAILS_ON_OLD 874: none fixture excludes number fragments, metadata and Russian source lists', () => {
  const result = scoreSaved(load('none'), questions);
  assert.equal(result.overall.found, 0);
  assert.equal(result.overall.coverage, 0);
  assert.equal(result.overall.successes, 0);
  assert.equal(result.questions[0].nonEmpty, true);
  assert.deepEqual(result.questions[0].sources.unexpected, ['https://example.net/port53']);
  assert.equal(result.overall.incorrectClaims.rate, null, 'missing annotations are not zero errors');
});

test('FAILS_ON_OLD 874: empty fixture never succeeds even with full worker findings', () => {
  const result = scoreSaved(load('empty'), questions);
  assert.equal(result.overall.coverage, 0);
  assert.equal(result.overall.successes, 0);
  assert.equal(result.questions[0].nonEmpty, false);
  assert.equal(result.questions[0].workers[0].coverage, 1);
  assert.equal(result.overall.incorrectClaims.rate, null, 'zero annotated claims has no denominator');
});

test('source-only prose, URLs, citations and footer cannot supply required facts', () => {
  for (const heading of ['## Sources', 'References:', '**Sources:**', '## Источники', '## Ссылки']) {
    const result = scoreText(`\n${heading}\n1. 53 UDP TCP https://example.net/53`, dns);
    assert.equal(result.found, 0, heading);
    assert.equal(result.nonEmpty, false, heading);
  }
  assert.equal(scoreText('https://example.net/53/UDP/TCP [53]', dns).success, false);
  assert.equal(scoreText('53.5 and 1,53 are bigger numbers.', dns).found, 0);
});

test('FAILS_ON_OLD 874: twenty-question fixture reaches 31/31 and rejects judge at 65%', () => {
  const result = scoreSaved(load('twenty'), questions, { judgeDiff: true });
  assert.equal(result.overall.found, 31);
  assert.equal(result.overall.total, 31);
  assert.equal(result.overall.coverage, 1);
  assert.equal(result.overall.successes, 20);
  assert.equal(result.judge.manualQuestions, 20);
  assert.equal(result.judge.manualAgreement, 0.65);
  assert.equal(result.judge.verdict, 'unsuitable');
  assert.equal(result.judge.differences.length, 7);
  assert.equal(result.judge.factAgreement, null, 'scalar judges do not provide per-fact labels');
});

test('judge threshold includes 70% and does not require a model retry', () => {
  const fixture = load('twenty');
  fixture.answers.find(a => a.id === 'gzip-header').judge.score = 1;
  const result = scoreSaved(fixture, questions, { judgeDiff: true });
  assert.equal(result.judge.manualAgreement, 0.7);
  assert.equal(result.judge.verdict, 'suitable');
  assert.equal(result.judge.differences.length, 6);
});

test('judge suitability stays unknown until all 20 questions have manual labels', () => {
  const fixture = load('twenty');
  delete fixture.answers[0].annotation;
  const result = scoreSaved(fixture, questions);
  assert.equal(result.judge.manualQuestions, 19);
  assert.equal(result.judge.verdict, 'insufficient_data');
  assert.equal(result.questions[0].judge.reference, 'literal');
});

test('manual labels take precedence over literal matches for judge comparison', () => {
  const fixture = load('all');
  fixture.annotation.facts = [true, false, false];
  fixture.judge.facts = [true, false, false];
  const result = scoreSaved(fixture, questions);
  assert.equal(result.questions[0].coverage, 1);
  assert.equal(result.questions[0].manualCoverage, 1 / 3);
  assert.equal(result.judge.agreement, 1);
});

test('missing judge produces null agreement instead of an invented assessment', () => {
  const fixture = load('all');
  delete fixture.judge;
  const result = scoreSaved(fixture, questions, { judgeDiff: true });
  assert.equal(result.judge.agreement, null);
  assert.equal(result.judge.verdict, 'insufficient_data');
  assert.deepEqual(result.judge.differences, []);
});

test('batch coverage uses fact totals and counts absent answers as missing', () => {
  const result = scoreSaved({ answers: [load('partial'), { id: 'postgres-port', markdown: 'Port 5432.' }] }, questions);
  assert.equal(result.overall.found, 2);
  assert.equal(result.overall.total, 31);
  assert.equal(result.overall.coverage, 2 / 31);
  assert.equal(result.overall.answered, 2);
  assert.equal(result.questions.filter(q => q.missingAnswer).length, 18);
  assert.equal(result.overall.incorrectClaims.annotatedQuestions, 1);
});

test('an explicit single-question selection keeps the selected denominator', () => {
  const result = scoreSaved(load('twenty'), questions, { questionId: 'dns-transport' });
  assert.equal(result.overall.answered, 1);
  assert.equal(result.overall.total, 3);
  assert.equal(result.judge.verdict, 'insufficient_data');
});

test('empty batch has no successes and no judge agreement', () => {
  const result = scoreSaved({ answers: [] }, questions);
  assert.equal(result.overall.found, 0);
  assert.equal(result.overall.total, 31);
  assert.equal(result.overall.successes, 0);
  assert.equal(result.judge.agreement, null);
});

test('MCP and JSON-RPC envelopes preserve answer/report separation', () => {
  const fixture = load('all');
  const mcp = { content: [{ type: 'text', text: fixture.markdown }],
    structuredContent: { ...fixture.report, annotation: fixture.annotation, judge: fixture.judge } };
  for (const saved of [mcp, { jsonrpc: '2.0', id: 874, result: mcp }]) {
    const result = scoreSaved(saved, questions);
    assert.equal(result.overall.coverage, 1);
    assert.equal(result.questions[0].workers.length, 4);
  }
});

test('invalid datasets and answer identifiers fail instead of reporting success', () => {
  assert.throws(() => scoreSaved(load('empty'), [{ ...dns, facts: [] }]), /1–3/);
  assert.throws(() => scoreSaved(load('all'), []), /non-empty/);
  assert.throws(() => scoreSaved({ id: 'unknown', markdown: '53 UDP TCP' }, questions), /Cannot identify/);
  assert.throws(() => scoreSaved({ answers: [load('partial'), load('partial')] }, questions), /Duplicate/);
  assert.throws(() => scoreSaved(load('all'), questions, { questionId: 'unknown' }), /Unknown question/);
  assert.throws(() => scoreSaved({ answers: null }, questions), /array/);
});

test('invalid manual/judge labels and inconsistent scalar scores are rejected', () => {
  for (const judge of [{ score: 1.2 }, { score: -1 }, { facts: [true] },
    { facts: ['true', false, false] }, { facts: [true, true, true], score: 0 }]) {
    assert.throws(() => scoreSaved({ ...load('all'), judge }, questions), /judge/);
  }
  assert.throws(() => scoreSaved({ ...load('all'), annotation: { facts: [] } }, questions), /annotation/);
  assert.throws(() => scoreSaved({ ...load('all'), annotation: { claims: [{ text: 'claim' }] } }, questions), /claims/);
});

test('CLI scores tracked fixtures from another working directory with zero swarm calls', () => {
  const output = execFileSync(process.execPath, [script,
    fileURLToPath(new URL('./fixtures/eval-partial.json', import.meta.url)), '--judge-diff'],
  { cwd: fileURLToPath(new URL('./fixtures', import.meta.url)), encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.overall.coverage, 1 / 3);
  assert.equal(result.judge.differences[0].id, 'dns-transport');
});

test('CLI exits nonzero for missing files, unknown flags and missing flag values', () => {
  for (const args of [[], ['missing-eval-874.json'], ['--unknown'], ['--question']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^eval:/);
  }
  assert.equal(spawnSync(process.execPath, [script, '--help']).status, 0);
});
