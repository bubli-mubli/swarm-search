// Evidence is produced by Node fetch at the worker stage, never by model/CLI assertions.
import { fetchSource } from './source-fetch.mjs';

export const URL_RE = /https?:\/\/(?:\[[\da-f:.]+\]|[^\s)\]>"'`<\[])+/gi;
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

export async function verifyWorkerSources(text, { timeoutMs = 10_000, signal } = {}) {
  const clean = stripVerification(text);
  const lines = clean.split('\n');
  const sourceVerification = [];
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
        const evidence = { url, quote, verified: 'unverified', reason: 'no_fetch' };
        if (quote && (pages.has(url) || pages.size < 12) && !controller.signal.aborted) {
          if (!pages.has(url)) {
            try {
              const response = await fetchSource(url, { signal: controller.signal });
              const body = response.status === 200 ? pageText(await readBody(response)) : '';
              if (response.status !== 200) await response.body?.cancel();
              pages.set(url, { status: response.status, body });
            } catch (error) {
              pages.set(url, error?.code === 'blocked_address' ? { reason: 'blocked_address' } : null);
            }
          }
          const page = pages.get(url);
          if (page) {
            if (page.status !== undefined) evidence.status = page.status;
            if (page.reason) evidence.reason = page.reason;
            else if (page.status !== 200) evidence.reason = `http_${page.status}`;
            else if (!page.body.includes(normalize(quote))) evidence.reason = 'quote_not_found';
            else {
              evidence.verified = 'yes';
              delete evidence.reason;
            }
          }
        }
        receipts.add(evidence);
        sourceVerification.push(evidence);
        marks.push(verificationMark(evidence));
      }
      if (marks.length) {
        lines[i] = lines[i].replace(/\bVERIFIED=unverified \(no_fetch\)/g, '').trimEnd() +
          ` — ${[...new Set(marks)].join('; ')}`;
      }
    }
    if (signal?.aborted) throw new Error('cancelled');
    return { text: lines.join('\n'), sourceVerification };
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
