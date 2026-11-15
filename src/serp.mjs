import { sourceUrlIssue } from './web-sources.mjs';

export function serpOptions(opts) {
  const topN = opts.topN === undefined ? 10 : Number(opts.topN);
  if (typeof opts.topN === 'boolean' || !Number.isInteger(topN) || topN < 1 || topN > 100) {
    throw new Error('serp: topN must be an integer from 1 to 100');
  }
  if (opts.region !== undefined && (typeof opts.region !== 'string' || !opts.region.trim())) {
    throw new Error('serp: region must be a non-empty string');
  }
  if (opts.paths?.length) throw new Error('serp: paths cannot be combined with search results');
  return { topN, region: opts.region?.trim() ?? null };
}

// Only a dedicated adapter may supply ranks. Never parse LLM prose or enumerate citations.
// searchSerp({query, topN, region, signal, timeoutMs}) returns {region, results}, with
// native organic positions and retrieval timestamps. No current LLM adapter implements it.
export async function serpSearch({ query, topN, region, slots, signal, timeoutMs }) {
  const started = Date.now();
  const slot = slots.find(s => typeof s.provider.searchSerp === 'function') || slots[0];
  const provider = slot?.provider;
  let calls = 0;
  const finish = (status, reason, results = [], actualRegion = region) => {
    const serp = { query, topN, region: actualRegion, provider: provider?.id ?? null, status, reason, results };
    const markdown = `SERP: ${status}${reason ? ` (${reason})` : ''}\nQuery: ${query}\nRegion: ${actualRegion ?? 'unknown'}\n` +
      results.map(r => `- position: ${r.position} · ${r.title} — ${r.url} (fetched_at: ${r.fetched_at})`).join('\n');
    return { markdown, report: {
      query, mode: 'serp', status, serp, workers: [], round2: [], rounds: 0,
      elapsedSec: (Date.now() - started) / 1000,
      usage: { calls, pricedCalls: 0, costUsd: null },
    } };
  };
  const checkCancelled = () => { if (signal?.aborted) throw new Error('cancelled'); };
  checkCancelled();
  if (typeof provider?.searchSerp !== 'function') return finish('unavailable', 'positions_not_supported: selected provider does not expose native SERP positions');
  let data;
  try {
    calls++;
    data = await provider.searchSerp({ query, topN, region, signal, timeoutMs });
  } catch (error) {
    checkCancelled();
    return finish('unavailable', `provider_error: ${error.message || error}`);
  }
  checkCancelled();
  if (data?.status === 'unavailable') return finish('unavailable', data.reason || 'positions_unavailable');
  if (region !== null && data?.region !== region) return finish('unavailable', 'region_not_confirmed');
  const actualRegion = typeof data?.region === 'string' && data.region.trim() ? data.region : null;
  if (!Array.isArray(data?.results) || !data.results.length) return finish('unavailable', 'positions_unavailable: no ranked results');
  const positions = new Set();
  for (const row of data.results) {
    if (!Number.isInteger(row?.position) || row.position < 1 || positions.has(row.position)) {
      return finish('unavailable', 'positions_unavailable: missing, invalid or duplicate native position');
    }
    positions.add(row.position);
    const issue = sourceUrlIssue(row.url);
    if (issue) return finish('unavailable', issue);
    if (typeof row.title !== 'string' || !row.title.trim()) return finish('unavailable', 'title_unavailable');
    if (typeof row.fetched_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(row.fetched_at) || !Number.isFinite(Date.parse(row.fetched_at))) {
      return finish('unavailable', 'fetched_at_unavailable');
    }
  }
  const results = data.results.filter(row => row.position <= topN)
    .sort((a, b) => a.position - b.position)
    .map(({ position, url, title, fetched_at }) => ({ position, url, title, fetched_at }));
  return finish(results.length === topN ? 'ok' : 'partial', results.length === topN ? null : 'incomplete_positions', results, actualRegion);
}
