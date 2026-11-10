import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { arcodexCli as cx, arclaudeCli as cl } from '../src/providers/agentrouter-cli.mjs';
import { ProviderError, mergeSystem, runProcess } from '../src/providers/base.mjs';
import { agyCli as ag } from '../src/providers/agy-cli.mjs';
import { claudeCli as cd } from '../src/providers/claude-cli.mjs';
import { swarmSearch as ss, isRetryable } from '../src/swarm.mjs';
import { callTool, TOOLS, UNTRUSTED_NOTE } from '../src/mcp.mjs';
import { tmp, fixture, mockAvail, mockFail, testFallback, checkFallback, mockAgyFindings, assertRouterFallback, checkErr, okAns, waf, writeServer } from './helpers.mjs';

test('AgentRouter builds read-only commands with prompt in argv and web disabled for files', () => {
  const p = 'q', c = cx.buildArgs({ model: 'm', system: 'S', prompt: p, web: false, outFile: '/tmp/o' });
  assert.deepEqual([c[0], c.includes('--ephemeral'), c.includes('read-only'), c[c.indexOf('-m') + 1], c[c.indexOf('-o') + 1], c.includes('web_search="disabled"'), c.slice(-2)],
    ['exec', true, true, 'm', '/tmp/o', true, ['--', mergeSystem('S', p)]]);
  const web = cx.buildArgs({ model: '', prompt: 'P', web: true, outFile: '/tmp/o' });
  assert.ok(web.includes('web_search="live"') && !web.includes('-m'));
  const k = cl.buildArgs({ model: 'sonnet', system: 'S', prompt: p, web: false });
  assert.deepEqual([k[0], k[k.indexOf('--model') + 1], k[k.indexOf('--output-format') + 1], k[k.indexOf('--tools') + 1], k[k.indexOf('--system-prompt') + 1], k.slice(-2)],
    ['-p', 'sonnet', 'json', '', 'S', ['--', p]]);
  assert.ok(cl.buildArgs({ model: 'haiku', prompt: 'P', web: true }).includes('--allowedTools'));
});

test('AgentRouter keeps configured default instead of bare CLI model pins', async (t) => {
  for (const n of ['SWARM_ARCODEX_MODEL', 'SWARM_ARCLAUDE_MODEL']) { const p = process.env[n]; delete process.env[n]; t.after(() => { p ? process.env[n] = p : delete process.env[n]; }); }
  const { arcodexCli: c, arclaudeCli: l } = await import('../src/providers/agentrouter-cli.mjs?defaults');
  assert.equal(c.defaultModel, ''); assert.equal(l.defaultModel, '');
  assert.ok(!c.buildArgs({ model: '', prompt: 'P', outFile: '/tmp/o' }).includes('-m'));
  assert.ok(!l.buildArgs({ model: '', prompt: 'P' }).includes('--model'));
});

for (const [name, prov, other, script, checkRes, checkArgs] of [
  ['arcodex', cx, cl, (l) => `fs.writeFileSync('${l}',JSON.stringify([a.slice(2),fs.readFileSync(0,'utf8')]));fs.writeFileSync(a[a.indexOf('-o')+1],' ANSWER\\n');process.stderr.write('Reconnecting... 1/5\\n');`,
   (res) => assert.equal(res.text, 'ANSWER'), (a) => { assert.equal(a.at(-1), mergeSystem('S', 'P')); assert.ok(a.includes('web_search="disabled"')); }],
  ['arclaude', cl, cx, (l) => `fs.writeFileSync('${l}',JSON.stringify([a.slice(2),fs.readFileSync(0,'utf8')]));process.stdout.write(JSON.stringify({result:'ANSWER',usage:{input_tokens:3,cache_read_input_tokens:7,output_tokens:2},total_cost_usd:0}));`,
   (res) => assert.deepEqual(res, { text: 'ANSWER', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0 } }), (a) => { assert.equal(a.at(-1), 'P'); assert.equal(a[a.indexOf('--system-prompt') + 1], 'S'); }],
]) {
  test(`${name} wrapper detection, parsing and empty stdin`, async (t) => {
    const dir = await tmp(t, 'w-'), log = join(dir, 'seen.json');
    await fixture(t, name, `import fs from 'node:fs';const a=process.argv;${script(log)}`);
    assert.equal(await prov.detect(), true); assert.equal(await other.detect(), false);
    const res = await prov.complete({ system: 'S', prompt: 'P', model: 'm', timeoutMs: 5000 });
    checkRes(res);
    const [a, i] = JSON.parse(await readFile(log, 'utf8'));
    assert.equal(i, ''); checkArgs(a);
  });
}

for (const [name, prov, k1, k2] of [['arcodex', cx, 'OPENAI_API_KEY', 'OPENAI_BASE_URL'], ['arclaude', cl, 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']]) {
  test(`${name} inherits credentials and URL from environment`, async (t) => {
    const vals = { AGENTROUTER_POOL_TOKEN: 'token', [k1]: 'key', [k2]: 'http://127.0.0.1/u' };
    for (const [k, v] of Object.entries(vals)) { const p = process.env[k]; process.env[k] = v; t.after(() => { p ? process.env[k] = p : delete process.env[k]; }); }
    const dir = await tmp(t, 'e-'), log = join(dir, 'env.json');
    await fixture(t, name, `import fs from 'node:fs';const a=process.argv;fs.writeFileSync('${log}',JSON.stringify({AGENTROUTER_POOL_TOKEN:process.env.AGENTROUTER_POOL_TOKEN,${k1}:process.env.${k1},${k2}:process.env.${k2}}));if(a.includes('-o'))fs.writeFileSync(a[a.indexOf('-o')+1],'ANSWER');else process.stdout.write(JSON.stringify({result:'ANSWER'}));`);
    const res = await prov.complete({ prompt: 'P', timeoutMs: 5000 });
    assert.equal(res.text, 'ANSWER'); assert.deepEqual(JSON.parse(await readFile(log, 'utf8')), vals);
  });
}

for (const [name, prov, script, check] of [
  ...['arcodex', 'arclaude'].flatMap(n => [
    ['rate limit exceeded', 429, /rate limit/i, 1, 'stderr'],
    ['Reconnecting... 5/5', 503, /network/i, 1, 'stderr'],
    ['fetch failed: ECONNRESET', 503, /network/i, 1, 'stderr'],
    [waf, 503, /WAF|captcha|HTML/i, 0, 'stdout'],
    [waf, 503, /WAF|captcha|HTML/i, 1, 'stdout'],
  ].map(([b, st, re, code, io]) => [
    `${n} retryable error ${b === waf ? `on WAF banner (exit ${code})` : `for ${b}`}`,
    n === 'arcodex' ? cx : cl, `process.${io}.write(${JSON.stringify(b)});process.exit(${code});`, (e) => checkErr(e, n + '-cli', st, re),
  ])),
  ['arcodex network error on exit zero without answer', cx, `process.stdout.write('Reconnecting... 5/5');`, (e) => e.status === 503 && /AgentRouter.*network/i.test(e.message)],
  ['arcodex rejects WAF page saved in outFile', cx, `import fs from 'node:fs';fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],${JSON.stringify(waf)});`, (e) => /WAF|captcha|HTML/i.test(e.message) && isRetryable(e)],
]) {
  test(name, async (t) => {
    await fixture(t, prov === cx ? 'arcodex' : 'arclaude', script);
    await assert.rejects(prov.complete({ prompt: 'P', timeoutMs: 5000 }), check);
  });
}

test('arclaude JSON rate limit and parse errors', async (t) => {
  const dir = await fixture(t, 'arclaude', `process.stdout.write(JSON.stringify({is_error:true,result:'rate limit exceeded'}));`);
  await assert.rejects(cl.complete({ prompt: 'P', timeoutMs: 5000 }), (err) => err.status === 429 && isRetryable(err));
  await writeFile(join(dir, 'arclaude'), `#!${process.execPath}\nprocess.stdout.write('bad');`, { mode: 0o755 });
  await assert.rejects(cl.complete({ prompt: 'P', timeoutMs: 5000 }), (err) => /could not parse JSON/.test(err.message) && !isRetryable(err));
});

for (const d of ['rate limit exceeded', 'Reconnecting... 5/5', 'fetch failed: ECONNRESET']) {
  test(`auto falls back from AgentRouter to agy after ${d}`, async (t) => {
    assertRouterFallback(await testFallback(t, { script: `process.stderr.write(${JSON.stringify(d)});process.exit(1);`, setup: mockAgyFindings }));
  });
}

for (const [name, bin, script, avail, setup, check] of [
  ['auto falls back on AgentRouter WAF response', 'arcodex', `process.stdout.write(${JSON.stringify(waf)});`, ['arcodex-cli', 'arclaude-cli', 'agy-cli', 'claude-cli'],
   (t) => { mockFail(t, cl, cd); t.mock.method(ag, 'complete', async () => okAns()); },
   ({ report, msgs }) => { checkFallback(report, 'agy-cli', 'arcodex-cli'); assert.ok(msgs.some(m => /AgentRouter.*WAF.*retrying on agy-cli/i.test(m))); }],
  ['auto follows default chain to claude when both AgentRouter and agy fail', 'arcodex', `process.stderr.write('rate limit exceeded');process.exit(1);`, ['arcodex-cli', 'agy-cli', 'claude-cli'],
   (t) => ({ agy: t.mock.method(ag, 'complete', async () => { throw new ProviderError('agy: 429', { status: 429 }); }), claude: t.mock.method(cd, 'complete', async () => okAns()) }),
   ({ report, agy, claude }) => { checkFallback(report, 'claude-cli', 'arcodex-cli'); assert.equal(agy.mock.callCount(), 2); assert.equal(claude.mock.callCount(), 2); }],
  ['auto falls back from arclaude to agy when arcodex absent', 'arclaude', `process.stderr.write('fetch failed: ECONNRESET');process.exit(1);`, ['arclaude-cli', 'agy-cli', 'claude-cli'],
   (t) => { mockFail(t, cd); return { agy: t.mock.method(ag, 'complete', async () => okAns()) }; },
   ({ report, agy }) => { checkFallback(report, 'agy-cli', 'arclaude-cli'); assert.equal(agy.mock.callCount(), 2); }],
]) {
  test(name, async (t) => check(await testFallback(t, { bin, script, avail, setup })));
}

test('files fallback skips agy and keeps web disabled', async (t) => {
  const dir = await fixture(t, 'arcodex', `process.stderr.write('rate limit exceeded');process.exit(1);`);
  await writeServer(dir); mockAvail(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
  t.mock.method(ag, 'complete', () => assert.fail('files fallback'));
  const calls = []; t.mock.method(cd, 'complete', async ({ web }) => { calls.push(web); return { text: 'Port 8787 (s.mjs:1)' }; });
  const { report } = await ss({ query: 'port?', paths: [join(dir, 's.mjs')], workers: 1, rank: 'off' });
  checkFallback(report, 'claude-cli', 'arcodex-cli'); assert.deepEqual(calls, [false, false]);
});

test('healthy auto workers all use AgentRouter', async (t) => {
  mockAvail(t, ['arcodex-cli', 'agy-cli', 'claude-cli']); t.mock.method(cx, 'complete', async () => okAns()); mockFail(t, ag, cd);
  const { report } = await ss({ query: 'q', angles: ['a', 'b', 'c'] });
  assert.ok(report.workers.every(w => w.provider === 'arcodex-cli')); assert.equal(report.retried, 0);
});

for (const [title, pfx, ans, chk] of [
  ['auto retries failed AgentRouter planner', 'You split', '["angle one", "angle two"]',
   ({ report, pl }) => {
     assert.deepEqual(report.workers.map(w => w.label), ['angle one', 'angle two']);
     assert.ok(report.workers.every(w => w.provider === 'arcodex-cli' && w.ok));
     assert.equal(pl.mock.callCount(), 1); assert.equal(report.synthesis.provider, 'arcodex-cli');
   }],
  ['auto retries gap audit and keeps model overrides', 'You audit', '{"followups": ["verify"]}',
   ({ report, pl }) => {
     assert.equal(pl.mock.callCount(), 1); assert.equal(report.round2.length, 1);
     assert.match(report.round2[0].label, /verify/); assert.equal(report.round2[0].provider, 'arcodex-cli');
     assert.deepEqual(report.synthesis, { provider: 'arcodex-cli', model: 's-mod' });
   }],
]) {
  test(title, async (t) => {
    mockAvail(t, ['arcodex-cli', 'agy-cli', 'claude-cli']);
    t.mock.method(cx, 'complete', async ({ system, model }) => {
      if (system.startsWith(pfx)) throw new ProviderError('net fail', { status: 503 });
      if (title.includes('gap')) assert.equal(model, system.startsWith('You are the synthesizer') ? 's-mod' : 'w-mod');
      return okAns();
    });
    const pl = t.mock.method(ag, 'complete', async ({ system, model, web }) => {
      assert.ok(system.startsWith(pfx)); assert.equal(web, false);
      if (title.includes('gap')) assert.equal(model, 's-mod');
      return { text: ans };
    });
    mockFail(t, cd);
    const opts = title.includes('planner') ? { query: 'q', workers: 2 } : { query: 'q', angles: ['a'], rounds: 2, round2: 'gaps', model: 'w-mod', synthModel: 's-mod' };
    const { report } = await ss(opts);
    chk({ report, pl });
  });
}

test('AgentRouter cancellation stops without falling back', async (t) => {
  await fixture(t, 'arcodex', `setInterval(()=>{},1000);`); mockAvail(t, ['arcodex-cli', 'agy-cli']); mockFail(t, ag);
  const c = new AbortController(), tm = setTimeout(() => c.abort(), 30); t.after(() => clearTimeout(tm));
  await assert.rejects(ss({ query: 'q', angles: ['a'], signal: c.signal }), /cancelled/);
});

test('CLI retains files flags and JSON report with AgentRouter', async (t) => {
  const dir = await fixture(t, 'arcodex', `import fs from 'node:fs';fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'Port 8787 (s.mjs:1)');`);
  const path = await writeServer(dir);
  const { stdout } = await runProcess(process.execPath, ['bin/swarm-search.mjs', 'run', 'port?', '--mode', 'files', '--paths', path, '--workers', '1', '--rank', 'off', '--json'], {
    timeoutMs: 5000, env: { SWARM_PROVIDER: 'auto', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENROUTER_API_KEY: '' },
  });
  const res = JSON.parse(stdout);
  assert.deepEqual(Object.keys(res).sort(), ['markdown', 'report']);
  assert.equal(res.report.mode, 'files'); assert.equal(res.report.workers[0].provider, 'arcodex-cli'); assert.match(res.markdown, /_swarm-search · mode: files/);
});

test('MCP keeps tool names, args and output with AgentRouter', async (t) => {
  mockAvail(t, ['arclaude-cli']); t.mock.method(cl, 'complete', async () => okAns());
  assert.deepEqual(TOOLS.map(t => t.name), ['swarm_search', 'swarm_providers']);
  assert.match(TOOLS[0].inputSchema.properties.provider.description, /arcodex-cli.*arclaude-cli/);
  const res = await callTool('swarm_search', { query: 'q', angles: ['a'], provider: 'arclaude-cli:sonnet', synth_provider: 'arclaude-cli:haiku' });
  assert.equal(res.content[0].type, 'text'); assert.ok(res.content[0].text.startsWith(UNTRUSTED_NOTE)); assert.match(res.content[0].text, /synthesis: arclaude-cli:haiku/);
});
