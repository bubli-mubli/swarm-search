import {ProviderError,mergeSystem} from '../src/providers/base.mjs';
import {callTool,TOOLS,UNTRUSTED_NOTE} from '../src/mcp.mjs';
import {test,ok,match,rejects,readFile,join,ss,isRetryable,fixture,mockAvail,mockFail,checkFallback,checkErr,okAns,waf,writeServer,cx,cl,ag,cd,chain,eq,deep,reply,fail,cli,env,flag} from './helpers.mjs';

const req = {system:'S',prompt:'P',model:'m',timeoutMs:5000};
test('argv, read-only, web',()=>{
  const c = cx.buildArgs({...req,web:false,outFile:'/tmp/o'});
  deep([[c[0],c.includes('--ephemeral'),c.includes('read-only'),flag(c,'-m'),flag(c,'-o'),c.includes('web_search="disabled"'),c.slice(-2)],
    ['exec',true,true,'m','/tmp/o',true,['/tmp/o','-']]]);
  const web = cx.buildArgs({model:'',prompt:'P',web:true,outFile:'/tmp/o'});
  ok(web.includes('web_search="live"') && !web.includes('-m'));
  const k = cl.buildArgs({...req,model:'sonnet',web:false});
  deep([[k[0],flag(k,'--model'),flag(k,'--output-format'),flag(k,'--tools'),flag(k,'--system-prompt'),k.includes('P')],
    ['-p','sonnet','json','','S',false]]);
  ok(cl.buildArgs({model:'haiku',prompt:'P',web:true}).includes('--allowedTools'));
});
test('router model defaults',async t=>{
  env(t,{SWARM_ARCODEX_MODEL:undefined,SWARM_ARCLAUDE_MODEL:undefined});
  const {arcodexCli:c,arclaudeCli:l} = await import('../src/providers/agentrouter-cli.mjs?defaults');
  eq([c.defaultModel,''],[l.defaultModel,'']);
  ok(!c.buildArgs({model:'',prompt:'P',outFile:'/tmp/o'}).includes('-m'));
  ok(!l.buildArgs({model:'',prompt:'P'}).includes('--model'));
});
for (const [name,p,other,data,want,keys] of [
  ['arcodex',cx,cl,' ANSWER\n','ANSWER',['OPENAI_API_KEY','OPENAI_BASE_URL']],
  ['arclaude',cl,cx,{result:'ANSWER',usage:{input_tokens:3,cache_read_input_tokens:7,output_tokens:2},total_cost_usd:0},
    {text:'ANSWER',usage:{inputTokens:10,outputTokens:2,costUsd:0}},['ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL']],
]) {
  test(`${name}: parse, stdin, env`,async t=>{
    const vals = {AGENTROUTER_POOL_TOKEN:'token',[keys[0]]:'key',[keys[1]]:'http://127.0.0.1/u'};
    const dir = await fixture(t,name,`fs.writeFileSync(process.env.TASK6_LOG,JSON.stringify([a,fs.readFileSync(0,'utf8'),Object.fromEntries(${JSON.stringify(Object.keys(vals))}.map(k=>[k,process.env[k]]))]));${reply(name, data)}${name === 'arcodex' ? fail('Reconnecting... 1/5', 0) : ''}`);
    const log = join(dir,'seen'); env(t,{TASK6_LOG:log});
    eq([await p.detect(),true],[await other.detect(),false]);
    const res = await p.complete(req),[a,input] = JSON.parse(await readFile(log,'utf8'));
    if (name === 'arcodex') eq([res.text,want]); else deep([res,want]);
    eq([input,name === 'arcodex' ? mergeSystem('S','P') :'P']);
    if (name === 'arcodex') eq([a.at(-1),'-']); else ok(!a.includes('P'));
    if (name === 'arcodex') ok(a.includes('web_search="disabled"')); else eq([flag(a,'--system-prompt'),'S']);
    env(t,vals);
    eq([(await p.complete({prompt:'P',timeoutMs:5000})).text,'ANSWER']);
    deep([JSON.parse(await readFile(log,'utf8'))[2],vals]);
  });
}

const errors = ['rate limit exceeded','Reconnecting... 5/5','fetch failed: ECONNRESET'];
for (const [name,p] of [['arcodex',cx],['arclaude',cl]]) {
  for (const [body,status,re,code,io] of [
    ...errors.map((b,i)=>[b,i ? 503 :429,i ? /network/i :/rate limit/i,1,'stderr']),
    ...[0,1].map(code=>[waf,503,/WAF|captcha|HTML/i,code,'stdout']),
  ]) test(`${name}: ${body === waf ? 'WAF' : body} exit ${code}`,async t=>{
    await fixture(t,name,fail(body,code,io));
    await rejects(p.complete(req),e=>checkErr(e,p.id,status,re));
  });
}
for (const [name,p,body,check] of [
  ['exit zero network, no answer',cx,fail(errors[1],0,'stdout'),e=>e.status === 503 && /AgentRouter.*network/i.test(e.message)],
  ['WAF outFile',cx,reply('arcodex',waf),e=>/WAF|captcha|HTML/i.test(e.message) && isRetryable(e)],
  ['JSON rate limit',cl,reply('arclaude',{is_error:true,result:errors[0]}),e=>e.status === 429 && isRetryable(e)],
  ['invalid JSON',cl,`process.stdout.write('bad');`,e=>/could not parse JSON/.test(e.message) && !isRetryable(e)],
]) test(name,async t=>{
  await fixture(t,p === cx ? 'arcodex' :'arclaude',body);
  await rejects(p.complete(req),check);
});

for (const [body,kind,bin] of [
  ...errors.map(b=>[b,'findings','arcodex']),
  [waf,'WAF','arcodex'],[errors[0],'chain','arcodex'],[errors[2],'arclaude','arclaude'],
]) test(`fallback ${kind}: ${body === waf ? 'HTML' : body}`,async t=>{
  await fixture(t,bin,fail(body,kind === 'WAF' ? 0 :1,kind === 'WAF' ? 'stdout' :'stderr'));
  mockAvail(t,kind === 'WAF' ? [cx.id,cl.id,ag.id,cd.id] :bin === 'arclaude' ? [cl.id,ag.id,cd.id] :chain);
  const used = [],msgs = [],findings = kind === 'findings';
  const agy = t.mock.method(ag,'complete',async ({system,web})=>{
    if (kind === 'chain') throw new ProviderError('agy: 429',{status:429});
    used.push([system.startsWith('You are one worker') ? 'w' :'s',web]);
    return okAns(findings ? '## Findings\n- Ans (https://example.org)' :undefined);
  });
  const claude = kind === 'chain' ? t.mock.method(cd,'complete',async ()=>okAns()) :mockFail(t,cd);
  if (kind === 'WAF') mockFail(t,cl);
  const {report:r,markdown} = await ss({query:'q',angles:findings ? ['a','b'] :['a'],onProgress:m=>msgs.push(m)});
  if (findings) {
    deep([r.workers.map(w=>[w.provider,w.ok,w.retriedFrom]),[['agy-cli',true,cx.id],['agy-cli',true,cx.id]]]);
    eq([r.retried,2],[r.synthesis.provider,ag.id],[used.filter(([s])=>s === 'w').length,2]);
    match(markdown,/synthesis: agy-cli:/);
    ok(msgs.some(m=>/arcodex-cli failed.*AgentRouter.*retrying on agy-cli/.test(m)));
  } else {
    checkFallback(r,kind === 'chain' ? cd.id :ag.id,bin + '-cli');
    if (kind === 'WAF') ok(msgs.some(m=>/AgentRouter.*WAF.*retrying on agy-cli/i.test(m)));
    else {eq([agy.mock.callCount(),2]); if (kind === 'chain') eq([claude.mock.callCount(),2]);}
}
});
for (let [kind,opts,prefix,text] of [
  ['files',{workers:1,rank:'off',query:'port?'}],
  ['healthy',{angles:['a','b','c']}],
  ['planner',{workers:2},'You split','["angle one", "angle two"]'],
  ['gaps',{angles:['a'],rounds:2,round2:'gaps',model:'w-mod',synthModel:'s-mod'},'You audit','{"followups":["verify"]}'],
]) test(`auto ${kind}`,async t=>{
  mockAvail(t); const calls = [],gaps = kind === 'gaps';
  if (kind === 'files') {
    const dir = await fixture(t,'arcodex',fail(errors[0]));
    opts = {...opts,paths:[await writeServer(dir)]};
    t.mock.method(cd,'complete',async ({web})=>{calls.push(web); return {text:'Port 8787 (s.mjs:1)'};});
  } else {
    mockFail(t,cd);
    t.mock.method(cx,'complete',async ({system,model})=>{
      if (prefix && system.startsWith(prefix)) throw new ProviderError('net fail',{status:503});
      if (gaps) eq([model,system.startsWith('You are the synthesizer') ? 's-mod' :'w-mod']);
      return okAns();
    });
}
  const pl = prefix ? t.mock.method(ag,'complete',async ({system,model,web})=>{
    ok(system.startsWith(prefix)); eq([web,false]); if (gaps) eq([model,ag.defaultModel]);
    return {text};
  }) :mockFail(t,ag);
  const {report:r} = await ss({query:'q',...opts});
  if (kind === 'files') {checkFallback(r,cd.id,cx.id); deep([calls,[false,false]]);}
  else if (kind === 'healthy') {ok(r.workers.every(w=>w.provider === cx.id)); eq([r.retried,0]);}
  else {
    eq([pl.mock.callCount(),1]);
    if (gaps) {
      eq([r.round2.length,1],[r.round2[0].provider,cx.id]); match(r.round2[0].label,/verify/);
      deep([r.synthesis,{provider:cx.id,model:'s-mod'}]);
    } else {
      deep([r.workers.map(w=>w.label),['angle one','angle two']]);
      ok(r.workers.every(w=>w.provider === cx.id && w.ok)); eq([r.synthesis.provider,cx.id]);
}
  }
});
test('cancel router without fallback',async t=>{
  await fixture(t,'arcodex',`setInterval(()=>{},1000);`); mockAvail(t,[cx.id,ag.id]); mockFail(t,ag);
  const c = new AbortController(),tm = setTimeout(()=>c.abort(),30); t.after(()=>clearTimeout(tm));
  await rejects(ss({query:'q',angles:['a'],signal:c.signal}),/cancelled/);
});
test('CLI files flags and JSON',async t=>{
  const dir = await fixture(t,'arcodex',reply('arcodex','Port 8787 (s.mjs:1)'));
  const res = await cli(await writeServer(dir));
  deep([Object.keys(res).sort(),['markdown','report']]);
  eq([res.report.mode,'files'],[res.report.workers[0].provider,cx.id]); match(res.markdown,/_swarm-search · mode: files/);
});
test('MCP names, args and output',async t=>{
  mockAvail(t,[cl.id]); t.mock.method(cl,'complete',async ()=>okAns());
  deep([TOOLS.map(t=>t.name),['swarm_search','swarm_providers']]);
  match(TOOLS[0].inputSchema.properties.provider.description,/arcodex-cli.*arclaude-cli/);
  const res = await callTool('swarm_search',{query:'q',angles:['a'],provider:'arclaude-cli:sonnet',synth_provider:'arclaude-cli:haiku'});
  eq([res.content[0].type,'text']); ok(res.content[0].text.startsWith(UNTRUSTED_NOTE)); match(res.content[0].text,/synthesis: arclaude-cli:haiku/);
});
