import {test,ss,mockAvail,cx,ag,cl,cd,ProviderError,okAns,eq,deep,match} from './helpers.mjs';

for (const error of ['fetch failed','ECONNRESET','ETIMEDOUT']) test(`agy network: ${error}`,async t=>{
  mockAvail(t);
  for (const p of [cx,ag,cd]) t.mock.method(p,'complete',async ()=>{
    if (p===cx) throw new ProviderError('router failure',{status:503});
    if (p===ag) throw new ProviderError('agy exited with code 1',{stderr:error});
    return okAns();
  });
  const {report:r}=await ss({query:'q',angles:['a'],provider:'auto'});
  eq([r.workers[0].provider,cd.id],[r.synthesis.provider,cd.id],[cd.complete.mock.callCount(),2]);
});

for (const [spec,angles,want] of [
  ['arcodex-cli,claude-cli',['a'],['custom']],
  ['claude-cli:first,arcodex-cli:primary,claude-cli:reserve',['a','b'],['first','reserve']],
]) test(`fallback model: ${spec}`,async t=>{
  mockAvail(t);
  t.mock.method(cx,'complete',async ()=>{throw new ProviderError('network',{status:503});});
  t.mock.method(cd,'complete',async ({model})=>okAns(model));
  const {report:r}=await ss({query:'q',provider:spec,model:'custom',angles,workers:1});
  deep([r.workers.map(w=>w.text),want],[r.workers.map(w=>w.model),want]);
});

test('empty paid synthesis: 3 calls, $0.12',async t=>{
  mockAvail(t,[cl.id,cd.id]);
  for (const p of [cl,cd]) t.mock.method(p,'complete',async ({system})=>{
    const empty=p===cl&&!system.startsWith('You are one worker');
    return {text:empty?' ':okAns().text,usage:{inputTokens:10,outputTokens:2,costUsd:0.04}};
  });
  const {report:r,markdown}=await ss({query:'q',angles:['a'],provider:'arclaude-cli,claude-cli'});
  eq([cd.complete.mock.callCount(),1],[r.usage.calls,3],[r.usage.pricedCalls,3],[r.usage.inputTokens,30],[r.usage.outputTokens,6],
    [r.usage.costUsd,0.12],[r.usage.costPerUsefulUsd,0.12]);
  match(markdown,/\$0\.120 · \$0\.120 per useful answer/);
});
