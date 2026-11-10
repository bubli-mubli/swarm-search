// Реестр провайдеров: автоопределение доступных и разбор строки выбора.
import { claudeCli } from './claude-cli.mjs';
import { codexCli } from './codex-cli.mjs';
import { agyCli } from './agy-cli.mjs';
import { geminiCli } from './gemini-cli.mjs';
import { anthropicApi } from './anthropic-api.mjs';
import { openaiApi } from './openai-api.mjs';
import { googleApi } from './google-api.mjs';
import { openrouterApi } from './openrouter-api.mjs';
import { arcodexCli, arclaudeCli } from './agentrouter-cli.mjs';

// Порядок = приоритет: AgentRouter → agy → Claude → legacy CLI → платные API.
export const PROVIDERS = [arcodexCli, arclaudeCli, agyCli, claudeCli, codexCli, geminiCli, anthropicApi, openaiApi, googleApi, openrouterApi];

export const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

export async function detectAvailable() {
  const flags = await Promise.all(PROVIDERS.map((p) => Promise.resolve(p.detect()).catch(() => false)));
  return PROVIDERS.filter((_, i) => flags[i]);
}

// Разбирает спецификацию вида "claude-cli", "codex-cli:gpt-5-mini", "mixed",
// "claude-cli,agy-cli" → массив {provider, model}. Пустая строка = авто.
export async function resolveProviders(spec, { available, mode, remote = false, includeFallbacks = false } = {}) {
  const avail = available ?? (await detectAvailable());
  const raw = (spec || process.env.SWARM_PROVIDER || 'auto').trim();
  // Фильтруем до выбора первого провайдера и до дедупликации семейств в mixed.
  const compatible = avail.filter((p) => (mode !== 'files' || !p.webAlwaysOn) && (!remote || !p.localFiles));
  const requireCompatible = () => {
    if (compatible.length) return;
    if (!avail.length) throw new Error(noProvidersMessage());
    if (mode === 'files' && avail.every((p) => p.webAlwaysOn)) {
      throw new Error(`files mode: ${avail.map((p) => p.id).join(', ')} cannot run without web access; install arcodex / arclaude, or choose --provider claude-cli, codex-cli, gemini-cli or an API provider. Run swarm-search providers to check availability.`);
    }
    throw new Error(`remote clients: ${avail.map((p) => p.id).join(', ')} cannot run with the required restrictions; use --provider arclaude-cli, claude-cli or an API provider`);
  };

  if (raw === 'auto' || raw === '') {
    requireCompatible();
    // В auto выбираем одну обёртку AgentRouter: arcodex, иначе arclaude.
    // При сбое общего маршрутизатора следующий провайдер — agy, затем Claude.
    const hasArcodex = compatible.some((p) => p.id === arcodexCli.id);
    const automatic = compatible.filter((p) => !hasArcodex || p.id !== arclaudeCli.id);
    return (includeFallbacks ? automatic : automatic.slice(0, 1)).map((provider) => ({ provider, model: undefined }));
  }

  if (raw === 'mixed') {
    // По одному провайдеру на семейство моделей — чтобы воркеры реально были разными.
    const seen = new Set();
    requireCompatible();
    const picked = compatible.filter((p) => (seen.has(p.family) ? false : (seen.add(p.family), true)));
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
    '  arcodex / arclaude (AgentRouter) | agy (Antigravity CLI) | claude (Claude Code CLI) | codex (OpenAI Codex CLI) | gemini (Gemini CLI)',
    '  ANTHROPIC_API_KEY | OPENAI_API_KEY | GEMINI_API_KEY | OPENROUTER_API_KEY',
  ].join('\n');
}
