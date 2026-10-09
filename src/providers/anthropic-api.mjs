// Anthropic Messages API напрямую (ANTHROPIC_API_KEY). Дефолт — Claude Haiku 5.5.
import { postJson } from './base.mjs';

export const anthropicApi = {
  id: 'anthropic',
  family: 'anthropic',
  kind: 'api',
  label: 'Anthropic API (Claude Haiku 5.5)',
  defaultModel: process.env.SWARM_ANTHROPIC_MODEL || 'claude-haiku-5-5',
  detect: () => Boolean(process.env.ANTHROPIC_API_KEY),

  buildBody({ system, prompt, model, web }) {
    const body = {
      model,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    };
    if (system) body.system = system;
    // Базовый вариант web_search — его поддерживают и младшие модели Haiku.
    if (web) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    return body;
  },

  async complete({ system, prompt, model = this.defaultModel, web = false, timeoutMs, signal }) {
    const data = await postJson('https://api.anthropic.com/v1/messages', {
      provider: this.id,
      timeoutMs,
      signal,
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: this.buildBody({ system, prompt, model, web }),
    });
    const blocks = data.content || [];
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    // URL живут не в тексте, а в citations текстовых блоков и в результатах web_search — собираем их отдельно.
    const urls = new Set();
    for (const b of blocks) {
      for (const c of b.citations || []) if (c.url) urls.add(c.url);
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) if (r.url) urls.add(r.url);
      }
    }
    const sources = [...urls].map((u, i) => `[${i + 1}] ${u}`);
    return {
      text: sources.length ? `${text}\n\nSources:\n${sources.join('\n')}` : text,
      usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens },
    };
  },
};
