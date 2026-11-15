// One source for prompt instructions and the syntax consumed by both parsers.
export const URL_RE = /https?:\/\/(?:\[[\da-f:.]+\]|[^\s)\]>"'`<\[])+/gi;
export const PATH_LINE_RE = /(?:[\w.@~-]+\/)+[\w.@-]+:\d+(?:[-–]\d+)?|[\w@-][\w.@-]*\.[A-Za-z]\w*:\d+(?:[-–]\d+)?/g;
const SOURCE_HEADINGS = Object.freeze(['Sources', 'References', 'Источники', 'Ссылки']);
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function extractRefs(text) {
  const s = String(text || '');
  const urls = (s.match(URL_RE) || []).map(u => u.replace(/[.,;:!?]+$/, ''));
  const paths = s.replace(URL_RE, ' ').match(PATH_LINE_RE) || [];
  return [...urls, ...paths];
}

export function responseFormat(kind, { mode = 'web', sourceHeadings = SOURCE_HEADINGS, firstSource = 1, maxCitationRange = 50 } = {}) {
  const rule = (id, text, check) => Object.freeze({ id: `${kind}.${id}`, text, check });
  let rules, read, parseLine;
  if (kind === 'synthesis') {
    const headings = Object.freeze([...sourceHeadings]);
    const heading = new RegExp(`^\\s*(?:#{1,6}\\s*)?\\**\\s*(?:${headings.map(escapeRegex).join('|')})\\s*\\**\\s*:?\\s*\\**\\s*$`, 'i');
    const sourceLine = /^\s*(?:[-*]\s*)?\[?(\d+)\]?[.):]?\s+(.*)$/;
    read = text => {
      const lines = String(text || '').split('\n');
      const heads = lines.flatMap((line, i) => heading.test(line) ? [i] : []);
      const head = heads.at(-1) ?? -1;
      const body = lines.slice(0, head === -1 ? lines.length : head).join('\n');
      const cited = new Set();
      let invalidCitation = false;
      for (const match of body.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)) {
        for (const part of match[1].split(',')) {
          const [a, b = a] = part.split(/[–-]/).map(n => Number(n.trim()));
          if (a < firstSource || !Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b < a || b - a >= maxCitationRange) {
            invalidCitation = true;
            continue;
          }
          for (let n = a; n <= b; n++) cited.add(n);
        }
      }
      const entries = [];
      const extraLines = [];
      if (head !== -1) {
        for (let i = head + 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const match = lines[i].match(sourceLine);
          if (match) entries.push({ n: Number(match[1]), line: i, content: match[2], refs: extractRefs(match[2]) });
          else extraLines.push(i + 1);
        }
      }
      return { lines, heads, head, body, cited, invalidCitation, entries, extraLines };
    };
    rules = [
      rule('answer', 'Write a nonempty answer before the Sources list.', p => p.body.trim() ? null : 'The answer body is empty'),
      rule('sources-list', `Finish with a numbered Sources list under one of these headings: ${headings.join(', ')}.`,
        p => p.heads.length === 1 && p.entries.length ? null : 'Expected exactly one Sources heading and at least one numbered source'),
      rule('source-numbers', `Number sources consecutively from [${firstSource}], without duplicates or gaps; put each source on its own numbered line.`, p => {
        if (p.extraLines.length) return `Unnumbered source line ${p.extraLines[0]}`;
        const bad = p.entries.findIndex((entry, i) => entry.n !== i + firstSource);
        return bad === -1 ? null : `Expected source ${bad + firstSource}, found ${p.entries[bad].n}`;
      }),
      rule('source-ref', 'Every numbered source must contain a URL or path:line.', p => {
        const bad = p.entries.find(entry => !entry.refs.length);
        return bad ? `Source ${bad.n} has no URL or path:line` : null;
      }),
      rule('citations', `Every [n] cited in the answer must appear in Sources and every listed source must be cited; citation ranges must ascend and contain at most ${maxCitationRange} numbers.`, p => {
        if (p.invalidCitation) return 'Invalid citation number or range';
        const listed = new Set(p.entries.map(entry => entry.n));
        const missing = [...p.cited].find(n => !listed.has(n));
        if (missing !== undefined) return `Citation [${missing}] is missing from Sources`;
        const unused = [...listed].find(n => !p.cited.has(n));
        return unused === undefined ? null : `Source [${unused}] is never cited`;
      }),
    ];
  } else if (kind === 'worker') {
    const files = mode === 'files';
    const headings = ['Findings', files ? 'Not found' : 'Uncertain'];
    const headingPatterns = headings.map(name => new RegExp(`^\\s*##\\s+${escapeRegex(name)}\\s*$`, 'i'));
    parseLine = line => {
      const refs = extractRefs(line);
      const urls = [...new Set(refs.filter(ref => /^https?:\/\//i.test(ref)))];
      const quoted = String(line).match(/\bQuote:\s*(?:"([^"\n]+)"|«([^»\n]+)»|`([^`\n]+)`)/i);
      return { refs, urls, quote: urls.length === 1 && quoted ? (quoted[1] || quoted[2] || quoted[3]).trim() : '' };
    };
    read = text => {
      const lines = String(text || '').split('\n');
      const heads = headingPatterns.map(pattern => lines.findIndex(line => pattern.test(line)));
      return {
        nothing: files && /^NOTHING RELEVANT\.?$/i.test(String(text).trim()), heads,
        findings: heads[0] === -1 ? [] : lines.slice(heads[0] + 1, heads[1] === -1 ? lines.length : heads[1])
          .filter(line => /^\s*[-*+]\s/.test(line)).map(parseLine),
      };
    };
    const example = files ? '- finding (path:line)' : '- claim (URL) — Quote: "exact passage"';
    rules = [
      rule('structure', `Reply in this exact structure:\n## ${headings[0]}\n${example}\n## ${headings[1]}\n- what you could not verify` +
        (files ? '\nIf nothing is relevant, reply exactly: NOTHING RELEVANT.' : ''),
      p => p.nothing || (p.heads[0] !== -1 && p.heads[1] > p.heads[0]) ? null : `Expected ## ${headings[0]} followed by ## ${headings[1]}`),
      files ? rule('finding-source', 'Cite every finding as path:line.',
        p => p.findings.every(f => f.refs.some(ref => !/^https?:\/\//i.test(ref))) ? null : 'Finding has no path:line') :
        rule('finding-source', 'Cite one source URL per finding.',
          p => p.findings.every(f => f.urls.length === 1) ? null : 'Expected one URL on each finding line'),
      ...(!files ? [rule('quote', 'Include a verbatim passage from that page as Quote: "exact passage" on the SAME line as its URL.',
        p => p.findings.every(f => f.quote) ? null : 'Finding has no same-line Quote passage')] : []),
    ];
  } else {
    throw new Error(`Unknown response format: ${kind}`);
  }
  rules = Object.freeze(rules);
  return Object.freeze({
    kind, rules, ...(parseLine ? { parseLine } : {}),
    block: `FORMAT_RULES_BLOCK ${kind}\n${rules.map(r => `[${r.id}] ${r.text}`).join('\n')}\nEND_FORMAT_RULES_BLOCK`,
    parse(text) {
      const parsed = read(text);
      for (const r of rules) {
        const detail = r.check(parsed);
        if (detail) return { ...parsed, ok: false, violation: { id: r.id, text: r.text, detail } };
      }
      return { ...parsed, ok: true, violation: null };
    },
  });
}
