import assert, { AssertionError } from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const fixture = JSON.parse(await readFile(new URL('./fixtures/plugin-compat-711.json', import.meta.url), 'utf8'));
const contractTest = 'plugin compatibility 711: saved connection runs the real MCP server';
const exec = promisify(execFile);

async function scratch(t, label) {
  const dir = await mkdtemp(join(root, `.plugin-compat-711-${label}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function cleanEnvironment(sandbox, bin = dirname(process.execPath)) {
  // An allowlist also drops NODE_OPTIONS, API endpoints, SWARM_* defaults and CLI credentials.
  return {
    PATH: bin, HOME: sandbox, USERPROFILE: sandbox,
    TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

function withoutDescriptions(value) {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description')
    .map(([key, nested]) => [key, withoutDescriptions(nested)]));
}

function checkTools(tools) {
  assert.ok(Array.isArray(tools), 'tools/list must return tools');
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  assert.equal(byName.size, tools.length, 'tool names must be unique');
  for (const [name, saved] of Object.entries(fixture.tools)) {
    const tool = byName.get(name);
    assert.ok(tool, `recorded MCP tool ${name} is missing`);
    assert.equal(tool.inputSchema?.type, saved.type, `${name} input type`);
    assert.deepEqual([...(tool.inputSchema.required || [])].sort(), [...(saved.required || [])].sort(),
      `${name} must not require new arguments`);
    for (const [arg, schema] of Object.entries(saved.properties)) {
      assert.deepEqual(withoutDescriptions(tool.inputSchema.properties?.[arg]), schema, `${name} old argument ${arg}`);
    }
    // Additional tools and optional properties are compatible; versions/descriptions are not pinned.
  }
}

function stdioClient(t, child) {
  const pending = new Map();
  let nextId = 0;
  let failure;
  let stderr = '';
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const fail = detail => {
    failure ||= new AssertionError({ message: `recorded MCP launch/stdio failed: ${detail}\n${stderr}` });
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
    pending.clear();
  };
  child.once('error', error => fail(error.message));
  child.once('close', (code, signal) => fail(`server closed (code=${code}, signal=${signal})`));
  child.stdin.on('error', error => fail(error.message));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0');
      if (message.id === undefined) {
        assert.equal(typeof message.method, 'string');
        return;
      }
      const entry = pending.get(message.id);
      assert.ok(entry, `unexpected response id ${message.id}`);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    } catch (error) { fail(error.message); }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    lines.close();
  });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  return {
    async request(method, params) {
      if (failure) throw failure;
      const id = ++nextId;
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(`timeout waiting for ${method}`), 5000);
        pending.set(id, { resolve, reject, timer });
        send({ jsonrpc: '2.0', id, method, params });
      });
      assert.equal(response.error, undefined, `${method}: ${JSON.stringify(response.error)}`);
      assert.ok(Object.hasOwn(response, 'result'), `${method} must return a result`);
      return response.result;
    },
    initialized() { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); },
    async finish() {
      child.stdin.end();
      const exit = await closed;
      assert.equal(exit.code, 0, stderr);
      assert.equal(exit.signal, null);
    },
  };
}

test(contractTest, { timeout: 20_000 }, async t => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
  assert.equal(pkg.bin?.[fixture.cli.name], fixture.cli.path, 'the old CLI command must remain installed');
  assert.equal(plugin.name, fixture.plugin.name, 'the plugin name must remain discoverable');
  const skill = await readFile(join(root, fixture.plugin.skillPath), 'utf8');
  const metadata = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(metadata, 'the old skill path must still contain skill metadata');
  assert.match(metadata[1], /^name:\s*['"]?swarm-search['"]?\s*$/m, 'the old skill must remain discoverable');
  assert.match(skill, /\bswarm_search\b/, 'the skill must use the old tool name');
  for (const [name, saved] of Object.entries(fixture.connection)) {
    assert.ok(config[name], `recorded MCP connection ${name} is missing`);
    assert.deepEqual({ command: config[name].command, args: config[name].args }, saved, 'the plugin launch configuration changed');
  }

  const sandbox = await scratch(t, 'client');
  const bin = join(sandbox, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, process.platform === 'win32' ? 'node.exe' : 'node'));
  const [serverName, saved] = Object.entries(fixture.connection)[0];
  const args = saved.args.map(arg => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', root));
  const env = {
    ...cleanEnvironment(sandbox, bin),
    CLAUDE_PLUGIN_ROOT: root,
    // Keep the recorded command/argv intact; only preload the offline provider boundary.
    NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'test/fixtures/plugin-compat-provider-711.mjs')).href}`,
  };
  const client = stdioClient(t, spawn(saved.command, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] }));
  const initialized = await client.request('initialize', fixture.initialize);
  assert.equal(initialized.protocolVersion, fixture.initialize.protocolVersion, 'the old MCP protocol must still negotiate');
  assert.equal(initialized.serverInfo?.name, serverName);
  assert.ok(initialized.capabilities?.tools, 'the server must negotiate tools');
  client.initialized();
  checkTools((await client.request('tools/list', {})).tools);

  const providers = await client.request('tools/call', fixture.providersCall);
  assert.notEqual(providers.isError, true);
  assert.match(providers.content[0].text, /✓ claude-cli\s/);
  assert.match(providers.content[0].text, /✓ openai\s/);
  const result = await client.request('tools/call', fixture.searchCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.ok(result.content[0].text.includes(fixture.marker));
  const report = result.structuredContent;
  const old = fixture.searchCall.arguments;
  assert.equal(report.query, old.query);
  assert.equal(report.mode, old.mode);
  assert.equal(report.rounds, old.rounds);
  assert.equal(report.round2Mode, old.round2);
  assert.equal(report.ranking, null, 'rank=off must remain accepted');
  assert.equal(report.workers.length, old.workers);
  assert.equal(report.round2.length, old.workers);
  for (const worker of [...report.workers, ...report.round2]) {
    assert.equal(worker.ok, true, worker.error);
    assert.equal(worker.provider, old.provider);
    assert.equal(worker.model, old.model);
    assert.ok(worker.text.includes(fixture.marker));
  }
  assert.deepEqual(report.synthesis, { provider: old.synth_provider, model: old.synth_model });
  assert.equal(report.synthesisFailure, undefined, 'the test provider must complete synthesis');

  const serp = await client.request('tools/call', fixture.serpCall);
  assert.notEqual(serp.isError, true);
  assert.equal(serp.structuredContent.query, fixture.serpCall.arguments.query);
  assert.equal(serp.structuredContent.mode, 'serp');
  assert.equal(serp.structuredContent.serp.topN, fixture.serpCall.arguments.top_n);
  assert.equal(serp.structuredContent.serp.region, fixture.serpCall.arguments.region);
  assert.equal(serp.structuredContent.serp.status, 'unavailable');
  assert.equal(serp.structuredContent.usage.calls, 0, 'unsupported native positions must not call a model');
  await client.finish();
});

async function mutationCopy(t, label) {
  const dir = await scratch(t, label);
  // No checkout, dependencies, credentials or neighboring workspaces enter these temporary copies.
  for (const path of ['package.json', '.mcp.json', '.claude-plugin', 'bin', 'src', 'skills',
    'test/plugin-compat-711.test.mjs', 'test/fixtures/plugin-compat-711.json', 'test/fixtures/plugin-compat-provider-711.mjs']) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await cp(join(root, path), join(dir, path), { recursive: true });
  }
  return dir;
}

async function expectContractFailure(t, dir, message) {
  let result;
  try {
    await exec(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${contractTest}$`,
      'test/plugin-compat-711.test.mjs'], { cwd: dir, env: cleanEnvironment(dir), timeout: 15_000, maxBuffer: 512 * 1024 });
    assert.fail('the mutated copy unexpectedly passed the saved-client test');
  } catch (error) { result = error; }
  assert.equal(result.code, 1, result.stdout || result.message);
  assert.equal(result.killed, false, 'the mutation must fail promptly, without a runner timeout');
  const output = result.stdout + result.stderr;
  assert.match(output, /ERR_ASSERTION/);
  assert.match(output, /# fail 1\b/);
  assert.match(output, message);
  t.diagnostic(`isolated mutation detected: ${message.source}; runner exit=1, assertion failures=1`);
}

test('plugin compatibility 711: detects a renamed MCP tool in a temporary copy', { timeout: 25_000 }, async t => {
  const dir = await mutationCopy(t, 'tool');
  const path = join(dir, 'src/mcp.mjs');
  const source = await readFile(path, 'utf8');
  const mutated = source.replaceAll(/(['"])swarm_search\1/g, '$1swarm_search_renamed_711$1');
  assert.notEqual(mutated, source, 'the mutation must rename an existing public tool');
  await writeFile(path, mutated);
  await expectContractFailure(t, dir, /recorded MCP tool swarm_search is missing/);
});

test('plugin compatibility 711: detects a broken launch path in a temporary copy', { timeout: 25_000 }, async t => {
  const dir = await mutationCopy(t, 'launch');
  await rename(join(dir, fixture.cli.path), join(dir, 'bin/swarm-search-moved-711.mjs'));
  await expectContractFailure(t, dir, /recorded MCP launch\/stdio failed/);
});
