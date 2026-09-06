// Регистрация MCP-сервера в конфигах клиентов: Claude Desktop, Codex, Antigravity, Gemini CLI, Claude Code.
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
export const BIN_PATH = resolve(here, '..', 'bin', 'swarm-search.mjs');
const SERVER_NAME = 'swarm-search';

export const CLIENTS = ['claude-code', 'claude-desktop', 'codex', 'agy', 'gemini-cli'];

function claudeDesktopConfigPath() {
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform() === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

// Путь к node: предпочитаем стабильную ссылку из PATH (например /opt/homebrew/bin/node),
// а не process.execPath, который у Homebrew указывает на версионную папку Cellar и протухает при обновлении.
export function nodeCommand() {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, platform() === 'win32' ? 'node.exe' : 'node');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // ищем дальше
    }
  }
  return process.execPath;
}

export function stdioEntry() {
  return { command: nodeCommand(), args: [BIN_PATH, 'mcp'] };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

async function readJson(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`cannot parse ${path}: ${err.message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${path}: expected a JSON object at top level`);
  return parsed;
}

async function writeWithBackup(path, content) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await copyFile(path, `${path}.bak`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await writeFile(path, content);
}

async function mergeJsonConfig(path, key) {
  const cfg = await readJson(path);
  if (cfg[key] != null && !isPlainObject(cfg[key])) throw new Error(`${path}: "${key}" must be an object`);
  cfg[key] = cfg[key] || {};
  cfg[key][SERVER_NAME] = stdioEntry();
  await writeWithBackup(path, JSON.stringify(cfg, null, 2) + '\n');
  return path;
}

function tomlBlock() {
  const { command, args } = stdioEntry();
  return `\n[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nstartup_timeout_sec = 30\n`;
}

// Возвращает описание того, что будет сделано, и функцию apply().
export function planInstall(client) {
  switch (client) {
    case 'claude-desktop': {
      const path = claudeDesktopConfigPath();
      return {
        summary: `add mcpServers.${SERVER_NAME} to ${path}`,
        snippet: JSON.stringify({ mcpServers: { [SERVER_NAME]: stdioEntry() } }, null, 2),
        apply: () => mergeJsonConfig(path, 'mcpServers'),
        after: 'Restart Claude Desktop. The swarm_search tool appears under the tools menu.',
      };
    }
    case 'gemini-cli': {
      const path = join(homedir(), '.gemini', 'settings.json');
      return {
        summary: `add mcpServers.${SERVER_NAME} to ${path}`,
        snippet: JSON.stringify({ mcpServers: { [SERVER_NAME]: stdioEntry() } }, null, 2),
        apply: () => mergeJsonConfig(path, 'mcpServers'),
        after: 'Run `gemini` and check `/mcp` — swarm-search should be listed.',
      };
    }
    case 'codex': {
      const path = join(homedir(), '.codex', 'config.toml');
      return {
        summary: `append [mcp_servers.${SERVER_NAME}] to ${path}`,
        snippet: tomlBlock().trim(),
        apply: async () => {
          let current = '';
          try {
            current = await readFile(path, 'utf8');
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
          }
          // Старый блок вырезаем целиком (до следующей секции), чтобы установка была идемпотентной.
          const re = new RegExp(`\\n?\\[mcp_servers\\.${SERVER_NAME}\\][^\\[]*`, 'g');
          const cleaned = current.replace(re, '\n');
          await writeWithBackup(path, cleaned.trimEnd() + '\n' + tomlBlock());
          return path;
        },
        after: 'Codex CLI and the ChatGPT desktop Codex app read this file on next start.',
      };
    }
    case 'agy': {
      const { command, args } = stdioEntry();
      const cmd = ['agy', 'mcp', 'add', SERVER_NAME, '--', command, ...args];
      return {
        summary: `run: ${cmd.join(' ')}`,
        snippet: cmd.join(' '),
        apply: () => {
          try {
            execFileSync('agy', ['mcp', 'remove', SERVER_NAME], { stdio: 'ignore' });
          } catch {
            // не было — нормально
          }
          execFileSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
          return 'agy mcp list';
        },
        after: 'Check with `agy mcp list`.',
      };
    }
    case 'claude-code': {
      const cmds = ['claude plugin marketplace add jumpleGo/swarm-search', 'claude plugin install swarm-search@jumplego'];
      return {
        summary: `run: ${cmds.join(' && ')}`,
        snippet: cmds.join('\n'),
        apply: () => {
          for (const c of cmds) {
            const [bin, ...rest] = c.split(' ');
            execFileSync(bin, rest, { stdio: 'inherit' });
          }
          return 'claude plugin list';
        },
        after: 'Restart Claude Code; use /swarm-search <question> or just ask for a swarm search.',
      };
    }
    default:
      throw new Error(`Unknown client "${client}". Known: ${CLIENTS.join(', ')}`);
  }
}
