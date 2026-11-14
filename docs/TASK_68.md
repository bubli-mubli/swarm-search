# Task 68: HTTP-backed source verification

Hypothesis: requiring an actual HTTP 200 and a verbatim quote in the fetched page prevents
model assertions from turning unvisited sources into checked facts (Vera's vc.ru/ai/3226615 report).

Initial snapshot: `749a924`, clean working tree, no difference from `origin/main`.
Task 6 (files selection and AgentRouter) and fallback task 306 were already merged and are preserved.

## Reproduction before and after

The first commit, `e9c73be`, adds only a regression test to the old implementation.
Reproduce without changing the current checkout:

```sh
git worktree add --detach .scratch/task68/before e9c73be
(cd .scratch/task68/before && node --test test/web-verification.test.mjs)
git worktree remove .scratch/task68/before
```

Expected before: exit 1, `FAILS_ON_OLD`, `actual: 1`, `expected: 0`: a worker's URL with
`VERIFIED=yes` and forged fetch metadata is counted as verified without any request.
This was reproduced both before the fix and from the committed old checkout.

After the fix:

```sh
node --test test/web-verification.test.mjs
npm test
```

Expected: the no-fetch source becomes `VERIFIED=unverified (no_fetch)` in both the worker report
and final output. Only actual HTTP 200 plus the same finding's quote in the body produces
`VERIFIED=yes`. HTTP 201/404, missing quotes, network failures, timeouts, fabricated receipts,
and a quote borrowed from another finding cannot grant verification.

## Changes and compatibility

- `src/web-verification.mjs`: fetch and quote checks at each web-worker stage; trusted in-memory
  receipts; at most 12 fetched URLs, 10 seconds and 2 MiB per page. HTML formatting, common entities
  and whitespace are normalized; script/style/comment content does not serve as quote evidence.
- `src/swarm.mjs`: workers request a same-line `Quote: "exact passage"`; both rounds are checked
  before audit/synthesis. Model labels are replaced. Source checks require receipts and expose
  reasons in `report.sourceCheck.verification`; workers expose `sourceVerification`.
- `test/web-verification.test.mjs`: red regression plus real local HTTP tests, cancellation,
  quote isolation, forged metadata and both rounds.
- `test/swarm.test.mjs`: two prior tests intentionally change their URL-verification expectations
  from presence-only to no-fetch = unverified, with extra reason assertions. Existing path/range,
  citation and invented-source assertions remain. No metric scripts or test skipping changed.
- `README.md`, `README.ru.md`, `skills/swarm-search/SKILL.md`: explain labels and reasons.

No dependencies or provider/stdin logic changed. CLI flags, MCP schemas, output envelope, footer
format and existing source-check fields remain; verification data is additive. File references
keep their original range check, and files workers perform no HTTP fetch.

## Validation, 2026-11-13 UTC

`npm test` completed with exit 0, including AgentRouter argv/parsing/fallback, task 306 quota
fallback, files-mode regression and MCP stdio/HTTP checks:

```text
ℹ tests 71
ℹ suites 0
ℹ pass 71
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12616.277336
```

Full output: `.scratch/task68/npm-test.log`; old-code failure:
`.scratch/task68/fails-on-old-commit.log` (workspace files, not ephemeral /tmp).

An actual external HTTP check of `https://example.com` found `Example Domain` with status 200:
`sourceVerification: [{url: "https://example.com", quote: "Example Domain", verified: "yes", status: 200}]`.
Evidence: `.scratch/task68/live-http.log`.

Two free CLI smoke attempts did not complete a live worker report. Explicit agy exited with code 3.
With `--provider arcodex-cli,agy-cli`, AgentRouter returned an HTML/WAF captcha; the existing
fallback advanced to agy, which exited with code 3. Logs:
`.scratch/task68/live-worker-progress.log`, `.scratch/task68/live-router-progress.log`.
No paid APIs were called.

The installed `swarm-search` points to `agent-hq/repos/swarm-search/bin/swarm-search.mjs`, not this
workspace. The task branch was pushed normally; the production/plugin installation was not
replaced. Deployment and live-worker validation remain **unverified**, pending rollout and
working free provider access. A fetched quote proves text presence, not correctness of its interpretation.

## Follow-up #331: SSRF guard and files-mode no-fetch policy

Hypothesis: checking every resolved destination and every redirect, with no source requests in
files mode, prevents model-provided verification URLs from reaching private VM services.

Baseline: `dcae39a`, the current `origin/main` after shipping #68; clean working tree on
`hq/nika/331`. `git fetch origin` and `git ls-remote --heads origin master main hq/nika/331`
confirmed that the requested `origin/master` does not exist. No remote master branch or synthetic
tracking alias was created. Diff size is therefore measured against the actual `origin/main`.
Before writing, `df -B1 /home` reported **23,048,040,448 bytes available**, above the 1 GB minimum.

### Changes

- `src/source-fetch.mjs` uses only Node built-ins. IPv4/IPv6 literals and every DNS answer are
  checked before requests. Loopback, private, link-local, unspecified, IPv4-mapped private IPv6,
  carrier NAT, benchmark, multicast and IPv6 site-local addresses are blocked. Denials produce
  `VERIFIED=unverified (blocked_address)`. The fetch dispatcher uses Node HTTP(S) with a pinned
  lookup containing only checked addresses, preserving Host/TLS validation and public dual-stack
  alternatives; connecting cannot perform another DNS lookup or silently use a proxy.
- Fetch always uses `redirect: 'manual'`. At most three redirects are followed; each destination
  is parsed, resolved and checked again. Redirect bodies are cancelled. Lookup failures, redirect
  limit, request/body failures and timeouts remain `no_fetch`; the prior 10 s / 12 URLs / 2 MiB
  limits and exact quote/HTTP 200 checks remain.
- `src/web-verification.mjs` recognizes bracketed IPv6 URLs, trusts only internally produced
  receipts and guards `mode: 'files'` before any DNS/fetch. Files URLs receive
  `VERIFIED=unverified (no_fetch_files_mode)`, including URLs carrying a quote and a model's
  forged `VERIFIED=yes`.
- `src/swarm.mjs` applies this offline policy to both files-worker rounds and retains receipts
  through synthesis. Local `path:line` checks remain. CLI flags, MCP schema, output envelope,
  footer, provider order and provider/stdin logic are unchanged. Receipts/reasons are additive.
- `TASK_68.md` was moved to `docs/TASK_68.md` using `git mv`. README translations and the shipped
  skill explain the new reasons without changing invocation or output handling.

### Red regressions, followed by fixes

`008fc7f` contains the SSRF regressions before their fix (`5f78afd`): **8 tests, 8 failures**.
`a6fbc50` contains the files regressions before their fix (`029959b`): **3 tests, 3 failures**.
`ba42620` contains a public dual-stack pinning regression before `1250af6`: **1 test, 1 failure**.
Each corresponding targeted suite passed after its fix.

The final 11 SSRF/files tests were also copied into a detached checkout of the original
`dcae39a`: **11 tests, 11 failures**, exit 1. Reproduce from this branch:

```sh
git worktree add --detach .scratch/task331/before dcae39a
cp test/source-fetch-safety.test.mjs test/files-source-verification.test.mjs .scratch/task331/before/test/
(cd .scratch/task331/before && node --test test/source-fetch-safety.test.mjs test/files-source-verification.test.mjs)
rm .scratch/task331/before/test/source-fetch-safety.test.mjs .scratch/task331/before/test/files-source-verification.test.mjs
git worktree remove .scratch/task331/before
```

After the fix, run `node --test test/source-fetch-safety.test.mjs test/files-source-verification.test.mjs`
or `npm test`. Loopback fetch calls are zero; a redirect to `10.0.0.1` makes only the initial public
request and becomes `blocked_address`. Direct files verification and both `gaps`/`critique`
integration runs perform zero fetch and zero DNS calls, and synthesis preserves `no_fetch_files_mode`.

Existing HTTP tests were adapted because real production loopback access is now correctly blocked:
the fixture supplies public DNS answers and maps only the test HTTP transport to its local server,
asserting the pinned addresses. Actual HTTP 200/201/404, streamed bodies, quote and forged-receipt
assertions are preserved. The new critique test's count was corrected from an assumed single shard
to one critique per actual first-round worker; all those workers are checked. No skips, weakened
assertions, metric changes or dependencies were introduced.

### Validation

Final `npm test` (exit 0), including CLI/MCP compatibility, AgentRouter argv/parsing/fallback,
quota fallback and files-mode fallback:

```text
ℹ tests 83
ℹ suites 0
ℹ pass 83
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6312.963698
```

Full output: `.scratch/task331/npm-test.log`. Red evidence: `ssrf-red.log`, `files-red.log`,
`fails-on-old.log` and `dns-pin-red.log` in the same workspace directory (no ephemeral `/tmp`).
`node bin/swarm-search.mjs providers` passed. A live HTTPS check of `https://example.com` returned
HTTP 200 and found `Example Domain`, granting `VERIFIED=yes`; evidence is `live-public-http.log`.
No paid API calls or production rollout were performed. The installed plugin is not this workspace;
production validation after rollout remains outstanding, so this report does not claim deployment.
