import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PROVIDERS,byId,resolveProviders as rp} from '../src/providers/index.mjs';
import {DEFAULTS,swarmSearch as ss,isRetryable} from '../src/swarm.mjs';
import {ProviderError,runProcess} from '../src/providers/base.mjs';

export const [cx,cl,ag,cd,gm] = ['arcodex-cli','arclaude-cli','agy-cli','claude-cli','gemini-cli'].map(id=>byId[id]);
export const chain = [cx.id,ag.id,cd.id];
export const okAns = (text = 'Ans (https://example.org)')=>({text});
export const waf = '<!doctype html><html><body>Cloudflare captcha challenge</body></html>';
export const ids = s=>s.map(x=>x.provider.id);
export const eq = (...rows)=>rows.forEach(([a,b])=>assert.equal(a,b));
export const deep = (...rows)=>rows.forEach(([a,b])=>assert.deepEqual(a,b));
export const checkErr = (e,id,st,re)=>e instanceof ProviderError && e.provider === id && e.status === st && isRetryable(e) && /AgentRouter/.test(e.message) && re.test(e.message);
export const mockFail = (t,...ps)=>ps.forEach(p=>t.mock.method(p,'complete',()=>assert.fail()));
export const fail = (body,code = 1,io = 'stderr')=>`process.${io}.write(${JSON.stringify(body)});process.exit(${code});`;
export const reply = (name,data)=>name === 'arcodex'
  ? `fs.writeFileSync(a[a.indexOf('-o')+1],${JSON.stringify(data)});`
  :`process.stdout.write(${JSON.stringify(JSON.stringify(data))});`;

export async function tmp(t) {
  const d = await mkdtemp(join(tmpdir(),'swarm-test-'));
  t.after(()=>rm(d,{recursive:true,force:true}));
  return d;
}
export async function writeServer(d) {
  const p = join(d,'s.mjs');
  await writeFile(p,'const port = 8787;\n');
  return p;
}
export const binary = (d,name,body)=>writeFile(join(d,name),`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);${body}\n`,{mode:0o755});
export async function fixture(t,name,body) {
  const d = await tmp(t);
  await binary(d,name,body);
  env(t,{PATH:d});
  return d;
}
export function mockAvail(t,list = chain) {
  const s = new Set(list),backoff = DEFAULTS.retryBackoffMs;
  env(t,{SWARM_PROVIDER:undefined});
  for (const p of PROVIDERS) t.mock.method(p,'detect',()=>s.has(p.id));
  DEFAULTS.retryBackoffMs = 1;
  t.after(()=>{DEFAULTS.retryBackoffMs = backoff;});
  return s;
}
export function checkFallback(r,w,f) {
  eq([r.workers[0].provider,w],[r.workers[0].retriedFrom,f],[r.synthesis.provider,w],[r.retried,1]);
}
export async function cli(path,env = {}) {
  const {stdout} = await runProcess(process.execPath,['bin/swarm-search.mjs','run','port?','--mode','files','--paths',path,'--workers','1','--rounds','1','--rank','off','--json'],{
    timeoutMs:10000,env:{SWARM_PROVIDER:'auto',ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',GEMINI_API_KEY:'',GOOGLE_API_KEY:'',OPENROUTER_API_KEY:'',...env},
  });
  return JSON.parse(stdout);
}
export function env(t,values) {
  for (const [k,v] of Object.entries(values)) {
    const prev = process.env[k];
    v === undefined ? delete process.env[k] :process.env[k] = v;
    t.after(()=>{prev === undefined ? delete process.env[k] :process.env[k] = prev;});
  }
}
export const flag = (args,key)=>args[args.indexOf(key) + 1];
export const {ok,match,rejects} = assert;
export {test,assert,readFile,join,PROVIDERS,rp,ss,isRetryable,ProviderError};
