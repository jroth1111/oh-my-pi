# Fork upgrade onto upstream 18.6.0

## Authority and preservation

Upstream is the implementation base, not a conflicting patch to the old fork.

- Upstream base: `6d8552d7f9df1852826923f07f0eed4fe29511f3` (`can1357/oh-my-pi`, v18.6.0).
- Preserved fork: `b67e931ffcc1aa73b0d6332a1c5f3b599a976198`.
- Backup branch: `backup/fork-before-upstream-18.6.0-20261004`.
- Upgrade branch: `upgrade/upstream-18.6.0-20261004`.
- The working merge has upstream as its first parent and the preserved fork as its second parent. It is intentionally uncommitted and unpushed.
- Original untracked `.sol/` and `.unlazy/` are outside the upgrade and were not edited.

The effective old-fork delta contained 416 paths, including 223 added files. All 223 added files remain available. Ten previously modified paths now use upstream unchanged: seven non-chat gateway route modules, the AI barrel, the provider-quirks documentation, and the removed monolithic settings schema. Their surviving additions are represented by upstream equivalents or ported to the settings registry and shared gateway interfaces.

## Adaptations

| Fork capability | Upstream-based adaptation |
| --- | --- |
| Gateway routes, fallback trees, commit gates, decision traces, management APIs | Ported into the current transport-independent router, shared by HTTP and stdio; credential resolution now preserves upstream's `ResolvedApiKey` snapshots. |
| Credential reservations, quota probes, incarnation tracking | Composed with upstream's replaceable store-bound auth modules, refresh recovery, scope-aware blocks, and account policies. |
| Cursor CLI controls, auto routing, tools, discovery | Kept current upstream HTTP/1 and HTTP/2 transports, client identity, rich discovery, and nested default-model protobuf shape. Preserved roster wire IDs, default-model fallback, capability controls, and routed-model notifications. |
| Cursor passthrough | Kept upstream's unhandled-MCP handoff behavior distinct from explicit passthrough, which must never execute a supplied local handler. |
| Grokbot | Retained provider, discovery, login/host-secret hooks, wire mappings, and KDL policy. Generated six offline seed rows without fetching private account entitlements. |
| Devin | Retained wire/auth additions and private-catalog boundaries on top of upstream's current discovery, metadata helpers, and seed policy. |
| Incomplete todos and parent verification | Ported to upstream's settings handles, compaction pipeline, lifecycle-event mapper, and isolation interfaces. Kept upstream's no-stash cherry-pick behavior and preserved partial/empty merge accounting. |
| Explicit empty tool whitelist | Preserved across session-managed tools, custom tools, and deferred MCP activation. |
| RPC consumers | Added `routed_model`, `unverifiedMerge`, and `droppedBy` to the authoritative wire definitions; regenerated TypeScript, Python, Rust, and Go artifacts. |

All 74 upstream bundled providers were independently compared with the upstream snapshot and remain unchanged. Only the new `grokbot` seed provider was added. Regeneration used:

```sh
bun run gen:compat
bun --cwd=packages/catalog run gen:models --offline-provider=grokbot
bun --cwd=packages/coding-agent run gen:rpc
```

The offline seed generator updates only explicitly selected authored seed providers. It does not read credentials or discover private catalogs.

## Verification

Verified during the upgrade:

- Frozen-lockfile dependency installation.
- TypeScript lint, formatting, and types across every workspace package (`bun run check:ts`). Lint warnings remain; no lint errors.
- AI/provider suite: 6,058 passing tests, 291 skipped live/optional tests, zero failures in the recorded full run. An additional explicit-passthrough regression was subsequently added and passed.
- Catalog suite: 1,145 passing tests, zero failures, plus the focused offline-seed and current-default-model regressions.
- Coding-agent singleton suite: 1,150 passing tests; UI suite: all 67 chunks passed; runtime suite: all 32 chunks passed with concurrency limited to two.
- Python RPC SDK: 105 tests and 26 subtests passed; Go RPC SDK tests passed; Rust RPC SDK compiled successfully.
- Native addon built with `nightly-2026-08-12`.
- Compiled `packages/coding-agent/dist/omp` reports `omp/18.6.0` and passes `--smoke-test`; the source CLI smoke also passed.
- No unresolved Git conflict markers; staged diff whitespace validation passed.

Final additional verification:

- Rust: all 3,100 tests passed, plus doctests; nightly formatting/clippy passed. The four initial hook-fixture failures were fixed by creating the fixture's own `.git/hooks` directory, without changing global Git configuration.
- Full `bun check` passed with the isolated matching nightly formatter/clippy components. All seven workspace test commands passed with the endpoint/multiplexer environment overrides removed only from the verification subprocess (`workspace-clean-env-final.log`).
- Utils: full isolated suite passed (833 tests run).
- Agent core: full suite passed (705 tests run) with the shell's `ANTHROPIC_BASE_URL` override removed only from the verification subprocess.
- TUI: full suite passed (3,262 tests run) with Herdr identity markers removed only from the verification subprocess. Upstream correctly suppresses glyph probing inside Herdr, so ambient pane markers invalidate the direct-terminal fixture.
- Native/tooling/browser: 82 of 86 chunks passed in the broad low-concurrency run. The residual browser, config-value, and collab files subsequently passed together (99 tests run, `native-residuals-final.log`); the collab timeout fixture now virtualizes only the connect deadline, not subsequent real socket publication/teardown.

Remaining limitation: three unchanged upstream `cli-non-tty-launch.test.ts` prompt cases still fail or time out. Their fixture expects an empty-credential launch to report `No models available`, but the process enters print mode and emits `Working...`. Credential/endpoint scrubbing and an explicitly isolated agent directory did not resolve it. The failure is not classified as upstream-only or harmless, and the upgrade is not claimed to have an entirely green full suite. The compiled worker smoke passes, but the residual no-model CLI scenario needs further diagnosis. The unsuccessful fixture experiments were fully reverted to upstream. See `cli-non-tty-final.log`, `cli-no-model-fixture.log`, and `cli-isolated-agent-final.log`.

Two directories left by interrupted/failed test fixtures were moved out of the checkout into the private verification directory's `leftover-fixtures/`; they remain recoverable. No original user directories were removed.

The installed nightly toolchain's manifest reports rustfmt/clippy as installed although their executables are missing. Matching official component archives were downloaded into the private verification directory and checked against SHA-256 values from the installed toolchain manifest; verification uses those isolated tools, without changing the active toolchain or global configuration.

Full verification logs are owner-only under `/private/tmp/omp-upgrade-verify.sm3zWF/`. No live-provider success is claimed for skipped E2E tests, and no installed global `omp`/`ompf` binary was replaced.
