import {test,assert,ok,match,rejects,ss,PROVIDERS,rp,tmp,mockAvail,ids,writeServer,cx,cl,ag,cd,gm,chain,eq,deep,mockFail} from './helpers.mjs';

test('selection: auto/mixed/files/remote',async ()=>{
  const av = [cx,cl,ag,cd],files = {mode:'files'},remote = {...files,remote:true};
  for (const [spec,available,opts,want] of [
    ['auto',[ag,gm],files,[{provider:gm,model:undefined}]],
    ['auto',av,{includeFallbacks:true},[cx.id,ag.id,cd.id]],
    ['mixed',av,{},[cx.id,cl.id,ag.id]],
    ['mixed',[ag,gm,cd],files,[gm.id,cd.id]],
    ['auto',[cx,ag,cd],remote,[cd.id]],
    ['auto',av,{},cx.id],['arclaude-cli:haiku',av,{},cl],
    ['auto',[cl],files,cl.id],['auto',[ag,gm,cd],files,gm],['auto',av,remote,cl.id],
  ]) {
    const slots = await rp(spec,{available,...opts});
    if (Array.isArray(want)) deep([typeof want[0] === 'string' ? ids(slots) :slots,want]);
    else eq([typeof want === 'string' ? slots[0].provider.id :slots[0].provider,want]);
  }
});

test('priority without arcodex',async t=>{
  const order = [...chain.slice(0,1),cl.id,...chain.slice(1),'codex-cli',gm.id,'anthropic'],en = mockAvail(t,order);
  deep([ids(await rp('auto',{includeFallbacks:true})),order.filter(id=>id !== cl.id)]);
  for (const id of order) {eq([(await rp('auto'))[0].provider.id,id]); en.delete(id);}
  ok(PROVIDERS.slice(PROVIDERS.findIndex(p=>p.kind === 'api')).every(p=>p.kind === 'api'));
  for (const id of [cl.id,ag.id,cd.id,'anthropic']) en.add(id);
  deep([ids(await rp('auto',{includeFallbacks:true})),[cl.id,ag.id,cd.id,'anthropic']]);
});

test('legacy specs and models',async ()=>deep([
  (await rp('arcodex-cli:gpt-custom,arclaude-cli:sonnet,agy-cli,claude-cli:haiku,codex-cli')).map(s=>[s.provider.id,s.model]),
  [[cx.id,'gpt-custom'],[cl.id,'sonnet'],[ag.id,undefined],[cd.id,'haiku'],['codex-cli',undefined]],
]));

for (const [name,available,provider,opts] of [
  ['files offline over agy',[ag.id,gm.id],gm,{mode:'files'}],
  ['files router and auto synthesis',chain,cx,{provider:'auto',synthProvider:'auto'}],
]) test(name,async t=>{
  const dir = await tmp(t),calls = []; mockAvail(t,available);
  const bad = t.mock.method(ag,'complete',()=>assert.fail());
  if (provider === cx) mockFail(t,cd);
  const good = t.mock.method(provider,'complete',async ({web,system,prompt})=>{
    eq([web,false]); calls.push(prompt);
    if (provider === gm && system.startsWith('You are one worker')) match(prompt,/port = 8787/);
    return {text:'Port 8787 (s.mjs:1)'};
  });
  await writeServer(dir);
  const {report:r,markdown} = await ss({query:'port?',paths:[dir],workers:1,rank:'off',...opts});
  eq([r.workers[0].provider,provider.id],[r.synthesis.provider,provider.id]);
  if (provider === gm) eq([bad.mock.callCount(),0],[good.mock.callCount(),2]);
  else {match(markdown,/mode: files/); eq([calls.length,2]);}
});

test('actionable errors',async ()=>{
  const files = {query:'q',paths:['src'],mode:'files'};
  for (const [run,error] of [
    [()=>rp('auto',{available:[ag],mode:'files'}),/files mode:.*arcodex.*arclaude.*--provider/s],
    [()=>ss({...files,provider:ag.id}),/cannot run without web access.*--provider/s],
    [()=>ss({...files,provider:cd.id,synthProvider:ag.id}),/synthesis on agy-cli.*--synth-provider auto/s],
    [()=>ss({query:'q',provider:cx.id,remote:true,angles:['a']}),/can read the server's disk/],
  ]) await rejects(run(),error);
});

test('remote disk capabilities',()=>{ok(cx.localFiles); ok(!cl.localFiles); });
test('SWARM_PROVIDER explicit; auto overrides it',async t=>{
  mockAvail(t,[cx.id,ag.id]); process.env.SWARM_PROVIDER = ag.id;
  eq([(await rp())[0].provider,ag],[(await rp('auto',{mode:'files' }))[0].provider.id,cx.id]);
  await rejects(ss({query:'q',paths:['src'] }),/cannot run without web access/);
});
test('remote paths before providers',async t=>{
  const dir = await tmp(t);
  for (const p of PROVIDERS) t.mock.method(p,'detect',()=>assert.fail());
  await rejects(ss({query:'q',mode:'files',paths:['src'],filesRoots:[dir],remote:true }),/outside SWARM_FILES_ROOTS/);
});
