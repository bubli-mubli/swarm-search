import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('MCP initialize reports the package version from another working directory', { timeout: 10_000 }, async t => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const cwd = await mkdtemp(join(tmpdir(), 'swarm-mcp-version-1206-'));
  const protocols = ['2024-11-05', '2025-03-26', '2025-06-18', 'unsupported-version'];
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/swarm-search.mjs', import.meta.url)), 'mcp'], {
    cwd,
    env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    lines.close();
    await rm(cwd, { recursive: true, force: true });
  });

  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.once('error', error => { stderr += error.message; });
  child.stdin.on('error', error => { stderr += error.message; });
  const replies = [];
  lines.on('line', line => {
    replies.push(line);
    if (replies.length === protocols.length) child.stdin.end();
  });
  for (const [index, protocolVersion] of protocols.entries()) {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: index + 1, method: 'initialize',
      params: { protocolVersion, capabilities: {}, clientInfo: { name: 'mcp-version-test', version: '1' } },
    }) + '\n');
  }

  const exit = await closed;
  assert.equal(exit.code, 0, stderr);
  assert.equal(exit.signal, null, stderr);
  assert.equal(replies.length, protocols.length, 'every initialize request must receive a response');
  for (const [index, line] of replies.entries()) {
    const reply = JSON.parse(line);
    assert.equal(reply.jsonrpc, '2.0');
    assert.equal(reply.id, index + 1);
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.serverInfo.name, 'swarm-search');
    assert.equal(reply.result.protocolVersion, index < 3 ? protocols[index] : '2025-03-26');
    assert.deepEqual(reply.result.capabilities, { tools: { listChanged: false } });
    assert.equal(reply.result.serverInfo.version, pkg.version, 'initialize version must match package.json');
  }
});
