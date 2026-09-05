import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAngles, fallbackAngles, runPool, swarmSearch } from '../src/swarm.mjs';
import { collectFiles, buildShards } from '../src/corpus.mjs';
import { handleMessage, TOOLS, createSession, originAllowed } from '../src/mcp.mjs';
import { resolveProviders } from '../src/providers/index.mjs';
import { claudeCli } from '../src/providers/claude-cli.mjs';
import { codexCli } from '../src/providers/codex-cli.mjs';
import { agyCli } from '../src/providers/agy-cli.mjs';
import { anthropicApi } from '../src/providers/anthropic-api.mjs';
import { openrouterApi } from '../src/providers/openrouter-api.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('parseAngles extracts a JSON array even when wrapped in prose/fences', () => {
  assert.deepEqual(parseAngles('Sure:\n```json\n["a", "b", "c"]\n```', 5), ['a', 'b', 'c']);
  assert.deepEqual(parseAngles('["a","b","c"]', 2), ['a', 'b']);
  assert.equal(parseAngles('no json here', 3), null);
  assert.equal(parseAngles('[1, 2]', 3), null);
});

test('fallbackAngles yields exactly n angles', () => {
  assert.equal(fallbackAngles('q', 3).length, 3);
  assert.equal(fallbackAngles('q', 1).length, 1);
});

test('runPool respects concurrency and keeps order', async () => {
  let active = 0;
  let peak = 0;
  const tasks = [5, 1, 3, 2].map((n) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, n * 5));
    active -= 1;
    return n;
  });
  const res = await runPool(tasks, 2);
  assert.deepEqual(res.map((r) => r.value), [5, 1, 3, 2]);
  assert.equal(peak, 2);
});

test('runPool isolates failures', async () => {
  const res = await runPool([async () => 1, async () => { throw new Error('boom'); }], 2);
  assert.equal(res[0].ok, true);
  assert.equal(res[1].ok, false);
  assert.match(res[1].error.message, /boom/);
});

test('corpus: skips node_modules/binaries and shards by size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-corpus-'));
  try {
    await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'ignored');
    await writeFile(join(dir, 'a.txt'), 'x'.repeat(500));
    await writeFile(join(dir, 'b.txt'), 'y'.repeat(500));
    await writeFile(join(dir, 'img.png'), 'binary');
    const files = await collectFiles([dir]);
    assert.deepEqual(files.map((f) => f.path.split('/').pop()).sort(), ['a.txt', 'b.txt']);
    const shards = await buildShards(files, { maxChars: 700 });
    assert.equal(shards.length, 2);
    assert.match(shards[0].text, /FILE: .*\.txt/);
    assert.match(shards[0].text, /^\s+1\| /m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('providers: build correct CLI args and API bodies', async () => {
  const c = claudeCli.buildArgs({ model: 'haiku', web: true, system: 'S' });
  assert.ok(c.includes('--allowedTools') && c.includes('WebSearch,WebFetch') && c.includes('--system-prompt'));
  const c2 = claudeCli.buildArgs({ model: 'haiku', web: false });
  assert.ok(!c2.includes('--allowedTools'));
  assert.equal(c2[c2.indexOf('--tools') + 1], '');

  const x = codexCli.buildArgs({ model: '', web: true, outFile: '/tmp/o' });
  assert.ok(!x.includes('-m'));
  assert.ok(x.includes('web_search="live"') && x.includes('read-only'));

  const gm = (await import('../src/providers/gemini-cli.mjs')).geminiCli.buildArgs({ model: 'gemini-2.5-flash' });
  assert.equal(gm[gm.indexOf('-p') + 1], '');

  const g = agyCli.buildArgs({ model: 'gemini-3.8-flash-low', timeoutMs: 150_000, prompt: 'hello' });
  assert.ok(g.includes('plan') && g.includes('3m'));
  assert.equal(g.at(-1), '-p=hello');

  const a = anthropicApi.buildBody({ system: 'S', prompt: 'P', model: 'claude-haiku-4-5', web: true });
  assert.equal(a.tools[0].type, 'web_search_20250305');
  assert.equal(a.system, 'S');

  const o = openrouterApi.buildBody({ prompt: 'P', model: 'x/y', web: true });
  assert.equal(o.model, 'x/y:online');
});

test('resolveProviders parses specs and mixed picks one per family', async () => {
  const fake = (id, family) => ({ id, family, defaultModel: 'm', detect: () => true });
  const available = [fake('claude-cli', 'anthropic'), fake('anthropic', 'anthropic'), fake('codex-cli', 'openai')];
  const mixed = await resolveProviders('mixed', { available });
  assert.deepEqual(mixed.map((s) => s.provider.id), ['claude-cli', 'codex-cli']);
  const auto = await resolveProviders('auto', { available });
  assert.equal(auto[0].provider.id, 'claude-cli');
  const pinned = await resolveProviders('codex-cli:gpt-5-mini,agy-cli', { available });
  assert.equal(pinned[0].model, 'gpt-5-mini');
  assert.equal(pinned[1].provider.id, 'agy-cli');
  await assert.rejects(resolveProviders('nope', { available }), /Unknown provider/);
});

test('swarmSearch runs plan → workers → synthesis with a fake provider', async () => {
  const calls = [];
  const fakeProvider = {
    id: 'fake',
    family: 'fake',
    defaultModel: 'fake-1',
    detect: () => true,
    async complete({ system, prompt }) {
      calls.push(system.slice(0, 20));
      if (system.startsWith('You split')) return { text: '["angle one","angle two"]' };
      if (system.startsWith('You are one worker')) return { text: `## Findings\n- fact about ${prompt.split('sub-question: ')[1]} (https://x)` };
      return { text: `ANSWER built from:\n${prompt}` };
    },
  };
  const { byId } = await import('../src/providers/index.mjs');
  byId.fake = fakeProvider;
  try {
    const { markdown, report } = await swarmSearch({ query: 'test question', provider: 'fake', workers: 2 });
    assert.equal(report.workers.length, 2);
    assert.ok(report.workers.every((w) => w.ok));
    assert.match(markdown, /ANSWER built from/);
    assert.match(markdown, /angle one/);
    assert.match(markdown, /swarm-search · mode: web · workers: 2/);
    assert.equal(calls.filter((c) => c.startsWith('You are one worker')).length, 2);
  } finally {
    delete byId.fake;
  }
});

test('MCP handleMessage: initialize, tools/list, unknown method, notification', async () => {
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'swarm-search');
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  const unknown = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope' });
  assert.equal(unknown.error.code, -32601);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const bad = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'missing' } });
  assert.equal(bad.error.code, -32602);
  const batch = await handleMessage([{ jsonrpc: '2.0', id: 5, method: 'ping' }]);
  assert.equal(batch.error.code, -32600);
});

test('MCP: notifications/cancelled aborts a running tools/call', async () => {
  const { byId } = await import('../src/providers/index.mjs');
  byId.slow = {
    id: 'slow', family: 'slow', defaultModel: 'm', detect: () => true,
    complete: ({ signal }) => new Promise((_, reject) => {
      const onAbort = () => reject(new Error('aborted by signal'));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  };
  try {
    const session = createSession();
    const pending = handleMessage(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'swarm_search', arguments: { query: 'q', provider: 'slow', angles: ['a'] } } },
      session,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(session.inflight.size, 1);
    await handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }, session);
    const res = await pending;
    assert.equal(res.error.code, -32800);
    assert.equal(session.inflight.size, 0);
  } finally {
    delete byId.slow;
  }
});

test('HTTP origin check: loopback and allowlist only', () => {
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed('http://localhost:3000'), true);
  assert.equal(originAllowed('http://127.0.0.1'), true);
  assert.equal(originAllowed('https://evil.example'), false);
  assert.equal(originAllowed('https://chatgpt.com', ['https://chatgpt.com']), true);
  assert.equal(originAllowed('not a url'), false);
});

test('MCP stdio server answers a real handshake', async () => {
  const child = spawn(process.execPath, [join(root, 'bin', 'swarm-search.mjs'), 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  await new Promise((resolve) => {
    const check = () => (out.split('\n').filter(Boolean).length >= 2 ? resolve() : setTimeout(check, 20));
    check();
  });
  child.kill();
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].id, 1);
  assert.equal(lines[1].result.tools[0].name, 'swarm_search');
});
