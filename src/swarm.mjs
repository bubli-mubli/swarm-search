// Пайплайн swarm search: план → параллельные воркеры → (второй раунд) → синтез итога.
import { resolveProviders } from './providers/index.mjs';
import { collectFiles, buildShards } from './corpus.mjs';

export const DEFAULTS = {
  // null = auto: число воркеров решает планировщик по сложности вопроса.
  workers: process.env.SWARM_WORKERS ? Number(process.env.SWARM_WORKERS) : null,
  maxWorkers: 12,
  maxAutoWorkers: Number(process.env.SWARM_MAX_AUTO_WORKERS) || 8,
  timeoutMs: Number(process.env.SWARM_TIMEOUT_MS) || 180_000,
  shardChars: Number(process.env.SWARM_SHARD_CHARS) || 60_000,
  rounds: Number(process.env.SWARM_ROUNDS) || 1,
  round2: process.env.SWARM_ROUND2 || 'gaps',
};

const PLANNER_SYSTEM =
  'You split a research question into independent sub-questions for parallel workers. ' +
  'Reply with a JSON array of strings only, no prose, no markdown fences.';

const WORKER_SYSTEM_WEB =
  'You are one worker in a research swarm. Investigate ONLY your sub-question, using web search when available. ' +
  'Be concrete: facts, numbers, dates, names. Every claim must end with its source URL in parentheses. ' +
  'Reply in this exact structure:\n## Findings\n- claim (URL)\n## Uncertain\n- what you could not verify\n' +
  'Keep it under 400 words. Do not answer the overall question, only your part.';

const WORKER_SYSTEM_FILES =
  'You are one worker in a code/document search swarm. You receive a slice of files with line numbers. ' +
  'Report ONLY what in this slice is relevant to the query. Cite every finding as `path:line`. ' +
  'Reply in this exact structure:\n## Findings\n- finding (path:line)\n## Not found\n- what the query asked that this slice does not contain\n' +
  'If nothing is relevant, reply exactly: NOTHING RELEVANT. Keep it under 400 words.';

const GAPS_SYSTEM =
  'You audit the first-round reports of a research swarm. Find (a) claims where workers contradict each other and ' +
  '(b) parts of the original question nobody answered or workers marked uncertain / not found. ' +
  'Turn each into one targeted follow-up sub-question. Reply with JSON only: {"followups": ["...", "..."]}. ' +
  'Return {"followups": []} if the reports already answer the question well.';

const CRITIQUE_SYSTEM =
  'You are a worker in a research swarm, now in the critique round. You see your own first-round report and the anonymized reports of the other workers. ' +
  'Reply in this exact structure:\n## Confirmed\n- claims of others you can corroborate (source)\n' +
  '## Disputed\n- claims of others that contradict your evidence, and which side is right (source)\n' +
  '## Retracted\n- your own claims you no longer stand behind\n## Missing\n- what nobody covered\n' +
  'Be terse, cite sources, do not repeat agreed facts. Under 300 words.';

const SYNTH_SYSTEM =
  'You are the synthesizer of a research swarm. You receive the original question and reports from several workers. ' +
  'Merge them into one answer for a busy expert. Rules: lead with the direct answer, and if it depends on a contested point, say that the point is contested instead of picking a side; ' +
  'then key findings as bullets, each with a [n] reference; ' +
  'then a section "## Worker disagreements" (heading in the language of the question): one bullet per conflict (different numbers, dates, versions, yes/no, ' +
  'or one worker could not confirm what another asserts). In each bullet list every position separately: the position, which workers hold it ' +
  '(Worker ids with their provider/model), and that side\'s own [n] sources. Do NOT settle a conflict by counting workers: workers on the same model ' +
  'often share the same mistake and the minority is often right. Only weigh source quality (primary/official vs aggregator, date) and name the check that would settle it. ' +
  'If there are no conflicts, write one line saying so. Also list claims backed by a single worker and a single source as unconfirmed. ' +
  'Finish with a numbered "Sources" list mapping [n] to URLs or path:line. ' +
  'Number sources consecutively from [1]; every [n] used in the text MUST appear in the Sources list and vice versa. ' +
  'If round-2 reports are present, they were produced after seeing round 1: prefer them where they resolve a conflict and cite evidence. ' +
  'Drop duplicates, do not invent sources, keep the language of the original question.';

// Достаёт JSON-массив строк из ответа планировщика; на любой сбой — null.
export function parseAngles(text, n) {
  if (!text) return null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    const clean = arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    return clean.length ? clean.slice(0, n) : null;
  } catch {
    return null;
  }
}

// Достаёт {"followups": [...]} из ответа аудитора; на сбой — пустой список.
export function parseFollowups(text, max) {
  if (!text) return [];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    const arr = Array.isArray(obj.followups) ? obj.followups : [];
    return arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, max);
  } catch {
    return [];
  }
}

// Число воркеров: положительное число = фиксировано, иначе auto (null).
export function resolveWorkers(value) {
  if (value === undefined || value === null || value === '' || value === 'auto') {
    return DEFAULTS.workers && DEFAULTS.workers > 0 ? Math.min(DEFAULTS.workers, DEFAULTS.maxWorkers) : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.floor(n), DEFAULTS.maxWorkers);
}

// Выполняет задачи с ограничением параллелизма, сохраняя порядок результатов.
export async function runPool(tasks, concurrency, onDone, signal) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      if (signal?.aborted) {
        results[i] = { ok: false, error: new Error('cancelled') };
        continue;
      }
      try {
        results[i] = { ok: true, value: await tasks[i]() };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
      // Исключение в колбэке не должно валить пул, пока другие задачи ещё работают.
      try {
        onDone?.(i, results[i]);
      } catch {
        // игнорируем
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  return results;
}

// Сводка расхода по всем вызовам прогона (план, воркеры, аудит, синтез) и цена одного полезного ответа воркера.
export function summarizeUsage(calls, usefulAnswers) {
  const sum = (key) => calls.reduce((acc, c) => acc + (Number(c.usage?.[key]) || 0), 0);
  const priced = calls.filter((c) => typeof c.usage?.costUsd === 'number');
  const costUsd = priced.length ? priced.reduce((acc, c) => acc + c.usage.costUsd, 0) : null;
  return {
    calls: calls.length,
    pricedCalls: priced.length,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    costUsd,
    usefulAnswers,
    // Цена ответа честна только если известна стоимость всех вызовов; иначе — null.
    costPerUsefulUsd: costUsd !== null && priced.length === calls.length && usefulAnswers ? costUsd / usefulAnswers : null,
  };
}

const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtUsd = (n) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`;

export function usageLine(u) {
  let line = `tokens ${fmtTokens(u.inputTokens)} in / ${fmtTokens(u.outputTokens)} out`;
  if (u.costUsd !== null) {
    line += ` · ${fmtUsd(u.costUsd)}${u.pricedCalls < u.calls ? ` (${u.pricedCalls}/${u.calls} calls priced)` : ''}`;
    if (u.costPerUsefulUsd !== null) line += ` · ${fmtUsd(u.costPerUsefulUsd)} per useful answer`;
  }
  return line;
}

const isUseful = (r) => r.ok && r.text.trim() && !/^NOTHING RELEVANT\.?$/i.test(r.text.trim());

/**
 * Основной вход. Возвращает { markdown, report } где report — структурированные данные прогона.
 * opts: { query, mode, paths, workers, provider, model, synthProvider, synthModel, angles, language,
 *         rounds, round2, timeoutMs, signal, onProgress }
 */
export async function swarmSearch(opts) {
  const started = Date.now();
  const query = String(opts.query || '').trim();
  if (!query) throw new Error('query is required');

  const fixedWorkers = resolveWorkers(opts.workers);
  const rounds = Number(opts.rounds) === 2 ? 2 : DEFAULTS.rounds === 2 ? 2 : 1;
  const round2Mode = opts.round2 === 'critique' || (!opts.round2 && DEFAULTS.round2 === 'critique') ? 'critique' : 'gaps';
  const timeoutMs = Number(opts.timeoutMs) || DEFAULTS.timeoutMs;
  const signal = opts.signal;
  const throwIfCancelled = () => {
    if (signal?.aborted) throw new Error('cancelled');
  };
  const paths = (opts.paths || []).filter(Boolean);
  const mode = opts.mode && opts.mode !== 'auto' ? opts.mode : paths.length ? 'files' : 'web';
  const progress = (msg) => opts.onProgress?.(msg);

  const pool = await resolveProviders(opts.provider);
  // Явная модель применяется к каждому провайдеру, у которого модель не задана в спецификации.
  const slots = pool.map((s) => ({ provider: s.provider, model: s.model ?? opts.model ?? s.provider.defaultModel }));
  const pick = (i) => slots[i % slots.length];

  const synth = opts.synthProvider
    ? (await resolveProviders(opts.synthProvider))[0]
    : { provider: slots[0].provider, model: slots[0].model };
  synth.model = opts.synthModel ?? synth.model ?? synth.provider.defaultModel;

  const languageHint = opts.language ? `\nAnswer language: ${opts.language}.` : '';
  // Служебные вызовы (план, аудит, синтез) — для подсчёта расхода; воркеры считаются по своим отчётам.
  const serviceCalls = [];

  // Запускает список заданий на воркерах и превращает результаты в отчёты.
  const runJobs = async (jobs, concurrency, stage) => {
    const tasks = jobs.map((job, i) => async () => {
      const slot = pick(i);
      const res = await slot.provider.complete({ system: job.system, prompt: job.prompt, model: slot.model, web: job.web, timeoutMs, signal });
      return { ...res, provider: slot.provider.id, model: slot.model };
    });
    let done = 0;
    const results = await runPool(
      tasks,
      concurrency,
      (i, r) => {
        done += 1;
        progress(`${stage} worker ${i + 1}/${jobs.length} ${r.ok ? 'done' : 'failed'} (${done}/${jobs.length})`);
      },
      signal,
    );
    throwIfCancelled();
    return results.map((r, i) => ({
      id: jobs[i].id,
      label: jobs[i].label,
      provider: r.ok ? r.value.provider : pick(i).provider.id,
      model: r.ok ? r.value.model : pick(i).model,
      ok: r.ok,
      text: r.ok ? r.value.text : '',
      error: r.ok ? null : String(r.error?.message || r.error),
      usage: r.ok ? r.value.usage : undefined,
    }));
  };

  // 1. Формируем задания первого раунда.
  let jobs = [];
  let concurrency;
  let plannedBy = fixedWorkers ? 'fixed' : 'auto';
  let shardTexts = [];
  if (mode === 'files') {
    if (!paths.length) throw new Error('mode=files requires paths');
    progress(`collecting files from ${paths.join(', ')}`);
    const files = await collectFiles(paths);
    // При фиксированном N маленький корпус режем мельче, чтобы занять всех воркеров; нижняя граница — 8k символов.
    const totalChars = files.reduce((sum, f) => sum + f.size, 0);
    const maxChars = fixedWorkers
      ? Math.max(8_000, Math.min(DEFAULTS.shardChars, Math.ceil(totalChars / fixedWorkers)))
      : DEFAULTS.shardChars;
    const shards = await buildShards(files, { maxChars });
    if (!shards.length) throw new Error('no readable text files found under given paths');
    concurrency = fixedWorkers ?? Math.min(shards.length, DEFAULTS.maxAutoWorkers);
    progress(`${files.length} files → ${shards.length} shards, ${concurrency} parallel workers`);
    shardTexts = shards.map((s) => s.text);
    jobs = shards.map((shard, i) => ({
      id: i + 1,
      label: `shard ${i + 1}: ${shard.files.slice(0, 3).join(', ')}${shard.files.length > 3 ? ` +${shard.files.length - 3}` : ''}`,
      system: WORKER_SYSTEM_FILES + languageHint,
      prompt: `Query: ${query}\n\nFiles in your slice:\n${shard.files.join('\n')}\n\n${shard.text}`,
      web: false,
    }));
  } else {
    let angles = Array.isArray(opts.angles) && opts.angles.length ? opts.angles.slice(0, DEFAULTS.maxWorkers) : null;
    if (angles) plannedBy = 'caller';
    if (!angles) {
      const cap = fixedWorkers ?? DEFAULTS.maxAutoWorkers;
      progress(fixedWorkers ? `planning ${cap} angles with ${slots[0].provider.id}` : `planning up to ${cap} angles with ${slots[0].provider.id}`);
      const sizing = fixedWorkers
        ? `Produce exactly ${cap} sub-questions that together cover the question from different angles (facts, alternatives, risks, recent changes, numbers).`
        : `First decide how many genuinely independent angles this question has, from 1 to ${cap}. ` +
          `A narrow factual question (one version, one date, one definition) has 1. A comparison of several options, or a "state of X" question, has one per option or facet. ` +
          `Return exactly that many sub-questions, no padding.`;
      const plan = await slots[0].provider
        .complete({
          system: PLANNER_SYSTEM,
          prompt: `Question: ${query}\n\n${sizing} Same language as the question.`,
          model: slots[0].model,
          web: false,
          timeoutMs,
          signal,
        })
        .catch((err) => ({ text: '', error: err }));
      throwIfCancelled();
      serviceCalls.push(plan);
      angles = parseAngles(plan.text, cap) || fallbackAngles(query, fixedWorkers ?? 3);
    }
    concurrency = fixedWorkers ?? angles.length;
    jobs = angles.map((angle, i) => ({
      id: i + 1,
      label: angle,
      system: WORKER_SYSTEM_WEB + languageHint,
      prompt: `Overall question (for context only): ${query}\n\nYour sub-question: ${angle}`,
      web: true,
    }));
  }

  // 2. Первый раунд.
  const round1 = await runJobs(jobs, concurrency, 'round 1');
  const useful1 = round1.filter(isUseful);
  if (!useful1.length) {
    const errors = round1.filter((r) => !r.ok).map((r) => `- worker ${r.id} (${r.provider}): ${r.error}`).join('\n');
    throw new Error(`All ${round1.length} workers returned nothing.${errors ? `\n${errors}` : ''}`);
  }

  const reportBlock = (r, prefix = 'Worker') => `### ${prefix} ${r.id} (${r.provider}${r.model ? `:${r.model}` : ''}) — ${r.label}\n${r.text.trim()}`;

  // 3. Второй раунд (опционально): дозакрытие пробелов или критика.
  let round2 = [];
  let round2Note = '';
  if (rounds === 2) {
    if (round2Mode === 'gaps') {
      const maxFollowups = Math.min(4, Math.max(1, Math.ceil(useful1.length / 2)));
      progress(`round 2: auditing ${useful1.length} reports for gaps and conflicts`);
      const audit = await synth.provider
        .complete({
          system: GAPS_SYSTEM,
          prompt: `Original question: ${query}\nMax follow-ups: ${maxFollowups}\n\n${useful1.map((r) => reportBlock(r)).join('\n\n')}`,
          model: synth.model,
          web: false,
          timeoutMs,
          signal,
        })
        .catch((err) => ({ text: '', error: err }));
      throwIfCancelled();
      serviceCalls.push(audit);
      const followups = parseFollowups(audit.text, maxFollowups);
      if (!followups.length) {
        round2Note = 'gaps: none found';
        progress('round 2: no gaps found, skipping');
      } else {
        progress(`round 2: ${followups.length} follow-up workers`);
        let context = '';
        if (mode === 'files') {
          // Дозакрываем по шардам, где что-то нашлось; режем по общему лимиту, чтобы не раздуть промпт.
          const relevant = useful1.map((r) => shardTexts[r.id - 1]).filter(Boolean).join('\n');
          const cap = DEFAULTS.shardChars * 2;
          context = relevant.length > cap ? relevant.slice(0, cap) + '\n[... truncated ...]' : relevant;
        }
        const jobs2 = followups.map((fq, i) => ({
          id: round1.length + i + 1,
          label: `follow-up: ${fq}`,
          system: (mode === 'files' ? WORKER_SYSTEM_FILES : WORKER_SYSTEM_WEB) + languageHint,
          prompt:
            mode === 'files'
              ? `Query: ${fq}\n(Overall question for context: ${query})\n\n${context}`
              : `Overall question (for context only): ${query}\n\nYour sub-question (follow-up to resolve a gap or conflict): ${fq}`,
          web: mode !== 'files',
        }));
        round2 = await runJobs(jobs2, Math.min(jobs2.length, concurrency), 'round 2');
        round2Note = `gaps: ${followups.length} follow-ups`;
      }
    } else {
      progress(`round 2: ${useful1.length} workers critique each other`);
      const jobs2 = useful1.map((r, i) => {
        const others = useful1
          .filter((o) => o.id !== r.id)
          .map((o, k) => `### Report ${String.fromCharCode(65 + k)} — ${o.label}\n${o.text.trim()}`)
          .join('\n\n');
        return {
          id: round1.length + i + 1,
          label: `critique by worker ${r.id}`,
          system: CRITIQUE_SYSTEM + languageHint,
          prompt: `Original question: ${query}\n\n## Your first-round report\n${r.text.trim()}\n\n## Other workers' reports\n${others}`,
          web: mode !== 'files',
        };
      });
      round2 = await runJobs(jobs2, Math.min(jobs2.length, concurrency), 'round 2');
      round2Note = `critique: ${round2.filter(isUseful).length}/${jobs2.length}`;
    }
  }
  const useful2 = round2.filter(isUseful);

  // 4. Синтез.
  const allReports = [...round1, ...round2];
  progress(`synthesizing ${useful1.length + useful2.length} reports with ${synth.provider.id}`);
  const failed = allReports.filter((r) => !r.ok);
  const synthPrompt =
    `Original question: ${query}\nMode: ${mode}\n\n## Round 1\n\n` +
    useful1.map((r) => reportBlock(r)).join('\n\n') +
    (useful2.length ? `\n\n## Round 2 (${round2Mode === 'gaps' ? 'gap-filling follow-ups' : 'cross-critique'})\n\n${useful2.map((r) => reportBlock(r, round2Mode === 'gaps' ? 'Follow-up' : 'Critique')).join('\n\n')}` : '') +
    (failed.length ? `\n\nFailed workers: ${failed.map((r) => r.id).join(', ')} (mention that coverage is partial).` : '');
  const synthesis = await synth.provider.complete({ system: SYNTH_SYSTEM + languageHint, prompt: synthPrompt, model: synth.model, web: false, timeoutMs, signal });
  serviceCalls.push(synthesis);
  const usage = summarizeUsage([...serviceCalls, ...allReports], useful1.length + useful2.length);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const familiesUsed = [...new Set(allReports.filter((r) => r.ok).map((r) => `${r.provider}${r.model ? `:${r.model}` : ''}`))];
  const footer =
    `\n\n---\n_swarm-search · mode: ${mode} · workers: ${round1.length} (${plannedBy}; ${useful1.length} useful, ${round1.filter((r) => !r.ok).length} failed)` +
    (rounds === 2 ? ` · round 2: ${round2Note}` : '') +
    ` · workers on ${familiesUsed.join(', ')} · synthesis: ${synth.provider.id}:${synth.model} · ${elapsed}s · ${usageLine(usage)}_`;

  return {
    markdown: synthesis.text.trim() + footer,
    report: {
      query,
      mode,
      plannedBy,
      rounds,
      round2Mode: rounds === 2 ? round2Mode : null,
      workers: round1,
      round2,
      synthesis: { provider: synth.provider.id, model: synth.model },
      elapsedSec: Number(elapsed),
      usage,
    },
  };
}

// Если планировщик не вернул JSON — режем вопрос на типовые углы.
export function fallbackAngles(query, n) {
  const base = [
    `${query} — core facts and definitions`,
    `${query} — recent developments and current state`,
    `${query} — alternatives, comparisons, trade-offs`,
    `${query} — risks, criticism, known problems`,
    `${query} — numbers, benchmarks, pricing, data`,
    `${query} — practical how-to and best practices`,
    `${query} — expert opinions and community consensus`,
    `${query} — history and context`,
  ];
  return base.slice(0, Math.max(1, n));
}
