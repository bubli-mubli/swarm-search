# Threat model

## What this project does and where untrusted input enters

swarm-search is a dependency-free Node.js CLI and MCP server. It splits a question into
sub-questions, sends them to several cheap LLM workers in parallel and has one more model merge their
reports into an answer with sources. Workers either search the web, or read a slice of local files
(files mode). The workers are local CLIs (`claude`, `codex`, `agy`, `gemini`, spawned through
`src/providers/base.mjs`) or HTTP APIs (Anthropic, OpenAI, Google, OpenRouter).

Untrusted input enters at these places:

1. **Streamable HTTP MCP server** (`swarm-search mcp --http`, `serveHttp` in `src/mcp.mjs`). Any
   network peer, and any web page the operator's browser opens, can send requests. The controls that
   must hold:
   - `originAllowed`: a browser `Origin` must be a loopback host or listed in
     `SWARM_HTTP_ALLOWED_ORIGINS`. This is the defence against DNS rebinding and cross-site requests
     to a loopback server. A request with no `Origin` (a non-browser client) is allowed.
   - A bearer token (`--token` / `SWARM_HTTP_TOKEN`) is required to bind any non-loopback host,
     including `0.0.0.0`. When a token is set, every request to the MCP path must carry
     `Authorization: Bearer <token>`.
   - Body limit of 4 MiB, one JSON-RPC message per request, no batches.
   - Every HTTP request is treated as **remote**, even over loopback, because tunnels (ngrok,
     cloudflared) arrive on loopback. For remote calls:
     - files mode is off unless the operator sets `SWARM_FILES_ROOTS`;
     - CLI providers that can read the server's disk (`localFiles`: codex, agy, gemini) are never
       used, neither as workers nor for synthesis.
2. **MCP tool arguments** (`swarm_search` in `src/mcp.mjs`): `query`, `paths`, `provider`, `model`,
   `synth_provider`, `synth_model`, `angles`, `language`. These come from a remote client, or from a
   local agent that may itself be prompt-injected. `provider`/`model` strings end up in the argv of
   spawned CLIs (no shell). The prompt goes through stdin or argv, depending on the CLI.
3. **Paths in files mode** (`collectFiles` in `src/corpus.mjs`).
   - For remote clients:
     - each path is resolved with `realpath` and must lie inside one of `SWARM_FILES_ROOTS`, so a
       symlink that points outside is rejected;
     - hidden files and directories inside a root are refused;
     - secret-looking files (`.env`, keys, `credentials.json`, kubeconfig, ...; see
       `isSecretFile`) are skipped.
   - For any client:
     - directory walks skip dotfiles, symlinks (`Dirent.isFile()` is false for them), binaries,
       files over 400 KB and the secret patterns;
     - files mode never uses a provider whose web access cannot be turned off (`webAlwaysOn`: agy),
       so file contents have no exfiltration channel through search.
4. **Content of web pages and files.** It reaches worker prompts, and worker reports then reach the
   gap-audit, critique and synthesis prompts. The final answer goes back to an agent that usually has
   tools. This is the prompt-injection path. Code-level controls in `src/swarm.mjs`:
   - worker reports and file slices are wrapped in `<<<DATA <tag> ...>>>` / `<<<END DATA <tag>>>>`
     lines. The tag is random per run, and wrapper-like lines inside the content are broken, so the
     content cannot close the block;
   - role-spoofing lines (`System:`, `User:`, `Assistant:`, `Human:`, `Developer:` at line start) and
     chat-template markup (`<|im_start|>`, `<|system|>`, `[INST]`, `<<SYS>>`, `<system>`, ...) are
     neutralized before they enter those prompts (`neutralizeRoleSpoofing`, `wrapUntrusted`);
   - `verifySources` marks sources in the answer that no worker report contains;
   - `filterRetractions` drops critique-round retractions that cite no refuting source;
   - the MCP output starts with `UNTRUSTED_NOTE`.

   The system-prompt wording (`DATA_BOUNDARY`) is best effort, not a control.
5. **Local CLI use** (`swarm-search run`, stdio `mcp`, `install --write`). The caller is the local
   user, who is trusted. `install --write` edits the user's MCP client configs on request.

## Components that matter most / least

- Most important:
  - `src/mcp.mjs`: HTTP transport, Origin and bearer checks, the remote flag, the files-mode gate;
  - `src/corpus.mjs`: root containment, symlink handling, the hidden and secret file filters;
  - the provider gating in `swarmSearch` (`localFiles`, `webAlwaysOn`, `remote`);
  - `src/providers/base.mjs` (process spawning).
- Important: the prompt-injection controls in `src/swarm.mjs` (`neutralizeRoleSpoofing`,
  `wrapUntrusted`, `verifySources`, `filterRetractions`).
- Less important: `src/install.mjs` (user-invoked, local), `bench/` (maintainer tooling, never run by
  the server).
- Out of scope: vulnerabilities inside the third-party CLIs and APIs themselves (Claude Code, Codex,
  Antigravity, Gemini CLI, provider HTTP APIs), and answer quality or hallucinations.

## How to exercise it

- `npm test` runs the whole suite offline (`node --test test/*.test.mjs`), with no LLMs and no
  network. Real providers are replaced by fakes: tests register an object with
  `id`/`family`/`defaultModel`/`detect`/`complete` into `byId` from `src/providers/index.mjs`. The
  same trick lets a script drive `swarmSearch()` and `callTool()` end to end without any model,
  including files mode with `remote: true` and `filesRoots`.
- HTTP server, offline:
  - `node bin/swarm-search.mjs mcp --http --port 8787` binds loopback without a token;
  - `node bin/swarm-search.mjs mcp --http --host 0.0.0.0 --token T --files-roots /tmp/root` requires
    the token and allows files mode under `/tmp/root`.

  Example request:
  `curl -s localhost:8787/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`.
  Without providers in the image, `tools/call swarm_search` fails at provider resolution, which runs
  before the files are collected. To reach the path checks over HTTP, start the server from a script
  that first registers a fake provider.
- Places worth a close look:
  - `originAllowed` lets requests without an `Origin` through and counts the hostname `0.0.0.0` as
    loopback;
  - the bearer token is compared with `!==`, not in constant time;
  - `/health` and CORS preflight answer before the token check;
  - between the `realpath` containment check of an explicitly named file and the later
    `readFile(abs)` in `readNumbered`, the path can be swapped (TOCTOU);
  - `provider`/`model` strings from remote clients are passed into CLI argv.

## How you rate severity

- **Critical:**
  - an unauthenticated network peer reads arbitrary files on the server or runs code (RCE, argv or
    command injection into a spawned CLI);
  - the bearer-token requirement for non-loopback binds can be bypassed.
- **High:**
  - a remote client reads files outside `SWARM_FILES_ROOTS`, or hidden or secret files inside it
    (symlink, `..`, TOCTOU, case or Unicode tricks);
  - a remote client gets a `localFiles` provider (codex/agy/gemini) to run;
  - a web page in the operator's browser makes tool calls to a loopback server (DNS rebinding, Origin
    bypass);
  - files mode runs with a provider that has web access on.
- **Medium:**
  - content from a page or file defeats a code-level injection control: it closes or forges a data
    wrapper, gets role or chat-template markup past `neutralizeRoleSpoofing`, or gets an unverified
    source marked as verified;
  - a pre-auth DoS of the HTTP server (memory or CPU exhaustion before the token check).
- **Low:**
  - DoS or cost burn by an authenticated client (every call costs tokens by design);
  - information leaks in error messages;
  - issues that need the attacker to already be the local user (stdio, `run`, `install`).
- Not a vulnerability by itself: a model that follows injected text although every code-level control
  worked. Prompt-level defences are best effort. Report it if a code change would have stopped it.

## Anything to leave alone

- Missing third-party dependencies or lockfiles: the project has no runtime or dev dependencies on
  purpose.
- Real provider calls: the audit image has no network and no LLM credentials. Use fake providers as
  described above.
- `bench/` results and `bench/questions.json` content.
- Reports and patches: a minimal reproducer (an `npm test`-style test case is ideal) and a patch that
  keeps the zero-dependency rule.
