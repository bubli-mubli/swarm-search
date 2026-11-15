import { URL_RE } from './web-verification.mjs';

// Parse for validation only. Return the original string, including path, query and fragment.
export function sourceUrlIssue(value) {
  try {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /\s/.test(value)) return 'invalid_source_url';
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'invalid_source_url';
    return url.pathname === '/' && !url.search ? 'page_url_required' : null;
  } catch {
    return 'invalid_source_url';
  }
}

export function workerSources(result) {
  let text = String(result.text || '');
  const sources = new Map();
  const sourceIssues = [];
  const inText = new Set((text.match(URL_RE) || []).map(u => u.replace(/[.,;:!?]+$/, '')));
  const add = (source) => {
    const url = typeof source === 'string' ? source : source?.url;
    const reason = sourceUrlIssue(url);
    if (reason === 'invalid_source_url') {
      sourceIssues.push({ url: typeof url === 'string' ? url : null, reason });
      return;
    }
    const previous = sources.get(url);
    sources.set(url, { url, title: (typeof source?.title === 'string' ? source.title : '') || previous?.title || '' });
  };
  for (const source of Array.isArray(result.sources) ? result.sources : []) add(source);
  for (const url of inText) add(url);
  const missing = [...sources.keys()].filter(url => !inText.has(url));
  if (missing.length) text += `\n\nProvider sources:\n${missing.map(url => `- ${url}`).join('\n')}`;
  for (const url of sources.keys()) {
    const reason = sourceUrlIssue(url);
    if (reason) sourceIssues.push({ url, reason });
  }
  if (!sources.size) sourceIssues.push({ reason: 'missing_source_url' });
  return { text, sources: [...sources.values()], sourceIssues, status: sourceIssues.length ? 'partial' : 'ok' };
}
