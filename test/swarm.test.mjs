import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAngles, fallbackAngles, runPool, swarmSearch, parseFollowups, resolveWorkers, summarizeUsage, usageLine, verifySources, filterRetractions, isRetryable, extractRefs, DEFAULTS } from '../src/swarm.mjs';
import { collectFiles, buildShards, isSecretFile, rankFiles, tokenize } from '../src/corpus.mjs';
import { ProviderError } from '../src/providers/base.mjs';
import { runBench, scoreAnswer, loadQuestions, answerBody } from '../bench/bench.mjs';
import { handleMessage, TOOLS, createSession, originAllowed, serveHttp, callTool, UNTRUSTED_NOTE } from '../src/mcp.mjs';
import { resolveProviders } from '../src/providers/index.mjs';
import { stripTomlBlock } from '../src/install.mjs';
import { claudeCli, claudeUsage } from '../src/providers/claude-cli.mjs';
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

test('parseFollowups extracts followups object, tolerates junk', () => {
  assert.deepEqual(parseFollowups('ok:\n{"followups": ["a", " b "]}', 4), ['a', 'b']);
  assert.deepEqual(parseFollowups('{"followups": []}', 4), []);
  assert.deepEqual(parseFollowups('nothing', 4), []);
  assert.deepEqual(parseFollowups('{"followups": ["a","b","c"]}', 2), ['a', 'b']);
});

test('resolveWorkers: auto by default, number when given, capped', () => {
  assert.equal(resolveWorkers(undefined), null);
  assert.equal(resolveWorkers('auto'), null);
  assert.equal(resolveWorkers(3), 3);
  assert.equal(resolveWorkers('5'), 5);
  assert.equal(resolveWorkers(99), 12);
  assert.equal(resolveWorkers(0), null);
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
  assert.equal(o.max_tokens, 8000);
  assert.ok(o.usage.include);

  // Лёгкая обвязка claude-cli: без MCP, скиллов и user settings.
  assert.ok(c.includes('--strict-mcp-config') && c.includes('--disable-slash-commands'));
  assert.equal(c[c.indexOf('--setting-sources') + 1], '');
  // agy в headless не должен молча отклонять read_url.
  assert.ok(g.includes('--dangerously-skip-permissions') && g.includes('--sandbox'));
});

test('providers: without web the CLIs get no network tools', async () => {
  const { geminiCli, NO_WEB_POLICY } = await import('../src/providers/gemini-cli.mjs');
  const g = agyCli.buildArgs({ model: 'm', timeoutMs: 60_000, prompt: 'p', web: false });
  assert.ok(!g.includes('--dangerously-skip-permissions') && g.includes('plan'));
  assert.ok(agyCli.webAlwaysOn);

  const gm = geminiCli.buildArgs({ model: 'm', policyFile: '/tmp/no-web.toml' });
  assert.equal(gm[gm.indexOf('--policy') + 1], '/tmp/no-web.toml');
  assert.ok(!geminiCli.buildArgs({ model: 'm' }).includes('--policy'));
  assert.match(NO_WEB_POLICY, /toolName = "google_web_search"\ndecision = "deny"/);
  assert.match(NO_WEB_POLICY, /toolName = "web_fetch"/);

  const x = codexCli.buildArgs({ model: 'm', web: false, outFile: '/tmp/o' });
  assert.ok(x.includes('web_search="disabled"') && !x.includes('web_search="live"'));
});

test('swarmSearch files mode skips providers whose web cannot be disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-offline-'));
  const { byId } = await import('../src/providers/index.mjs');
  const used = [];
  const make = (id, webAlwaysOn) => ({
    id,
    family: id,
    defaultModel: 'm',
    webAlwaysOn,
    detect: () => true,
    async complete({ system }) {
      used.push(id);
      return { text: system.startsWith('You are one worker') ? '## Findings\n- x (a.txt:1)' : 'SYNTH' };
    },
  });
  byId.leaky = make('leaky', true);
  byId.offline = make('offline', false);
  try {
    await writeFile(join(dir, 'a.txt'), 'hello');
    await swarmSearch({ query: 'q', paths: [dir], provider: 'leaky,offline' });
    assert.ok(used.length && used.every((id) => id === 'offline'));
    await assert.rejects(swarmSearch({ query: 'q', paths: [dir], provider: 'leaky' }), /cannot run without web access/);
  } finally {
    delete byId.leaky;
    delete byId.offline;
    await rm(dir, { recursive: true, force: true });
  }
});

test('corpus: secrets are dropped even when named explicitly, roots block escapes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-secrets-'));
  const outside = await mkdtemp(join(tmpdir(), 'swarm-outside-'));
  try {
    for (const name of ['.env', '.env.local', 'server.pem', 'tls.key', 'id_rsa', 'credentials.json', 'my-service-account.json', 'ok.txt', '.env.example']) {
      await writeFile(join(dir, name), 'SECRET=1');
    }
    assert.ok(isSecretFile('.env.production') && isSecretFile('id_ed25519.pub') && !isSecretFile('.env.example') && !isSecretFile('index.js'));
    for (const name of ['.npmrc', '.netrc', '.git-credentials', '.pgpass', '.pypirc', 'secrets.json', 'terraform.tfstate', 'a.p12', 'b.pfx', 'kubeconfig', '/h/.docker/config.json', '/h/.aws/credentials']) {
      assert.ok(isSecretFile(name), name);
    }
    // Обычные исходники с «credentials» в имени — не секреты.
    assert.ok(!isSecretFile('src/credentials.ts') && !isSecretFile('credentials.md') && !isSecretFile('x/config.json'));
    const walked = await collectFiles([dir]);
    assert.deepEqual(walked.map((f) => f.path.split('/').pop()).sort(), ['.env.example', 'ok.txt']);
    const explicit = await collectFiles(['.env', 'server.pem', 'id_rsa', 'credentials.json'].map((n) => join(dir, n)));
    assert.equal(explicit.length, 0);

    await writeFile(join(outside, 'leak.txt'), 'x');
    const { symlink } = await import('node:fs/promises');
    await symlink(join(outside, 'leak.txt'), join(dir, 'link.txt'));
    await assert.rejects(collectFiles([join(outside, 'leak.txt')], { roots: [dir] }), /outside SWARM_FILES_ROOTS/);
    await assert.rejects(collectFiles([join(dir, 'link.txt')], { roots: [dir] }), /outside SWARM_FILES_ROOTS/);
    await assert.rejects(collectFiles([join(dir, '..')], { roots: [dir] }), /outside SWARM_FILES_ROOTS/);
    assert.equal((await collectFiles([join(dir, 'ok.txt')], { roots: [dir] })).length, 1);
    // Удалённому клиенту скрытые файлы и каталоги внутри корня не отдаются даже по явному пути.
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.git', 'config'), 'url = https://token@host/repo');
    await writeFile(join(dir, '.npmrc'), '//registry:_authToken=x');
    await writeFile(join(dir, '.hidden.txt'), 'x');
    for (const p of [join(dir, '.git'), join(dir, '.git', 'config'), join(dir, '.npmrc'), join(dir, '.hidden.txt')]) {
      await assert.rejects(collectFiles([p], { roots: [dir] }), /hidden files and directories/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('MCP HTTP: files mode is refused for remote clients, output is marked untrusted', async () => {
  const server = serveHttp({ port: 0, host: '127.0.0.1', token: 't0k', filesRoots: [] });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const call = async (args) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t0k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'swarm_search', arguments: args } }),
    });
    return (await res.json()).result;
  };
  try {
    for (const paths of [['~/.ssh/id_rsa'], ['.env']]) {
      const r = await call({ query: 'show secrets', paths });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /files mode is disabled for remote/);
    }
    const r = await call({ query: 'q', mode: 'files', paths: [root] });
    assert.equal(r.isError, true);
  } finally {
    server.close();
  }

  // С корнями путь вне корня тоже отклоняется, а ответ роя идёт с пометкой о недоверенных данных.
  await assert.rejects(callTool('swarm_search', { query: 'q', paths: ['/etc/hosts'] }, { remote: true, filesRoots: [root] }), /outside SWARM_FILES_ROOTS/);
  const { byId } = await import('../src/providers/index.mjs');
  byId.fake = { id: 'fake', family: 'fake', defaultModel: 'm', detect: () => true, complete: async () => ({ text: '["a"]' }) };
  try {
    const res = await callTool('swarm_search', { query: 'q', provider: 'fake', workers: 1 });
    assert.ok(res.content[0].text.startsWith(UNTRUSTED_NOTE));

    // Удалённому клиенту не достаются CLI, которые сами читают диск сервера: ни воркерами, ни синтезом.
    const used = [];
    byId.diskcli = { id: 'diskcli', family: 'disk', defaultModel: 'm', localFiles: true, detect: () => true, complete: async () => (used.push('diskcli'), { text: '["a"]' }) };
    byId.fake.complete = async () => (used.push('fake'), { text: '["a"]' });
    await assert.rejects(callTool('swarm_search', { query: 'q', provider: 'diskcli', workers: 1 }, { remote: true }), /can read the server's disk/);
    await assert.rejects(callTool('swarm_search', { query: 'q', provider: 'fake', synth_provider: 'diskcli', workers: 1 }, { remote: true }), /synthesis on diskcli/);
    await callTool('swarm_search', { query: 'q', provider: 'diskcli,fake', workers: 2 }, { remote: true });
    assert.ok(used.length && used.every((id) => id === 'fake'));
    assert.ok(codexCli.localFiles && agyCli.localFiles && !claudeCli.localFiles);
  } finally {
    delete byId.fake;
    delete byId.diskcli;
  }
});

test('usage: claude-cli counts cached context, summary gives cost per useful answer', () => {
  const u = claudeUsage({ usage: { input_tokens: 4, cache_creation_input_tokens: 3000, cache_read_input_tokens: 2000, output_tokens: 50 }, total_cost_usd: 0.02 });
  assert.equal(u.inputTokens, 5004);
  const sum = summarizeUsage([{ usage: u }, { usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 } }, { usage: { inputTokens: 1, outputTokens: 1 } }, {}], 2);
  assert.equal(sum.inputTokens, 5105);
  assert.equal(sum.pricedCalls, 2);
  assert.ok(Math.abs(sum.costUsd - 0.03) < 1e-9);
  // Часть вызовов без цены — цену ответа не выдумываем.
  assert.equal(sum.costPerUsefulUsd, null);
  assert.match(usageLine(sum), /tokens 5\.1k in \/ 61 out · \$0\.030 \(2\/4 calls priced\)_?$/);
  const full = summarizeUsage([{ usage: u }, { usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 } }], 2);
  assert.ok(Math.abs(full.costPerUsefulUsd - 0.015) < 1e-9);
  assert.match(usageLine(full), /\$0\.030 · \$0\.015 per useful answer$/);
  assert.equal(summarizeUsage([{ usage: { inputTokens: 1 } }], 1).costPerUsefulUsd, null);
});

test('resolveProviders parses specs and mixed picks one per family', async () => {
  const fake = (id, family) => ({ id, family, defaultModel: 'm', detect: () => true });
  const available = [fake('claude-cli', 'anthropic'), fake('anthropic', 'anthropic'), fake('codex-cli', 'openai')];
  const mixed = await resolveProviders('mixed', { available });
  assert.deepEqual(mixed.map((s) => s.provider.id), ['claude-cli', 'codex-cli']);
  const auto = await resolveProviders('auto', { available });
  assert.equal(auto[0].provider.id, 'claude-cli');
  // OpenRouter в mixed идёт своей моделью (другое семейство), а не дефолтной.
  const withOr = await resolveProviders('mixed', { available: [...available, { id: 'openrouter', family: 'mixed', mixedModel: 'deepseek/x', detect: () => true }] });
  assert.equal(withOr.at(-1).model, 'deepseek/x');
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
    assert.match(markdown, /swarm-search · mode: web · workers: 2 \(fixed;/);
    assert.match(markdown, /tokens \d+ in/);
    assert.equal(report.usage.calls, 4);
    assert.equal(calls.filter((c) => c.startsWith('You are one worker')).length, 2);
  } finally {
    delete byId.fake;
  }
});

test('swarmSearch auto sizing: planner decides the worker count', async () => {
  const prompts = [];
  const { byId } = await import('../src/providers/index.mjs');
  byId.fake = {
    id: 'fake', family: 'fake', defaultModel: 'm', detect: () => true,
    async complete({ system, prompt }) {
      if (system.startsWith('You split')) {
        prompts.push(prompt);
        return { text: '["only one angle"]' };
      }
      if (system.startsWith('You are one worker')) return { text: '## Findings\n- x (https://x)' };
      return { text: 'ANSWER' };
    },
  };
  try {
    const { report, markdown } = await swarmSearch({ query: 'what is the current Node LTS version', provider: 'fake' });
    assert.equal(report.plannedBy, 'auto');
    assert.equal(report.workers.length, 1);
    assert.match(prompts[0], /from 1 to 8/);
    assert.match(markdown, /workers: 1 \(auto;/);
  } finally {
    delete byId.fake;
  }
});

test('swarmSearch rounds=2 gaps: audit → follow-ups → synthesis sees round 2', async () => {
  const seen = { synth: '' };
  const { byId } = await import('../src/providers/index.mjs');
  byId.fake = {
    id: 'fake', family: 'fake', defaultModel: 'm', detect: () => true,
    async complete({ system, prompt }) {
      if (system.startsWith('You split')) return { text: '["a","b"]' };
      if (system.startsWith('You audit')) return { text: '{"followups": ["resolve conflict about X"]}' };
      if (system.startsWith('You are one worker')) return { text: `## Findings\n- about ${prompt.slice(-30)} (https://x)` };
      seen.synth = prompt;
      return { text: 'ANSWER' };
    },
  };
  try {
    const { report, markdown } = await swarmSearch({ query: 'q', provider: 'fake', rounds: 2 });
    assert.equal(report.round2Mode, 'gaps');
    assert.equal(report.round2.length, 1);
    assert.match(report.round2[0].label, /^follow-up: resolve conflict/);
    assert.match(seen.synth, /## Round 2 \(gap-filling follow-ups\)/);
    assert.match(markdown, /round 2: gaps: 1 follow-ups/);
  } finally {
    delete byId.fake;
  }
});

test('swarmSearch rounds=2 gaps with no gaps skips follow-ups', async () => {
  const { byId } = await import('../src/providers/index.mjs');
  byId.fake = {
    id: 'fake', family: 'fake', defaultModel: 'm', detect: () => true,
    async complete({ system }) {
      if (system.startsWith('You split')) return { text: '["a"]' };
      if (system.startsWith('You audit')) return { text: '{"followups": []}' };
      if (system.startsWith('You are one worker')) return { text: '## Findings\n- x (https://x)' };
      return { text: 'ANSWER' };
    },
  };
  try {
    const { report, markdown } = await swarmSearch({ query: 'q', provider: 'fake', rounds: 2 });
    assert.equal(report.round2.length, 0);
    assert.match(markdown, /round 2: gaps: none found/);
  } finally {
    delete byId.fake;
  }
});

test('swarmSearch rounds=2 critique: each worker sees the others', async () => {
  const critiquePrompts = [];
  const { byId } = await import('../src/providers/index.mjs');
  byId.fake = {
    id: 'fake', family: 'fake', defaultModel: 'm', detect: () => true,
    async complete({ system, prompt }) {
      if (system.startsWith('You split')) return { text: '["a","b","c"]' };
      if (system.startsWith('You are a worker in a research swarm, now in the critique')) {
        critiquePrompts.push(prompt);
        return { text: '## Confirmed\n- ok\n## Disputed\n- none' };
      }
      if (system.startsWith('You are one worker')) return { text: `## Findings\n- from ${prompt.slice(-1)} (https://x)` };
      return { text: 'ANSWER' };
    },
  };
  try {
    const { report, markdown } = await swarmSearch({ query: 'q', provider: 'fake', rounds: 2, round2: 'critique', workers: 3 });
    assert.equal(report.round2.length, 3);
    assert.equal(critiquePrompts.length, 3);
    assert.match(critiquePrompts[0], /## Your first-round report/);
    assert.equal((critiquePrompts[0].match(/### Report [A-Z]/g) || []).length, 2);
    assert.match(markdown, /round 2: critique: 3\/3/);
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

test('stripTomlBlock removes only our block, keeps args with brackets elsewhere intact', () => {
  const cfg = [
    'model = "x"',
    '',
    '[mcp_servers.other]',
    'command = "a"',
    'args = ["b", "c"]',
    '',
    '[mcp_servers.swarm-search]',
    'command = "/old/node"',
    'args = ["/old/swarm-search.mjs","mcp"]',
    'startup_timeout_sec = 30',
    '',
    '[projects."/x"]',
    'trust_level = "trusted"',
  ].join('\n');
  const out = stripTomlBlock(cfg);
  assert.ok(!out.includes('swarm-search'));
  assert.ok(out.includes('args = ["b", "c"]'));
  assert.ok(out.includes('[projects."/x"]\ntrust_level = "trusted"'));
  assert.equal(stripTomlBlock('a = 1\n'), 'a = 1\n');
});

test('synthesis asks for a worker-disagreements block instead of majority vote', async () => {
  const seen = {};
  const { byId } = await import('../src/providers/index.mjs');
  byId.fake = {
    id: 'fake', family: 'fake', defaultModel: 'm1', detect: () => true,
    async complete({ system, prompt }) {
      if (system.startsWith('You split')) return { text: '["a","b"]' };
      if (system.startsWith('You are one worker')) return { text: '## Findings\n- x (https://x)' };
      seen.system = system;
      seen.prompt = prompt;
      return { text: 'ok' };
    },
  };
  try {
    await swarmSearch({ query: 'q', provider: 'fake', workers: 2 });
    assert.match(seen.system, /## Worker disagreements/);
    assert.match(seen.system, /Do NOT settle a conflict by counting workers/);
    // Синтезатор видит модель каждого воркера, чтобы указать её на каждой стороне спора.
    assert.match(seen.prompt, /### Worker 1 \(fake:m1\)/);
  } finally {
    delete byId.fake;
  }
});

test('verifySources: refs must come from worker reports, [n] must match the Sources list', () => {
  const reports = [{ text: '- a (https://real.example/a)\n- b (src/x.mjs:12-14)' }, 'round 2 cites https://r2.example/'];
  const text = [
    'Answer [1] and [2], also [3]; see [1, 4].',
    '',
    '## Sources',
    '1. https://real.example/a.',
    '2. src/x.mjs:12',
    '3. https://invented.example/z',
    '4. [4] https://r2.example/',
    '5. https://real.example/a',
  ].join('\n');
  const { markdown, check } = verifySources(text, reports);
  assert.equal(check.total, 5);
  assert.equal(check.verified, 4);
  assert.deepEqual(check.unverified, [{ n: 3, refs: ['https://invented.example/z'] }]);
  assert.match(markdown, /3\. https:\/\/invented\.example\/z — \*\*source not found in worker reports\*\*/);
  assert.doesNotMatch(markdown, /2\. src\/x\.mjs:12 —/);
  assert.deepEqual(check.unusedRefs, [5]);
  assert.match(markdown, /listed but never cited: \[5\]/);
  const noList = verifySources('Claim [1].', reports);
  assert.equal(noList.check.hasList, false);
  assert.deepEqual(noList.check.missingRefs, [1]);
  assert.match(noList.markdown, /no Sources list; cited but not in Sources: \[1\]/);
  assert.deepEqual(extractRefs('at 10:30 see https://a.b/c, and lib/a.js:3 or Makefile.am:7'), ['https://a.b/c', 'lib/a.js:3', 'Makefile.am:7']);

  // Префикс настоящей ссылки не засчитывается: ни выдуманный номер строки, ни укороченный URL.
  const prefix = verifySources(
    'A [1], B [2], C [3], D [4] and https://ex.com/a in text.\n\n## Sources\n1. src/a.mjs:1\n2. https://ex.com/a\n3. Official Stripe documentation\n4. src/a.mjs:120',
    ['- x (src/a.mjs:120) and (https://ex.com/abc/def)'],
  );
  assert.equal(prefix.check.total, 4);
  assert.equal(prefix.check.verified, 1);
  assert.deepEqual(prefix.check.unverified, [{ n: 1, refs: ['src/a.mjs:1'] }, { n: 2, refs: ['https://ex.com/a'] }, { n: 3, refs: [] }]);
  assert.match(prefix.markdown, /3\. Official Stripe documentation — \*\*no URL or path:line, cannot verify\*\*/);
  // Ссылка прямо в тексте ответа проверяется так же.
  assert.deepEqual(prefix.check.bodyUnverified, ['https://ex.com/a']);
  assert.match(prefix.markdown, /in text\. — \*\*source not found in worker reports\*\*/);
  assert.match(prefix.markdown, /refs in the text not found in worker reports: https:\/\/ex\.com\/a/);
});

test('swarmSearch marks invented sources and counts verified ones in the footer', async () => {
  const { byId } = await import('../src/providers/index.mjs');
  byId.fake = {
    id: 'fake', family: 'fake', defaultModel: 'm', detect: () => true,
    async complete({ system }) {
      if (system.startsWith('You split')) return { text: '["a"]' };
      if (system.startsWith('You are one worker')) return { text: '## Findings\n- x (https://good.example)' };
      return { text: 'X [1], Y [2].\n\n## Sources\n1. https://good.example\n2. https://made-up.example' };
    },
  };
  try {
    const { markdown, report } = await swarmSearch({ query: 'q', provider: 'fake', workers: 1 });
    assert.equal(report.sourceCheck.verified, 1);
    assert.equal(report.sourceCheck.total, 2);
    assert.match(markdown, /made-up\.example — \*\*source not found in worker reports\*\*/);
    assert.match(markdown, /sources traced to worker reports 1\/2/);
  } finally {
    delete byId.fake;
  }
});

test('critique: retractions need a refuting source from another worker', async () => {
  const others = '- price is $5 (https://vendor.example/pricing)\n- uses src/a.mjs:10';
  const text = [
    '## Confirmed', '- ok',
    '## Retracted',
    '- my $4 price, refuted by https://vendor.example/pricing',
    '- my claim about X, others disagree',
    '- old line ref, see src/a.mjs:10',
    '- retracted because of https://not-in-reports.example',
    '## Missing', '- none',
  ].join('\n');
  const f = filterRetractions(text, others);
  assert.equal(f.kept, 2);
  assert.equal(f.dropped, 2);
  assert.doesNotMatch(f.text, /others disagree|not-in-reports/);
  assert.match(f.text, /## Missing\n- none/);
  const none = filterRetractions('## Retracted\n- I give up, majority says so\n', others);
  assert.equal(none.dropped, 1);
  assert.match(none.text, /## Retracted\n- none/);
  assert.equal(filterRetractions('## Retracted\n- none', others).dropped, 0);
  // Отказ на нескольких строках оставляется целиком, «None of my claims.» — не отказ.
  const multi = filterRetractions('## Retracted\n- my claim X is wrong\n  refuted by https://vendor.example/pricing\n- None of my claims.\n- also wrong\n  per https://vendor.example', others);
  assert.deepEqual([multi.kept, multi.dropped], [1, 1]);
  assert.match(multi.text, /- my claim X is wrong\n  refuted by https:\/\/vendor\.example\/pricing/);
  assert.doesNotMatch(multi.text, /None of my claims|also wrong/);

  // В пайплайне синтез видит только обоснованные отказы, а футер — сколько отброшено.
  const seen = {};
  const { byId } = await import('../src/providers/index.mjs');
  byId.fake = {
    id: 'fake', family: 'fake', defaultModel: 'm', detect: () => true,
    async complete({ system, prompt }) {
      if (system.startsWith('You split')) return { text: '["a","b"]' };
      if (system.startsWith('You are a worker in a research swarm, now in the critique')) {
        return { text: '## Retracted\n- dropping my claim (https://w1.example)\n- dropping because everyone else said so' };
      }
      if (system.startsWith('You are one worker')) return { text: `## Findings\n- x (https://w${prompt.endsWith('a') ? 1 : 2}.example)` };
      seen.synth = prompt;
      return { text: 'ANSWER' };
    },
  };
  try {
    const { markdown, report } = await swarmSearch({ query: 'q', provider: 'fake', rounds: 2, round2: 'critique', workers: 2 });
    // Воркер 2 ссылается на отчёт воркера 1 — принято; воркер 1 ссылается на свой же — отброшено.
    assert.deepEqual(report.retractions, { kept: 1, dropped: 3 });
    assert.doesNotMatch(seen.synth, /everyone else said so/);
    assert.match(markdown, /3\/4 retractions without a source dropped/);
  } finally {
    delete byId.fake;
  }
});

test('failover: a failed worker is retried once on another provider of the pool', async () => {
  assert.ok(isRetryable(new ProviderError('x', { status: 402 })));
  assert.ok(isRetryable(new ProviderError('x', { status: 503 })));
  assert.ok(isRetryable(new ProviderError('claude timed out after 180s')));
  assert.ok(isRetryable(new ProviderError('codex exited with code 1', { stderr: 'Rate limit reached' })));
  assert.ok(!isRetryable(new ProviderError('x', { status: 400 })));
  assert.ok(!isRetryable(new Error('could not parse JSON output')));

  const { byId } = await import('../src/providers/index.mjs');
  const calls = [];
  const make = (id, behavior) => ({
    id, family: id, defaultModel: 'm', detect: () => true,
    async complete({ system }) {
      if (system.startsWith('You split')) return { text: '["a","b","c"]' };
      if (system.startsWith('You are one worker')) {
        calls.push(id);
        return behavior();
      }
      return { text: 'ANSWER' };
    },
  });
  byId.broke = make('broke', () => {
    throw new ProviderError('broke: HTTP 429 slow down', { status: 429 });
  });
  byId.empty = make('empty', () => ({ text: '  ' }));
  byId.good = make('good', () => ({ text: '## Findings\n- x (https://x)' }));
  const backoff = DEFAULTS.retryBackoffMs;
  DEFAULTS.retryBackoffMs = 1;
  try {
    const { report, markdown } = await swarmSearch({ query: 'q', provider: 'broke,empty,good', workers: 3 });
    // broke (429) → empty; empty (пустой ответ) → good; good — с первого раза.
    assert.deepEqual(report.workers.map((w) => [w.ok, w.provider, w.retriedFrom]), [
      [true, 'empty', 'broke'],
      [true, 'good', 'empty'],
      [true, 'good', undefined],
    ]);
    assert.equal(report.retried, 2);
    assert.match(markdown, /retried 2/);
    assert.equal(calls.length, 5);

    // Неповторяемая ошибка и пул из одного провайдера — без повтора.
    calls.length = 0;
    byId.bad = make('bad', () => {
      throw new ProviderError('bad: HTTP 400', { status: 400 });
    });
    await assert.rejects(swarmSearch({ query: 'q', provider: 'bad,good', angles: ['a'] }), /All 1 workers returned nothing/);
    await assert.rejects(swarmSearch({ query: 'q', provider: 'broke', angles: ['a'] }), /HTTP 429/);
    assert.deepEqual(calls, ['bad', 'broke']);
  } finally {
    DEFAULTS.retryBackoffMs = backoff;
    for (const id of ['broke', 'empty', 'good', 'bad']) delete byId[id];
  }
});

test('rankFiles: relevant and named files first, budget drops the rest and says how many', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-rank-'));
  try {
    assert.deepEqual(tokenize('validateJwtToken в auth_middleware'), ['validate', 'jwt', 'token', 'auth', 'middleware']);
    await writeFile(join(dir, 'readme.txt'), 'General notes about the project. '.repeat(20));
    await writeFile(join(dir, 'auth.js'), 'function validateJwt(token) { return verifyJwt(token, secret); }\n'.repeat(3));
    await writeFile(join(dir, 'util.js'), 'export const add = (a, b) => a + b;\n'.repeat(10));
    await writeFile(join(dir, 'config.yaml'), 'port: 8080\n');
    const files = await collectFiles([dir]);
    const all = await rankFiles(files, 'where do we validate JWT? also check config.yaml');
    assert.deepEqual(all.files.map((f) => f.path.split('/').pop()).slice(0, 2), ['config.yaml', 'auth.js']);
    assert.equal(all.dropped, 0);
    const cut = await rankFiles(files, 'where do we validate JWT?', { maxChars: 300 });
    assert.equal(cut.files[0].path.split('/').pop(), 'auth.js');
    assert.equal(cut.dropped, files.length - cut.files.length);
    assert.ok(cut.dropped > 0);

    // В пайплайне: шард с релевантным файлом идёт первым, отброшенные файлы видны в футере и в промпте синтеза.
    const prompts = [];
    const { byId } = await import('../src/providers/index.mjs');
    byId.fake = {
      id: 'fake', family: 'fake', defaultModel: 'm', detect: () => true,
      async complete({ system, prompt }) {
        prompts.push(prompt);
        return { text: system.startsWith('You are one worker') ? '## Findings\n- x (auth.js:1)' : 'ANSWER' };
      },
    };
    const rankChars = DEFAULTS.rankChars;
    DEFAULTS.rankChars = 300;
    try {
      const { markdown, report } = await swarmSearch({ query: 'where do we validate JWT?', paths: [dir], provider: 'fake', workers: 1 });
      assert.equal(report.ranking.dropped, cut.dropped);
      assert.match(markdown, new RegExp(`ranked files: ${cut.files.length}/4 kept, ${cut.dropped} dropped`));
      assert.match(prompts[0], /^Query: .*\n\nFiles in your slice:\nauth\.js/);
      assert.match(prompts.at(-1), /files were ranked as least relevant and not read/);
      // off — без ранжирования и без отбрасывания.
      const off = await swarmSearch({ query: 'where do we validate JWT?', paths: [dir], provider: 'fake', workers: 1, rank: 'off' });
      assert.equal(off.report.ranking, null);
    } finally {
      DEFAULTS.rankChars = rankChars;
      delete byId.fake;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bench: question set is well-formed, runner scores facts and cost per success on fakes', async () => {
  const questions = await loadQuestions();
  assert.ok(questions.length >= 10 && questions.length <= 15);
  assert.equal(new Set(questions.map((q) => q.id)).size, questions.length);
  assert.ok(questions.filter((q) => q.mode === 'files').length >= 2);
  assert.ok(questions.every((q) => q.query && q.facts.length && q.facts.every((f) => f.any.length)));

  assert.deepEqual(scoreAnswer('Rust 1.0 shipped in May 2015', [{ any: ['2015'] }, { any: ['Mozilla'] }]), { correct: 1, total: 2 });
  assert.equal(answerBody('Anthropic? no.\n\n---\n_swarm-search · workers on anthropic:x_'), 'Anthropic? no.');

  // Подменный рой: «умный» провайдер отвечает фактами, «глупый» — пусто, «сломанный» падает.
  const answers = { 'rust-1.0': 'In 2015.', 'redis-port': 'Port 6379.' };
  const run = async ({ query, provider }) => {
    if (provider === 'broken') throw new Error('HTTP 402');
    const q = questions.find((x) => x.query === query);
    const text = provider === 'smart' ? answers[q.id] || 'unknown' : '';
    return { markdown: `${text}\n\n---\n_swarm-search · footer 2015 6379_`, report: { usage: { calls: 3, pricedCalls: 3, costUsd: 0.01 }, sourceCheck: { verified: 1, total: 2 } } };
  };
  let t = 0;
  const subset = questions.filter((q) => ['rust-1.0', 'redis-port', 'ipv6-bits'].includes(q.id));
  const res = await runBench({ providers: ['smart', 'dumb', 'broken'], questions: subset, run, now: () => (t += 1000) });
  const [smart, dumb, broken] = res.providers;
  assert.equal(smart.successes, 2);
  assert.ok(Math.abs(smart.accuracy - 2 / 3) < 1e-9);
  assert.ok(Math.abs(smart.costPerSuccessUsd - 0.015) < 1e-9);
  assert.equal(smart.sourcesVerified, 3);
  assert.equal(dumb.nonEmptyRate, 0);
  assert.equal(dumb.accuracy, 0);
  assert.equal(dumb.costPerSuccessUsd, null);
  assert.equal(broken.runs.every((r) => r.error === 'HTTP 402'), true);
  assert.equal(broken.costUsd, null);
  // Упавший прогон мог потратить деньги до ошибки: цена успеха тогда неизвестна.
  let n = 0;
  const flaky = await runBench({ providers: ['smart'], questions: subset.slice(0, 2), run: async (o) => (n++ ? Promise.reject(new Error('HTTP 500')) : run(o)) });
  assert.equal(flaky.providers[0].successes, 1);
  assert.equal(flaky.providers[0].costPerSuccessUsd, null);
  assert.equal(smart.avgSec, 1);

  // Сквозной прогон на фейковом провайдере через настоящий swarmSearch, включая files-вопрос по этому репо.
  const { byId } = await import('../src/providers/index.mjs');
  byId.fake = {
    id: 'fake', family: 'fake', defaultModel: 'm', detect: () => true,
    async complete({ system }) {
      if (system.startsWith('You split')) return { text: '["a"]', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } };
      if (system.startsWith('You are one worker')) return { text: '## Findings\n- 8787 (bin/swarm-search.mjs:1)', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.002 } };
      return { text: 'Default port is 8787 [1].\n\n## Sources\n1. bin/swarm-search.mjs:1', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } };
    },
  };
  try {
    const e2e = await runBench({ providers: ['fake'], questions: questions.filter((q) => ['files-http-port', 'redis-port'].includes(q.id)), workers: 1 });
    const p = e2e.providers[0];
    assert.deepEqual(p.runs.map((r) => [r.id, r.success, r.error]), [['redis-port', false, null], ['files-http-port', true, null]]);
    assert.equal(p.successes, 1);
    assert.ok(Math.abs(p.costPerSuccessUsd - 0.007) < 1e-9);
    assert.equal(p.sourcesVerified, 2);
  } finally {
    delete byId.fake;
  }
});
