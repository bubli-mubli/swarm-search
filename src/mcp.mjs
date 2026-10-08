// Минимальный MCP-сервер без зависимостей: stdio (Claude Code/Desktop, Codex, Gemini, Antigravity)
// и Streamable HTTP (ChatGPT connectors и любой удалённый клиент).
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { swarmSearch, DEFAULTS } from './swarm.mjs';
import { detectAvailable, PROVIDERS } from './providers/index.mjs';

export const SERVER_INFO = { name: 'swarm-search', version: '0.2.0' };
const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export const TOOLS = [
  {
    name: 'swarm_search',
    description:
      'Parallel swarm research. Splits the question into sub-questions, runs N cheap LLM workers in parallel ' +
      '(web search, or a scan of local files when `paths` is given), then one synthesizer returns a sourced summary. ' +
      'Use for broad research questions, multi-source comparisons, "what is the current state of X", or scanning a large codebase/doc set for something.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The research question or what to find.' },
        mode: { type: 'string', enum: ['auto', 'web', 'files'], description: 'auto = files if paths given, else web.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Local files/directories to scan (files mode).' },
        workers: {
          type: 'integer',
          minimum: 1,
          maximum: DEFAULTS.maxWorkers,
          description: `Fixed number of parallel workers. Omit for auto: the planner decides how many independent angles the question has (1-${DEFAULTS.maxAutoWorkers}).`,
        },
        rounds: {
          type: 'integer',
          enum: [1, 2],
          description: 'Default 1. Use 2 for contested or uncertain questions: a second round runs after workers see round-1 results (see round2).',
        },
        round2: {
          type: 'string',
          enum: ['gaps', 'critique'],
          description: '"gaps" (default): an auditor lists contradictions and unanswered parts, targeted follow-up workers resolve them. "critique": every worker reviews the others\' reports and confirms/disputes claims with sources (costs N extra calls).',
        },
        provider: {
          type: 'string',
          description:
            'Worker provider: auto | mixed | ' + PROVIDERS.map((p) => p.id).join(' | ') + '. ' +
            'Optional model after colon, e.g. "claude-cli:haiku" or "openrouter:deepseek/deepseek-v4.1-flash". Comma-separate to round-robin.',
        },
        model: { type: 'string', description: 'Worker model override for the chosen provider.' },
        synth_provider: { type: 'string', description: 'Provider spec for the final synthesis (default: same as workers).' },
        synth_model: { type: 'string', description: 'Model for the final synthesis.' },
        angles: { type: 'array', items: { type: 'string' }, description: 'Skip the planner and use these sub-questions directly.' },
        language: { type: 'string', description: 'Answer language (default: language of the query).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'swarm_providers',
    description: 'List LLM providers this machine can use for swarm workers (installed CLIs and API keys present).',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function callTool(name, args = {}, { onProgress, signal } = {}) {
  if (name === 'swarm_providers') {
    const available = await detectAvailable();
    const lines = PROVIDERS.map((p) => `${available.includes(p) ? '✓' : '✗'} ${p.id.padEnd(11)} ${p.label}${p.defaultModel ? ` (default model: ${p.defaultModel})` : ''}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  if (name === 'swarm_search') {
    const { markdown } = await swarmSearch({
      query: args.query,
      mode: args.mode,
      paths: args.paths,
      workers: args.workers,
      provider: args.provider,
      model: args.model,
      synthProvider: args.synth_provider,
      synthModel: args.synth_model,
      angles: args.angles,
      language: args.language,
      rounds: args.rounds,
      round2: args.round2,
      onProgress,
      signal,
    });
    return { content: [{ type: 'text', text: markdown }] };
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
}

// Создаёт контекст сессии: активные запросы (для отмены) и функция отправки уведомлений.
export function createSession({ notify } = {}) {
  return { notify, inflight: new Map() };
}

// Обрабатывает один JSON-RPC запрос. Возвращает ответ или null для уведомлений.
// `signal` — внешняя отмена (например, клиент HTTP закрыл соединение).
export async function handleMessage(msg, session = createSession(), { signal } = {}) {
  if (Array.isArray(msg)) {
    // Батчи убраны из MCP 2025-06-18; принимаем строго одно сообщение на фрейм.
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported' } };
  }
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined;
  const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

  try {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'Call swarm_search for broad research or large file scans. It runs several cheap model workers in parallel and can take 1-5 minutes.',
        });
      }
      case 'notifications/initialized':
        return null;
      case 'notifications/cancelled':
        session.inflight.get(params.requestId)?.abort();
        return null;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'resources/list':
        return ok({ resources: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
      case 'tools/call': {
        if (isNotification) return null;
        const controller = new AbortController();
        const onExternalAbort = () => controller.abort();
        signal?.addEventListener('abort', onExternalAbort, { once: true });
        session.inflight.set(id, controller);

        const token = params._meta?.progressToken;
        let step = 0;
        const onProgress = (message) => {
          process.stderr.write(`[swarm-search] ${message}\n`);
          if (token !== undefined && session.notify) {
            step += 1;
            session.notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: step, message } });
          }
        };
        try {
          return ok(await callTool(params.name, params.arguments || {}, { onProgress, signal: controller.signal }));
        } catch (err) {
          if (err.code === -32602) return fail(-32602, err.message);
          if (controller.signal.aborted) return fail(-32800, 'Request cancelled');
          // Ошибки выполнения инструмента возвращаем как результат с isError — так требует MCP.
          return ok({ content: [{ type: 'text', text: `swarm_search failed: ${err.message}` }], isError: true });
        } finally {
          session.inflight.delete(id);
          signal?.removeEventListener('abort', onExternalAbort);
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return fail(-32603, err.message);
  }
}

// ---- stdio ----
export function serveStdio() {
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const session = createSession({ notify: write });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // Не ждём завершения — иначе notifications/cancelled встанет в очередь за долгим tools/call.
    handleMessage(msg, session).then((res) => res && write(res));
  });
  rl.on('close', () => process.exit(0));
  process.stderr.write(`[swarm-search] MCP stdio server ready (${SERVER_INFO.version})\n`);
}

// ---- Streamable HTTP (stateless) ----
// Origin проверяем обязательно: без этого любая веб-страница могла бы дёргать localhost-сервер (DNS rebinding).
export function originAllowed(origin, allowed = []) {
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(host) || allowed.includes(origin);
}

export function serveHttp({
  port = 8787,
  host = '127.0.0.1',
  path = '/mcp',
  token = process.env.SWARM_HTTP_TOKEN,
  allowedOrigins = (process.env.SWARM_HTTP_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
} = {}) {
  if (!LOOPBACK_HOSTS.has(host) || host === '0.0.0.0') {
    if (!token) throw new Error(`refusing to bind ${host} without a bearer token (set --token or SWARM_HTTP_TOKEN)`);
  }
  const session = createSession();

  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const origin = req.headers.origin;
      if (!originAllowed(origin, allowedOrigins)) return res.writeHead(403).end('origin not allowed');
      if (origin) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'origin');
        res.setHeader('access-control-allow-headers', 'content-type, authorization, mcp-session-id, mcp-protocol-version');
        res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      if (url.pathname === '/health') return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      if (url.pathname !== path) return res.writeHead(404).end('not found');
      if (token && req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end('unauthorized');
      if (req.method === 'GET') return res.writeHead(405, { allow: 'POST' }).end('SSE stream not supported; use POST');
      if (req.method !== 'POST') return res.writeHead(405).end();

      let body = '';
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413).end('payload too large');
          req.destroy();
          return;
        }
        body += chunk;
      }
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
      if (Array.isArray(msg)) return res.writeHead(400).end('batch requests are not supported');

      const response = await handleMessage(msg, session, { signal: abort.signal });
      if (res.writableEnded || abort.signal.aborted) return;
      if (!response) return res.writeHead(202).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (err) {
      process.stderr.write(`[swarm-search] http error: ${err.message}\n`);
      if (!res.headersSent) res.writeHead(500).end('internal error');
      else res.end();
    }
  });
  server.listen(port, host, () => {
    process.stderr.write(`[swarm-search] MCP HTTP server on http://${host}:${port}${path}${token ? ' (bearer token required)' : ''}\n`);
  });
  return server;
}
