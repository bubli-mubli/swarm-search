// OpenAI Codex CLI (`codex exec`). Работает по подписке ChatGPT, веб-поиск через web_search="live".
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasBinary, runProcess, mergeSystem } from './base.mjs';

export const codexCli = {
  id: 'codex-cli',
  family: 'openai',
  kind: 'cli',
  label: 'OpenAI Codex CLI',
  // Дешёвая модель, доступная по подписке ChatGPT; SWARM_CODEX_MODEL='' — модель из ~/.codex/config.toml.
  defaultModel: process.env.SWARM_CODEX_MODEL ?? 'gpt-6-luna',
  detect: () => hasBinary('codex'),

  buildArgs({ model, web, outFile }) {
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--color', 'never'];
    if (model) args.push('-m', model);
    if (web) args.push('-c', 'web_search="live"');
    args.push('-o', outFile);
    return args;
  },

  async complete({ system, prompt, model = this.defaultModel, web = false, timeoutMs, signal }) {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-codex-'));
    const outFile = join(dir, 'last.md');
    try {
      const args = this.buildArgs({ model, web, outFile });
      // Промпт передаём через stdin («-»), чтобы не упереться в лимит argv.
      args.push('-');
      await runProcess('codex', args, { input: mergeSystem(system, prompt), timeoutMs, signal });
      const text = await readFile(outFile, 'utf8').catch(() => '');
      return { text: text.trim() };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
