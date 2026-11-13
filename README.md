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
question ──► planner (1 call) ──► N sub-questions (N chosen by the planner, 1–8)
                                      │
                 ┌────────────────────┼────────────────────┐
                 ▼                    ▼                    ▼
           worker 1 (web)       worker 2 (web)   ...  worker N (web)      ← Haiku / GPT / Gemini
                 └────────────────────┼────────────────────┘
                                      ▼
               optional round 2: gap-filling follow-ups  or  cross-critique
                                      ▼
                             synthesizer (1 call) ──► answer + [n] sources
```

**Who decides how many workers?** By default the planner: it reads the question and returns one
sub-question per genuinely independent angle, so a narrow fact costs one worker and a five-way
comparison gets five. Pass `workers: N` to force a number.

**Do workers talk to each other?** Not in round 1: independence is what makes the synthesis catch
errors. With `rounds: 2` they do, after the fact:

- `round2: "gaps"` (default) — an auditor reads all round-1 reports, lists contradictions and
  unanswered parts, and a few targeted follow-up workers resolve just those. Cheap: 1 + up to 4 calls.
- `round2: "critique"` — every worker sees the anonymized reports of the others and replies with
  Confirmed / Disputed / Retracted / Missing, with sources. N extra calls. Strongest with
  `provider: "mixed"`, where Claude, GPT and Gemini check each other.

In **files mode** (`paths` given) the corpus is sharded instead: every worker reads a slice of files
with line numbers and reports `path:line` findings; the synthesizer merges them. Round 2 in files
mode re-reads the shards that had findings with the follow-up questions.

Files mode never sends secrets to workers: `.env*` (templates `.env.example`/`.sample`/`.template`
are kept), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `*.tfstate`, `id_*` SSH keys,
`credentials`/`credentials.json`, `.npmrc`, `.netrc`, `.git-credentials`, `.pgpass`, `.pypirc`,
`secrets.{json,yaml,yml,toml,env,ini}`, `kubeconfig`, `.kube/config`, `.docker/config.json` and
`*service-account*.json` are dropped both while walking a directory and when named explicitly. Workers run without web access in files mode: Claude CLI gets
no web tools, Codex gets `web_search="disabled"`, Gemini CLI gets a policy that denies
`google_web_search`/`web_fetch`, and `agy-cli` (whose web search cannot be turned off) is skipped
for files shards and synthesis.

Files priority: Claude CLI → Codex CLI → Gemini CLI → APIs (Anthropic, OpenAI, Google, OpenRouter).
AgentRouter gets the reserved first priority in #6.

Worker and critique prompts carry a data boundary: text from web pages, files and other reports is
data, embedded instructions are not followed but listed under `## Uncertain` / `## Not found`.
Before worker reports and file slices go into the gap-audit, critique and synthesis prompts, the code
neutralizes role spoofing in them: lines that pose as a chat turn (`System:`, `User:`, `Assistant:`,
`Human:`, `Developer:` at line start, also after markdown or `  12| ` line numbers) become
`[quoted User]:`, and chat-template markup (`<|im_start|>`, `<|system|>`, `<｜User｜>`, `[INST]`,
`<<SYS>>`, `<system>`, `<s>` …) gets its brackets swapped for `‹ ›`. Each report or slice is then
wrapped in `<<<DATA <tag> …>>>` / `<<<END DATA <tag>>>>` lines with a random tag per run, and any
wrapper-like line inside the content is broken, so the content cannot close the block and talk as
the orchestrator. Wording and line numbers stay intact, so `path:line` citations still hold.
The MCP tool output starts with a note that the content was compiled from untrusted sources.

**Answer quality checks done in code, not only in prompts:**

- *Source check.* After synthesis every URL and `path:line` in the Sources list and in the answer
  text must appear in a round-1 or round-2 worker report as a whole token: URLs match exactly (only a
  trailing `/` is ignored), `path:line` matches the same path with the line inside a line or range
  the worker cited (`src/a.mjs:12` is found in `src/a.mjs:10-14`, not in `src/a.mjs:120`). Refs that
  don't match are marked "source not found in worker reports"; a Sources entry with no URL or
  `path:line` is marked "no URL or path:line, cannot verify" and counts as unverified. Every `[n]`
  in the text must be in the list and vice versa, mismatches are listed in a "Source check" line.
  The footer shows `sources traced to worker reports k/n`, details are in `report.sourceCheck`
  (`bodyUnverified` lists refs from the text). This only traces sources back to worker reports:
  URLs are not opened and it does not check that a source supports the claim.
- *Grounded retractions.* In `critique` a worker may move a claim to `## Retracted` only with the
  refuting source (URL or `path:line`) taken from another worker's report. Retractions without one
  are removed before synthesis, so a correct fact is not dropped just because the majority said
  otherwise; the footer counts them (`report.retractions`). A bullet continued on indented lines
  is kept or dropped as a whole, `- none` / `- None of my claims.` are not counted.
- *Failover.* A worker that fails with HTTP 402/429/5xx, a timeout, a rate-limit/quota error or an
  empty answer is retried once on the next pool slot with a different provider (e.g.
  `provider: "openrouter,claude-cli"` or `mixed`); 429 waits `SWARM_RETRY_BACKOFF_MS` first.
  The footer shows `retried k`, each retried worker has `retriedFrom` in the report.
- *File ranking (files mode).* When the corpus is larger than `SWARM_RANK_CHARS` (480k chars ≈
  8 shards), files are ranked by BM25 against the question (path tokens weigh more, files named in
  the question come first) and only the top files that fit the budget are sharded. The footer says
  `ranked files: kept/total kept, N dropped`, and the synthesizer is told coverage is partial.
  `rank: "on"` always orders files by relevance, `"off"` disables ranking.

## Requirements

- Node.js `^22.23.4 || ^24.22.1 || >=26.12.1` (releases with the Brotli security patch; any
  other version, including Node 20 and the end-of-life lines 23 and 25, gets an `engines` warning on
  install, and an install with `engine-strict` fails)
- at least one worker backend:

| provider id | what it uses | needs | default model |
|---|---|---|---|
| `claude-cli` | `claude -p` (Claude Code CLI) | Claude subscription, `claude` in PATH | `haiku` |
| `codex-cli` | `codex exec` (OpenAI Codex CLI) | ChatGPT subscription, `codex` in PATH | `gpt-6-luna` (`SWARM_CODEX_MODEL=` = your Codex default) |
| `agy-cli` | `agy -p` (Google Antigravity CLI) | Antigravity login, `agy` in PATH | `gemini-3.8-flash-low` |
| `gemini-cli` | `gemini -p` (Gemini CLI) | Google login / `GEMINI_API_KEY` | `gemini-3.5-flash-lite` |
| `anthropic` | Messages API | `ANTHROPIC_API_KEY` | `claude-haiku-5-5` |
| `openai` | Responses API | `OPENAI_API_KEY` | `gpt-6-luna` |
| `google` | Gemini API | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `gemini-3.5-flash-lite` |
| `openrouter` | chat/completions | `OPENROUTER_API_KEY` | `anthropic/claude-haiku-5.5` |

`swarm-search providers` shows which ones are usable on your machine. `auto` picks the first
available in the order above; every default model can be overridden with `SWARM_<PROVIDER>_MODEL`.

In `mixed` mode OpenRouter brings a separate model family, `deepseek/deepseek-v4.1-flash`
(`SWARM_OPENROUTER_MIXED_MODEL`), instead of a second Haiku. A cheap DeepSeek worker by hand:
`--provider openrouter:deepseek/deepseek-v4.1-flash`.

`claude-cli` workers run without MCP servers, skills, plugins and your CLAUDE.md
(`--strict-mcp-config --disable-slash-commands --setting-sources ''`), so one web worker uses about
6k tokens of context instead of hundreds of thousands. `SWARM_CLAUDE_LEAN=0` restores the full harness.
The answer footer shows tokens for all calls, cost (where the provider reports it) and the cost per useful worker answer.

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

Files mode is **disabled** for HTTP clients by default (a tunnel arrives on loopback, so every
HTTP request counts as remote). To allow it, list the directories remote clients may read with
`SWARM_FILES_ROOTS=/srv/docs,/srv/repo` or `--files-roots /srv/docs,/srv/repo`: each path is
resolved with `realpath` and must lie inside one of the roots, so symlinks and `..` cannot escape;
hidden files and directories inside a root (`.git`, `.ssh`, `.npmrc`, …) are refused even when
named explicitly. Stdio clients are not restricted.

HTTP clients also never get workers that can read the server's disk on their own: `codex-cli`
(its `-s read-only` sandbox still lets shell commands read any file), `agy-cli` (file tools are
auto-approved in plan mode) and `gemini-cli` (reads the server's working directory) are skipped
for remote calls in every mode, workers and synthesis alike. Use `claude-cli` (web tools only) or
an API provider; a pool with only those three CLIs fails with an error.

## Usage

### MCP tool `swarm_search`

| argument | meaning |
|---|---|
| `query` | the question (required) |
| `mode` | `auto` (default) · `web` · `files` |
| `paths` | files/dirs to scan → files mode |
| `workers` | fixed worker count (max 12); omit for auto sizing by the planner |
| `rounds` | `1` (default) or `2` |
| `round2` | `gaps` (default) or `critique` |
| `provider` | `auto` · `mixed` · provider id · `id:model` · comma list for round-robin |
| `model` | worker model override |
| `synth_provider`, `synth_model` | use a stronger model for the final synthesis only |
| `angles` | your own sub-questions, skips the planner |
| `language` | force answer language |
| `rank` | files mode: `auto` (default) · `on` · `off`, see file ranking above |

`swarm_providers` lists usable backends.

### CLI

```bash
swarm-search run "state of WebGPU in 2026: browser support, frameworks, gotchas" --workers 6
swarm-search run "where do we validate JWT?" --paths src,server --provider codex-cli
swarm-search run "is Bun ready for production?" --provider mixed --rounds 2 --round2 critique --synth-provider claude-cli:sonnet
swarm-search run "..." --json           # full report with per-worker output
```

### Environment

| variable | default | purpose |
|---|---|---|
| `SWARM_PROVIDER` | `auto` | default provider spec |
| `SWARM_WORKERS` | unset = auto | fixed default worker count |
| `SWARM_MAX_AUTO_WORKERS` | `8` | upper bound for auto sizing |
| `SWARM_ROUNDS` / `SWARM_ROUND2` | `1` / `gaps` | default rounds and round-2 mode |
| `SWARM_TIMEOUT_MS` | `180000` | per-call timeout |
| `SWARM_SHARD_CHARS` | `60000` | max characters per files-mode shard |
| `SWARM_RANK` | `auto` | files-mode ranking: `auto` (only above `SWARM_RANK_CHARS`), `on`, `off` |
| `SWARM_RANK_CHARS` | `480000` | corpus size that turns ranking on and the budget of kept files |
| `SWARM_RETRY_BACKOFF_MS` | `1500` | pause before retrying a worker that got HTTP 429 |
| `SWARM_HTTP_TOKEN` | – | bearer token for `mcp --http` (required when binding a non-loopback host) |
| `SWARM_HTTP_ALLOWED_ORIGINS` | – | comma-separated browser origins allowed besides localhost (`mcp --http`) |
| `SWARM_FILES_ROOTS` | – | comma-separated directories remote `mcp --http` clients may scan in files mode; unset = files mode off over HTTP |
| `SWARM_CLAUDE_MODEL`, `SWARM_CODEX_MODEL`, `SWARM_AGY_MODEL`, `SWARM_GEMINI_MODEL`, `SWARM_ANTHROPIC_MODEL`, `SWARM_OPENAI_MODEL`, `SWARM_GOOGLE_MODEL`, `SWARM_OPENROUTER_MODEL` | see table | per-provider default model |

## Cost and time

A 4-worker web run is 6 model calls (1 plan + 4 workers + 1 synthesis) and takes 1–3 minutes with
CLI backends. Round 2 adds 1 audit + up to 4 follow-ups (`gaps`) or N critiques (`critique`). CLI providers run on your subscriptions; API providers bill per token. Workers are
read-only: `claude -p` gets only WebSearch/WebFetch, `codex exec` runs with `-s read-only`,
`agy`/`gemini` run in plan mode. Read-only still means codex, agy and gemini can read local files,
so for local runs a prompt injection in a page or file could make them quote one; remote HTTP
clients never get these providers (see above).

## Development

```bash
npm test                       # unit tests (no network)
node bin/swarm-search.mjs providers
node bin/swarm-search.mjs run "..." --workers 2
```

### Provider benchmark

Before switching the cheap default model, compare providers on a fixed set: `bench/questions.json`
holds 15 questions with checkable facts (12 web, 3 files queries over this repo).

```bash
npm run bench -- claude-cli openrouter:deepseek/deepseek-v4.1-flash openrouter:minimax/minimax-m3.1-flash
npm run bench -- codex-cli --only rust-1.0,files-http-port --workers 1 --out bench/codex.json
```

Each argument is one provider spec (workers and synthesis both run on it). The JSON result has per
provider: `accuracy` (share of facts found in the answer), `successes` (answers with all facts),
`nonEmptyRate`, `costPerSuccessUsd` (total cost / successful answers, `null` if any run was not
fully priced), `avgSec`, `sourcesVerified/sourcesTotal` and per-question runs. The benchmark calls
real models and costs money; `npm test` only runs it against fakes.

Layout: `src/swarm.mjs` pipeline · `src/providers/*` one file per backend · `src/corpus.mjs`
file sharding · `src/mcp.mjs` stdio + HTTP transports · `src/install.mjs` client configs ·
`.claude-plugin/`, `commands/`, `skills/`, `.mcp.json` Claude Code plugin surface.

Adding a provider: export `{ id, family, kind, label, defaultModel, detect(), complete({ system, prompt, model, web, timeoutMs, signal }) → { text, usage? } }`
and add it to `PROVIDERS` in `src/providers/index.mjs`.

## License

MIT
