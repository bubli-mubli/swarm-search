// Google Antigravity CLI (`agy`) — доступ к Gemini Flash/Pro по подписке Antigravity.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasBinary, runProcess, ProviderError, mergeSystem } from './base.mjs';

// agy не читает stdin; длиннее этого промпт уходит через файл, чтобы не упереться в лимит argv.
const MAX_ARGV_PROMPT = 60_000;

export const agyCli = {
  id: 'agy-cli',
  family: 'google',
  kind: 'cli',
  label: 'Antigravity CLI (Gemini Flash)',
  defaultModel: process.env.SWARM_AGY_MODEL || 'gemini-3.8-flash-low',
  detect: () => hasBinary('agy'),

  buildArgs({ model, timeoutMs, prompt }) {
    // plan-режим держит сессию read-only, веб-поиск в нём доступен.
    // Промпт обязан быть приклеен к флагу (-p=...), иначе agy съест следующий флаг как промпт.
    const minutes = Math.max(1, Math.ceil(timeoutMs / 60_000));
    return ['--mode', 'plan', '--model', model, '--output-format', 'json', '--print-timeout', `${minutes}m`, `-p=${prompt}`];
  },

  async complete({ system, prompt, model = this.defaultModel, timeoutMs = 180_000, signal }) {
    let full = mergeSystem(system, prompt);
    let dir = null;
    if (full.length > MAX_ARGV_PROMPT) {
      dir = await mkdtemp(join(tmpdir(), 'swarm-agy-'));
      const file = join(dir, 'prompt.md');
      await writeFile(file, full);
      full = `Read the file ${file} and follow the instructions in it exactly. Reply only with what it asks for.`;
    }
    let stdout;
    try {
      const args = this.buildArgs({ model, timeoutMs, prompt: full });
      ({ stdout } = await runProcess('agy', args, { timeoutMs: timeoutMs + 15_000, signal }));
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    let data;
    try {
      data = JSON.parse(stdout.slice(stdout.indexOf('{')));
    } catch {
      throw new ProviderError('agy-cli: could not parse JSON output', { provider: this.id, stderr: stdout.slice(0, 500) });
    }
    if (data.status && data.status !== 'SUCCESS') {
      throw new ProviderError(`agy-cli: ${data.error || data.status}`, { provider: this.id });
    }
    return {
      text: String(data.response ?? ''),
      usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens },
    };
  },
};
