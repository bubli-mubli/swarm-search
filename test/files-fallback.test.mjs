import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runProcess } from '../src/providers/base.mjs';
import { TOOLS } from '../src/mcp.mjs';

const cli = fileURLToPath(new URL('../bin/swarm-search.mjs', import.meta.url));
const authFailure = 'process.stderr.write("Login required\\n"); process.exit(1);';

async function fixture(t, behaviors = {}) {
  const scratch = fileURLToPath(new URL('../.scratch/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'fallback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'server.mjs');
  const log = join(dir, 'calls.jsonl');
  await writeFile(path, 'const port = 8787;\n');
  for (const id of ['claude', 'codex', 'gemini', 'agy']) {
    if (behaviors[id] === null) continue;
    await writeFile(join(dir, id), `#!${process.execPath}
import fs from 'node:fs';
const id = ${JSON.stringify(id)};
const args = process.argv.slice(2);
let input = ''; for await (const chunk of process.stdin) input += chunk;
const system = id === 'claude' ? args[args.indexOf('--system-prompt') + 1] : input;
const stage = system.includes('You are the synthesizer') ? 'synthesis' : system.includes('You audit') ? 'audit' : 'worker';
fs.appendFileSync(${JSON.stringify(log)}, id + '\\n');
if (!input.includes('8787')) throw new Error('missing corpus/answer on stdin');
if (id === 'agy') throw new Error('files must never invoke agy');
${behaviors[id] || ''}
const text = stage === 'audit' ? '{"followups": []}' : 'Port 8787 (server.mjs:1)';
if (id === 'codex') fs.writeFileSync(args[args.indexOf('-o') + 1], text);
else process.stdout.write(JSON.stringify(id === 'claude' ? { result: text } : { response: text }));
`, { mode: 0o755 });
  }
  const options = { timeoutMs: 10000, env: {
    PATH: dir, TMPDIR: dir, SWARM_PROVIDER: '',
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENROUTER_API_KEY: '',
  } };
  return {
    dir,
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n'),
    run: (extra = []) => runProcess(process.execPath, [cli, 'run', 'port?', '--mode', 'files', '--paths', path,
      '--workers', '1', '--rounds', '1', '--rank', 'off', '--json', ...extra], options),
    tool: (context) => runProcess(process.execPath, ['--input-type=module', '-e',
      `import { callTool } from ${JSON.stringify(new URL('../src/mcp.mjs', import.meta.url).href)};
console.log(JSON.stringify(await callTool('swarm_search', ${JSON.stringify({ query: 'port?', mode: 'files', paths: [path] })}, ${JSON.stringify(context)})));`,
    ], options),
  };
}

for (const stage of ['worker', 'missing binary', 'audit', 'synthesis']) {
  test(`files CLI fallback: ${stage}`, async (t) => {
    const missing = stage === 'missing binary';
    const f = await fixture(t, { claude: missing ? null : `if (stage === '${stage}') { ${authFailure} }` });
    const extra = missing ? ['--provider', 'claude-cli:missing-model'] : stage === 'audit' ? ['--rounds', '2'] : [];
    const { report, markdown } = JSON.parse((await f.run(extra)).stdout);
    const failure = report.providerAttempts.find((a) => !a.ok);
    assert.equal(failure.provider, 'claude-cli');
    assert.match(failure.error + (failure.stderr || ''), missing ? /ENOENT/ : /Login required\n/);
    assert.match(markdown, missing ? /ENOENT/ : /Login required/);
    assert.match(markdown, /_swarm-search · mode: files/);
    assert.equal(report.synthesis.provider, 'codex-cli');
    assert.ok(report.synthesis.model && report.synthesis.model !== 'missing-model');
    if (stage === 'worker') {
      assert.equal(report.workers[0].retriedFrom, 'claude-cli');
      assert.deepEqual(await f.calls(), ['claude', 'codex', 'codex']);
    }
  });
}

test('files fallback: all providers fail once with raw reasons', async (t) => {
  const f = await fixture(t, {
    claude: authFailure,
    codex: 'process.stderr.write("HTTP 429 quota exhausted\\n"); process.exit(2);',
    gemini: 'process.stdout.write(JSON.stringify({error: {message: "credentials expired"}})); process.exit(0);',
  });
  await assert.rejects(f.run(['--provider', 'claude-cli,claude-cli:other']), (err) => {
    assert.match(err.stderr, /files mode: all offline providers failed/);
    for (const reason of ['claude-cli', 'Login required', 'codex-cli', 'HTTP 429 quota exhausted', 'gemini-cli', 'credentials expired']) {
      assert.ok(err.stderr.includes(reason), reason);
    }
    return true;
  });
  assert.deepEqual(await f.calls(), ['claude', 'codex', 'gemini']);
});

test('MCP provider stays optional; remote fallback excludes disk access', async (t) => {
  const schema = TOOLS.find((tool) => tool.name === 'swarm_search').inputSchema;
  assert.equal(schema.properties.provider.type, 'string');
  assert.ok(!schema.required.includes('provider'));
  const f = await fixture(t, { claude: authFailure });
  await assert.rejects(f.tool({ remote: true, filesRoots: [f.dir] }), /exited with code/);
  assert.deepEqual(await f.calls(), ['claude']);
});
