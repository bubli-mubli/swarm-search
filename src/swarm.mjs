// Пайплайн swarm search: план → параллельные воркеры → синтез итога.
import { resolveProviders } from './providers/index.mjs';
import { collectFiles, buildShards } from './corpus.mjs';

export const DEFAULTS = {
  workers: Number(process.env.SWARM_WORKERS) || 4,
  maxWorkers: 12,
  timeoutMs: Number(process.env.SWARM_TIMEOUT_MS) || 180_000,
  shardChars: Number(process.env.SWARM_SHARD_CHARS) || 60_000,
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

const SYNTH_SYSTEM =
  'You are the synthesizer of a research swarm. You receive the original question and reports from several workers. ' +
  'Merge them into one answer for a busy expert. Rules: lead with the direct answer; then key findings as bullets, each with a [n] reference; ' +
  'call out where workers disagree or were unsure; finish with a numbered "Sources" list mapping [n] to URLs or path:line. ' +
  'Number sources consecutively from [1]; every [n] used in the text MUST appear in the Sources list and vice versa. ' +
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
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

/**
 * Основной вход. Возвращает { markdown, report } где report — структурированные данные прогона.
 * opts: { query, mode, paths, workers, provider, model, synthProvider, synthModel, angles, language, timeoutMs, onProgress }
 */
export async function swarmSearch(opts) {
  const started = Date.now();
  const query = String(opts.query || '').trim();
  if (!query) throw new Error('query is required');

  const workers = Math.max(1, Math.min(Number(opts.workers) || DEFAULTS.workers, DEFAULTS.maxWorkers));
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

  // 1. Формируем задания воркерам.
  let jobs = [];
  if (mode === 'files') {
    if (!paths.length) throw new Error('mode=files requires paths');
    progress(`collecting files from ${paths.join(', ')}`);
    const files = await collectFiles(paths);
    // Маленький корпус режем мельче, чтобы реально занять всех воркеров; нижняя граница — 8k символов.
    const totalChars = files.reduce((sum, f) => sum + f.size, 0);
    const maxChars = Math.max(8_000, Math.min(DEFAULTS.shardChars, Math.ceil(totalChars / workers)));
    const shards = await buildShards(files, { maxChars });
    if (!shards.length) throw new Error('no readable text files found under given paths');
    progress(`${files.length} files → ${shards.length} shards, ${workers} parallel workers`);
    jobs = shards.map((shard, i) => ({
      id: i + 1,
      label: `shard ${i + 1}: ${shard.files.slice(0, 3).join(', ')}${shard.files.length > 3 ? ` +${shard.files.length - 3}` : ''}`,
      system: WORKER_SYSTEM_FILES + languageHint,
      prompt: `Query: ${query}\n\nFiles in your slice:\n${shard.files.join('\n')}\n\n${shard.text}`,
      web: false,
    }));
  } else {
    let angles = Array.isArray(opts.angles) && opts.angles.length ? opts.angles.slice(0, workers) : null;
    if (!angles) {
      progress(`planning ${workers} angles with ${slots[0].provider.id}`);
      const plan = await slots[0].provider
        .complete({
          system: PLANNER_SYSTEM,
          prompt: `Question: ${query}\n\nProduce exactly ${workers} sub-questions that together cover the question from different angles (facts, alternatives, risks, recent changes, numbers). Same language as the question.`,
          model: slots[0].model,
          web: false,
          timeoutMs,
          signal,
        })
        .catch((err) => ({ text: '', error: err }));
      throwIfCancelled();
      angles = parseAngles(plan.text, workers) || fallbackAngles(query, workers);
    }
    jobs = angles.map((angle, i) => ({
      id: i + 1,
      label: angle,
      system: WORKER_SYSTEM_WEB + languageHint,
      prompt: `Overall question (for context only): ${query}\n\nYour sub-question: ${angle}`,
      web: true,
    }));
  }

  // 2. Параллельный прогон воркеров.
  const tasks = jobs.map((job, i) => async () => {
    const slot = pick(i);
    const res = await slot.provider.complete({ system: job.system, prompt: job.prompt, model: slot.model, web: job.web, timeoutMs, signal });
    return { ...res, provider: slot.provider.id, model: slot.model };
  });
  let done = 0;
  const results = await runPool(
    tasks,
    workers,
    (i, r) => {
      done += 1;
      progress(`worker ${i + 1}/${jobs.length} ${r.ok ? 'done' : 'failed'} (${done}/${jobs.length})`);
    },
    signal,
  );
  throwIfCancelled();

  const reports = results.map((r, i) => ({
    id: jobs[i].id,
    label: jobs[i].label,
    provider: r.ok ? r.value.provider : pick(i).provider.id,
    model: r.ok ? r.value.model : pick(i).model,
    ok: r.ok,
    text: r.ok ? r.value.text : '',
    error: r.ok ? null : String(r.error?.message || r.error),
    usage: r.ok ? r.value.usage : undefined,
  }));

  const useful = reports.filter((r) => r.ok && r.text.trim() && !/^NOTHING RELEVANT\.?$/i.test(r.text.trim()));
  if (!useful.length) {
    const errors = reports.filter((r) => !r.ok).map((r) => `- worker ${r.id} (${r.provider}): ${r.error}`).join('\n');
    throw new Error(`All ${reports.length} workers returned nothing.${errors ? `\n${errors}` : ''}`);
  }

  // 3. Синтез.
  progress(`synthesizing ${useful.length} reports with ${synth.provider.id}`);
  const synthPrompt =
    `Original question: ${query}\nMode: ${mode}\n\n` +
    useful.map((r) => `### Worker ${r.id} (${r.provider}) — ${r.label}\n${r.text.trim()}`).join('\n\n') +
    (reports.some((r) => !r.ok) ? `\n\nFailed workers: ${reports.filter((r) => !r.ok).map((r) => r.id).join(', ')} (mention that coverage is partial).` : '');
  const synthesis = await synth.provider.complete({ system: SYNTH_SYSTEM + languageHint, prompt: synthPrompt, model: synth.model, web: false, timeoutMs, signal });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const familiesUsed = [...new Set(reports.filter((r) => r.ok).map((r) => `${r.provider}${r.model ? `:${r.model}` : ''}`))];
  const footer =
    `\n\n---\n_swarm-search · mode: ${mode} · workers: ${reports.length} (${useful.length} useful, ${reports.filter((r) => !r.ok).length} failed) · ` +
    `workers on ${familiesUsed.join(', ')} · synthesis: ${synth.provider.id}:${synth.model} · ${elapsed}s_`;

  return {
    markdown: synthesis.text.trim() + footer,
    report: { query, mode, workers: reports, synthesis: { provider: synth.provider.id, model: synth.model }, elapsedSec: Number(elapsed) },
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
