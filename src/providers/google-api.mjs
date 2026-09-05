// Google Gemini API (GEMINI_API_KEY или GOOGLE_API_KEY). Веб-поиск — grounding через google_search.
import { postJson } from './base.mjs';

const apiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

export const googleApi = {
  id: 'google',
  family: 'google',
  kind: 'api',
  label: 'Google Gemini API',
  defaultModel: process.env.SWARM_GOOGLE_MODEL || 'gemini-2.5-flash',
  detect: () => Boolean(apiKey()),

  buildBody({ system, prompt, web }) {
    const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (web) body.tools = [{ google_search: {} }];
    return body;
  },

  async complete({ system, prompt, model = this.defaultModel, web = false, timeoutMs, signal }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const data = await postJson(url, {
      provider: this.id,
      timeoutMs,
      signal,
      headers: { 'x-goog-api-key': apiKey() },
      body: this.buildBody({ system, prompt, web }),
    });
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
    // Источники grounding подмешиваем в текст, чтобы синтезатор мог на них ссылаться.
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const sources = chunks
      .map((c) => c.web?.uri)
      .filter(Boolean)
      .map((u, i) => `[${i + 1}] ${u}`);
    return {
      text: sources.length ? `${text}\n\nSources:\n${sources.join('\n')}` : text,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
      },
    };
  },
};
