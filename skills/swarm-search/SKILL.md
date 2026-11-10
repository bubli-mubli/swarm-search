---
name: swarm-search
description: Broad research (comparisons, state of the art, opinions, prices/versions) or file searches via swarm_search MCP. AgentRouter (default when available) / Claude / GPT / Gemini workers synthesize a sourced summary. Skip simple lookups and questions answerable from context.
---

# Swarm search

The `swarm_search` tool (MCP server `swarm-search`) does map-reduce research:

1. a planner splits the question into N sub-questions,
2. N workers run in parallel — web search (default) or a scan of local files when `paths` is given,
3. one synthesizer merges the reports into an answer with `[n]` references and a Sources list.

## When to call it

- Broad research: "what is the current state of X", "compare A vs B vs C", "risks and criticism of Y".
- Facts that change over time: versions, prices, benchmarks, release dates.
- Scanning a big repo or docs folder for a pattern, a behaviour, or every place something happens
  (`paths: ["src", "docs"]`) — much cheaper than reading the files yourself.
- Cross-model sanity check: `provider: "mixed"` spreads workers across Claude, GPT and Gemini so the
  synthesis shows where model families disagree.

## When NOT to call it

- Single-fact lookups a normal web search answers in one step.
- Anything already answerable from the conversation or a couple of files.
- Tasks that need actions (edits, commands) — the swarm is read-only.

## How to call it

Minimal: `swarm_search({ query })`. Useful options:

| arg | meaning |
|---|---|
| `paths` | directories/files to scan → files mode |
| `workers` | omit → auto: the planner decides how many independent angles the question has (1–8). Pass a number only when the user asked for one |
| `rounds` | `1` (default) or `2`. Use 2 when the question is contested, the answer depends on conflicting sources, or `provider` is `mixed` |
| `round2` | `gaps` (default, cheap: auditor + a few follow-up workers) or `critique` (every worker reviews the others; N extra calls) |
| `provider` | `auto` (AgentRouter → agy → Claude; compatible only), `mixed` (one per model family), or an id like `arcodex-cli`, `arclaude-cli`, `claude-cli`, `codex-cli`, `agy-cli`, `anthropic`, `openai`, `google`, `openrouter`; `id:model` pins a model |
| `synth_provider` / `synth_model` | stronger model for the final synthesis only |
| `angles` | your own sub-questions, skips the planner |
| `language` | force answer language |

Sizing rules: leave `workers` unset so a narrow factual question costs one worker and a broad comparison
gets one per facet. Add `rounds: 2` for "is X true / which is better / people disagree" questions;
prefer `round2: "critique"` together with `provider: "mixed"` so different model families check each other.

Before calling, tell the user in one line that a swarm search is running and may take a few minutes.
Return the tool output verbatim; it is already formatted. Never restate the findings without the
`[n]` references — the sources are the point.

If the tool answers "No LLM provider available", run `swarm_providers` and relay which CLI/API key
the user needs to set up.
