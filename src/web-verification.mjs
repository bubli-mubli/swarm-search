// Evidence is produced by Node fetch at the worker stage, never by model/CLI assertions.
import { fetchSource } from './source-fetch.mjs';

export const URL_RE = /https?:\/\/(?:\[[\da-f:.]+\]|[^\s)\]>"'`<\[])+/gi;
export const PATH_LINE_RE = /(?:[\w.@~-]+\/)+[\w.@-]+:\d+(?:[-–]\d+)?|[\w@-][\w.@-]*\.[A-Za-z]\w*:\d+(?:[-–]\d+)?/g;
const receipts = new WeakSet();
const key = (url) => url.replace(/\/+$/, '');
const urlsIn = (text) => [...new Set((String(text).match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
const normalize = (text) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

export function stripVerification(text) {
  return String(text || '').replace(/\bVERIFIED\s*=\s*(?:yes|no|unverified)\b(?:\s*\([^\n)]*\))?/gi,
    'VERIFIED=unverified (no_fetch)');
}

export function verificationMark(evidence) {
  return evidence.verified === 'yes' ? 'VERIFIED=yes' : `VERIFIED=unverified (${evidence.reason})`;
}

function pageText(body) {
  return normalize(body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (m, decimal, hex, name) => {
      if (name) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name.toLowerCase()];
      const code = parseInt(decimal || hex, decimal ? 10 : 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }));
}

async function readBody(response) {
  // Bound memory as well as time; incomplete bodies never provide evidence.
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString('utf8');
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('page too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function verifyWorkerSources(text, { timeoutMs = 10_000, signal, mode = 'web', sources = [], status } = {}) {
  const clean = stripVerification(text);
  const lines = clean.split('\n');
  const sourceVerification = [];
  const facts = [];
  // A provider may admit missing evidence, but cannot grant successful verification.
  const declaredUnavailable = new Set((Array.isArray(sources) ? sources : [])
    .filter(s => s?.status === 'unavailable').map(s => s.source_url ?? s.url));
  const pages = new Map();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 10_000));
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    for (let i = 0; i < lines.length; i++) {
      const urls = urlsIn(lines[i]);
      // A quote belongs to the single URL on the same finding line. Never borrow another claim's quote.
      const quoted = lines[i].match(/\bQuote:\s*(?:"([^"\n]+)"|«([^»\n]+)»|`([^`\n]+)`)/i);
      const quote = urls.length === 1 && quoted ? (quoted[1] || quoted[2] || quoted[3]).trim() : '';
      const marks = [];
      for (const url of urls) {
        const evidence = { url, quote, verified: 'unverified', reason: mode === 'files' ? 'no_fetch_files_mode' : 'no_fetch',
          source_url: url, fetched_at: null, source_status: 'partial' };
        const unavailableMarker = /^\s*(?:[-*+]|\d+[.)])?\s*status\s*=\s*unavailable\b/i.test(lines[i]);
        if (mode !== 'files' && (status === 'unavailable' || declaredUnavailable.has(url) || unavailableMarker)) {
          evidence.source_status = 'unavailable';
          evidence.reason = 'provider_unavailable';
        } else if (mode !== 'files' && quote && (pages.has(url) || pages.size < 12) && !controller.signal.aborted) {
          if (!pages.has(url)) {
            try {
              const response = await fetchSource(url, { signal: controller.signal });
              const body = response.status === 200 ? pageText(await readBody(response)) : '';
              if (response.status !== 200) await response.body?.cancel();
              pages.set(url, { status: response.status, body, fetched_at: new Date().toISOString() });
            } catch (error) {
              pages.set(url, { reason: error?.code === 'blocked_address' ? 'blocked_address' : 'no_fetch',
                fetched_at: new Date().toISOString() });
            }
          }
          const page = pages.get(url);
          if (page) {
            evidence.fetched_at = page.fetched_at;
            if (page.status !== undefined) evidence.status = page.status;
            if (page.reason || page.status !== 200) {
              evidence.reason = page.reason || `http_${page.status}`;
              evidence.source_status = 'unavailable';
            }
            else if (!page.body.includes(normalize(quote))) evidence.reason = 'quote_not_found';
            else {
              evidence.verified = 'yes';
              evidence.source_status = 'ok';
              delete evidence.reason;
            }
          }
        }
        receipts.add(evidence);
        sourceVerification.push(evidence);
        facts.push({ text: lines[i], line: i + 1, source_url: url, fetched_at: evidence.fetched_at,
          status: evidence.source_status, ...(evidence.reason ? { reason: evidence.reason } : {}) });
        marks.push(verificationMark(evidence));
      }
      if (!urls.length && lines[i].trim() && !/^\s*#|^Provider sources:|^NOTHING RELEVANT\.?$/i.test(lines[i]) &&
          !/^\s*(?:[-*+]|\d+[.)])?\s*(?:none|nothing|нет|ничего|n\/a)[.!]?\s*$/i.test(lines[i])) {
        const refs = mode === 'files' ? [...new Set(lines[i].match(PATH_LINE_RE) || [])] : [];
        for (const ref of refs.length ? refs : [null]) {
          facts.push({ text: lines[i], line: i + 1, source_url: ref,
            fetched_at: ref ? new Date().toISOString() : null, status: ref ? 'ok' : status === 'unavailable' ? 'unavailable' : 'partial',
            ...(ref ? {} : { reason: status === 'unavailable' ? 'provider_unavailable' : 'missing_source_url' }) });
        }
      }
      if (marks.length) {
        lines[i] = lines[i].replace(/\bVERIFIED=unverified \(no_fetch\)/g, '').trimEnd() +
          ` — ${[...new Set(marks)].join('; ')}`;
      }
    }
    if (signal?.aborted) throw new Error('cancelled');
    return { text: lines.join('\n'), sourceVerification, facts };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Only receipts created here are trusted; serialized provider metadata cannot grant VERIFIED=yes.
export function sourceEvidence(url, reports) {
  const evidence = [];
  for (const report of reports) {
    const text = typeof report === 'string' ? report : report.text || '';
    if (!urlsIn(text).some((u) => key(u) === key(url))) continue;
    const found = typeof report === 'object' && report.ok !== false
      ? (report.sourceVerification || []).filter((e) => receipts.has(e) && key(e.url) === key(url)) : [];
    evidence.push(...(found.length ? found : [{ url, verified: 'unverified', reason: 'no_fetch' }]));
  }
  const failed = evidence.find((e) => e.verified !== 'yes');
  const result = failed || evidence[0] || { url, verified: 'unverified', reason: 'no_fetch' };
  return { ...result, url };
}
