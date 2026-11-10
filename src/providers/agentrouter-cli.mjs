import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasBinary, runProcess, mergeSystem, ProviderError } from './base.mjs';
import { codexCli } from './codex-cli.mjs';
import { claudeCli, claudeUsage } from './claude-cli.mjs';

const HTML_PAGE = /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i;

function routerError(provider, error) {
  const d = `${error.message || ''}\n${error.stderr || ''}`;
  let reason = error.message || 'unknown error', status = error.status;
  if (/rate.?limit|too many requests|\b429\b/i.test(d)) {
    reason = 'AgentRouter rate limit exceeded'; status = 429;
  } else if (/<!doctype\s+html\b|<html\b|captcha|cloudflare|\bWAF\b|cf-chl|HTTP\s*403\b/i.test(d)) {
    reason = 'AgentRouter returned an HTML/WAF captcha page; try the next provider'; status = 503;
  } else if (/reconnecting\.{0,3}\s*\d+\s*\/\s*\d+|network|fetch failed|failed to fetch|error sending request|connection|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND/i.test(d)) {
    reason = 'AgentRouter network connection failed'; status = 503;
  } else if (/unrecognized_model|unsupported model|tools.*reasoning_effort|reasoning_effort.*tools/i.test(d)) {
    reason = 'AgentRouter rejected the model/tool configuration; choose a supported model with --provider arcodex-cli:model or arclaude-cli:model'; status = 400;
  }
  return new ProviderError(`${provider}: ${reason}`, { provider, status, cause: error, stderr: error.stderr });
}

export const arcodexCli = {
  ...codexCli,
  id: 'arcodex-cli',
  label: 'AgentRouter Codex CLI',
  defaultModel: process.env.SWARM_ARCODEX_MODEL ?? '',
  detect: () => hasBinary('arcodex'),
  buildArgs: ({ system, prompt, ...opts }) => [...codexCli.buildArgs(opts), '--', mergeSystem(system, prompt)],
  async complete({ system, prompt, model = this.defaultModel, web = false, timeoutMs, signal }) {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-arcodex-')), outFile = join(dir, 'last.md');
    try {
      const { stdout, stderr } = await runProcess('arcodex', this.buildArgs({ system, prompt, model, web, outFile }), { timeoutMs, signal });
      const text = (await readFile(outFile, 'utf8').catch(() => '')).trim();
      if (HTML_PAGE.test(text)) throw new ProviderError('HTML response instead of an answer', { stderr: text.slice(0, 500) });
      if (!text) {
        const error = routerError(this.id, new ProviderError('empty response', { stderr: `${stdout}\n${stderr}` }));
        if (error.status) throw error;
      }
      return { text };
    } catch (e) {
      if (e.provider === this.id) throw e;
      throw routerError(this.id, e);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

export const arclaudeCli = {
  ...claudeCli,
  id: 'arclaude-cli',
  label: 'AgentRouter Claude CLI',
  defaultModel: process.env.SWARM_ARCLAUDE_MODEL ?? '',
  detect: () => hasBinary('arclaude'),
  buildArgs({ prompt, ...opts }) {
    const args = claudeCli.buildArgs(opts);
    if (!opts.model) args.splice(args.indexOf('--model'), 2);
    return [...args, '--', prompt];
  },
  async complete({ system, prompt, model = this.defaultModel, web = false, timeoutMs, signal }) {
    try {
      const { stdout, stderr } = await runProcess('arclaude', this.buildArgs({ system, prompt, model, web }), { timeoutMs, signal });
      let data;
      try { data = JSON.parse(stdout); } catch {
        throw new ProviderError('could not parse JSON output', { stderr: `${stderr}\n${stdout.slice(0, 500)}` });
      }
      if (data.is_error) throw new ProviderError(String(data.result || 'unknown error'), { stderr });
      const text = String(data.result ?? '');
      if (HTML_PAGE.test(text)) throw new ProviderError('HTML response instead of an answer', { stderr: text.slice(0, 500) });
      return { text, usage: claudeUsage(data) };
    } catch (e) {
      throw routerError(this.id, e);
    }
  },
};
