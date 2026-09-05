# swarm-search

Parallel "swarm" research for Claude, ChatGPT and Gemini clients, with **zero dependencies**.

One question goes in. A planner splits it into sub-questions, **N cheap workers** run in parallel
(web search, or a scan of local files), and **one synthesizer** merges everything into an answer with
`[n]` references and a Sources list. Workers default to **Claude Haiku** through your Claude Code
subscription; GPT (Codex CLI / OpenAI API) and Gemini (Antigravity CLI / Gemini CLI / Gemini API)
are one flag away, and `provider: "mixed"` spreads the workers across model families so the
synthesis shows where they disagree.

Ships as:

- a **Claude Code plugin** (`/swarm-search`, skill, MCP server),
- an **MCP server** over stdio for Claude Desktop, Codex CLI / ChatGPT desktop Codex, Antigravity, Gemini CLI,
- an **MCP server over Streamable HTTP** for ChatGPT connectors and any remote client,
- a **CLI** (`swarm-search run "..."`).

[Русская версия](./README.ru.md)

---

## How it works

```
question ──► planner (1 call) ──► N sub-questions
                                      │
                 ┌────────────────────┼────────────────────┐
                 ▼                    ▼                    ▼
           worker 1 (web)       worker 2 (web)   ...  worker N (web)      ← Haiku / GPT / Gemini
                 └────────────────────┼────────────────────┘
                                      ▼
                             synthesizer (1 call) ──► answer + [n] sources
```

In **files mode** (`paths` given) the corpus is sharded instead: every worker reads a slice of files
with line numbers and reports `path:line` findings; the synthesizer merges them.

## Requirements

- Node.js ≥ 20
- at least one worker backend:

| provider id | what it uses | needs | default model |
|---|---|---|---|
| `claude-cli` | `claude -p` (Claude Code CLI) | Claude subscription, `claude` in PATH | `haiku` |
| `codex-cli` | `codex exec` (OpenAI Codex CLI) | ChatGPT subscription, `codex` in PATH | your Codex default |
| `agy-cli` | `agy -p` (Google Antigravity CLI) | Antigravity login, `agy` in PATH | `gemini-3.8-flash-low` |
| `gemini-cli` | `gemini -p` (Gemini CLI) | Google login / `GEMINI_API_KEY` | `gemini-2.5-flash` |
| `anthropic` | Messages API | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` |
| `openai` | Responses API | `OPENAI_API_KEY` | `gpt-5-mini` |
| `google` | Gemini API | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `gemini-2.5-flash` |
| `openrouter` | chat/completions | `OPENROUTER_API_KEY` | `anthropic/claude-haiku-4.5` |

`swarm-search providers` shows which ones are usable on your machine. `auto` picks the first
available in the order above; every default model can be overridden with `SWARM_<PROVIDER>_MODEL`.

## Install

### Claude Code (plugin)

```bash
claude plugin marketplace add jumpleGo/swarm-search
claude plugin install swarm-search@jumplego
```

Then in any session:

```
/swarm-search what changed in Node.js 24 LTS vs 22, should we migrate now?
/swarm-search where are request timeouts handled --files src,server --workers 6
```

or just ask for a swarm search — the bundled skill tells Claude when to reach for the
`swarm_search` tool.

### Claude Desktop, Codex, Antigravity, Gemini CLI (stdio MCP)

```bash
git clone https://github.com/jumpleGo/swarm-search ~/swarm-search
cd ~/swarm-search
node bin/swarm-search.mjs install claude-desktop --write   # or: codex | agy | gemini-cli | claude-code
```

Without `--write` the command only prints the config snippet. It registers the server as:

```json
{ "mcpServers": { "swarm-search": { "command": "node", "args": ["/abs/path/bin/swarm-search.mjs", "mcp"] } } }
```

Codex gets a `[mcp_servers.swarm-search]` block in `~/.codex/config.toml` (also read by the
ChatGPT desktop app's Codex mode). Antigravity is registered with `agy mcp add`.

### ChatGPT (remote MCP connector)

ChatGPT only connects to **remote HTTPS** MCP servers, so run the HTTP transport and expose it:

```bash
SWARM_HTTP_TOKEN=$(openssl rand -hex 16) node bin/swarm-search.mjs mcp --http --port 8787
# in another shell
ngrok http 8787          # or: cloudflared tunnel --url http://localhost:8787
```

In ChatGPT enable Developer mode in settings and create a connector with URL
`https://<your-tunnel>/mcp` and Bearer auth using that token. The server is stateless
(JSON responses on `POST /mcp`, `GET /health`). The Gemini consumer app has no custom MCP
support; use Antigravity or Gemini CLI for Gemini.

## Usage

### MCP tool `swarm_search`

| argument | meaning |
|---|---|
| `query` | the question (required) |
| `mode` | `auto` (default) · `web` · `files` |
| `paths` | files/dirs to scan → files mode |
| `workers` | parallel workers, default 4, max 12 |
| `provider` | `auto` · `mixed` · provider id · `id:model` · comma list for round-robin |
| `model` | worker model override |
| `synth_provider`, `synth_model` | use a stronger model for the final synthesis only |
| `angles` | your own sub-questions, skips the planner |
| `language` | force answer language |

`swarm_providers` lists usable backends.

### CLI

```bash
swarm-search run "state of WebGPU in 2026: browser support, frameworks, gotchas" --workers 6
swarm-search run "where do we validate JWT?" --paths src,server --provider codex-cli
swarm-search run "is Bun ready for production?" --provider mixed --synth-provider claude-cli:sonnet
swarm-search run "..." --json           # full report with per-worker output
```

### Environment

| variable | default | purpose |
|---|---|---|
| `SWARM_PROVIDER` | `auto` | default provider spec |
| `SWARM_WORKERS` | `4` | default worker count |
| `SWARM_TIMEOUT_MS` | `180000` | per-call timeout |
| `SWARM_SHARD_CHARS` | `60000` | max characters per files-mode shard |
| `SWARM_HTTP_TOKEN` | – | bearer token for `mcp --http` (required when binding a non-loopback host) |
| `SWARM_HTTP_ALLOWED_ORIGINS` | – | comma-separated browser origins allowed besides localhost (`mcp --http`) |
| `SWARM_CLAUDE_MODEL`, `SWARM_CODEX_MODEL`, `SWARM_AGY_MODEL`, `SWARM_GEMINI_MODEL`, `SWARM_ANTHROPIC_MODEL`, `SWARM_OPENAI_MODEL`, `SWARM_GOOGLE_MODEL`, `SWARM_OPENROUTER_MODEL` | see table | per-provider default model |

## Cost and time

A 4-worker web run is 6 model calls (1 plan + 4 workers + 1 synthesis) and takes 1–3 minutes with
CLI backends. CLI providers run on your subscriptions; API providers bill per token. Workers are
read-only: `claude -p` gets only WebSearch/WebFetch, `codex exec` runs with `-s read-only`,
`agy`/`gemini` run in plan mode.

## Development

```bash
npm test                       # unit tests (no network)
node bin/swarm-search.mjs providers
node bin/swarm-search.mjs run "..." --workers 2
```

Layout: `src/swarm.mjs` pipeline · `src/providers/*` one file per backend · `src/corpus.mjs`
file sharding · `src/mcp.mjs` stdio + HTTP transports · `src/install.mjs` client configs ·
`.claude-plugin/`, `commands/`, `skills/`, `.mcp.json` Claude Code plugin surface.

Adding a provider: export `{ id, family, kind, label, defaultModel, detect(), complete({ system, prompt, model, web, timeoutMs, signal }) → { text, usage? } }`
and add it to `PROVIDERS` in `src/providers/index.mjs`.

## License

MIT
