import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arcodexCli, arclaudeCli } from '../src/providers/agentrouter-cli.mjs';
import { PROVIDERS } from '../src/providers/index.mjs';
import { ProviderError, mergeSystem, runProcess } from '../src/providers/base.mjs';
import { agyCli } from '../src/providers/agy-cli.mjs';
import { claudeCli } from '../src/providers/claude-cli.mjs';
import { swarmSearch, isRetryable, DEFAULTS } from '../src/swarm.mjs';
import { callTool, TOOLS, UNTRUSTED_NOTE } from '../src/mcp.mjs';

async function fixture(t, name, body) {
  const dir = await mkdtemp(join(tmpdir(), 'a-'));
  await writeFile(join(dir, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  const prev = process.env.PATH; process.env.PATH = dir;
  t.after(async () => { prev ? process.env.PATH = prev : delete process.env.PATH; await rm(dir, { recursive: true, force: true }); });
  return dir;
}

function availableOnly(t, ids) {
  for (const p of PROVIDERS) t.mock.method(p, 'detect', () => ids.includes(p.id));
  const prev = process.env.SWARM_PROVIDER; delete process.env.SWARM_PROVIDER;
  const backoff = DEFAULTS.retryBackoffMs; DEFAULTS.retryBackoffMs = 1;
  t.after(() => { DEFAULTS.retryBackoffMs = backoff; prev ? process.env.SWARM_PROVIDER = prev : delete process.env.SWARM_PROVIDER; });
}

const checkErr = (err, id, status, re) =>
  err instanceof ProviderError && err.provider === id && err.status === status && isRetryable(err) && /AgentRouter/.test(err.message) && re.test(err.message);
const okAns = (text = 'Ans (https://example.org)') => ({ text });
const mockFail = (t, ...providers) => providers.forEach(p => t.mock.method(p, 'complete', () => assert.fail()));

test('AgentRouter builds read-only commands with prompt in argv and web disabled for files', () => {
  const p = 'q', c = arcodexCli.buildArgs({ model: 'm', system: 'S', prompt: p, web: false, outFile: '/tmp/o' });
  assert.deepEqual([c[0], c.includes('--ephemeral'), c.includes('read-only'), c[c.indexOf('-m') + 1], c[c.indexOf('-o') + 1], c.includes('web_search="disabled"'), c.slice(-2)],
    ['exec', true, true, 'm', '/tmp/o', true, ['--', mergeSystem('S', p)]]);
  const web = arcodexCli.buildArgs({ model: '', prompt: 'P', web: true, outFile: '/tmp/o' });
  assert.ok(web.includes('web_search="live"') && !web.includes('-m'));
  const cl = arclaudeCli.buildArgs({ model: 'sonnet', system: 'S', prompt: p, web: false });
  assert.deepEqual([cl[0], cl[cl.indexOf('--model') + 1], cl[cl.indexOf('--output-format') + 1], cl[cl.indexOf('--tools') + 1], cl[cl.indexOf('--system-prompt') + 1], cl.slice(-2)],
    ['-p', 'sonnet', 'json', '', 'S', ['--', p]]);
  assert.ok(arclaudeCli.buildArgs({ model: 'haiku', prompt: 'P', web: true }).includes('--allowedTools'));
});

test('AgentRouter keeps configured default instead of bare CLI model pins', async (t) => {
  for (const n of ['SWARM_ARCODEX_MODEL', 'SWARM_ARCLAUDE_MODEL']) {
    const prev = process.env[n]; delete process.env[n];
    t.after(() => { prev ? process.env[n] = prev : delete process.env[n]; });
  }
  const { arcodexCli: codex, arclaudeCli: claude } = await import('../src/providers/agentrouter-cli.mjs?defaults');
  assert.equal(codex.defaultModel, ''); assert.equal(claude.defaultModel, '');
  assert.ok(!codex.buildArgs({ model: '', prompt: 'P', outFile: '/tmp/o' }).includes('-m'));
  assert.ok(!claude.buildArgs({ model: '', prompt: 'P' }).includes('--model'));
});

test('arcodex wrapper detection, parsing and empty stdin', async (t) => {
  const log = join(tmpdir(), 'seen-c.json');
  t.after(() => rm(log, { force: true }));
  await fixture(t, 'arcodex', `import fs from 'node:fs';let i='';for await(const c of process.stdin)i+=c;
fs.writeFileSync('${log}',JSON.stringify([process.argv.slice(2),i]));
fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],' ANSWER\\n');process.stderr.write('Reconnecting... 1/5\\n');`);
  assert.equal(await arcodexCli.detect(), true);
  assert.equal(await arclaudeCli.detect(), false);
  const res = await arcodexCli.complete({ system: 'S', prompt: 'P', model: 'm', timeoutMs: 5000 });
  assert.equal(res.text, 'ANSWER');
  const [a, i] = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(i, ''); assert.equal(a.at(-1), mergeSystem('S', 'P')); assert.ok(a.includes('web_search="disabled"'));
});

test('arclaude wrapper detection, parsing and empty stdin', async (t) => {
  const log = join(tmpdir(), 'seen-l.json');
  t.after(() => rm(log, { force: true }));
  await fixture(t, 'arclaude', `import fs from 'node:fs';let i='';for await(const c of process.stdin)i+=c;
fs.writeFileSync('${log}',JSON.stringify([process.argv.slice(2),i]));
process.stdout.write(JSON.stringify({result:'ANSWER',usage:{input_tokens:3,cache_read_input_tokens:7,output_tokens:2},total_cost_usd:0}));`);
  assert.equal(await arclaudeCli.detect(), true);
  assert.equal(await arcodexCli.detect(), false);
  const res = await arclaudeCli.complete({ system: 'S', prompt: 'P', model: 'm', timeoutMs: 5000 });
  assert.deepEqual(res, { text: 'ANSWER', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0 } });
  const [a, i] = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(i, ''); assert.equal(a.at(-1), 'P'); assert.equal(a[a.indexOf('--system-prompt') + 1], 'S');
});

for (const [name, provider, k1, k2] of [['arcodex', arcodexCli, 'OPENAI_API_KEY', 'OPENAI_BASE_URL'], ['arclaude', arclaudeCli, 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']]) {
  test(`${name} inherits credentials and URL from environment`, async (t) => {
    const vals = { AGENTROUTER_POOL_TOKEN: 'token', [k1]: 'key', [k2]: 'http://127.0.0.1/u' };
    for (const [k, v] of Object.entries(vals)) {
      const prev = process.env[k]; process.env[k] = v;
      t.after(() => { prev ? process.env[k] = prev : delete process.env[k]; });
    }
    const log = join(tmpdir(), `env-${name}.json`);
    t.after(() => rm(log, { force: true }));
    await fixture(t, name, `import fs from 'node:fs';const a=process.argv.slice(2);
fs.writeFileSync('${log}',JSON.stringify({AGENTROUTER_POOL_TOKEN:process.env.AGENTROUTER_POOL_TOKEN,${k1}:process.env.${k1},${k2}:process.env.${k2}}));
if(a.includes('-o'))fs.writeFileSync(a[a.indexOf('-o')+1],'ANSWER');else process.stdout.write(JSON.stringify({result:'ANSWER'}));`);
    const res = await provider.complete({ prompt: 'P', timeoutMs: 5000 });
    assert.equal(res.text, 'ANSWER');
    assert.deepEqual(JSON.parse(await readFile(log, 'utf8')), vals);
  });
}

for (const [name, provider] of [['arcodex', arcodexCli], ['arclaude', arclaudeCli]]) {
  for (const [diag, status] of [['rate limit exceeded', 429], ['Reconnecting... 5/5', 503], ['fetch failed: ECONNRESET', 503]]) {
    test(`${name} retryable error for ${diag}`, async (t) => {
      await fixture(t, name, `process.stderr.write(${JSON.stringify(diag)});process.exit(1);`);
      await assert.rejects(provider.complete({ prompt: 'P', timeoutMs: 5000 }), (e) =>
        checkErr(e, provider.id, status, status === 429 ? /rate limit/i : /connection|network/i));
    });
  }
}

test('arcodex network error on exit zero without answer', async (t) => {
  await fixture(t, 'arcodex', `process.stdout.write('Reconnecting... 5/5');`);
  await assert.rejects(arcodexCli.complete({ prompt: 'P', timeoutMs: 5000 }), (err) => err.status === 503 && /AgentRouter.*connection|network/i.test(err.message));
});

test('arclaude JSON rate limit and parse errors', async (t) => {
  const dir = await fixture(t, 'arclaude', `process.stdout.write(JSON.stringify({is_error:true,result:'rate limit exceeded'}));`);
  await assert.rejects(arclaudeCli.complete({ prompt: 'P', timeoutMs: 5000 }), (err) => err.status === 429 && isRetryable(err));
  await writeFile(join(dir, 'arclaude'), `#!${process.execPath}\nprocess.stdout.write('bad');`, { mode: 0o755 });
  await assert.rejects(arclaudeCli.complete({ prompt: 'P', timeoutMs: 5000 }), (err) => /could not parse JSON/.test(err.message) && !isRetryable(err));
});

const waf = '<!doctype html><html><body>Cloudflare captcha challenge</body></html>';
for (const [name, provider] of [['arcodex', arcodexCli], ['arclaude', arclaudeCli]]) {
  for (const code of [0, 1]) {
    test(`${name} retryable error on WAF banner (exit ${code})`, async (t) => {
      await fixture(t, name, `process.stdout.write(${JSON.stringify(waf)});process.exit(${code});`);
      await assert.rejects(provider.complete({ prompt: 'P', timeoutMs: 5000 }), (e) => checkErr(e, provider.id, 503, /WAF|captcha|HTML/i));
    });
  }
}

test('arcodex rejects WAF page saved in outFile', async (t) => {
  await fixture(t, 'arcodex', `import fs from 'node:fs';fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],${JSON.stringify(waf)});`);
  await assert.rejects(arcodexCli.complete({ prompt: 'P', timeoutMs: 5000 }), (err) => /WAF|captcha|HTML/i.test(err.message) && isRetryable(err));
});

test('auto falls back on AgentRouter WAF response', async (t) => {
  await fixture(t, 'arcodex', `process.stdout.write(${JSON.stringify(waf)});`);
  availableOnly(t, ['arcodex-cli', 'arclaude-cli', 'agy-cli', 'claude-cli']);
  mockFail(t, arclaudeCli, claudeCli);
  t.mock.method(agyCli, 'complete', async () => okAns());
  const msgs = [];
  const { report } = await swarmSearch({ query: 'q', angles: ['a'], onProgress: (m) => msgs.push(m) });
  assert.equal(report.workers[0].provider, 'agy-cli');
  assert.equal(report.workers[0].retriedFrom, 'arcodex-cli');
  assert.equal(report.synthesis.provider, 'agy-cli');
  assert.equal(report.retried, 1);
  assert.ok(msgs.some(m => /AgentRouter.*(?:WAF|captcha|HTML).*retrying on agy-cli/i.test(m)));
});

const testRouterFallback = async (t, diag) => {
  await fixture(t, 'arcodex', `process.stderr.write(${JSON.stringify(diag)});process.exit(1);`);
  availableOnly(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
  const used = [];
  t.mock.method(agyCli, 'complete', async ({ system, web }) => {
    used.push([system.startsWith('You are one worker') ? 'w' : 's', web]);
    return okAns('## Findings\n- Ans (https://example.org)');
  });
  mockFail(t, claudeCli);
  const msgs = [];
  const { report, markdown } = await swarmSearch({ query: 'q', angles: ['a', 'b'], onProgress: (m) => msgs.push(m) });
  assert.deepEqual(report.workers.map(w => [w.provider, w.ok, w.retriedFrom]), [['agy-cli', true, 'arcodex-cli'], ['agy-cli', true, 'arcodex-cli']]);
  assert.equal(report.retried, 2);
  assert.equal(report.synthesis.provider, 'agy-cli');
  assert.equal(used.filter(([s]) => s === 'w').length, 2);
  assert.match(markdown, /synthesis: agy-cli:/);
  assert.ok(msgs.some(m => /arcodex-cli failed.*AgentRouter.*retrying on agy-cli/.test(m)));
};

for (const diag of ['rate limit exceeded', 'Reconnecting... 5/5', 'fetch failed: ECONNRESET']) {
  test(`auto falls back from AgentRouter to agy after ${diag}`, (t) => testRouterFallback(t, diag));
}

test('auto follows default chain to claude when both AgentRouter and agy fail', async (t) => {
  await fixture(t, 'arcodex', `process.stderr.write('rate limit exceeded');process.exit(1);`);
  availableOnly(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
  const agy = t.mock.method(agyCli, 'complete', async () => { throw new ProviderError('agy: 429', { status: 429 }); });
  const claude = t.mock.method(claudeCli, 'complete', async () => okAns());
  const { report } = await swarmSearch({ query: 'q', angles: ['a'] });
  assert.equal(report.workers[0].provider, 'claude-cli');
  assert.equal(report.workers[0].retriedFrom, 'arcodex-cli');
  assert.equal(report.synthesis.provider, 'claude-cli');
  assert.equal(agy.mock.callCount(), 2);
  assert.equal(claude.mock.callCount(), 2);
});

test('auto falls back from arclaude to agy when arcodex absent', async (t) => {
  await fixture(t, 'arclaude', `process.stderr.write('fetch failed: ECONNRESET');process.exit(1);`);
  availableOnly(t, ['arclaude-cli', 'agy-cli', 'claude-cli']);
  const agy = t.mock.method(agyCli, 'complete', async () => okAns());
  mockFail(t, claudeCli);
  const { report } = await swarmSearch({ query: 'q', angles: ['a'] });
  assert.equal(report.workers[0].provider, 'agy-cli');
  assert.equal(report.workers[0].retriedFrom, 'arclaude-cli');
  assert.equal(report.synthesis.provider, 'agy-cli');
  assert.equal(report.retried, 1);
  assert.equal(agy.mock.callCount(), 2);
});

test('files fallback skips agy and keeps web disabled', async (t) => {
  const dir = await fixture(t, 'arcodex', `process.stderr.write('rate limit exceeded');process.exit(1);`);
  await writeFile(join(dir, 's.mjs'), 'const port = 8787;\n');
  availableOnly(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
  t.mock.method(agyCli, 'complete', () => assert.fail('files fallback'));
  const calls = [];
  t.mock.method(claudeCli, 'complete', async ({ web }) => { calls.push(web); return { text: 'Port 8787 (s.mjs:1)' }; });
  const { report } = await swarmSearch({ query: 'port?', paths: [join(dir, 's.mjs')], workers: 1, rank: 'off' });
  assert.equal(report.workers[0].provider, 'claude-cli');
  assert.equal(report.workers[0].retriedFrom, 'arcodex-cli');
  assert.equal(report.synthesis.provider, 'claude-cli');
  assert.deepEqual(calls, [false, false]);
});

test('healthy auto workers all use AgentRouter', async (t) => {
  availableOnly(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
  t.mock.method(arcodexCli, 'complete', async () => okAns());
  mockFail(t, agyCli, claudeCli);
  const { report } = await swarmSearch({ query: 'q', angles: ['a', 'b', 'c'] });
  assert.ok(report.workers.every(w => w.provider === 'arcodex-cli'));
  assert.equal(report.retried, 0);
});

test('auto retries failed AgentRouter planner', async (t) => {
  availableOnly(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
  t.mock.method(arcodexCli, 'complete', async ({ system }) => {
    if (system.startsWith('You split')) throw new ProviderError('net fail', { status: 503 });
    return okAns();
  });
  const planner = t.mock.method(agyCli, 'complete', async ({ system, web }) => {
    assert.ok(system.startsWith('You split')); assert.equal(web, false);
    return { text: '["angle one", "angle two"]' };
  });
  mockFail(t, claudeCli);
  const { report } = await swarmSearch({ query: 'q', workers: 2 });
  assert.deepEqual(report.workers.map(w => w.label), ['angle one', 'angle two']);
  assert.ok(report.workers.every(w => w.provider === 'arcodex-cli' && w.ok));
  assert.equal(planner.mock.callCount(), 1);
  assert.equal(report.synthesis.provider, 'arcodex-cli');
});

test('auto retries gap audit and keeps model overrides', async (t) => {
  availableOnly(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
  t.mock.method(arcodexCli, 'complete', async ({ system, model }) => {
    if (system.startsWith('You audit')) throw new ProviderError('net fail', { status: 503 });
    assert.equal(model, system.startsWith('You are the synthesizer') ? 's-mod' : 'w-mod');
    return okAns();
  });
  const audit = t.mock.method(agyCli, 'complete', async ({ system, model, web }) => {
    assert.ok(system.startsWith('You audit')); assert.equal(model, 's-mod'); assert.equal(web, false);
    return { text: '{"followups": ["verify"]}' };
  });
  mockFail(t, claudeCli);
  const { report } = await swarmSearch({ query: 'q', angles: ['a'], rounds: 2, round2: 'gaps', model: 'w-mod', synthModel: 's-mod' });
  assert.equal(audit.mock.callCount(), 1);
  assert.equal(report.round2.length, 1);
  assert.match(report.round2[0].label, /verify/);
  assert.equal(report.round2[0].provider, 'arcodex-cli');
  assert.deepEqual(report.synthesis, { provider: 'arcodex-cli', model: 's-mod' });
});

test('AgentRouter cancellation stops without falling back', async (t) => {
  await fixture(t, 'arcodex', `setInterval(()=>{},1000);`);
  availableOnly(t, ['arcodex-cli', 'agy-cli']);
  mockFail(t, agyCli);
  const c = new AbortController();
  const tm = setTimeout(() => c.abort(), 30);
  t.after(() => clearTimeout(tm));
  await assert.rejects(swarmSearch({ query: 'q', angles: ['a'], signal: c.signal }), /cancelled/);
});

test('CLI retains files flags and JSON report with AgentRouter', async (t) => {
  const dir = await fixture(t, 'arcodex', `import fs from 'node:fs';fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'Port 8787 (s.mjs:1)');`);
  const path = join(dir, 's.mjs');
  await writeFile(path, 'const port = 8787;\n');
  const { stdout } = await runProcess(process.execPath, ['bin/swarm-search.mjs', 'run', 'port?', '--mode', 'files', '--paths', path, '--workers', '1', '--rank', 'off', '--json'], {
    timeoutMs: 5000,
    env: { SWARM_PROVIDER: 'auto', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENROUTER_API_KEY: '' },
  });
  const res = JSON.parse(stdout);
  assert.deepEqual(Object.keys(res).sort(), ['markdown', 'report']);
  assert.equal(res.report.mode, 'files');
  assert.equal(res.report.workers[0].provider, 'arcodex-cli');
  assert.match(res.markdown, /_swarm-search · mode: files/);
});

test('MCP keeps tool names, args and output with AgentRouter', async (t) => {
  availableOnly(t, ['arclaude-cli']);
  t.mock.method(arclaudeCli, 'complete', async () => okAns());
  assert.deepEqual(TOOLS.map(t => t.name), ['swarm_search', 'swarm_providers']);
  assert.match(TOOLS[0].inputSchema.properties.provider.description, /arcodex-cli.*arclaude-cli/);
  const res = await callTool('swarm_search', { query: 'q', angles: ['a'], provider: 'arclaude-cli:sonnet', synth_provider: 'arclaude-cli:haiku' });
  assert.equal(res.content[0].type, 'text');
  assert.ok(res.content[0].text.startsWith(UNTRUSTED_NOTE));
  assert.match(res.content[0].text, /synthesis: arclaude-cli:haiku/);
});
