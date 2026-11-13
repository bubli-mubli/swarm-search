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
