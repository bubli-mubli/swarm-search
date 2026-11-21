// Preloaded only in the real CLI child. Substitute providers, never CLI/MCP/swarm code.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.env.CLAUDE_PLUGIN_ROOT, 'the recorded plugin root must be expanded');
assert.deepEqual(Object.keys(process.env).filter(key => /key|token|secret|credential/i.test(key)), [],
  'the MCP child must not inherit credentials');
const fixture = JSON.parse(await readFile(new URL('./plugin-compat-711.json', import.meta.url), 'utf8'));
const { PROVIDERS } = await import(pathToFileURL(join(process.env.CLAUDE_PLUGIN_ROOT, 'src/providers/index.mjs')));
const args = fixture.searchCall.arguments;
const allowed = new Set([args.provider, args.synth_provider]);
const source = `${args.paths[0]}:1`;

for (const provider of PROVIDERS) {
  provider.detect = () => allowed.has(provider.id);
  // Future native SERP adapters must not make real requests in this offline fixture either.
  provider.searchSerp = undefined;
  provider.complete = async ({ system, prompt, model, web }) => {
    assert.ok(allowed.has(provider.id), `unexpected provider: ${provider.id}`);
    assert.equal(web, false, 'the saved files call must stay offline');
    assert.ok(prompt.includes(args.query), 'the old query argument must reach the provider');
    assert.ok(prompt.includes(args.paths[0]), 'the old paths argument must reach the provider');
    assert.ok(system.includes(`Answer language: ${args.language}.`), 'the old language argument must reach the provider');
    if (provider.id === args.synth_provider) {
      assert.equal(model, args.synth_model, 'the old synth_model argument must reach the provider');
      return { text: `${fixture.marker} is recorded [1].\n\n## Sources\n1. ${source}` };
    }
    assert.equal(model, args.model, 'the old model argument must reach the worker');
    return { text: `## Findings\n- ${fixture.marker} is recorded (${source})\n## Not found\n- none` };
  };
}
