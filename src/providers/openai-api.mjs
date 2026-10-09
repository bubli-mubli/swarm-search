// OpenAI Responses API (OPENAI_API_KEY). Веб-поиск — встроенный инструмент web_search.
import { postJson } from './base.mjs';

export const openaiApi = {
  id: 'openai',
  family: 'openai',
  kind: 'api',
  label: 'OpenAI API',
  defaultModel: process.env.SWARM_OPENAI_MODEL || 'gpt-6-luna',
  detect: () => Boolean(process.env.OPENAI_API_KEY),

  buildBody({ system, prompt, model, web }) {
    const body = { model, input: prompt };
    if (system) body.instructions = system;
    if (web) body.tools = [{ type: 'web_search' }];
    return body;
  },

  async complete({ system, prompt, model = this.defaultModel, web = false, timeoutMs, signal }) {
    const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const data = await postJson(`${base}/responses`, {
      provider: this.id,
      timeoutMs,
      signal,
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: this.buildBody({ system, prompt, model, web }),
    });
    const text =
      data.output_text ??
      (data.output || [])
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content || [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text)
        .join('\n');
    return {
      text,
      usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens },
    };
  },
};
