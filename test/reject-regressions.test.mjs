import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { DEFAULTS } from '../src/swarm.mjs';
import {
  test, ss, fixture, mockAvail, mockFail, binary, readFile, join,
  cx, cl, ag, cd, reply, fail, env,
} from './helpers.mjs';

for (const [name, provider] of [['arcodex', cx], ['arclaude', cl]]) {
  test(`${name}: files shard with 59000 multibyte characters uses stdin without E2BIG`, async t => {
    const contents = '界'.repeat(59_000);
    const answer = 'Found text (large.txt:1)';
    const dir = await fixture(t, name, `
      process.stdin.setEncoding('utf8');
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      fs.appendFileSync(process.env.TASK6_CALLS, JSON.stringify({args:a,input})+'\\n');
      ${reply(name, name === 'arcodex' ? answer : {result:answer})}
    `);
    const path = join(dir, 'large.txt'), log = join(dir, 'calls.jsonl');
    await writeFile(path, contents);
    env(t, {TASK6_CALLS:log, SWARM_WORKERS:undefined});
    mockAvail(t, [provider.id]);
    assert.equal(DEFAULTS.shardChars, 60_000);
    const {report} = await ss({query:'find text', paths:[path], provider:'auto', rank:'off'});
    assert.equal(report.workers.length, 1);
    assert.equal(report.workers[0].ok, true);
    assert.equal(report.workers[0].provider, provider.id);
    assert.equal(report.synthesis.provider, provider.id);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].input.includes(contents), 'complete file must reach stdin');
    for (const {args, input} of calls) {
      assert.ok(input.length > 0);
      assert.ok(!args.some(arg => arg.includes('Query:') || arg.includes(contents)));
    }
    if (name === 'arcodex') assert.equal(calls[0].args.at(-1), '-');
    else assert.ok(!calls[0].args.includes('--'));
  });
}

for (const stage of ['worker', 'synthesis']) {
  test(`auto ${stage}: GPT model rejection falls through agy default to Claude default`, async t => {
    const dir = await fixture(t, 'arcodex', `
      fs.readFileSync(0, 'utf8');
      fs.appendFileSync(process.env.TASK6_CALLS, JSON.stringify({provider:'arcodex',args:a})+'\\n');
      ${stage === 'worker' ? fail('HTTP 400: unrecognized_model gpt-worker') : `
        if (a[a.indexOf('-m')+1] === 'gpt-synthesis') { ${fail('HTTP 400: unsupported model gpt-synthesis')} }
        ${reply('arcodex', 'Finding (https://example.org)')}
      `}
    `);
    const log = join(dir, 'calls.jsonl');
    env(t, {TASK6_CALLS:log});
    mockAvail(t);
    await binary(dir, 'agy', `
      fs.appendFileSync(process.env.TASK6_CALLS, JSON.stringify({provider:'agy',args:a})+'\\n');
      ${fail('HTTP 400: unsupported model on agy')}
    `);
    await binary(dir, 'claude', `
      fs.readFileSync(0, 'utf8');
      fs.appendFileSync(process.env.TASK6_CALLS, JSON.stringify({provider:'claude',args:a})+'\\n');
      process.stdout.write(JSON.stringify({result:'Answer (https://example.org)'}));
    `);
    const {report} = await ss({
      query:'q', angles:['a'], provider:'auto', model:'gpt-worker', synthModel:'gpt-synthesis',
      ...(stage === 'synthesis' ? {synthProvider:'auto'} : {}),
    });
    assert.equal(report.workers[0].ok, true);
    assert.equal(report.workers[0].provider, stage === 'worker' ? cd.id : cx.id);
    assert.equal(report.synthesis.provider, cd.id);
    assert.equal(report.synthesis.model, cd.defaultModel);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(c => c.provider), stage === 'worker'
      ? ['arcodex','agy','claude','arcodex','agy','claude']
      : ['arcodex','arcodex','agy','claude']);
    const models = calls.map(({args}) => args[args.indexOf(args.includes('-m') ? '-m' : '--model')+1]);
    assert.deepEqual(models, stage === 'worker'
      ? ['gpt-worker',ag.defaultModel,cd.defaultModel,'gpt-synthesis',ag.defaultModel,cd.defaultModel]
      : ['gpt-worker','gpt-synthesis',ag.defaultModel,cd.defaultModel]);
  });
}

test('auto fallback keeps a generic HTTP 400 fatal', async t => {
  mockAvail(t);
  t.mock.method(cx, 'complete', async () => {
    const {ProviderError} = await import('../src/providers/base.mjs');
    throw new ProviderError('HTTP 400: invalid request', {status:400});
  });
  mockFail(t, ag, cd);
  await assert.rejects(ss({query:'q', angles:['a'], provider:'auto'}), /All 1 workers returned nothing/);
});
