import {test,match,readFile,join,fixture,binary,writeServer,cli,eq} from './helpers.mjs';

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
