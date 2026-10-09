// Официальный Gemini CLI (`gemini -p`). Требует рабочий логин Google / GEMINI_API_KEY.
import { hasBinary, runProcess, ProviderError, mergeSystem } from './base.mjs';

export const geminiCli = {
  id: 'gemini-cli',
  family: 'google',
  kind: 'cli',
  label: 'Gemini CLI',
  defaultModel: process.env.SWARM_GEMINI_MODEL || 'gemini-3.5-flash-lite',
  detect: () => hasBinary('gemini'),

  buildArgs({ model }) {
    // plan = read-only, встроенный google_web_search остаётся доступен.
    // -p обязан получить значение (иначе съест -m); сам промпт приходит через stdin и дописывается к нему.
    return ['-p', '', '-m', model, '-o', 'json', '--approval-mode', 'plan'];
  },

  async complete({ system, prompt, model = this.defaultModel, timeoutMs, signal }) {
    const args = this.buildArgs({ model });
    const { stdout } = await runProcess('gemini', args, { input: mergeSystem(system, prompt), timeoutMs, signal });
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
