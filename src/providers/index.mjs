// Реестр провайдеров: автоопределение доступных и разбор строки выбора.
import { claudeCli } from './claude-cli.mjs';
import { codexCli } from './codex-cli.mjs';
import { agyCli } from './agy-cli.mjs';
import { geminiCli } from './gemini-cli.mjs';
import { anthropicApi } from './anthropic-api.mjs';
import { openaiApi } from './openai-api.mjs';
import { googleApi } from './google-api.mjs';
import { openrouterApi } from './openrouter-api.mjs';
import { arcodexCli } from './agentrouter-cli.mjs';

// Порядок = приоритет автовыбора. Первым идёт Claude CLI (Haiku по подписке).
// arcodex стоит первым, но попадает в автовыбор только если установлен; тогда agy идёт перед claude (см. ROUTER_CHAIN).
export const PROVIDERS = [arcodexCli, claudeCli, anthropicApi, codexCli, openaiApi, agyCli, googleApi, geminiCli, openrouterApi];

// Цепочка при найденном arcodex: arcodex → agy → claude. Авто-фолбэки не выходят за её пределы.
const ROUTER_CHAIN = ['arcodex-cli', 'agy-cli', 'claude-cli'];

function orderRouterChain(available) {
  if (!available.some((p) => p.id === ROUTER_CHAIN[0])) return available;
  const rank = (p) => ROUTER_CHAIN.includes(p.id) ? ROUTER_CHAIN.indexOf(p.id) : ROUTER_CHAIN.length;
  return [...available].sort((a, b) => rank(a) - rank(b));
}

export const FILES_PRIORITY = [
  'arcodex-cli',
  'claude-cli', 'codex-cli', 'gemini-cli', 'anthropic', 'openai', 'google', 'openrouter',
];

function orderFilesProviders(available) {
  const priority = (p) => FILES_PRIORITY.includes(p.id) ? FILES_PRIORITY.indexOf(p.id) : FILES_PRIORITY.length;
  return [...available].sort((a, b) => priority(a) - priority(b));
}

export const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

export async function detectAvailable({ mode } = {}) {
  const flags = await Promise.all(PROVIDERS.map((p) => Promise.resolve(p.detect()).catch(() => false)));
  const available = PROVIDERS.filter((_, i) => flags[i]);
  return mode === 'files' ? orderFilesProviders(available) : orderRouterChain(available);
}

// Разбирает спецификацию вида "claude-cli", "codex-cli:gpt-5-mini", "mixed",
// "claude-cli,agy-cli" → массив {provider, model}. Пустая строка = авто.
export async function resolveProviders(spec, { available, mode, remote = false, includeFallbacks = false } = {}) {
  const avail = available ?? (await detectAvailable({ mode }));
  const raw = (spec || process.env.SWARM_PROVIDER || 'auto').trim();
  // Filter before auto selection and mixed family deduplication.
  const compatible = avail.filter((p) => (mode !== 'files' || !p.webAlwaysOn) && (!remote || !p.localFiles));
  const requireCompatible = () => {
    if (compatible.length) return;
    if (!avail.length) throw new Error(noProvidersMessage());
    if (mode === 'files' && avail.every((p) => p.webAlwaysOn)) {
      throw new Error(`files mode: ${avail.map((p) => p.id).join(', ')} cannot run without web access; install arcodex or choose --provider claude-cli, codex-cli or gemini-cli.`);
    }
    throw new Error(`remote clients: ${avail.map((p) => p.id).join(', ')} cannot run with the required restrictions; use --provider claude-cli or an API provider`);
  };

  if (raw === 'auto' || raw === '') {
    requireCompatible();
    // Фолбэки только при arcodex первым: arcodex → agy → claude из доступных, без codex/gemini и платных API.
    const chain = includeFallbacks && compatible[0].id === ROUTER_CHAIN[0]
      ? compatible.filter((p) => ROUTER_CHAIN.includes(p.id)) : compatible.slice(0, 1);
    return chain.map((provider) => ({ provider, model: undefined }));
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
    '  arcodex (AgentRouter) | agy (Antigravity CLI) | claude (Claude Code CLI) | codex (OpenAI Codex CLI) | gemini (Gemini CLI)',
    '  ANTHROPIC_API_KEY | OPENAI_API_KEY | GEMINI_API_KEY | OPENROUTER_API_KEY',
  ].join('\n');
}
