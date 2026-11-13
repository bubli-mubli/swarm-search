---
name: swarm-search
description: Run a parallel swarm search (N cheap workers + synthesis) on a question or over local files
argument-hint: <question> [--files path1,path2] [--workers N] [--rounds 2] [--round2 gaps|critique] [--provider auto|mixed|claude-cli|codex-cli|agy-cli|...]
---

Run a swarm search for: $ARGUMENTS

Steps:
1. Parse `$ARGUMENTS`. Everything before the first `--flag` is the `query`. Recognize optional flags:
   `--files a,b` → `paths` (files mode), `--workers N` → `workers` (omit otherwise: auto sizing),
   `--rounds 2` → `rounds`, `--round2 gaps|critique` → `round2`, `--provider X` → `provider`,
   `--model M` → `model`, `--lang L` → `language`.
2. Call the MCP tool `swarm_search` with those arguments. Do not run the research yourself
   and do not spawn subagents — the tool already fans out to parallel workers. It may take 1–5 minutes.
3. Present the returned markdown to the user as-is (it already contains the answer, findings with
   [n] references, disagreements and a Sources list). Add at most two sentences of your own if you see
   a contradiction with what you know from the current session.
4. If the tool reports that no provider is available, tell the user to run
   `node ${CLAUDE_PLUGIN_ROOT}/bin/swarm-search.mjs providers` and set up one CLI or API key.
