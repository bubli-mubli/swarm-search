// Preserve raw worker diagnostics, but do not feed unavailable findings back to models.
const FAILURE_STATUSES = new Set(['timeout', 'http_error', 'rate_limit', 'auth', 'parse_error', 'unknown_error']);

// Normalize CLI/API diagnostics at the shared worker boundary. This does not decide retries.
export function sourceFailure(error) {
  const text = `${error?.message || error || ''} ${error?.stderr || ''}`;
  const code = Number(error?.status) || Number(text.match(/\b(?:HTTP|status:?|code:?)\s*(\d{3})\b/i)?.[1]);
  let status;
  if (code === 401 || code === 403) status = 'auth';
  else if (code === 402 || code === 429) status = 'rate_limit';
  else if (code >= 400 && code <= 599) status = 'http_error';
  else if (error?.name === 'TimeoutError' || error?.name === 'AbortError' ||
    /timed?\s*out|timeout|ETIMEDOUT/i.test(`${text} ${error?.code || ''} ${error?.cause?.code || ''}`)) status = 'timeout';
  else if (/rate.?limit|too many requests|quota|resource_exhausted|insufficient (?:credits|balance|funds)/i.test(text)) status = 'rate_limit';
  else if (/unauth|forbidden|authentication|authorization|login required|log in|not logged in|credentials? (?:expired|invalid|missing)|invalid (?:api.?key|token)/i.test(text)) status = 'auth';
  else if (error instanceof SyntaxError || error?.cause instanceof SyntaxError ||
    /(?:could not|cannot|failed to) parse|non[- ]JSON|invalid JSON|HTML response instead of an answer/i.test(text)) status = 'parse_error';
  else status = 'unknown_error';
  return { status, ...(code >= 400 && code <= 599 ? { http_status: code } : {}) };
}

export function workerSourceResult(result) {
  // Optional adapter metadata can admit failure, but cannot turn empty text into findings.
  if (FAILURE_STATUSES.has(result.sourceResult?.status)) {
    const { status, http_status } = result.sourceResult;
    return { status, ...(Number.isInteger(http_status) && http_status >= 400 && http_status <= 599 ? { http_status } : {}) };
  }
  if (result.status === 'unavailable') return sourceFailure(result.error || 'source unavailable');
  return { status: !result.text.trim() || /^NOTHING RELEVANT\.?$/i.test(result.text.trim()) ? 'ok_empty' : 'ok' };
}

export function workerSourceResults(report) {
  const urls = [...new Set(report.facts.map(f => f.source_url).filter(Boolean))];
  if (!urls.length) return [{ source_url: null, ...report.sourceResult }];
  return urls.map(source_url => {
    if (FAILURE_STATUSES.has(report.sourceResult.status)) return { source_url, ...report.sourceResult };
    const failed = report.facts.find(f => f.source_url === source_url && f.status === 'unavailable');
    if (!failed) return { source_url, status: 'ok' };
    const receipt = report.sourceVerification?.find(e => e.url === source_url && e.source_status === 'unavailable');
    // Legacy no_fetch receipts do not retain a cause: do not guess timeout vs network failure.
    return { source_url, ...sourceFailure({ status: receipt?.status, message: failed.reason?.replace(/^http_/, 'HTTP ') }) };
  });
}

// Count final page/source outcomes and prior provider attempts, including recovered failures.
export function sourceOutcomes(reports) {
  return reports.flatMap(report => {
    const attempts = report.sourceAttempts || [];
    const finalIndex = attempts.findLastIndex(a => a.provider === report.provider);
    const previous = attempts.filter((_, i) => i !== finalIndex).map(a => ({ worker_id: report.id, provider: a.provider, model: a.model,
      source_url: null, ...a.sourceResult }));
    const final = report.sourceResults || [report.sourceResult ||
      (report.ok ? workerSourceResult(report) : sourceFailure(report.error))];
    return [...previous, ...final.map(s => ({ worker_id: report.id, provider: report.provider, model: report.model, ...s }))];
  });
}

export function summarizeSources(reports) {
  const summary = { total: 0, found: 0, empty: 0, failed: 0, reasons: {} };
  for (const outcome of sourceOutcomes(reports)) {
    summary.total++;
    if (outcome.status === 'ok') summary.found++;
    else if (outcome.status === 'ok_empty') summary.empty++;
    else {
      summary.failed++;
      summary.reasons[outcome.status] = (summary.reasons[outcome.status] || 0) + 1;
    }
  }
  return summary;
}

export function sourceOutcomesNote(reports, russian = false) {
  const summary = summarizeSources(reports);
  const reasons = Object.entries(summary.reasons).map(([reason, count]) => `${reason}=${count}`).join(', ');
  const heading = russian ? '## Результаты источников' : '## Source outcomes';
  const rows = sourceOutcomes(reports).map(s => `- Worker ${s.worker_id} (${s.provider}${s.model ? `:${s.model}` : ''}): ${s.status}` +
    (s.http_status ? ` (HTTP ${s.http_status})` : '') + (s.source_url ? ` — ${s.source_url}` : ''));
  return `\n\n${heading}\nfound=${summary.found}, empty=${summary.empty}, failed=${summary.failed}` +
    (reasons ? ` (${reasons})` : '') +
    (summary.failed ? (russian ? '\nОтвет неполный: отказы источников не означают пустой результат.'
      : '\nAnswer is incomplete: source failures do not mean an empty result.') : '') + `\n${rows.join('\n')}`;
}

export function sourceStatus(facts, fallback = 'ok') {
  if (fallback === 'unavailable') return 'unavailable';
  if (facts.length && facts.every(f => f.status === 'unavailable')) return 'unavailable';
  return fallback !== 'ok' || facts.some(f => f.status !== 'ok') ? 'partial' : 'ok';
}

export function synthesisReportText(report) {
  if (report.status === 'unavailable') return 'No usable findings: sources unavailable.';
  const lines = report.text.split('\n');
  const removed = new Set();
  const hasUnavailable = (report.facts || []).some(f => f.status === 'unavailable');
  const boundary = line => /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(line);
  for (const fact of report.facts || []) {
    // With mixed provider metadata, an unattributed claim cannot be assigned to a good source.
    if (fact.status !== 'unavailable' && !(hasUnavailable && fact.source_url === null)) continue;
    let start = fact.line - 1, end = start + 1;
    // A finding may span several lines. Withhold the whole list item/paragraph.
    while (start > 0 && !boundary(lines[start]) && !/^\s*#/.test(lines[start - 1])) start--;
    while (end < lines.length && !boundary(lines[end])) end++;
    // A continuation inherits the surrounding finding's source; it is not an unrelated claim.
    if (fact.source_url === null && report.facts.some(f => f.source_url !== null && f.line > start && f.line <= end)) continue;
    for (let i = start; i < end; i++) removed.add(i);
  }
  return lines.filter((_, i) => !removed.has(i)).join('\n').trim();
}

export function reportProvenance(report) {
  const facts = (report.facts || []).map(({ source_url, fetched_at, status, reason }) =>
    ({ source_url, fetched_at, status, ...(reason ? { reason } : {}) }));
  return synthesisReportText(report) + (facts.length ? `\n\nSource provenance (per finding):\n${JSON.stringify(facts)}` : '');
}

export function unavailableSources(reports) {
  return reports.flatMap(report => {
    const seen = new Set();
    const missing = (report.facts || []).filter(fact => {
      if (fact.status !== 'unavailable' || seen.has(fact.source_url)) return false;
      seen.add(fact.source_url);
      return true;
    }).map(({ source_url, fetched_at, status, reason }) =>
      ({ worker_id: report.id, source_url, fetched_at, status, reason }));
    if (!report.ok || (!missing.length && report.status === 'unavailable')) {
      missing.push({ worker_id: report.id, source_url: null, fetched_at: null,
        status: 'unavailable', reason: report.ok ? 'provider_unavailable' : 'worker_failed' });
    }
    return missing;
  });
}

export function completenessNote(reports, missing, russian = false) {
  const partial = reports.some(r => r.sourceResult?.status !== 'ok_empty' && r.status !== 'ok');
  if (!partial && !missing.length) return '';
  const heading = russian ? '## Пробелы данных\nОтвет неполный: часть источников недоступна или проверена не полностью.'
    : '## Data gaps\nAnswer is incomplete: some sources are unavailable or only partially checked.';
  const rows = missing.map(s => `- ${s.source_url || `Worker ${s.worker_id}`} — unavailable (${s.reason}); fetched_at: ${s.fetched_at ?? 'null'}`);
  return `\n\n${heading}${rows.length ? `\n${rows.join('\n')}` : ''}`;
}
