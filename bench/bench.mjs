#!/usr/bin/env node
// Контрольный бенчмарк провайдеров: фиксированные вопросы с проверяемыми фактами → точность и цена успешного ответа.
// Запуск: npm run bench -- <provider-spec> [<provider-spec> ...] [--only id1,id2] [--workers 2] [--out file.json]
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { swarmSearch } from '../src/swarm.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function loadQuestions(file = join(root, 'bench', 'questions.json')) {
  return JSON.parse(await readFile(file, 'utf8'));
}

// Ответ без футера роя: в футере имена провайдеров и моделей, они не должны засчитываться как факты.
export function answerBody(markdown) {
  return String(markdown || '').split('\n\n---\n_swarm-search')[0].trim();
}

// Факт засчитан, если в ответе есть любой из вариантов (без учёта регистра).
export function scoreAnswer(text, facts) {
  const lower = String(text || '').toLowerCase();
  const correct = facts.filter((f) => f.any.some((v) => lower.includes(v.toLowerCase()))).length;
  return { correct, total: facts.length };
}

// Сводка по одному провайдеру. Цена успешного ответа — только если цена известна у всех прогонов:
// упавший прогон (например, синтез с HTTP 500 после оплаченных воркеров) делает её неизвестной.
export function summarizeProvider(provider, runs) {
  const finished = runs.filter((r) => r.error === null);
  const factsCorrect = runs.reduce((sum, r) => sum + r.correct, 0);
  const factsTotal = runs.reduce((sum, r) => sum + r.total, 0);
  const successes = runs.filter((r) => r.success).length;
  const priced = finished.filter((r) => typeof r.costUsd === 'number');
  const costUsd = priced.length ? priced.reduce((sum, r) => sum + r.costUsd, 0) : null;
  const totalSec = runs.reduce((sum, r) => sum + r.sec, 0);
  return {
    provider,
    questions: runs.length,
    accuracy: factsTotal ? factsCorrect / factsTotal : 0,
    factsCorrect,
    factsTotal,
    successes,
    successRate: runs.length ? successes / runs.length : 0,
    nonEmptyRate: runs.length ? runs.filter((r) => r.nonEmpty).length / runs.length : 0,
    costUsd,
    pricedRuns: priced.length,
    costPerSuccessUsd: costUsd !== null && priced.length === runs.length && successes ? costUsd / successes : null,
    totalSec: Number(totalSec.toFixed(1)),
    avgSec: runs.length ? Number((totalSec / runs.length).toFixed(1)) : 0,
    sourcesVerified: runs.reduce((sum, r) => sum + (r.sources?.verified || 0), 0),
    sourcesTotal: runs.reduce((sum, r) => sum + (r.sources?.total || 0), 0),
    runs,
  };
}

/**
 * Прогоняет вопросы на каждом провайдере (воркеры и синтез на одном и том же спеке).
 * run — подменяемый для тестов запуск роя; по умолчанию swarmSearch.
 */
export async function runBench({ providers, questions, workers = 2, rounds = 1, run = swarmSearch, onProgress, now = () => Date.now() }) {
  const results = [];
  for (const provider of providers) {
    const runs = [];
    for (const q of questions) {
      const started = now();
      const entry = { id: q.id, mode: q.mode || 'web', correct: 0, total: q.facts.length, success: false, nonEmpty: false, costUsd: null, sec: 0, sources: null, error: null };
      try {
        const { markdown, report } = await run({
          query: q.query,
          mode: q.mode || 'web',
          paths: (q.paths || []).map((p) => resolve(root, p)),
          provider,
          synthProvider: provider,
          workers,
          rounds,
        });
        const body = answerBody(markdown);
        Object.assign(entry, scoreAnswer(body, q.facts));
        entry.nonEmpty = body.length > 0;
        entry.success = entry.nonEmpty && entry.correct === entry.total;
        // Частично известная цена занизила бы стоимость: такой прогон считаем без цены.
        entry.costUsd = report.usage && report.usage.pricedCalls === report.usage.calls ? report.usage.costUsd : null;
        entry.sources = report.sourceCheck ? { verified: report.sourceCheck.verified, total: report.sourceCheck.total } : null;
      } catch (err) {
        entry.error = String(err?.message || err);
      }
      entry.sec = Number(((now() - started) / 1000).toFixed(1));
      runs.push(entry);
      onProgress?.(`${provider} · ${q.id}: ${entry.error ? `error: ${entry.error.slice(0, 80)}` : `${entry.correct}/${entry.total} facts`} · ${entry.sec}s`);
    }
    results.push(summarizeProvider(provider, runs));
  }
  return { date: new Date().toISOString(), workers, rounds, questions: questions.map((q) => q.id), providers: results };
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { flags, positional };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (!positional.length) {
    console.error('Usage: npm run bench -- <provider-spec> [<provider-spec> ...] [--only id1,id2] [--workers 2] [--rounds 1] [--out results.json]');
    process.exitCode = 2;
    return;
  }
  let questions = await loadQuestions(flags.questions ? resolve(flags.questions) : undefined);
  if (flags.only) {
    const only = new Set(flags.only.split(','));
    questions = questions.filter((q) => only.has(q.id));
  }
  const result = await runBench({
    providers: positional,
    questions,
    workers: Number(flags.workers) || 2,
    rounds: Number(flags.rounds) === 2 ? 2 : 1,
    onProgress: (m) => process.stderr.write(`· ${m}\n`),
  });
  const out = resolve(flags.out || join(root, 'bench', `results-${result.date.replace(/[:.]/g, '-')}.json`));
  await writeFile(out, JSON.stringify(result, null, 2));
  for (const p of result.providers) {
    const cost = p.costPerSuccessUsd === null ? 'n/a' : `$${p.costPerSuccessUsd.toFixed(4)}`;
    console.log(`${p.provider}: accuracy ${(p.accuracy * 100).toFixed(0)}% · success ${p.successes}/${p.questions} · non-empty ${(p.nonEmptyRate * 100).toFixed(0)}% · ${cost} per success · avg ${p.avgSec}s`);
  }
  console.log(`\n→ ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`bench: ${err.message}`);
    process.exitCode = 1;
  });
}
