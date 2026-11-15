import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'bin', 'swarm-search.mjs');
const exec = promisify(execFile);

async function fixture(t) {
  const scratch = join(root, '.scratch');
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'doctor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const cache = join(dir, 'cache');
  await mkdir(bin);
  await mkdir(cache);
  await symlink(process.execPath, join(bin, process.platform === 'win32' ? 'node.exe' : 'node'));
  // Deliberately do not inherit API keys, provider selection, plugin registration or NODE_OPTIONS.
  const env = {
    PATH: bin, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
    TMPDIR: cache, TMP: cache, TEMP: cache,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  return { dir, bin, cache, env };
}

async function run(env, args = []) {
  try {
    return { code: 0, ...await exec(process.execPath, [cli, 'doctor', ...args], {
      env, cwd: root, timeout: 8000, maxBuffer: 1024 * 1024,
    }) };
  } catch (error) {
    assert.equal(error.killed, false, 'doctor must finish within seconds');
    assert.equal(typeof error.code, 'number', error.message);
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function checkLines(result) {
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.length >= 5);
  for (const line of lines) {
    assert.match(line, /^\[(ok|warn|not configured|fail)\] [^:]+: .+/);
    if (!line.startsWith('[ok]')) assert.match(line, /; fix: \S+/);
  }
  assert.equal(result.code, lines.some(line => line.startsWith('[fail]')) ? 1 : 0);
  return lines;
}

test('FAILS_ON_OLD 480: doctor without keys reports not configured and exits zero', async (t) => {
  const { env } = await fixture(t);
  const result = await run(env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  checkLines(result);
  assert.match(result.stdout, /^\[ok\] node: /m);
  assert.match(result.stdout, /^\[not configured\] plugin: /m);
  assert.match(result.stdout, /^\[ok\] mcp: /m);
  assert.match(result.stdout, /^\[not configured\] providers: /m);
  assert.match(result.stdout, /^\[not configured\] provider anthropic: .*ANTHROPIC_API_KEY/m);
  assert.match(result.stdout, /^\[not configured\] provider google: .*GEMINI_API_KEY.*GOOGLE_API_KEY/m);
  assert.match(result.stdout, /^\[ok\] cache: /m);
});

test('FAILS_ON_OLD 480: doctor reports a broken cache path with a fix and exits one', async (t) => {
  const { dir, env } = await fixture(t);
  const file = join(dir, 'a-file');
  await writeFile(file, 'keep this data');
  const result = await run(env, ['--cache-dir', join(file, 'child')]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  checkLines(result);
  assert.match(result.stdout, /^\[fail\] cache: .*; fix: .*mkdir -p/m);
  assert.equal(await readFile(file, 'utf8'), 'keep this data');
});

test('doctor checks the actual worker temp directory when no cache override is given', async (t) => {
  const { dir, env } = await fixture(t);
  const missing = join(dir, 'missing');
  const result = await run({ ...env, TMPDIR: missing, TMP: missing, TEMP: missing });
  checkLines(result);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^\[fail\] cache: /m);
});

test('doctor checks cache write permissions without writing files', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const { dir, env } = await fixture(t);
  const cache = join(dir, 'read-only');
  await mkdir(cache, { mode: 0o500 });
  const result = await run(env, ['--cache-dir', cache]);
  checkLines(result);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^\[fail\] cache: .*EACCES/m);
});

test('doctor validates plugin registration and catches a stale install path', async (t) => {
  const { dir, env } = await fixture(t);
  const plugins = join(env.CLAUDE_CONFIG_DIR, 'plugins');
  await mkdir(plugins, { recursive: true });
  const registry = join(plugins, 'installed_plugins.json');
  const writeRegistry = installPath => writeFile(registry, JSON.stringify({
    version: 2, plugins: { 'swarm-search@jumplego': [{ scope: 'user', installPath }] },
  }));
  await writeRegistry(root);
  const healthy = await run(env);
  checkLines(healthy);
  assert.equal(healthy.code, 0);
  assert.match(healthy.stdout, /^\[ok\] plugin: /m);
  await writeRegistry(join(dir, 'removed-plugin'));
  const broken = await run(env);
  checkLines(broken);
  assert.equal(broken.code, 1);
  assert.match(broken.stdout, /^\[fail\] plugin: .*; fix: .*install claude-code/m);
});

test('doctor validates MCP entry paths without executing configured commands', async (t) => {
  const { dir, env } = await fixture(t);
  const path = join(dir, 'mcp.json');
  await writeFile(path, JSON.stringify({ mcpServers: { 'swarm-search': {
    command: process.execPath, args: [join(dir, 'missing.mjs'), 'mcp'],
  } } }));
  const result = await run(env, ['--mcp-config', path]);
  checkLines(result);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^\[fail\] mcp: .*; fix: /m);
});

test('doctor does not leak malformed config contents or split a check across lines', async (t) => {
  const { dir, env } = await fixture(t);
  const path = join(dir, 'broken\nconfig.json');
  await writeFile(path, '{ "key": "DO_NOT_PRINT_CONFIG_CONTENTS"');
  const result = await run(env, ['--mcp-config', path]);
  checkLines(result);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^\[fail\] mcp: /m);
  assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_PRINT_CONFIG_CONTENTS/);
});

test('doctor rejects unknown provider selection, but a selected provider without a key stays unconfigured', async (t) => {
  const { env } = await fixture(t);
  const invalid = await run({ ...env, SWARM_PROVIDER: 'typo-provider' });
  checkLines(invalid);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stdout, /^\[fail\] providers: .*; fix: unset SWARM_PROVIDER/m);
  const missing = await run({ ...env, SWARM_PROVIDER: 'openai' });
  checkLines(missing);
  assert.equal(missing.code, 0);
  assert.match(missing.stdout, /^\[not configured\] provider openai: /m);
});

test('doctor never starts CLI providers while checking availability', async (t) => {
  const { bin, dir, env } = await fixture(t);
  const marker = join(dir, 'provider-was-started');
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'called');\n`, { mode: 0o755 });
  const result = await run(env);
  checkLines(result);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^\[ok\] provider claude-cli: .*executable.*not checked/m);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('doctor API reachability sends neither an HTTP request nor an API key', async (t) => {
  const { env } = await fixture(t);
  const bytes = [];
  let connections = 0;
  const server = createServer(socket => {
    connections++;
    socket.on('data', chunk => bytes.push(chunk));
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await run({
    ...env, OPENAI_API_KEY: 'DO_NOT_PRINT_OR_SEND_THIS_KEY',
    OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  });
  checkLines(result);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^\[ok\] provider openai: .*TCP.*not checked/m);
  assert.equal(connections, 1);
  assert.equal(Buffer.concat(bytes).length, 0, 'no HTTP headers, prompt or credentials may be sent');
  assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_PRINT_OR_SEND_THIS_KEY/);
});

test('doctor reports a refused API endpoint as fail and includes a command', async (t) => {
  const { env } = await fixture(t);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const result = await run({ ...env, OPENAI_API_KEY: 'fake', OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` });
  checkLines(result);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^\[fail\] provider openai: .*ECONNREFUSED.*; fix: /m);
});

test('doctor enforces the patched Node versions from package engines', async () => {
  const { supportedNode } = await import('../src/doctor.mjs');
  const { engines } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const version of ['22.23.4', '22.24.0', '24.22.1', '26.12.1', '27.0.0']) {
    assert.equal(supportedNode(version, engines.node), true, version);
  }
  for (const version of ['20.20.0', '22.23.3', '23.0.0', '24.22.0', '25.0.0', '26.12.0', '26.12.1-rc.1']) {
    assert.equal(supportedNode(version, engines.node), false, version);
  }
});

test('doctor bounds a stalled TLS handshake and closes its connection', async (t) => {
  const { probeEndpoint } = await import('../src/doctor.mjs');
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.resume(); // Accept TCP but never answer the TLS handshake.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(resolve));
  });
  await assert.rejects(probeEndpoint(new URL(`https://127.0.0.1:${server.address().port}`), { timeoutMs: 100 }), { code: 'ETIMEDOUT' });
});

test('doctor warns for a disabled plugin without failing the command', async (t) => {
  const { env } = await fixture(t);
  await mkdir(join(env.CLAUDE_CONFIG_DIR, 'plugins'), { recursive: true });
  await writeFile(join(env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'swarm-search@jumplego': [{ installPath: root }] },
  }));
  await writeFile(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'swarm-search@jumplego': false },
  }));
  const result = await run(env);
  checkLines(result);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^\[warn\] plugin: .*disabled.*; fix: claude plugin enable/m);
});
