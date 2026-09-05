// OpenRouter (OPENROUTER_API_KEY) — любая модель через OpenAI-совместимый chat/completions.
// Веб-поиск включается суффиксом `:online` у модели.
import { postJson } from './base.mjs';

export const openrouterApi = {
  id: 'openrouter',
  family: 'mixed',
  kind: 'api',
  label: 'OpenRouter',
  defaultModel: process.env.SWARM_OPENROUTER_MODEL || 'anthropic/claude-haiku-4.5',
  detect: () => Boolean(process.env.OPENROUTER_API_KEY),

  buildBody({ system, prompt, model, web }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    return { model: web && !model.endsWith(':online') ? `${model}:online` : model, messages };
  },

  async complete({ system, prompt, model = this.defaultModel, web = false, timeoutMs, signal }) {
    const data = await postJson('https://openrouter.ai/api/v1/chat/completions', {
      provider: this.id,
      timeoutMs,
      signal,
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://github.com/jumpleGo/swarm-search',
        'X-Title': 'swarm-search',
      },
      body: this.buildBody({ system, prompt, model, web }),
    });
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
    };
  },
};
