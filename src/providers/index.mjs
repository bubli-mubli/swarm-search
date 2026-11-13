// Реестр провайдеров: автоопределение доступных и разбор строки выбора.
import { claudeCli } from './claude-cli.mjs';
import { codexCli } from './codex-cli.mjs';
import { agyCli } from './agy-cli.mjs';
import { geminiCli } from './gemini-cli.mjs';
import { anthropicApi } from './anthropic-api.mjs';
import { openaiApi } from './openai-api.mjs';
import { googleApi } from './google-api.mjs';
import { openrouterApi } from './openrouter-api.mjs';

// Порядок = приоритет автовыбора. Первым идёт Claude CLI (Haiku по подписке).
export const PROVIDERS = [claudeCli, anthropicApi, codexCli, openaiApi, agyCli, googleApi, geminiCli, openrouterApi];

export const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

export async function detectAvailable() {
  const flags = await Promise.all(PROVIDERS.map((p) => Promise.resolve(p.detect()).catch(() => false)));
  return PROVIDERS.filter((_, i) => flags[i]);
}

// Разбирает спецификацию вида "claude-cli", "codex-cli:gpt-5-mini", "mixed",
// "claude-cli,agy-cli" → массив {provider, model}. Пустая строка = авто.
export async function resolveProviders(spec, { available, mode } = {}) {
  const detected = available ?? (await detectAvailable());
  const raw = (spec || process.env.SWARM_PROVIDER || 'auto').trim();
  // files mode: автовыбор берёт только провайдеров, у которых веб отключается (иначе агент-ловушка agy "cannot run without web access").
  const avail = mode === 'files' ? detected.filter((p) => !p.webAlwaysOn) : detected;
  const requireAny = () => {
    if (avail.length) return;
    if (detected.length) throw new Error(`files mode: ${detected.map((p) => p.id).join(', ')} cannot run without web access; install or choose an offline provider, e.g. --provider claude-cli, codex-cli or gemini-cli`);
    throw new Error(noProvidersMessage());
  };

  if (raw === 'auto' || raw === '') {
    requireAny();
    return [{ provider: avail[0], model: undefined }];
  }

  if (raw === 'mixed') {
    // По одному провайдеру на семейство моделей — чтобы воркеры реально были разными.
    const seen = new Set();
    requireAny();
    const picked = avail.filter((p) => (seen.has(p.family) ? false : (seen.add(p.family), true)));
    return picked.map((provider) => ({ provider, model: provider.mixedModel }));
  }

  return raw.split(',').map((part) => {
    const [id, ...rest] = part.trim().split(':');
    const provider = byId[id];
    if (!provider) throw new Error(`Unknown provider "${id}". Known: ${PROVIDERS.map((p) => p.id).join(', ')}`);
    return { provider, model: rest.join(':') || undefined };
  });
}

export function noProvidersMessage() {
  return [
    'No LLM provider available. Install one CLI or set one API key:',
    '  claude (Claude Code CLI) | codex (OpenAI Codex CLI) | agy (Antigravity CLI) | gemini (Gemini CLI)',
    '  ANTHROPIC_API_KEY | OPENAI_API_KEY | GEMINI_API_KEY | OPENROUTER_API_KEY',
  ].join('\n');
}
