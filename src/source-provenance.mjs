// Preserve raw worker diagnostics, but do not feed unavailable findings back to models.
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
  const partial = reports.some(r => r.status !== 'ok');
  if (!partial && !missing.length) return '';
  const heading = russian ? '## Пробелы данных\nОтвет неполный: часть источников недоступна или проверена не полностью.'
    : '## Data gaps\nAnswer is incomplete: some sources are unavailable or only partially checked.';
  const rows = missing.map(s => `- ${s.source_url || `Worker ${s.worker_id}`} — unavailable (${s.reason}); fetched_at: ${s.fetched_at ?? 'null'}`);
  return `\n\n${heading}${rows.length ? `\n${rows.join('\n')}` : ''}`;
}
