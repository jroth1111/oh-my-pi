# Native Grokbot interoperability survey

Reviewed through GitHub CLI on 2026-10-08. This is source evidence, not a vendor-supported contract or a promise of serving entitlement. No third-party proxy was installed and no account was switched.

## Findings used

- [river-li/brok-pot-harness, ead2cf14](https://github.com/river-li/brok-pot-harness/blob/ead2cf14dbf86ef30e17724e7e71b9b0566530a3/src/shared/node/cursor-backend/cursor-inference.ts#L183): workload JWT forwarding is conditional on supplied context. The [eval launcher](https://github.com/river-li/brok-pot-harness/blob/ead2cf14dbf86ef30e17724e7e71b9b0566530a3/src/sand-eval-runner/main.ts#L51) consumes an environment variable and request file; that does not establish that the JWT itself is single-use or mandatory on every Stream call.
- [taowen/grokbot2api, 90a77bc5](https://github.com/taowen/grokbot2api/blob/90a77bc575570da4482f91dfacfd1f659fd74cac/sand_inference.py#L526): the direct Stream header builder uses the inference bearer, machine checksum, and Sand client metadata without an attestation header. Metadata uses the separate session token.
- [Luxciax/grokbot2api, cbfa9387](https://github.com/Luxciax/grokbot2api/blob/cbfa9387b56b9fc15501145c26ba28cd7957b5ee/model_catalogue.py#L135): its newer catalog maps Opus 5.5 selectors to packed legacy slugs without separate effort/fast parameters. Its [protocol notes](https://github.com/Luxciax/grokbot2api/blob/cbfa9387b56b9fc15501145c26ba28cd7957b5ee/docs/protocol.md#L599) report the same permission error for insufficient account access, and elsewhere for obsolete bare-ID routes. The error alone does not identify which cause applies.
- [BaiMeou/cursor-sand2api, bb241060](https://github.com/BaiMeou/cursor-sand2api/blob/bb241060ce0b0e8d94bcaccf6c894084e6098be1/src/inference-protocol.js#L592): Claude text-tool mode omits protobuf tool declarations and replays textual tool history. [Limitations](https://github.com/BaiMeou/cursor-sand2api/blob/bb241060ce0b0e8d94bcaccf6c894084e6098be1/docs/limitations.md#L33) explicitly distinguish listing, account plans, quota, and serving. This is an experiment reference, not a reason to silently remove OMP tools or switch routes. Its code is AGPL; no code was copied.
- [HarryPD168/grok-bot-auth, 8fc50070](https://github.com/HarryPD168/grok-bot-auth/blob/8fc50070b1fc62b650271bc90305f62e9f059d05/src/sand.rs#L502): observed per-account serving limits are distinct from catalog visibility. Do not transplant its observed allowlist as a universal OMP policy.
- [BenItBuhner/Cursor-for-Android, 93bd11a5](https://github.com/BenItBuhner/Cursor-for-Android/blob/93bd11a5d1ebff8e99b3e95b6f0fdb19a5e2e82c/app/src/main/java/com/cursorforandroid/domain/ModelSlugs.kt#L5): selector parsing is derived from advertised parameters and variants; unknown names remain intact. OMP likewise preserves advertised routes rather than inventing an ID from a model-name regex.

## Not proof of native Cursor Opus

[BlockedPath/grok-bot-setup](https://github.com/BlockedPath/grok-bot-setup/blob/b9766667a10901b787ba49f8ca0cf77c94af7d42/docs/GUIDE_CUSTOM_INFERENCE.md#L417) redirects the host to a local provider bridge. That can be useful for a separately selected provider, but it does not establish Cursor-served Opus. auth2api and OmniRoute are useful routing references; their alternate-provider modes are not substituted for the requested native routes. Installer/device/account-switching repositories were not used.

## Borrowed changes and live result

OMP keeps workload authorization optional and leaves JWT reuse rules to the issuer. Its explicit handoff file remains consume-once. Grokbot discovery joins AvailableModels and the account-advertised GetUsableModels roster: only a listed legacy slug becomes a packed wire route; unconfirmed aliases and parameterized variants retain their prior representation.

Fresh metadata returned 256 roster entries, including Opus 5.5 low/medium/high/xhigh/max and Fast variants. Direct text-only Stream probes using both `claude-opus-5-5` with medium parameters and bare `claude-opus-5-5-medium` were denied with `ERROR_NOT_HIGH_ENOUGH_PERMISSIONS`. Neither returned a serving model or native content. The denial therefore persists without tools and is not demonstrated to be fixed by packed routing alone. Live Opus serving remains unverified.

## Version caveat

The Luxciax helper writes RequestedModel flags at fields 7/8, while the supplied sand-host `3f90dc1` InferenceRequestedModel declares built-in-model at field 4 and no variant-string flag. Keep OMP's version-verified schema; do not copy incompatible field numbers. Cursor AgentService and Grokbot InferenceService remain separate adapters and credential/transport paths.

## Combined fork integration

The additive `grokbot-chat/host-managed` provider follows the GrokBotService session-authenticated path independently verified with a random reply challenge and a separate transcript readback. It never labels host-selected chat as Opus and never silently replaces native Stream or Cursor requests. Isolated temporary agents are cleaned up with ownership/identity checks and independent absence readback.

Read-only Sand allowance reporting is integrated with OMP usage reporting. The new opt-in `text-tools` mode independently implements the protocol idea using OMP's JSON parser and tool-name allowlist, not copied AGPL code. The selected native model remains intact, native tool declarations are omitted, text history uses fresh conversation ids, and signed/native content is not globally sanitized away.

Additional live trials covered canonical and packed Opus 5/5.5 routes with Max/built-in flags, the 5.5 low/medium/high/xhigh tiers, and a Fast variant. All nine Stream trials returned permission denial before model output. Separate native Cursor Opus 5 and 5.5 requests returned an Opus usage-limit error with an October 16 reset. These are transport/account outcomes, not proof of served Opus. No shared model setting, spend limit, or account was switched.

Shared host model selection remains a guarded manual experiment: [the reconstructed settings service](https://github.com/river-li/brok-pot-harness/blob/ead2cf14dbf86ef30e17724e7e71b9b0566530a3/src/host/extensions/settings/settings-service.ts) changes account-wide `agentDefaultModel`. OMP does not automatically perform that write or expose it as an isolated model picker.
