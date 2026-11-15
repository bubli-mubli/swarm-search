import { responseFormat } from './response-format.mjs';

const format = responseFormat('synthesis');

// The model cannot establish that its own prose is trusted. Conservatively retain
// the lineage of the whole synthesis, even for paraphrases or uncited additions.
// HTTP/quote verification is independent of this instruction/data boundary.
export function markUntrustedSynthesis(text, mode) {
  const mark = `_[untrusted source: ${mode === 'files' ? 'files' : 'web pages'} via worker reports]_`;
  const { lines, heads } = format.parse(text);
  const sourceHeads = new Set(heads);
  const out = [];
  let fence = null;
  let indented = false;
  for (const [i, line] of lines.entries()) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      out.push(line);
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      continue;
    }
    if (delimiter) {
      out.push(mark, '', line);
      fence = delimiter[1];
      indented = false;
      continue;
    }
    // Annotate a code block beside it, keeping copyable code unchanged.
    if (/^(?: {4}|\t)/.test(line)) {
      if (!indented) out.push(mark, '');
      out.push(line);
      indented = true;
      continue;
    }
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    indented = false;
    // Only structural lines are exempt; headings containing claims are marked.
    if (sourceHeads.has(i) || /^\s*(?:[-*_]\s*){3,}$/.test(line) || /^\s*=+\s*$/.test(line) ||
        /^\s*\|?[\s:|-]+\|\s*$/.test(line)) {
      out.push(line);
      continue;
    }
    // Raw HTML must not hide the code-generated label (e.g. an open comment).
    const visible = line.replace(/</g, '&lt;');
    // Keep the column count of Markdown tables intact.
    out.push(/^\s*\|/.test(visible) && /\|\s*$/.test(visible)
      ? visible.replace(/\|\s*$/, ` ${mark} |`)
      : `${visible} ${mark}`);
  }
  // An unclosed model-generated fence must not swallow the CLI/MCP footer.
  if (fence) out.push(fence);
  return out.join('\n');
}
