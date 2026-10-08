#!/usr/bin/env node
// CLI: swarm-search run|mcp|providers|install
import { swarmSearch } from '../src/swarm.mjs';
import { serveStdio, serveHttp } from '../src/mcp.mjs';
import { detectAvailable, PROVIDERS } from '../src/providers/index.mjs';
import { planInstall, CLIENTS } from '../src/install.mjs';

const USAGE = `swarm-search — parallel LLM workers + one synthesizer

Usage:
  swarm-search run "<question>" [--workers N|auto] [--rounds 1|2] [--round2 gaps|critique]
                                [--provider P] [--model M] [--paths a,b] [--mode web|files]
                                [--synth-provider P] [--synth-model M] [--language ru] [--json]
    workers: omit (auto) and the planner decides how many angles the question has (1-8);
    rounds 2: a second round after workers see round-1 results — "gaps" fills contradictions and
    unanswered parts with targeted follow-ups, "critique" makes every worker review the others.
  swarm-search mcp                      MCP server over stdio (Claude Code/Desktop, Codex, Antigravity, Gemini CLI)
  swarm-search mcp --http [--port 8787] [--host 0.0.0.0] [--token SECRET]
                                        MCP over Streamable HTTP (ChatGPT connectors, remote clients)
  swarm-search providers                Show which providers are usable on this machine
  swarm-search install <client> [--write]
                                        Print (or with --write apply) config for: ${CLIENTS.join(', ')}

Providers: auto | mixed | ${PROVIDERS.map((p) => p.id).join(' | ')}   (add ":model" to pin a model)
Env: SWARM_PROVIDER, SWARM_WORKERS (fixed default; unset = auto), SWARM_MAX_AUTO_WORKERS, SWARM_ROUNDS, SWARM_ROUND2,
     SWARM_TIMEOUT_MS, SWARM_SHARD_CHARS, SWARM_HTTP_TOKEN, SWARM_HTTP_ALLOWED_ORIGINS,
     SWARM_CLAUDE_MODEL, SWARM_CODEX_MODEL, SWARM_AGY_MODEL, SWARM_GEMINI_MODEL,
     SWARM_ANTHROPIC_MODEL, SWARM_OPENAI_MODEL, SWARM_GOOGLE_MODEL, SWARM_OPENROUTER_MODEL,
     SWARM_OPENROUTER_MIXED_MODEL (OpenRouter model in mixed mode), SWARM_CLAUDE_LEAN=0 (full Claude Code context for workers)
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  switch (cmd) {
    case 'mcp': {
      if (flags.http) {
        serveHttp({
          port: Number(flags.port) || Number(process.env.PORT) || 8787,
          host: flags.host || (flags.token || process.env.SWARM_HTTP_TOKEN ? '0.0.0.0' : '127.0.0.1'),
          token: flags.token || process.env.SWARM_HTTP_TOKEN,
        });
      } else serveStdio();
      return;
    }
    case 'providers': {
      const available = await detectAvailable();
      for (const p of PROVIDERS) {
        console.log(`${available.includes(p) ? '✓' : '✗'} ${p.id.padEnd(11)} ${p.label}${p.defaultModel ? ` — default model: ${p.defaultModel}` : ''}`);
      }
      if (!available.length) process.exitCode = 1;
      return;
    }
    case 'install': {
      const client = positional[0];
      if (!client) {
        console.error(`Usage: swarm-search install <${CLIENTS.join('|')}> [--write]`);
        process.exitCode = 2;
        return;
      }
      const plan = planInstall(client);
      console.log(`# ${plan.summary}\n`);
      console.log(plan.snippet);
      if (flags.write) {
        const where = await plan.apply();
        console.log(`\nApplied → ${where}`);
      } else {
        console.log('\n(dry run — add --write to apply)');
      }
      console.log(`\n${plan.after}`);
      return;
    }
    case 'run': {
      const query = positional.join(' ').trim();
      if (!query) {
        console.error('run: question is required');
        process.exitCode = 2;
        return;
      }
      const { markdown, report } = await swarmSearch({
        query,
        workers: flags.workers,
        provider: flags.provider,
        model: flags.model,
        paths: flags.paths ? String(flags.paths).split(',') : [],
        mode: flags.mode,
        synthProvider: flags['synth-provider'],
        synthModel: flags['synth-model'],
        language: flags.language,
        rounds: flags.rounds,
        round2: flags.round2,
        onProgress: (m) => process.stderr.write(`· ${m}\n`),
      });
      if (flags.json) console.log(JSON.stringify({ markdown, report }, null, 2));
      else console.log(markdown);
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command "${cmd}"\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`swarm-search: ${err.message}`);
  process.exitCode = 1;
});
