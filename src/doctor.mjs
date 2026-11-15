// Read-only diagnostics. Never launch a provider or send HTTP requests/credentials.
import { access, lstat, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as tcpConnect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { PROVIDERS } from './providers/index.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const INSTALL_PLUGIN = 'swarm-search install claude-code --write';
const INSTALL_CLI = 'npm install -g @anthropic-ai/claude-code && claude auth login';
const CLI = {
  'arcodex-cli': ['arcodex', INSTALL_CLI],
  'claude-cli': ['claude', INSTALL_CLI],
  'codex-cli': ['codex', 'npm install -g @openai/codex && codex login'],
  'agy-cli': ['agy', INSTALL_CLI],
  'gemini-cli': ['gemini', 'npm install -g @google/gemini-cli'],
};
const API = {
  anthropic: { keys: ['ANTHROPIC_API_KEY'], url: 'https://api.anthropic.com' },
  openai: { keys: ['OPENAI_API_KEY'], url: 'https://api.openai.com/v1' },
  google: { keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], url: 'https://generativelanguage.googleapis.com' },
  openrouter: { keys: ['OPENROUTER_API_KEY'], url: 'https://openrouter.ai' },
};

const row = (status, name, detail, fix) => ({ status, name, detail, fix });
const quote = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
const errorCode = error => error.code || (error instanceof SyntaxError ? 'invalid JSON' : 'invalid configuration');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readableFile(path) {
  if (!(await stat(path)).isFile()) throw Object.assign(new Error(), { code: 'not a regular file' });
  await access(path, constants.R_OK);
}

// The package currently uses caret ranges (major > 0) and >=, joined with ||.
export function supportedNode(version, range) {
  const actual = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  if (!actual) return false;
  return range.split('||').some(part => {
    const match = /^(\^|>=)(\d+)\.(\d+)\.(\d+)$/.exec(part.trim());
    if (!match) return false;
    const minimum = match.slice(2).map(Number);
    const difference = actual.map((n, i) => n - minimum[i]).find(n => n !== 0) || 0;
    return difference >= 0 && (match[1] === '>=' || actual[0] === minimum[0]);
  });
}

async function checkNode(version) {
  try {
    const { engines } = await readJson(join(PACKAGE_ROOT, 'package.json'));
    const supported = supportedNode(version, engines.node);
    return row(supported ? 'ok' : 'fail', 'node', `${version}; required ${engines.node}`,
      supported ? undefined : 'nvm install --lts && nvm use --lts');
  } catch (error) {
    return row('fail', 'node', `cannot read package requirements (${errorCode(error)})`, 'npm install -g swarm-search');
  }
}

async function findExecutable(command, env) {
  const hasPath = isAbsolute(command) || /[/\\]/.test(command);
  const names = process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(command)
    ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')].map(ext => command + ext.toLowerCase()) : [command];
  const paths = hasPath ? names.map(name => resolve(name))
    : (env.PATH || '').split(delimiter).filter(Boolean).flatMap(dir => names.map(name => join(dir, name)));
  let broken;
  for (const path of paths) {
    try {
      if (!(await stat(path)).isFile()) { broken = { path, error: 'not a regular file' }; continue; }
      await access(path, constants.X_OK | constants.R_OK);
      return { path };
    } catch (error) {
      // Absent optional commands are unconfigured; stale symlinks/permissions are broken.
      if ((error.code !== 'ENOENT' && error.code !== 'ENOTDIR') || await lstat(path).catch(() => null)) {
        broken = { path, error: errorCode(error) };
      }
    }
  }
  return broken || null;
}

async function pluginBundle(root) {
  const manifest = await readJson(join(root, '.claude-plugin', 'plugin.json'));
  if (manifest?.name !== 'swarm-search') throw new Error('invalid manifest');
  await Promise.all(['bin/swarm-search.mjs', 'src/mcp.mjs', 'commands/swarm-search.md', 'skills/swarm-search/SKILL.md']
    .map(path => readableFile(join(root, path))));
}

async function checkPlugin(env) {
  const root = resolve(env.CLAUDE_PLUGIN_ROOT || PACKAGE_ROOT);
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || env.USERPROFILE || homedir(), '.claude');
  try {
    await pluginBundle(root);
    if (env.CLAUDE_PLUGIN_ROOT) return { root, check: row('ok', 'plugin', `host plugin bundle readable at ${root}`) };
    let registry;
    try { registry = await readJson(join(configDir, 'plugins', 'installed_plugins.json')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { root, check: row('not configured', 'plugin', 'bundle present; Claude Code registration absent (optional for CLI/MCP)', INSTALL_PLUGIN) };
    }
    if (!plainObject(registry?.plugins)) throw new Error('invalid plugin registry');
    const entries = Object.entries(registry.plugins)
      .filter(([name]) => name === 'swarm-search' || name.startsWith('swarm-search@'))
      .flatMap(([name, installs]) => (Array.isArray(installs) ? installs : [installs]).map(install => ({ name, ...install })))
      .filter(install => !install.projectPath || resolve(install.projectPath) === resolve(process.cwd()));
    if (!entries.length) return { root, check: row('not configured', 'plugin', 'Claude Code registration absent (optional for CLI/MCP)', INSTALL_PLUGIN) };
    let installed;
    for (const entry of entries) {
      if (typeof entry.installPath !== 'string') continue;
      try { await pluginBundle(entry.installPath); installed = entry; break; } catch { /* try another registered scope */ }
    }
    if (!installed) return { root, check: row('fail', 'plugin', 'registered install path is missing, unreadable or incomplete', INSTALL_PLUGIN) };
    let settings = {};
    try { settings = await readJson(join(configDir, 'settings.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (settings?.enabledPlugins?.[installed.name] === false) {
      return { root: installed.installPath, check: row('warn', 'plugin', 'installed but disabled in Claude Code settings', `claude plugin enable ${quote(installed.name)}`) };
    }
    return { root: installed.installPath, check: row('ok', 'plugin', `registered bundle readable at ${installed.installPath}`) };
  } catch (error) {
    return { root, check: row('fail', 'plugin', `bundle or registration unreadable (${errorCode(error)})`, INSTALL_PLUGIN) };
  }
}

async function checkMcp(root, path, env) {
  const fix = 'swarm-search install claude-code --write';
  if (path !== undefined && typeof path !== 'string') return row('fail', 'mcp', '--mcp-config requires a JSON file path', 'swarm-search doctor --mcp-config /path/to/config.json');
  path = path || join(root, '.mcp.json');
  try {
    const config = await readJson(path);
    if (!plainObject(config)) throw new Error('invalid config');
    const entry = (config.mcpServers || config)['swarm-search'];
    if (!entry) return row('not configured', 'mcp', `no swarm-search entry in ${path}`, fix);
    if (entry.url && !entry.command) return row('warn', 'mcp', 'remote MCP entry; client connection not probed', 'swarm-search install claude-desktop');
    if (typeof entry.command !== 'string' || !entry.command || !Array.isArray(entry.args) || !entry.args.every(arg => typeof arg === 'string')) throw new Error('invalid entry');
    const expand = value => value.replace(/\$\{([^}]+)\}/g, (_, key) => {
      if (key === 'CLAUDE_PLUGIN_ROOT') return root;
      const replacement = entry.env?.[key] ?? env[key];
      if (typeof replacement !== 'string') throw new Error('unresolved variable');
      return replacement;
    });
    const executable = await findExecutable(expand(entry.command), { ...env, ...entry.env });
    if (!executable || executable.error) return row('fail', 'mcp', `MCP command missing or not executable (${executable?.error || 'not found'})`, fix);
    const args = entry.args.map(expand);
    const index = args.indexOf('mcp');
    if (index === -1) return row('fail', 'mcp', 'stdio entry must invoke the mcp command', fix);
    const script = args[index - 1];
    if (script && /\.[cm]?js$/.test(script)) {
      await readableFile(isAbsolute(script) ? script : resolve(root, script));
    } else if (!/(^|[/\\])swarm-search(?:\.cmd)?$/.test(entry.command)) {
      return row('warn', 'mcp', 'launcher found; package launch not executed', 'swarm-search install claude-desktop');
    }
    return row('ok', 'mcp', `stdio config and entry point readable at ${path}; client activation not checked`);
  } catch (error) {
    return row('fail', 'mcp', `cannot use ${path} (${errorCode(error)})`, fix);
  }
}

// Opening TCP/TLS does not invoke an HTTP endpoint, even on custom OpenAI-compatible servers.
export function probeEndpoint(url, { timeoutMs = 1500 } = {}) {
  return new Promise((resolveProbe, reject) => {
    let socket;
    const timer = setTimeout(() => finish(Object.assign(new Error(), { code: 'ETIMEDOUT' })), timeoutMs);
    function finish(error) {
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(error); else resolveProbe();
    }
    try {
      const options = { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) };
      const secure = url.protocol === 'https:';
      if (secure && !isIP(options.host)) options.servername = options.host;
      socket = secure ? tlsConnect(options) : tcpConnect(options);
      socket.once(secure ? 'secureConnect' : 'connect', () => finish());
      socket.once('error', finish);
    } catch (error) { finish(error); }
  });
}

async function checkProvider(provider, env) {
  const name = `provider ${provider.id}`;
  if (provider.kind === 'cli') {
    const metadata = CLI[provider.id];
    if (!metadata) return { configured: false, check: row('warn', name, 'no free diagnostic defined', 'swarm-search providers') };
    const [command, fix] = metadata;
    const executable = await findExecutable(command, env);
    if (!executable) return { configured: false, check: row('not configured', name, `${command} absent from PATH; install this CLI or use Claude CLI`, fix) };
    if (executable.error) return { configured: false, check: row('fail', name, `${command} is not executable (${executable.error})`, fix) };
    return { configured: true, check: row('ok', name, `${command} executable at ${executable.path}; login, network and quota not checked`) };
  }
  const metadata = API[provider.id];
  if (!metadata) return { configured: false, check: row('warn', name, 'no free diagnostic defined', 'swarm-search providers') };
  const keys = metadata.keys.join(' / ');
  const configured = metadata.keys.some(key => env[key]?.trim());
  if (!configured) return { configured: false, check: row('not configured', name, `${keys} missing; network probe skipped`, `export ${metadata.keys[0]}='<your-key>'`) };
  let url;
  try {
    url = new URL(provider.id === 'openai' ? env.OPENAI_BASE_URL || metadata.url : metadata.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid URL');
  } catch {
    return { configured: true, check: row('fail', name, 'invalid endpoint URL', 'unset OPENAI_BASE_URL') };
  }
  try {
    await probeEndpoint(url);
    return { configured: true, check: row('ok', name, `${keys} present; ${url.protocol === 'https:' ? 'TLS' : 'TCP'} reachable at ${url.host}; credentials and quota not checked`) };
  } catch (error) {
    return { configured: true, check: row('fail', name, `${keys} present; endpoint unreachable (${errorCode(error)}); restore DNS/network access`, `curl -I --connect-timeout 3 -- ${quote(url.origin + '/')}`) };
  }
}

async function checkProviders(env) {
  const results = await Promise.all(PROVIDERS.map(provider => checkProvider(provider, env)));
  const selection = (env.SWARM_PROVIDER || 'auto').trim();
  const known = new Set(PROVIDERS.map(provider => provider.id));
  const valid = ['', 'auto', 'mixed'].includes(selection) || selection.split(',').every(part => known.has(part.trim().split(':')[0]));
  const count = results.filter(result => result.configured).length;
  const summary = !valid ? row('fail', 'providers', 'unknown SWARM_PROVIDER selection', 'unset SWARM_PROVIDER')
    : row(count ? 'ok' : 'not configured', 'providers', `${count} locally configured; selection ${['', 'auto', 'mixed'].includes(selection) ? selection || 'auto' : 'explicit'}`,
      count ? undefined : INSTALL_CLI);
  return [summary, ...results.map(result => result.check)];
}

async function checkCache(path) {
  const replacement = join(process.cwd(), '.swarm-cache');
  const fix = `mkdir -p -- ${quote(replacement)} && export TMPDIR=${quote(replacement)}`;
  if (path !== undefined && typeof path !== 'string') return row('fail', 'cache', '--cache-dir requires a directory path', fix);
  path = path || tmpdir();
  try {
    if (!(await stat(path)).isDirectory()) return row('fail', 'cache', `${path} is not a directory`, fix);
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
    return row('ok', 'cache', `${path}; read/write/search permissions available (no files written)`);
  } catch (error) {
    return row('fail', 'cache', `${path} unavailable (${errorCode(error)})`, fix);
  }
}

export async function diagnose({ cacheDir, mcpConfig } = {}) {
  const env = process.env;
  const plugin = await checkPlugin(env);
  const [node, mcp, providers, cache] = await Promise.all([
    checkNode(process.versions.node), checkMcp(plugin.root, mcpConfig, env), checkProviders(env), checkCache(cacheDir),
  ]);
  return [node, plugin.check, mcp, ...providers, cache];
}

export const doctorExitCode = checks => checks.some(check => check.status === 'fail') ? 1 : 0;

export function formatCheck(check) {
  const line = `[${check.status}] ${check.name}: ${check.detail}${check.fix ? `; fix: ${check.fix}` : ''}`;
  return line.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
