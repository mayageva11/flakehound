# flakehound 🐕

[![ci](https://github.com/mayageva11/flakehound/actions/workflows/ci.yml/badge.svg)](https://github.com/mayageva11/flakehound/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![Tests](https://img.shields.io/badge/tests-133%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

**Live dashboard:** [mayageva11.github.io/flakehound](https://mayageva11.github.io/flakehound/) — rendered from a real `flakehound.report.json`.

**Root-cause analysis for flaky tests.** Existing tools count pass/fail and tell you *that* a test is flaky — flakehound clusters failures by their underlying cause and tells you **"23 failures over 3 weeks = 4 unique bugs"**, separates genuinely flaky tests from hard regressions, and gates your CI on *new* regressions only.

```
flakehound — 12 test runs across 4 files, 3 tests analyzed

Regressions (1)
  ✗ shop.spec.ts > payment — broken since bbb2222
      failing in 100% of the last 3 run(s) since commit bbb2222; passed before it

Flaky tests — quarantine candidates (1)
  ~ shop.spec.ts > checkout — score 1.00 (medium confidence)
      1 pass↔fail transition(s) on the same commit

Failure clusters (2) — ranked by impact
  1. [7a7c11808d52] 3 occurrence(s) across 1 test(s)
      AssertionError: expected cart total to equal charged amount at PaymentPage.verify (payment-page.ts:<N>:<N>)
  2. [a8a64e2d45ec] 2 occurrence(s) across 1 test(s)
      TimeoutError: Timeout <DURATION> exceeded waiting for locator('#pay-button') at CheckoutPage.pay (checkout-page.ts:<N>:<N>)

CI gate: 1 new, 0 known, 0 resolved regression(s)
```

## How it works

1. **Ingest** — parses JUnit XML (the universal CI format: Jest, Playwright, pytest, JUnit) across a history of runs.
2. **Signal** — scores flakiness by *transition frequency* (pass↔fail flips on the same commit, retry flips within a run), **not** naive fail rate. A test failing 100% since a specific commit is a **regression**, not flaky — the two are mutually exclusive.
3. **Cluster** — normalizes stack traces (strips line numbers, addresses, durations, path prefixes — keeps error classes, function names, filenames) and groups structurally identical failures. Similarity is **head-weighted**: error-class/message tokens weigh double, so the bug's identity dominates shared library frames. Guiding principle: *prefer false-split over false-merge* — the tool exists to surface bugs, never to hide them.
4. **Interpret** (optional) — sends each cluster's representative trace to a pluggable inference provider — a local Ollama model when one is reachable (zero cost, nothing leaves your machine), else the Claude API when `ANTHROPIC_API_KEY` is set — for a one-line root-cause hypothesis. The deterministic core works identically without either.
5. **Report + gate** — terminal report, `flakehound.report.json` artifact, and exit codes usable as a CI gate. With a baseline, clusters are also diffed — a **NEW** cluster means a bug shape never seen before (informational; only new *regressions* fail the gate). `flakehound explain <testId>` prints any test's run-by-run story.

## Quick start

```sh
# 1. Install (or run everything through npx, no install needed)
npm install --save-dev flakehound

# 2. Point your test runner at JUnit XML output — Jest, Playwright,
#    pytest, JUnit, Surefire… every major runner emits it.

# 3. Scaffold a commented config (optional — sensible defaults otherwise)
npx flakehound init

# 4. Analyze your run history
npx flakehound analyze
```

That's the whole integration: JUnit XML in, root-cause analysis out. No plugins,
no per-runner adapters, no account.

## Commands

| Command | What it does |
|---|---|
| `flakehound analyze` | Analyze the JUnit XML history: score flakiness, isolate regressions, cluster failures, gate CI |
| `flakehound explain <testId>` | One test's run-by-run story: history table, classification reasoning, its clusters |
| `flakehound init` | Scaffold a fully commented `flakehound.config.ts` (never overwrites; `--force` to replace) |

### `analyze` flags

| Flag | Meaning |
|---|---|
| `-i, --input <glob>` | JUnit XML glob (overrides config) |
| `-b, --baseline <path>` | previous report — regressions in it are *known* and don't re-fail the gate |
| `--json <path>` | report artifact path (default `flakehound.report.json`) |
| `--no-ai` | disable AI interpretation |
| `-c, --config <path>` | explicit config file |

**Exit codes:** `0` clean · `1` new regression(s) detected · `2` tool error (bad XML, bad config, or an input glob that matched **zero** files — a QA gate never silently passes on no evidence) — so CI can tell "found a bug" from "tool broke".

## Integration contract (run metadata)

Drop your JUnit XML files in a folder — flakehound works with zero metadata. Add more for commit-aware analysis; per XML file, the resolution chain is:

1. **Sidecar** `<name>.meta.json` next to the XML *(best — enables everything)*:
   ```json
   { "commitSha": "a1b2c3d", "timestamp": "2026-07-01T10:00:00Z", "runnerId": "ubuntu-22" }
   ```
2. **Directory name** convention `{sha}_{timestamp}/`, e.g. `a1b2c3d_2026-07-01T10-00/junit.xml`
3. **File mtime** — timestamp only; commit-aware signals degrade gracefully (flakiness falls back to time-ordered flips at low confidence; regression detection reports `insufficient-metadata` instead of guessing).

## CI integration

flakehound is CI-agnostic by construction: its only input is JUnit XML — the one format every CI ecosystem already emits (GitHub Actions, Jenkins, GitLab CI, CircleCI, TeamCity, …). There is no per-CI plugin and no per-CI code path. Integrating any CI means expressing three steps in that CI's native idiom:

1. **Run tests → JUnit XML** into a dated history folder (plus the optional metadata sidecar for commit-aware analysis).
2. **`flakehound analyze`** over the history, with the previous report as `--baseline`.
3. **Persist `flakehound.report.json`** for the next run, and act on the exit code (`0` clean · `1` new regression · `2` tool error).

The gate then fails **once** when a regression lands — not on every run until it's fixed. Two worked examples:

### GitHub Actions — the reusable action

The repo doubles as a composite action: it runs the analysis, writes a job
summary, gates on new regressions, and (optionally) upserts one PR comment with
the verdict, run strips, and clusters:

```yaml
- uses: mayageva11/flakehound@main
  with:
    input-glob: 'test-results/**/*.xml'
    baseline: flakehound.report.json   # optional
    comment: 'true'                    # PR comment on pull_request events
```

Outputs: `exit-code` (`0`/`1`/`2`) and `report-path`. Set
`fail-on-new-regressions: 'false'` to observe without gating.

### GitHub Actions — raw CLI

Baseline persistence via the cache:

```yaml
- name: Restore previous flakehound report
  uses: actions/cache/restore@v4
  with: { path: flakehound.report.json, key: flakehound-report }

- name: flakehound gate
  run: npx flakehound analyze --input 'test-results/**/*.xml' --baseline flakehound.report.json

- name: Save report for next run
  if: always()
  uses: actions/cache/save@v4
  with: { path: flakehound.report.json, key: flakehound-report-${{ github.run_id }} }
```

### Jenkins (declarative pipeline)

Full worked example: [`examples/jenkins/Jenkinsfile`](examples/jenkins/Jenkinsfile) — including writing the metadata sidecar from `$GIT_COMMIT` / `$NODE_NAME`. Baseline persistence uses build artifacts instead of a cache; the essentials:

```groovy
// previous build's report → this build's baseline (requires the copyartifact plugin)
copyArtifacts projectName: env.JOB_NAME, selector: lastCompleted(),
              filter: 'flakehound.report.json', optional: true
sh 'mv flakehound.report.json flakehound.baseline.json 2>/dev/null || true'

def rc = sh(returnStatus: true, script:
  "npx flakehound analyze --input 'flakehound-history/**/*.xml' " +
  "--baseline flakehound.baseline.json --json flakehound.report.json")
if (rc == 1) { error 'flakehound: new regression detected' }
else if (rc == 2) { unstable 'flakehound: tool error' }

// post { always { archiveArtifacts artifacts: 'flakehound.report.json', allowEmptyArchive: true } }
```

The one non-obvious choice is `lastCompleted()` rather than `lastSuccessful()`: a build that failed *because of* a new regression still archived its report, and that report is exactly what turns the regression from "new" (fails every build) into "known" (fails once, stays visible).

No baseline anywhere (first run, cache miss, missing artifact)? flakehound **fails safe**: every regression counts as new.

## Configuration

`flakehound.config.ts` (also `.js` / `.mjs` / `.json`) — TypeScript configs load at runtime via jiti; CLI flags override file values. `npx flakehound init` scaffolds a fully commented version of this file:

```ts
import { defineConfig } from 'flakehound';

export default defineConfig({
  input: 'test-results/**/*.xml',
  historyDays: 21,
  signal: {
    flakinessThreshold: 0.2, // score at which a test is called flaky
    minRuns: 3,              // minimum runs before classifying at all
    retryFlipWeight: 2,      // intra-run retry flips count double
  },
  cluster: {
    similarityThreshold: 0.7, // similarity for co-clustering
    weighting: 'head',        // error head weighs double; 'uniform' = plain Jaccard
  },
  ai: {
    enabled: true,            // --no-ai overrides
    provider: 'auto',         // 'auto' | 'ollama' | 'anthropic'
    model: 'claude-sonnet-5', // Anthropic model
    ollama: {
      baseUrl: 'http://localhost:11434',
      model: 'llama3.2',
    },
  },
});
```

## AI layer

Each cluster can be annotated with a one-line hypothesis (`race-condition` / `timeout` / `network` / `environment` / `assertion`). **AI interprets; it is never the source of truth** — it cannot affect scoring, clustering, cluster ids, or exit codes, and any provider failure degrades to a report without hypotheses.

### Inference providers — local-first, provider-agnostic

The hypothesis source sits behind a single `HypothesisProvider` interface, so *where* inference runs is an implementation detail the deterministic core never sees. Two providers ship today, chosen by a documented chain (`ai.provider: 'auto'`):

1. **Local Ollama reachable** (`http://localhost:11434` by default) → use it. Runs **entirely on your machine at zero API cost**, nothing leaves the box — the privacy-first default when a local model is present.
2. **Else `ANTHROPIC_API_KEY` set** → use the Claude API.
3. **Else** → skip hypotheses (the deterministic report is unchanged).

`--no-ai` forces the whole layer off regardless. Set `ai.provider` to `'ollama'` or `'anthropic'` to pin one explicitly.

This is a separation-of-concerns decision, not a feature bolt-on: adding a provider is implementing one method, selection is an explicit chain, and every failure path (unreachable endpoint, malformed JSON from a small local model, off-schema reply, timeout) degrades to *no hypothesis* with a single warning — the run never hangs or crashes. Small local models are noisier than a hosted model, so that graceful-degradation contract is enforced identically for both providers and covered by tests.

## Architecture

```
src/
├── ingest/      JUnit XML → canonical TestRun[]; metadata resolution chain
├── signal/      flakiness scoring (transition frequency) + regression classifier
├── cluster/     THE CORE: trace normalization → similarity → deterministic clustering
├── ai/          optional interpretation behind a HypothesisProvider interface
│                 (Ollama / Anthropic) — thin, at the edge, never source of truth
├── config/      flakehound.config.ts via jiti, zod-validated, flag overrides
├── report/      terminal report, JSON artifact, baseline diff (CI gate)
├── run.ts       pipeline orchestrator (injectable clock/client/streams)
└── cli.ts       commander entry point
```

### Design principles

- **Deterministic core, AI only at the edge.** Shuffled input produces byte-identical reports; the AI layer cannot affect scoring, clustering, ids, or exit codes.
- **Prefer false-split over false-merge.** A merged pair of distinct bugs hides a defect; a split bug is a duplicate resolved by eye. Every normalization rule must be justifiable as *unambiguously volatile* — which is why line numbers are stripped but HTTP status codes are preserved.
- **Flakiness ≠ fail rate.** A test failing 100% of the time isn't flaky — it's broken. Scoring counts pass↔fail *transitions* on the same commit (and retry flips within a run), and the regression classifier runs first, mutually exclusive.
- **Graceful degradation as a contract.** Missing metadata is a first-class case: signals downgrade confidence and say why, instead of guessing or crashing.
- **A QA tool practices what it preaches.** Every non-trivial module is unit-tested (133 tests), including shuffled-input determinism and exact threshold boundaries.

## Development

```sh
npm install
npm test           # vitest — the full suite
npm run typecheck  # strict TS
npm run build      # emit dist/
```

## Releasing

CI (typecheck + tests + build on Node 20/22, plus an action self-test) runs on
every push and PR. Publishing to npm is tag-driven: `npm version <x.y.z> &&
git push --follow-tags` triggers the release workflow, which publishes with
provenance. One-time setup: add an npm automation token as the `NPM_TOKEN`
repository secret.
