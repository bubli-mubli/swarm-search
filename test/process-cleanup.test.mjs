import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess, ProviderError } from '../src/providers/base.mjs';

const baseUrl = new URL('../src/providers/base.mjs', import.meta.url).href;

async function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      // Zombies hold no pipes.
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return !['Z', 'X'].includes(stat.match(/^\d+ \(.*\) (\S)/)[1]);
    }
    return true;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes(error.code)) return false;
    throw error;
  }
}

async function scratch(t) {
  const root = fileURLToPath(new URL('../.scratch/', import.meta.url));
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'process-cleanup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

for (const mode of ['timeout', 'timeout-detached', 'abort', 'exit']) {
  test(`FAILS_ON_OLD 979: ${mode} cleanup`, { timeout: 15000 }, async (t) => {
    const log = join(await scratch(t), 'pids');
    const record = `const fs=require('node:fs'),{spawn}=require('node:child_process');fs.appendFileSync(${JSON.stringify(log)},process.pid+'\\n');`;
    const launch = (code, detached = false) => `spawn(process.execPath,['-e',${JSON.stringify(code)}],{stdio:'inherit',detached:${detached}});`;
    const linger = 'setTimeout(() => {}, 5000);';
    const branch = record + launch(record + linger) + linger;
    const worker = record + launch(branch, mode !== 'timeout') + `
const ready = setInterval(() => {
  if (fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length !== 3) return;
  clearInterval(ready);
  process.stderr.write('fixture ready\\n', () => {
    fs.appendFileSync(${JSON.stringify(log)}, 'ready\\n');
    if (${JSON.stringify(mode)} === 'exit') process.exit(2);
  });
}, 10);` + linger;
    const callerCode = `
import { runProcess } from ${JSON.stringify(baseUrl)};
const controller = new AbortController();
process.on('message', () => controller.abort());
try {
  await runProcess(process.execPath, ['-e', ${JSON.stringify(worker)}], {
    timeoutMs: ${mode.startsWith('timeout') ? 1000 : 10000}, signal: controller.signal,
  });
  throw Error('unexpected success');
} catch (error) {
  process.send({ name: error.name, message: error.message, stderr: error.stderr, errorAt: Date.now() });
} finally { process.disconnect(); }`;
    const control = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const controlClosed = once(control, 'close');
    const caller = spawn(process.execPath, ['--input-type=module', '-e', callerCode], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let exit;
    const closed = once(caller, 'close').then(([code]) => {
      exit = { code, at: Date.now() };
    });
    const result = new Promise((resolve, reject) => {
      caller.once('message', resolve);
      caller.once('error', reject);
      caller.once('close', () => reject(new Error('caller closed without result')));
    });
    result.catch(() => {});
    let owned = [];
    let ready = false;
    const pids = async () => {
      try {
        const lines = (await readFile(log, 'utf8')).trim().split('\n');
        owned = lines.filter(p => /^\d+$/.test(p)).map(Number);
        ready = lines.includes('ready');
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return owned;
    };
    t.after(async () => {
      for (const pid of [...await pids(), control.pid, caller.pid].reverse()) {
        if (pid && await alive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
      await Promise.all([closed, controlClosed]);
    });
    const readyDeadline = Date.now() + 3000;
    while (!ready && Date.now() < readyDeadline) { await pids(); if (!ready) await delay(10); }
    assert.ok(ready && owned.length === 3, 'tree not ready');
    const readyAt = Date.now();
    if (mode === 'abort') caller.send('abort');
    const error = await result;
    let livePids;
    do {
      livePids = [];
      for (const pid of owned) if (await alive(pid)) livePids.push(pid);
      if (exit && !livePids.length) break;
      await delay(10);
    } while (Date.now() - error.errorAt < 400);
    assert.equal(error.name, 'ProviderError');
    assert.match(error.message, mode.startsWith('timeout') ? /timed out/ : mode === 'abort' ? /aborted/ : /exited with code 2/);
    if (mode === 'exit') {
      assert.match(error.stderr, /fixture ready/);
      assert.ok(error.errorAt - readyAt <= 400, 'worker error delayed');
    }
    assert.deepEqual({ callerExited: exit?.code === 0, livePids, controlAlive: await alive(control.pid) },
      { callerExited: true, livePids: [], controlAlive: true });
    assert.ok(exit.at - error.errorAt <= 400, 'caller exit delayed');
    t.diagnostic(`error-to-exit=${exit.at - error.errorAt}ms`);
  });
}

test('runProcess: success and startup errors', async () => {
  const result = await runProcess(process.execPath, ['-e', `
    process.stdin.on('data', data => process.stdout.write(data));
    process.stderr.write('diagnostic');
  `], { input: 'hello\n', timeoutMs: 3000 });
  assert.deepEqual(result, { stdout: 'hello\n', stderr: 'diagnostic' });
  await assert.rejects(runProcess('swarm979-missing', [], { timeoutMs: 3000 }), error => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /failed to start/);
    assert.equal(error.cause.code, 'ENOENT');
    return true;
  });
});

test('FAILS_ON_OLD 979: pre-aborted signal', async () => {
  await assert.rejects(runProcess('swarm979-missing', [], { signal: AbortSignal.abort() }), /aborted/);
});
