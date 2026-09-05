// Claude Code CLI (`claude -p`). Дефолт — Haiku, работает по подписке без API-ключа.
import { hasBinary, runProcess, ProviderError } from './base.mjs';

export const claudeCli = {
  id: 'claude-cli',
  family: 'anthropic',
  kind: 'cli',
  label: 'Claude Code CLI (Haiku by default)',
  defaultModel: process.env.SWARM_CLAUDE_MODEL || 'haiku',
  detect: () => hasBinary('claude'),

  buildArgs({ model, web, system }) {
    const tools = web ? 'WebSearch,WebFetch' : '';
    const args = ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence', '--tools', tools];
    // Без allowedTools headless-режим просит разрешение на веб-поиск и не ищет.
    if (web) args.push('--allowedTools', tools);
    if (system) args.push('--system-prompt', system);
    return args;
  },

  async complete({ system, prompt, model = this.defaultModel, web = false, timeoutMs, signal }) {
    const args = this.buildArgs({ model, web, system });
    // Промпт через stdin — не упираемся в лимит длины argv на больших шардах файлов.
    const { stdout } = await runProcess('claude', args, { input: prompt, timeoutMs, signal });
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new ProviderError('claude-cli: could not parse JSON output', { provider: this.id, stderr: stdout.slice(0, 500) });
    }
    if (data.is_error) throw new ProviderError(`claude-cli: ${data.result || 'unknown error'}`, { provider: this.id });
    return {
      text: String(data.result ?? ''),
      usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens, costUsd: data.total_cost_usd },
    };
  },
};
