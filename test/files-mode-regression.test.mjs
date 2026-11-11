import {test,match,readFile,join,fixture,binary,writeServer,cli,eq,deep} from './helpers.mjs';

test('files CLI auto: arcodex network failure falls directly to Claude, skipping agy and arclaude', async t => {
  const dir = await fixture(t, 'arcodex', `
    fs.readFileSync(0, 'utf8');
    fs.appendFileSync(process.env.TASK6_CALLS, 'arcodex\\n');
    process.stderr.write('fetch failed: ECONNRESET'); process.exitCode=1;
  `);
  for (const name of ['agy','arclaude']) await binary(dir, name, `throw new Error('must skip ${name}');`);
  await binary(dir, 'claude', `
    fs.readFileSync(0, 'utf8');
    if (a[a.indexOf('--tools')+1] !== '') throw new Error('web tools must be disabled');
    fs.appendFileSync(process.env.TASK6_CALLS, 'claude\\n');
    process.stdout.write(JSON.stringify({result:'Port 8787 (s.mjs:1)'}));
  `);
  const file = await writeServer(dir), log = join(dir, 'calls');
  const {report} = await cli(file, {TASK6_CALLS:log});
  eq([report.workers[0].provider,'claude-cli'], [report.workers[0].ok,true], [report.synthesis.provider,'claude-cli']);
  deep([(await readFile(log,'utf8')).trim().split('\n'), ['arcodex','claude','arcodex','claude']]);
});

test('files CLI auto: agy and Claude available selects Claude without web-access error', async t => {
  const dir = await fixture(t, 'agy', `throw new Error('files must not reach agy');`);
  await binary(dir, 'claude', `
    const input = fs.readFileSync(0, 'utf8');
    if (a[a.indexOf('--tools')+1] !== '') throw new Error('web tools must be disabled');
    fs.appendFileSync(process.env.TASK6_CALLS, input+'\\n');
    process.stdout.write(JSON.stringify({result:'Port 8787 (s.mjs:1)'}));
  `);
  const file = await writeServer(dir), log = join(dir, 'calls');
  const {report} = await cli(file, {TASK6_CALLS:log});
  eq([report.workers[0].provider,'claude-cli'], [report.workers[0].ok,true], [report.synthesis.provider,'claude-cli']);
  match(await readFile(log, 'utf8'), /const port = 8787/);
});

test('files CLI: skip agy, stdin, policy',async t=>{
  const dir = await fixture(t,'agy',`process.stderr.write('files must not reach agy');process.exitCode=1;`);
  const file = await writeServer(dir),calls = join(dir,'calls.jsonl');
  await binary(dir,'gemini',`let input='';for await(const c of process.stdin)input+=c;
const policy=a.includes('--policy')?fs.readFileSync(a[a.indexOf('--policy')+1],'utf8'):'';
fs.appendFileSync(process.env.TASK6_CALLS,JSON.stringify({args:a,input,policy})+'\\n');
process.stdout.write(JSON.stringify({response:'Port 8787 (s.mjs:1)'}));`);
  const {markdown,report:r} = await cli(file,{TASK6_CALLS:calls});
  eq([r.mode,'files'],[r.workers[0].provider,'gemini-cli'],[r.workers[0].ok,true],[r.synthesis.provider,'gemini-cli']);
  match(markdown,/_swarm-search · mode: files/);
  const seen = (await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
  eq([seen.length,2]);
  match(seen[0].input,/const port = 8787/);
  for (const call of seen) for (const re of [/google_web_search/,/web_fetch/,/decision = "deny"/]) match(call.policy,re);
});
