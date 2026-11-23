#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultQuestions = new URL('./questions.json', import.meta.url);
const ratio = (n, total) => total ? n / total : null;
const normalize = text => text.normalize('NFKC').toLowerCase()
  .replace(/[‘’]/g, "'").replace(/[‐‑–—−]/g, '-').replace(/\s+/g, ' ').trim();
const urlsIn = text => [...new Set((text.match(/https?:\/\/[^\s<>"`]+/gi) || [])
  .map(url => url.replace(/[),.;!?\]]+$/, '')))];
const urlKey = url => {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href.replace(/\/$/, '');
};

export function answerBody(text = '') {
  if (typeof text !== 'string') throw new Error('Answer text must be a string');
  return text.split(/\n\n---\r?\n_swarm-search/)[0]
    .split(/^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?(?:Sources|References|Источники|Ссылки|Provider sources|Source outcomes|Результаты источников|Unavailable sources|Недоступные источники)(?::?\*\*)?:?[ \t]*$/im)[0]
    .split(/^#{1,6}[ \t]+(?:Uncertain|Not found|Не найдено|Неопределённость)[ \t]*$/im)[0]
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s<>]+/gi, ' ')
    .replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, ' ')
    .replace(/[*_`]/g, '').trim();
}

export function scoreText(text, question) {
  const body = answerBody(text);
  const normalized = normalize(body);
  const facts = question.facts.map(fact => {
    const variants = [fact, ...(question.aliases?.[fact] || [])];
    const matched = variants.find(value => {
      const escaped = normalize(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu');
      return [...normalized.matchAll(pattern)].some(match => {
        // Reject digits inside decimals or thousands groups.
        if (!/^\d+$/.test(value)) return true;
        return !/\d[.,]$/.test(normalized.slice(0, match.index)) &&
          !/^[.,]\d/.test(normalized.slice(match.index + match[0].length));
      });
    });
    return { fact, found: matched !== undefined, matched: matched ?? null };
  });
  const found = facts.filter(f => f.found).length;
  return { facts, found, total: facts.length, coverage: ratio(found, facts.length),
    nonEmpty: Boolean(body), success: Boolean(body) && facts.length > 0 && found === facts.length };
}

function validateQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) throw new Error('Questions must be a non-empty array');
  const ids = new Set();
  const queries = new Set();
  for (const q of questions) {
    if (!q || typeof q.id !== 'string' || !q.id.trim() || ids.has(q.id) ||
        typeof q.query !== 'string' || !q.query.trim() || queries.has(q.query.trim()) ||
        !Array.isArray(q.facts) || q.facts.length < 1 || q.facts.length > 3 ||
        q.facts.some(f => typeof f !== 'string' || !f.trim()) || new Set(q.facts).size !== q.facts.length) {
      throw new Error('Need unique id/query and 1–3 fact strings');
    }
    ids.add(q.id);
    queries.add(q.query.trim());
    if (!Array.isArray(q.allowedUrls) || !q.allowedUrls.length || !q.allowedUrls.includes(q.source)) {
      throw new Error(`${q.id}: source must be in allowedUrls`);
    }
    for (const url of q.allowedUrls) {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error(`${q.id}: invalid source URL`);
      urlKey(url);
    }
    for (const [fact, aliases] of Object.entries(q.aliases || {})) {
      if (!q.facts.includes(fact) || !Array.isArray(aliases) ||
          aliases.some(a => typeof a !== 'string' || !a.trim())) throw new Error(`${q.id}: invalid aliases`);
    }
  }
}

function unpack(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Saved answer must be an object');
  const result = saved.result ?? saved;
  const report = result.report ?? result.structuredContent ?? {};
  const markdown = result.markdown ?? (Array.isArray(result.content)
    ? result.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '');
  return { ...result, markdown, report,
    annotation: result.annotation ?? report.annotation, judge: result.judge ?? report.judge };
}

function factLabels(labels, question, name) {
  if (labels === undefined) return null;
  if (!Array.isArray(labels) || labels.length !== question.facts.length || labels.some(b => typeof b !== 'boolean')) {
    throw new Error(`${question.id}: ${name}.facts needs ${question.facts.length} booleans`);
  }
  return labels;
}

function claimStats(annotation, question) {
  const claims = annotation?.claims;
  if (claims === undefined) return { annotated: false, incorrect: 0, total: 0, rate: null };
  if (!Array.isArray(claims) || claims.some(c => !c || typeof c.text !== 'string' || !c.text.trim() || typeof c.correct !== 'boolean')) {
    throw new Error(`${question.id}: invalid annotation.claims (text/boolean correct required)`);
  }
  const incorrect = claims.filter(c => !c.correct).length;
  return { annotated: true, incorrect, total: claims.length, rate: ratio(incorrect, claims.length) };
}

function judgeComparison(answer, question, scored, manual) {
  if (answer.judge === undefined) return null;
  const judge = answer.judge;
  const labels = factLabels(judge?.facts, question, 'judge');
  const score = typeof judge === 'number' ? judge : judge?.score;
  if (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) {
    throw new Error(`${question.id}: judge score must be in [0, 1]`);
  }
  if (!labels && score === undefined) throw new Error(`${question.id}: judge needs facts or score`);
  const expected = manual ?? scored.facts.map(f => f.found);
  const expectedScore = expected.filter(Boolean).length / expected.length;
  const judgedScore = labels ? labels.filter(Boolean).length / labels.length : score;
  if (labels && score !== undefined && Math.abs(score - judgedScore) > 1e-9) {
    throw new Error(`${question.id}: judge facts and score disagree`);
  }
  const differences = labels ? question.facts.flatMap((fact, i) => labels[i] === expected[i]
    ? [] : [{ fact, expected: expected[i], judge: labels[i] }]) : [];
  return { id: question.id, reference: manual ? 'manual' : 'literal', expectedScore, judgeScore: judgedScore,
    agrees: labels ? differences.length === 0 : Math.abs(expectedScore - judgedScore) < 1e-9,
    comparedFacts: labels ? labels.length : 0, agreedFacts: labels ? labels.length - differences.length : 0, differences };
}

export function scoreSaved(saved, questions, { questionId, judgeDiff = false } = {}) {
  validateQuestions(questions);
  const batch = Array.isArray(saved) || (saved && Object.hasOwn(saved, 'answers'));
  const inputs = batch ? (Array.isArray(saved) ? saved : saved.answers) : [saved];
  if (!Array.isArray(inputs)) throw new Error('answers must be an array');
  if (questionId && !questions.some(q => q.id === questionId)) throw new Error(`Unknown question: ${questionId}`);
  const answers = new Map();
  for (const input of inputs) {
    const answer = unpack(input);
    const id = answer.id ?? answer.questionId;
    const query = answer.report.query ?? answer.query;
    const q = id !== undefined ? questions.find(q => q.id === id)
      : !batch && questionId ? questions.find(q => q.id === questionId)
        : questions.find(q => q.query === query?.trim());
    if (!q) throw new Error(`Cannot identify saved question: ${id ?? query ?? '(missing id/query)'}`);
    if (answers.has(q.id)) throw new Error(`Duplicate saved answer: ${q.id}`);
    answers.set(q.id, answer);
  }
  const selected = questionId ? questions.filter(q => q.id === questionId)
    : batch ? questions : questions.filter(q => answers.has(q.id));
  if (!batch && selected.some(q => !answers.has(q.id))) throw new Error('Saved answer does not match --question');
  const comparisons = [];
  const results = selected.map(q => {
    const answer = answers.get(q.id) ?? { markdown: '', report: {} };
    const scored = scoreText(answer.markdown, q);
    const manual = factLabels(answer.annotation?.facts, q, 'annotation');
    const comparison = judgeComparison(answer, q, scored, manual);
    if (comparison) comparisons.push(comparison);
    const workers = ['workers', 'round2'].flatMap((key, i) => {
      const entries = answer.report[key] ?? [];
      if (!Array.isArray(entries)) throw new Error(`${q.id}: report.${key} must be an array`);
      return entries.map(w => ({ id: w.id, round: i + 1, provider: w.provider, model: w.model,
        ...scoreText(w.ok === false ? '' : w.text ?? '', q) }));
    });
    const urls = urlsIn(answer.markdown);
    const allowed = new Set(q.allowedUrls.map(urlKey));
    const permitted = url => { try { return allowed.has(urlKey(url)); } catch { return false; } };
    return { id: q.id, missingAnswer: !answers.has(q.id), ...scored, workers,
      manualCoverage: manual ? manual.filter(Boolean).length / manual.length : null,
      incorrectClaims: claimStats(answer.annotation, q),
      sources: { allowed: urls.filter(permitted), unexpected: urls.filter(url => !permitted(url)) },
      ...(comparison ? { judge: comparison } : {}) };
  });
  const found = results.reduce((sum, r) => sum + r.found, 0);
  const total = results.reduce((sum, r) => sum + r.total, 0);
  const claims = results.map(r => r.incorrectClaims);
  const incorrect = claims.reduce((sum, c) => sum + c.incorrect, 0);
  const claimTotal = claims.reduce((sum, c) => sum + c.total, 0);
  const matches = comparisons.filter(c => c.agrees).length;
  const manualComparisons = comparisons.filter(c => c.reference === 'manual');
  const manualAgreement = ratio(manualComparisons.filter(c => c.agrees).length, manualComparisons.length);
  const fullSet = questions.length === 20 && selected.length === 20 && manualComparisons.length === 20;
  return { questions: results,
    overall: { questions: results.length, answered: results.filter(r => !r.missingAnswer).length, found, total, coverage: ratio(found, total),
      successes: results.filter(r => r.success).length,
      incorrectClaims: { incorrect, total: claimTotal, rate: ratio(incorrect, claimTotal),
        annotatedQuestions: claims.filter(c => c.annotated).length } },
    judge: { comparedQuestions: comparisons.length, matches, agreement: ratio(matches, comparisons.length),
      factAgreement: ratio(comparisons.reduce((s, c) => s + c.agreedFacts, 0), comparisons.reduce((s, c) => s + c.comparedFacts, 0)),
      manualQuestions: manualComparisons.length, manualAgreement, threshold: 0.7,
      verdict: fullSet ? manualAgreement < 0.7 ? 'unsuitable' : 'suitable' : 'insufficient_data',
      ...(judgeDiff ? { differences: comparisons.filter(c => !c.agrees) } : {}) } };
}

async function main(argv) {
  const options = {};
  let questionsFile = defaultQuestions;
  let inputFile;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--judge-diff') options.judgeDiff = true;
    else if (arg === '--question' || arg === '--questions') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--question') options.questionId = value;
      else questionsFile = resolve(value);
    } else if (arg === '--help') {
      console.log('Usage: node eval/score.js <saved.json> [--question id] [--questions file] [--judge-diff]');
      return;
    } else if (arg.startsWith('-') || inputFile) throw new Error(`Unexpected argument: ${arg}`);
    else inputFile = arg;
  }
  if (!inputFile) throw new Error('A saved JSON answer file is required; use --help');
  const [questions, saved] = await Promise.all([
    readFile(questionsFile, 'utf8').then(JSON.parse), readFile(resolve(inputFile), 'utf8').then(JSON.parse),
  ]);
  console.log(JSON.stringify(scoreSaved(saved, questions, options), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`eval: ${error.message}`); process.exitCode = 1; });
}
