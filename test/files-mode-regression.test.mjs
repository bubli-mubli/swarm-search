import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

test('files mode auto CLI skips agy-cli when gemini-cli can run without web', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'f-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'server.mjs'), calls = join(dir, 'calls.jsonl');
  await writeFile(file, 'const port = 8787;\n');
  await writeFile(join(dir, 'agy'), `#!${process.execPath}\nprocess.stderr.write('files must not reach agy');process.exitCode=1;\n`, { mode: 0o755 });
  await writeFile(join(dir, 'gemini'), `#!${process.execPath}\nimport fs from 'node:fs';
let input='';for await(const c of process.stdin)input+=c;
const args=process.argv.slice(2),policy=args.includes('--policy')?fs.readFileSync(args[args.indexOf('--policy')+1],'utf8'):'';
fs.appendFileSync(process.env.TASK6_CALLS,JSON.stringify({args,input,policy})+'\\n');
process.stdout.write(JSON.stringify({response:'Port 8787 (server.mjs:1)'}));`, { mode: 0o755 });

  const { stdout } = await exec(process.execPath, [
    'bin/swarm-search.mjs', 'run', 'where is the port set?',
    '--mode', 'files', '--paths', file, '--workers', '1', '--rounds', '1', '--rank', 'off', '--json',
  ], {
    timeout: 10_000,
    env: { ...process.env, PATH: dir, TASK6_CALLS: calls, SWARM_PROVIDER: 'auto', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENROUTER_API_KEY: '' },
  });

  const { markdown, report } = JSON.parse(stdout);
  assert.equal(report.mode, 'files');
  assert.equal(report.workers[0].provider, 'gemini-cli');
  assert.equal(report.workers[0].ok, true);
  assert.equal(report.synthesis.provider, 'gemini-cli');
  assert.match(markdown, /_swarm-search · mode: files/);
  const seen = (await readFile(calls, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(seen.length, 2, 'one worker and one synthesis');
  assert.match(seen[0].input, /const port = 8787/);
  for (const call of seen) {
    assert.match(call.policy, /google_web_search/);
    assert.match(call.policy, /web_fetch/);
    assert.match(call.policy, /decision = "deny"/);
  }
});
