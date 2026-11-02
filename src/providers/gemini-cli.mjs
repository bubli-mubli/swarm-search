// Официальный Gemini CLI (`gemini -p`). Требует рабочий логин Google / GEMINI_API_KEY.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasBinary, runProcess, ProviderError, mergeSystem } from './base.mjs';

// Политика Gemini CLI, запрещающая сетевые инструменты (plan-режим их разрешает).
export const NO_WEB_POLICY = ['google_web_search', 'web_fetch']
  .map((tool) => `[[rule]]\ntoolName = "${tool}"\ndecision = "deny"\npriority = 999\n`)
  .join('\n');

export const geminiCli = {
  id: 'gemini-cli',
  family: 'google',
  kind: 'cli',
  label: 'Gemini CLI',
  defaultModel: process.env.SWARM_GEMINI_MODEL || 'gemini-3.5-flash-lite',
  // plan-режим читает файлы рабочего каталога сервера: удалённым клиентам MCP провайдер не даём.
  localFiles: true,
  detect: () => hasBinary('gemini'),

  buildArgs({ model, policyFile }) {
    // plan = read-only, встроенный google_web_search остаётся доступен; без веба его режет policyFile.
    // -p обязан получить значение (иначе съест -m); сам промпт приходит через stdin и дописывается к нему.
    const args = ['-p', '', '-m', model, '-o', 'json', '--approval-mode', 'plan'];
    if (policyFile) args.push('--policy', policyFile);
    return args;
  },

  async complete({ system, prompt, model = this.defaultModel, web = false, timeoutMs, signal }) {
    let dir = null;
    let policyFile;
    if (!web) {
      dir = await mkdtemp(join(tmpdir(), 'swarm-gemini-'));
      policyFile = join(dir, 'no-web.toml');
      await writeFile(policyFile, NO_WEB_POLICY);
    }
    let stdout;
    try {
      const args = this.buildArgs({ model, policyFile });
      ({ stdout } = await runProcess('gemini', args, { input: mergeSystem(system, prompt), timeoutMs, signal }));
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    let data;
    try {
      data = JSON.parse(stdout.slice(stdout.indexOf('{')));
    } catch {
      throw new ProviderError('gemini-cli: could not parse JSON output', { provider: this.id, stderr: stdout.slice(0, 500) });
    }
    if (data.error) throw new ProviderError(`gemini-cli: ${data.error.message || JSON.stringify(data.error)}`, { provider: this.id });
    return { text: String(data.response ?? '') };
  },
};
