import { requestNeeds } from "./capabilities";
/**
 * omp auth-gateway HTTP server.
 *
 * Accepts any provider-format request (OpenAI chat-completions, Anthropic
 * messages, OpenAI Responses, Gemini v1beta) and dispatches through pi-ai's
 * `streamSimple()` — which handles credential injection, anthropic-beta
 * headers, codex websocket transport, and all the per-provider intricacies.
 * The gateway is pure protocol translation: foreign wire → omp Context →
 * pi-ai stream() → omp events → foreign wire.
 *
 * Endpoints:
 *   GET  /healthz                          → unauth; ok + version
 *   GET  /v1/usage                         → aggregated provider usage (5-min per-credential cache via AuthStorage)
 *   GET  /v1/credentials/check             → per-credential auth probe (diagnose 401s in a multi-account pool)
 *   GET  /v1/models                        → list known models from the registry
 *   GET  /v1/routes                        → list registered virtual routes
 *   GET  /v1/routes/:id                    → one registered virtual route
 *   PUT  /v1/routes/:id                    → register or replace a virtual route
 *   DELETE /v1/routes/:id                    → unregister a virtual route
 *   GET  /v1/executions/:id                → redacted decision traces for one execution
 *   GET  /v1/health/routes                 → virtual route ids, generations, and targets (no credentials)
 *   GET  /v1/credentials                   → stored credential ids, providers, and types (no secrets)
 *   POST /v1/credentials/:id/disable       → disable a stored credential
 *   POST /v1/credentials/:id/pin           → pin a session to an OAuth credential
 *   POST /v1/chat/completions              → OpenAI chat-completions in/out
 *   POST /v1/grok/chat/completions         → OpenAI chat-completions (xAI alias)
 *   POST /v1/messages                      → Anthropic messages in/out
 *   POST /v1/messages/count_tokens         → Anthropic Messages count_tokens
 *   POST /v1/realtime                      → 501 not available on this gateway
 *   POST /v1/responses                     → OpenAI Responses in/out
 *   POST /backend-api/codex/responses      → OpenAI Responses (Codex alias)
 *   POST /backend-api/responses            → OpenAI Responses (Codex alias)
 *   POST /v1beta/models/generateContent    → Gemini v1beta generateContent
 *   POST /v1beta/models/streamGenerateContent → Gemini v1beta streamGenerateContent
 *   POST /v1/pi/stream                     → native pi-ai stream in/out
 *   POST /v1/systemone | /alpha/decisions  → TypeSafe System One judgments (routes/systemone)
 *   POST /v1/images[/generations|/edits]   → image generation, OpenAI/OpenRouter wire (routes/images)
 *   POST /v1/audio/speech                  → text-to-speech, raw audio out (routes/speech)
 *   POST /v1/audio/transcriptions          → speech-to-text, multipart or JSON base64 in (routes/transcriptions)
 *   POST /v1/embeddings                    → embeddings, OpenAI wire (routes/embeddings)
 *   POST /v1/rerank                        → rerank, OpenRouter wire (routes/rerank)
 *   POST /v1/videos                        → video generation submit/poll/content (routes/video)
 *
 * Chat routes live in this file; every other modality is a `routes/*` module
 * built on the shared plumbing in `dispatch.ts`.
 */

import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { type ModelKind, modelKind } from "@oh-my-pi/pi-catalog/types";
import { extractHttpStatusFromError, isRecord, logger } from "@oh-my-pi/pi-utils";
import { type AuthStorage, DEFAULT_TURN_RESERVATION_TTL_MS } from "../auth-storage";
import * as AIError from "../error";
import { classifyGatewayError, type GatewayErrorClassification } from "../error/gateway";
import { handleCountTokens } from "../providers/anthropic-count-tokens-server";
import * as anthropicMessages from "../providers/anthropic-messages-server";
import * as geminiV1beta from "../providers/gemini-v1beta-server";
import * as openaiChat from "../providers/openai-chat-server";
import * as openaiResponses from "../providers/openai-responses-server";
import * as piNative from "../providers/pi-native-server";
import { completeSimple, streamSimple } from "../stream";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "../types";
import { deterministicUuid } from "../utils/deterministic-id";
import { parseBind } from "../utils/parse-bind";
import { candidateAllowed } from "./affinity";
import {
	type RouteDecisionTrace,
	RouteDecisionTraceLog,
	type RouteSkipReason,
	redactedDecisionSummary,
} from "./decision-trace";
import {
	type AuthGatewayDispatchOptions as BaseAuthGatewayBootOptions,
	buildGatewayApiKeyResolver,
	mirrorRequestAbort,
	normalizeClientSessionKey,
	recordGatewayUsage,
	resolveGatewayAccount,
} from "./dispatch";
import { type GatewayHooks, runHook } from "./hooks";
import {
	captureRequestHeaders,
	corsHeaders,
	gatewayResponseHeaders,
	isAuthorized,
	json,
	resolveClientIdentity,
	resolvePeer,
	resolvePromptCacheKey,
	withCors,
} from "./http";
import { PromptCacheAffinityStore } from "./prompt-cache-store";
import { ProviderHealthBook } from "./provider-health";
import { decideAttempt, type ExecutionState } from "./route-conductor";
import { parseRouteDefinition } from "./route-definitions";
import { type CompiledRoute, type RouteDefinition, RouteRegistry, pickInitialRouteTarget } from "./route-graph";
import { handleEmbeddings } from "./routes/embeddings";
import { handleImageEdits, handleImageGenerations } from "./routes/images";
import { handleRerank } from "./routes/rerank";
import { handleSpeech } from "./routes/speech";
import { handleSystemOne } from "./routes/systemone";
import { handleTranscriptions } from "./routes/transcriptions";
import { handleVideoContent, handleVideoPoll, handleVideoSubmit } from "./routes/video";
import { type AuthGatewaySessionStateLease, AuthGatewaySessionStateStore } from "./session-state";
import {
	commitGateObservesDownstreamSse,
	observeSseCommit,
	StreamCommitGate,
	type StreamCommitState,
	observeAssistantCommit,
} from "./stream-commit-gate";
import type {
	AuthGatewayParsedRequestOptions,
	AuthGatewayServerHandle,
	AuthGatewayFormatModule as FormatModule,
	AuthGatewayParsedRequest as ParsedFormatRequest,
} from "./types";
import { DEFAULT_AUTH_GATEWAY_BIND } from "./types";

// ParsedFormatRequest / ParsedFormatOptions / FormatModule come from ./types.
// ModelResolver and the base AuthGatewayBootOptions (storage, resolveModel,
// listModels, fetch) live in ./dispatch, shared with the routes/* modules;
// the interface below adds the chat-route routing/resilience knobs.

export interface AuthGatewayBootOptions extends BaseAuthGatewayBootOptions {
	/**
	 * Wave A compiled-route shim. Constructed by {@link startAuthGateway} when omitted.
	 * When supplied, it remains the registry object; {@link routes} are still registered onto it.
	 */
	routeRegistry?: RouteRegistry;
	/**
	 * Optional virtual route definitions registered at boot.
	 * Applied onto {@link routeRegistry} even when that object is caller-supplied.
	 * An empty list is a no-op.
	 */
	routes?: readonly RouteDefinition[];
	/** Bounded redacted decision log. Constructed by {@link startAuthGateway} when omitted. */
	decisionTraces?: RouteDecisionTraceLog;
	/** Optional request lifecycle hooks. Missing hooks are a no-op. */
	hooks?: GatewayHooks;
}

// `parseBind` lives in ../utils/parse-bind so the gateway and broker can't
// drift on accepted inputs (e.g. empty hostname, IPv6 brackets).

export const FORMAT_ROUTES: Record<string, { module: FormatModule; label: string }> = {
	"/v1/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/grok/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/messages": { module: anthropicMessages, label: "anthropic-messages" },
	"/v1/responses": { module: openaiResponses, label: "openai-responses" },
	"/backend-api/codex/responses": { module: openaiResponses, label: "openai-responses" },
	"/backend-api/responses": { module: openaiResponses, label: "openai-responses" },
	"/v1beta/models/generateContent": { module: geminiV1beta, label: "gemini-v1beta" },
	"/v1beta/models/streamGenerateContent": { module: geminiV1beta, label: "gemini-v1beta" },
};

/** Gemini puts the model id on the path: `/v1beta/models/{model}:generateContent`. */
const GEMINI_MODEL_PATH = /^\/v1beta\/models\/([^/]+):(?:generateContent|streamGenerateContent)$/;

// (passthrough fast-path removed — it bypassed pi-ai provider logic, in
// particular the Anthropic Claude-Code OAuth system-prompt prefix injection.
// Every request now takes the translate path so credential-specific request
// shaping always applies.)

// Options the caller's wire format may carry but the resolved provider can't
// honour are dropped silently in `buildStreamOptions`. We used to 400 here
// (`Unsupported option: temperature for openai-codex-responses`), but every
// realistic client (llm-git, openai SDK, anthropic SDK) bakes some of these
// defaults in without knowing which model they'll resolve to. Failing loudly
// just turned that into per-call config hell. Silent strip is what the
// upstream provider would do anyway when it ignores extra fields.

/**
 * Derive a stable cache identity from the parts of the request that don't
 * change turn-to-turn within a logical conversation: model id, system prompt,
 * tool definitions, and the first message (the conversation seed). Codex-class
 * backends only cache prefixes when an explicit `prompt_cache_key` is set;
 * without one, two requests with the same prefix but different trailing
 * messages don't coalesce. This bridges Anthropic-style clients (which signal
 * caching via `cache_control` markers rather than an opaque key) to Codex's
 * keyed model so cross-protocol caching "just works".
 *
 * Including the first message scopes the key to one logical conversation:
 * two different chats with the same system prompt no longer share a cache
 * bucket and can't trample each other's prefix-tree entries.
 *
 * Anthropic-backed requests ignore `sessionId`; the key is harmless there.
 */
function deriveSessionId(modelId: string, context: Context): string {
	const parts: string[] = [modelId];
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		parts.push(context.systemPrompt.join("\n\n"));
	}
	if (context.tools && context.tools.length > 0) {
		parts.push(JSON.stringify(context.tools));
	}
	const first = context.messages?.[0];
	if (first) {
		// Strip timestamp / provider metadata so the hash is stable across turns
		// of the same conversation (omp re-stamps every parsed Message). role +
		// content is what's actually on the wire.
		parts.push(JSON.stringify({ role: first.role, content: first.content }));
	}
	const seed = parts.join("\u0000");
	// The 36-char UUID flows through unchanged:
	// `normalizeOpenAIPromptCacheKey` accepts ≤64 chars verbatim.
	return deterministicUuid(seed);
}

function buildStreamOptions(parsed: ParsedFormatRequest, api: Api, signal: AbortSignal): SimpleStreamOptions {
	const opts: SimpleStreamOptions = { signal, cursorExternalToolExecutor: true };
	const { options } = parsed;
	// Codex backend rejects every sampling control with
	// `Unsupported parameter: …` (#3117). Strip the full set for that one
	// provider; everything else is harmless to forward — `streamSimple` ignores
	// what the underlying provider doesn't honour.
	const isCodex = api === "openai-codex-responses";
	if (options.maxOutputTokens !== undefined) opts.maxTokens = options.maxOutputTokens;
	if (options.temperature !== undefined && !isCodex) opts.temperature = options.temperature;
	if (options.topP !== undefined && !isCodex) opts.topP = options.topP;
	if (options.topK !== undefined && !isCodex) opts.topK = options.topK;
	if (options.minP !== undefined && !isCodex) opts.minP = options.minP;
	if (options.stopSequences !== undefined && !isCodex) opts.stopSequences = options.stopSequences;
	if (options.presencePenalty !== undefined && !isCodex) opts.presencePenalty = options.presencePenalty;
	if (options.frequencyPenalty !== undefined && !isCodex) opts.frequencyPenalty = options.frequencyPenalty;
	if (options.repetitionPenalty !== undefined && !isCodex) opts.repetitionPenalty = options.repetitionPenalty;
	if (options.metadata !== undefined) opts.metadata = options.metadata;
	if (options.userProfileId !== undefined) opts.userProfileId = options.userProfileId;
	if (options.headers !== undefined) opts.headers = { ...opts.headers, ...options.headers };
	if (options.toolChoice !== undefined) {
		opts.toolChoice =
			typeof options.toolChoice !== "object"
				? options.toolChoice
				: "type" in options.toolChoice
					? options.toolChoice
					: { type: "tool", name: options.toolChoice.name };
	}
	if (options.reasoning !== undefined) opts.reasoning = options.reasoning;
	if (options.disableReasoning !== undefined) opts.disableReasoning = options.disableReasoning;
	if (options.forceReasoningOff !== undefined) {
		opts.disableReasoning = options.forceReasoningOff;
		opts.forceReasoningOff = options.forceReasoningOff;
	}
	if (options.hideThinkingSummary !== undefined) opts.hideThinkingSummary = options.hideThinkingSummary;
	if (options.taskBudget !== undefined) opts.taskBudget = options.taskBudget;
	if (options.anthropicPrefixMismatchBehavior !== undefined) {
		opts.anthropicPrefixMismatchBehavior = options.anthropicPrefixMismatchBehavior;
	}
	if (options.serviceTier !== undefined) opts.serviceTier = options.serviceTier;
	if (options.cacheRetention !== undefined) opts.cacheRetention = options.cacheRetention;
	if (options.include !== undefined) opts.include = options.include;
	// Client-supplied `prompt_cache_key` wins; otherwise derive a stable
	// key from the model + system + tools so prefix caching engages on
	// Codex-class backends across turns of the same logical conversation.
	const promptCacheKey =
		normalizeClientSessionKey(options.promptCacheKey) ?? deriveSessionId(parsed.modelId, parsed.context);
	opts.promptCacheKey = promptCacheKey;
	opts.sessionId = promptCacheKey;
	if (options.thinkingBudgets) {
		opts.thinkingBudgets = { ...opts.thinkingBudgets, ...options.thinkingBudgets };
	}
	if (options.explicitThinkingBudgetTokens !== undefined) {
		// Mirror Rust's `resolve_thinking_budget`: explicit budget pins onto
		// whichever effort the client requested (or High when unspecified) and
		// ALSO sets the effort so providers that gate on `reasoning` actually
		// surface the budget.
		const effort = options.reasoning ?? Effort.High;
		opts.thinkingBudgets = {
			...opts.thinkingBudgets,
			[effort]: options.explicitThinkingBudgetTokens,
		};
		opts.reasoning ??= effort;
	}
	applyParsedGatewayOptions(opts, options);
	return opts;
}

/**
 * Copy first-class parsed gateway fields onto {@link SimpleStreamOptions}.
 * Previously these were debug-logged and dropped; providers that honour them
 * (Responses continuation, parallel tool calls, …) must be able to read them.
 */
export function applyParsedGatewayOptions(opts: SimpleStreamOptions, options: AuthGatewayParsedRequestOptions): void {
	if (options.cursorAutoMode !== undefined) opts.cursorAutoMode = options.cursorAutoMode;
	if (options.cursorToolPassthrough !== undefined) opts.cursorExternalToolExecutor = options.cursorToolPassthrough;
	if (options.cursorExcludeTools !== undefined) opts.cursorExcludeTools = options.cursorExcludeTools;
	if (options.cursorLocalCliMode !== undefined) opts.cursorLocalCliMode = options.cursorLocalCliMode;
	if (options.cursorDevExperimentOverrides !== undefined)
		opts.cursorDevExperimentOverrides = options.cursorDevExperimentOverrides;
	if (options.parallelToolCalls !== undefined) opts.parallelToolCalls = options.parallelToolCalls;
	if (options.previousResponseId !== undefined) opts.previousResponseId = options.previousResponseId;
	if (options.store !== undefined) opts.store = options.store;
	if (options.seed !== undefined) opts.seed = options.seed;
	if (options.logitBias !== undefined) opts.logitBias = options.logitBias;
	if (options.user !== undefined) opts.user = options.user;
	if (options.responseFormat !== undefined) opts.responseFormat = options.responseFormat;
}


function clientClosedResponse(route: { module: FormatModule }): Response {
	return route.module.formatError(499, "request_aborted", "client closed request");
}

/** Route that serves each non-chat catalog kind the gateway advertises. */
const KIND_ROUTES: Partial<Record<ModelKind, string>> = {
	judge: "POST /v1/systemone",
	image: "POST /v1/images/generations",
	tts: "POST /v1/audio/speech",
	stt: "POST /v1/audio/transcriptions",
	embedding: "POST /v1/embeddings",
	rerank: "POST /v1/rerank",
	video: "POST /v1/videos",
};

/** Chat routes cannot drive a non-chat model; name the route that does, or `undefined` for chat models. */
function chatRouteRejection(model: Model<Api>): string | undefined {
	const kind = modelKind(model);
	const route = KIND_ROUTES[kind];
	return route && `Model ${model.provider}/${model.id} is a ${kind} model; use ${route}`;
}

type FormatErrorFn = (status: number, type: string, message: string) => Response;

type AttemptPrep = { type: "key"; apiKey: string } | { type: "retry" } | { type: "respond"; response: Response };

/**
 * Resolve the first viable dispatch target for a compiled route. A primary
 * that is absent from the catalog (stale route, credential-scoped model
 * change) is marked attempted and the conductor advances to the next sibling
 * instead of 404ing a route with usable fallbacks.
 */
function resolveFirstAvailableTarget(
	compiled: CompiledRoute,
	resolveModel: (id: string) => Model<Api> | undefined,
	firstTarget: string,
	attemptedTargets: Set<string>,
): { target: string; model: Model<Api> | undefined } {
	let current = firstTarget;
	for (;;) {
		const model = resolveModel(current);
		if (model !== undefined) return { target: current, model };
		attemptedTargets.add(current);
		const next = decideAttempt({
			route: compiled,
			state: conductorExecutionState(compiled, attemptedTargets, new Set<number>(), 0, 0, current, false, "probing"),
			commitState: "probing",
		});
		if (next.type !== "dispatch") return { target: current, model: undefined };
		current = next.targetModelId;
	}
}

function unknownModelResponse(formatError: FormatErrorFn, modelId: string): Response {
	return formatError(404, "invalid_request_error", `Unknown model: ${modelId}`);
}

function conductorExecutionState(
	compiled: CompiledRoute,
	attemptedTargets: ReadonlySet<string>,
	attemptedCredentials: ReadonlySet<number>,
	retryCount: number,
	fallbackCount: number,
	currentTarget: string,
	siblingsExhausted: boolean,
	commitState: StreamCommitState,
): ExecutionState {
	return {
		routeId: compiled.id,
		generation: compiled.generation,
		attemptedTargets,
		attemptedCredentials,
		retryCount,
		fallbackCount,
		committed: commitState !== "probing",
		currentTarget,
		siblingsExhausted,
	};
}

function dispatchTargetId(
	compiled: CompiledRoute,
	state: ExecutionState,
	commitState: StreamCommitState,
	cacheStore: PromptCacheAffinityStore,
	fingerprint: string,
	initialTarget: string,
): string | undefined {
	const hit = cacheStore.lookup(fingerprint);
	const action = decideAttempt({
		route: compiled,
		state,
		commitState,
		preferredTargetId: hit?.model ?? initialTarget,
	});
	return action.type === "dispatch" ? action.targetModelId : undefined;
}


function messageHasBillableUsage(message: AssistantMessage): boolean {
	const usage = message.usage;
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
}

const STREAM_PRELUDE_MAX_BYTES = 4 * 1024 * 1024;

type SseRead = { done: boolean; value?: Uint8Array };

type HeldSse =
	| { type: "forward"; stream: ReadableStream<Uint8Array> }
	| { type: "failed"; error: unknown; message?: AssistantMessage };

function attachCommitGateSseObserver(
	streamOpts: SimpleStreamOptions,
	commitGate: StreamCommitGate,
	routeLabel: string,
): void {
	const previousSse = streamOpts.onSseEvent;
	streamOpts.onSseEvent = (event, sseModel) => {
		const raw = event.raw;
		let bytes = 0;
		for (const line of raw) bytes += line.length + 1;
		commitGate.classifyAndObserve(event.event ?? "", bytes);
		// Consume the observation: a terminal event that ended the stream
		// before commit is the pre-commit-failure signal the failover loop
		// routes on; surface it instead of discarding the gate state.
		if (commitGate.state === "terminated") {
			logger.debug("auth-gateway stream terminated pre-commit", {
				route: routeLabel,
				event: event.event ?? "",
			});
		}
		previousSse?.(event, sseModel);
	};
}

function concatSsePrelude(
	prelude: Uint8Array[],
	reader: { read(): Promise<SseRead>; cancel(reason?: unknown): Promise<void> },
	pending: Promise<SseRead> | undefined,
): ReadableStream<Uint8Array> {
	let pendingRead = pending;
	let preludeOffset = 0;
	return new ReadableStream({
		async pull(controller) {
			if (preludeOffset < prelude.length) {
				const chunk = prelude[preludeOffset];
				preludeOffset += 1;
				if (chunk) controller.enqueue(chunk);
				return;
			}
			const read = pendingRead ?? reader.read();
			pendingRead = undefined;
			const { done, value } = await read;
			if (done || value === undefined) {
				controller.close();
				return;
			}
			controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

/**
 * Buffer encoded SSE until the commit gate leaves probing or the upstream
 * attempt settles. Callers must not return HTTP 200 while still probing.
 */
async function holdSseUntilCommit(
	sseStream: ReadableStream<Uint8Array>,
	gate: StreamCommitGate,
	settled: Promise<AssistantMessage>,
): Promise<HeldSse> {
	const reader = sseStream.getReader();
	const prelude: Uint8Array[] = [];
	let preludeBytes = 0;
	let pendingRead: Promise<SseRead> | undefined;
	let settleOutcome: { ok: true; message: AssistantMessage } | { ok: false; error: unknown } | undefined;
	const watchSettled = settled.then(
		message => {
			settleOutcome = { ok: true, message };
		},
		(error: unknown) => {
			settleOutcome = { ok: false, error };
		},
	);

	const forward = (): HeldSse => ({
		type: "forward",
		stream: concatSsePrelude(prelude, reader, pendingRead),
	});

	const failedFromOutcome = (): HeldSse => {
		if (!settleOutcome) return { type: "failed", error: "Upstream request failed" };
		if (!settleOutcome.ok) return { type: "failed", error: settleOutcome.error };
		return {
			type: "failed",
			error: settleOutcome.message.errorMessage ?? settleOutcome.message,
			message: settleOutcome.message,
		};
	};

	try {
		while (true) {
			if (gate.state === "committed") return forward();
			if (preludeBytes >= STREAM_PRELUDE_MAX_BYTES) {
				if (gate.state === "probing") gate.classifyAndObserve("", STREAM_PRELUDE_MAX_BYTES);
				return forward();
			}
			if (settleOutcome) {
				if (!settleOutcome.ok) return failedFromOutcome();
				const reason = settleOutcome.message.stopReason;
				if (reason === "error" || reason === "aborted") return failedFromOutcome();
				return forward();
			}
			pendingRead ??= reader.read();
			const raced = await Promise.race([
				pendingRead.then(r => ({ source: "read" as const, r })),
				watchSettled.then(() => ({ source: "settled" as const })),
			]);
			if (raced.source === "settled") continue;
			pendingRead = undefined;
			const { done, value } = raced.r;
			if (done || value === undefined) {
				await watchSettled;
				continue;
			}
			prelude.push(value);
			preludeBytes += value.byteLength;
		}
	} catch (error) {
		return { type: "failed", error };
	}
}

// (handlePassthrough removed — see note above.)

/** Wrap an SSE body so turn reservations (and settled probes) release on close, cancel, or read failure. */
export function renewReservationUntilSettled<T>(
	storage: AuthStorage,
	requestId: string,
	pending: Promise<T>,
): Promise<T> {
	const timer = setInterval(() => storage.renewTurnReservation(requestId), DEFAULT_TURN_RESERVATION_TTL_MS / 2);
	timer.unref?.();
	return pending.finally(() => clearInterval(timer));
}

export function releaseTurnOnStreamEnd(
	stream: ReadableStream<Uint8Array>,
	storage: AuthStorage,
	requestId: string,
	commitGate?: StreamCommitGate,
	settled?: Promise<unknown>,
): ReadableStream<Uint8Array> {
	const reader = stream.getReader();
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		if (commitGate?.sawSuccessfulTerminal) {
			storage.settleQuotaProbeSuccess(requestId);
		}
		storage.releaseTurnReservation(requestId);
	};
	return new ReadableStream({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					await settled;
					release();
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				release();
				controller.error(error);
			}
		},
		cancel(reason) {
			release();
			return reader.cancel(reason);
		},
	});
}

function targetSkipReason(
	compiled: CompiledRoute,
	health: ProviderHealthBook,
	targetId: string,
	model: Model<Api>,
): RouteSkipReason | undefined {
	if (
		compiled.portability !== undefined &&
		!candidateAllowed(
			compiled.portability,
			{ id: targetId, provider: model.provider, deployment: model.baseUrl },
			compiled.affinity ?? "preferred",
		)
	) {
		return "state_incompatible";
	}
	if (health.state(model.provider, model.id) === "open") {
		return "circuit_open";
	}
	return undefined;
}

function recordProviderHealthFailure(
	health: ProviderHealthBook,
	model: Model<Api>,
	classified: GatewayErrorClassification,
): void {
	if (classified.owner === "provider") {
		health.recordFailure(model.provider, model.id, "provider");
	} else if (classified.owner === "model") {
		health.recordFailure(model.provider, model.id, "model");
	}
}

function classifyAssistantFailure(message: AssistantMessage): GatewayErrorClassification {
	return classifyGatewayError(
		Object.assign(
			new Error(message.errorClassificationMessage ?? message.errorMessage ?? "Upstream request failed"),
			{ status: message.errorStatus, errorId: message.errorId, kind: "kind" in message ? message.kind : undefined },
		),
	);
}

async function settleGatewayStream(
	settled: Promise<AssistantMessage>,
	boot: AuthGatewayBootOptions,
	health: ProviderHealthBook,
	model: Model<Api>,
	requestId: string,
	onSuccess: () => void,
	afterOutcome: (ok: boolean) => Promise<void>,
): Promise<void> {
	let ok = false;
	try {
		const message = await settled;
		ok = message.stopReason !== "error" && message.stopReason !== "aborted";
		if (ok) {
			boot.storage.settleQuotaProbeSuccess(requestId);
			health.recordSuccess(model.provider, model.id);
			onSuccess();
		} else recordProviderHealthFailure(health, model, classifyAssistantFailure(message));
	} catch (error) {
		recordProviderHealthFailure(health, model, classifyGatewayError(error));
	}
	await afterOutcome(ok);
}

function rememberPromptCacheHit(
	cacheStore: PromptCacheAffinityStore,
	fingerprint: string,
	model: Model<Api>,
	sessionId: string,
	routeTarget?: string,
): void {
	cacheStore.remember(fingerprint, {
		provider: model.provider,
		// Prefer the route target id so affinity keys match qualified `provider/id` routes.
		model: routeTarget ?? model.id,
		accountId: sessionId,
	});
}

async function handleFormatEndpoint(
	route: { module: FormatModule; label: string },
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
	health: ProviderHealthBook,
	cacheStore: PromptCacheAffinityStore,
	sessionStates: AuthGatewaySessionStateStore,
	pathModel?: string,
	geminiStream?: boolean,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return clientClosedResponse(route);

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		return route.module.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	// Gemini model-bearing paths carry the model id when the body omits `model`.
	if (pathModel && isRecord(body) && (typeof body.model !== "string" || body.model.length === 0)) {
		body = { ...body, model: pathModel };
	}
	// Native Gemini selects streaming via the endpoint, not a body flag: the
	// module default (stream) must not turn generateContent into SSE.
	if (
		route.label === "gemini-v1beta" &&
		geminiStream !== undefined &&
		isRecord(body) &&
		typeof body.stream !== "boolean"
	) {
		body = { ...body, stream: geminiStream };
	}

	// All three supported wire formats put the model id on a top-level `model`
	// field. Read it without running the full strict schema so the route can
	// produce a coherent error envelope when the model id is missing.
	const modelId =
		typeof body === "object" && body !== null && typeof (body as { model?: unknown }).model === "string"
			? (body as { model: string }).model
			: undefined;
	if (!modelId) {
		return route.module.formatError(400, "invalid_request_error", "Missing top-level `model` field");
	}
	// Kind-gate the requested model id early. Virtual routes below may retarget
	// to a sibling model, but a request naming a non-chat model outright is a
	// client error regardless of routing; an unresolvable id still falls through
	// to the route registry (a virtual route may serve it).
	const requestedModel = bootOpts.resolveModel(modelId);
	const requestedKindRejection = requestedModel ? chatRouteRejection(requestedModel) : undefined;
	if (requestedKindRejection) {
		return route.module.formatError(400, "invalid_request_error", requestedKindRejection);
	}
	let parsed: ParsedFormatRequest;
	try {
		parsed = route.module.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const message = error instanceof Error ? error.message : String(error);
		return route.module.formatError(400, "invalid_request_error", message);
	}
	const compiled = (bootOpts.routeRegistry ?? new RouteRegistry(bootOpts.resolveModel)).resolve(modelId, {
		vision: requestNeeds(parsed.context).vision === true,
	});
	if (!compiled) {
		return unknownModelResponse(route.module.formatError, modelId);
	}
	const firstTarget = bootOpts.routeRegistry?.pickInitialTarget(compiled) ?? pickInitialRouteTarget(compiled);
	if (firstTarget === undefined) {
		return unknownModelResponse(route.module.formatError, modelId);
	}
	const attemptedTargets = new Set<string>();
	const initial = resolveFirstAvailableTarget(
		compiled,
		id => bootOpts.resolveModel(id),
		firstTarget,
		attemptedTargets,
	);
	let currentTarget = initial.target;
	if (initial.model === undefined) {
		return unknownModelResponse(route.module.formatError, currentTarget);
	}
	let model: Model<Api> = initial.model;
	const client = resolveClientIdentity(req.headers);

	// Parse the wire-format request BEFORE resolving the credential so we
	// have a stable per-conversation `sessionId` to thread into AuthStorage.
	// Sticky-credential tracking and `markUsageLimitReached` both key off
	// this id; without it `getApiKey` would re-roundrobin every request
	// and `markUsageLimitReached` would no-op (it can only mark the
	// credential it last handed out to that session).

	await runHook(bootOpts.hooks?.beforeRequest, {
		requestId,
		routeId: compiled.id,
		generation: compiled.generation,
	});
	// Merge gateway-captured passthrough headers under the parser's own
	// captures. Parsers that set `options.headers` themselves win (they may
	// have stripped or normalized values); the gateway's allow-list fills in
	// anything they didn't touch.
	{
		const captured = captureRequestHeaders(req.headers);
		parsed.options.headers = { ...captured, ...parsed.options.headers };
		if (captured["x-cursor-auto-mode"] === "true") parsed.options.cursorAutoMode = true;
		if (captured["x-cursor-tool-passthrough"] === "true") parsed.options.cursorToolPassthrough = true;
		if (captured["x-cursor-agent-exclude-tools"])
			parsed.options.cursorExcludeTools = captured["x-cursor-agent-exclude-tools"];
		if (captured["local-cli-mode"] === "true") parsed.options.cursorLocalCliMode = true;
		if (captured["x-dev-experiment-overrides"])
			parsed.options.cursorDevExperimentOverrides = captured["x-dev-experiment-overrides"];
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	const requestHasOpenAIImageFileReferences = parsed.context.messages.some(message => {
		if (
			message.role === "toolResult" &&
			message.content.some(
				block => block.type === "image" && block.providerFile?.provider === "openai" && block.providerFile.id,
			)
		)
			return true;
		const payload = "providerPayload" in message ? message.providerPayload : undefined;
		if (payload?.type !== "openaiResponsesHistory") return false;
		return payload.items.some(
			item =>
				Array.isArray(item.content) &&
				item.content.some(
					(part: unknown) =>
						isRecord(part) &&
						(part.type === "input_image" || part.type === "input_file") &&
						typeof part.file_id === "string" &&
						part.file_id.length > 0,
				),
		);
	});
	const openaiImageFileCompatError = (candidate: Model<Api>): Response | undefined => {
		if (route.label !== "openai-responses" || !requestHasOpenAIImageFileReferences) return undefined;
		const supportsOpenAIImageFileReferences =
			candidate.api === "openai-responses" ||
			candidate.api === "azure-openai-responses" ||
			candidate.api === "openai-codex-responses";
		if (supportsOpenAIImageFileReferences) return undefined;
		return route.module.formatError(
			400,
			"invalid_request_error",
			"OpenAI file IDs require a Responses-compatible upstream model",
		);
	};

	// Sticky credential id: honour the client's `prompt_cache_key` when
	// supplied (so external session ids align), otherwise derive from
	// modelId + system + tools + first message. Mirrored into
	// streamOpts.sessionId / promptCacheKey by `buildStreamOptions`.
	const clientKey = normalizeClientSessionKey(parsed.options.promptCacheKey);
	const sessionId = clientKey ?? deriveSessionId(parsed.modelId, parsed.context);
	parsed.options.promptCacheKey ??= sessionId;

	const traces = bootOpts.decisionTraces ?? new RouteDecisionTraceLog();
	const commitGate = new StreamCommitGate();
	const formatError: FormatErrorFn = (status, type, message) => {
		const response = route.module.formatError(status, type, message);
		response.headers.set("x-request-id", requestId);
		response.headers.set("request-id", requestId);
		return response;
	};
	const fingerprint = resolvePromptCacheKey(body, req.headers) ?? sessionId;
	const attemptedCredentials = new Set<number>();
	let retryCount = 0;
	let fallbackCount = 0;
	let pendingFallback: string | undefined;
	let lastClassified: GatewayErrorClassification | undefined;
	let siblingsExhausted = false;
	// One dispatch + one sibling-credential retry per target, plus a spare iteration.
	const attemptCap = compiled.targets.length * 2 + 1;

	const stateNow = (): ExecutionState =>
		conductorExecutionState(
			compiled,
			attemptedTargets,
			attemptedCredentials,
			retryCount,
			fallbackCount,
			currentTarget,
			siblingsExhausted,
			commitGate.state,
		);

	const classifiedError = (classified: GatewayErrorClassification): Response =>
		formatError(classified.status, classified.type, classified.message);

	// Per-session provider learning (sticky strict-tools / fast-mode / thinking
	// fallbacks, Codex transport sessions). Owned by this gateway instance: the
	// map is non-serializable, so no client can supply it and every turn would
	// otherwise re-learn each lesson from a fresh upstream rejection.
	//
	// The lease binds the {clientKey, model} pair, so it is acquired per
	// attempt — a target fallback re-acquires against the new model — and MUST
	// be released on every exit path: non-streaming settles release it inline,
	// streaming hands it to the event stream's result.
	let attemptLease: AuthGatewaySessionStateLease | undefined;
	const acquireAttemptLease = (apiKey: string): AuthGatewaySessionStateLease => {
		attemptLease?.release();
		attemptLease = sessionStates.acquire({
			clientKey,
			model,
			context: parsed.context,
			account: resolveGatewayAccount(bootOpts.storage, model.provider, sessionId, apiKey),
		});
		return attemptLease;
	};
	const releaseAttemptLease = () => {
		attemptLease?.release();
		attemptLease = undefined;
	};

	const considerFallback = (classified: GatewayErrorClassification): boolean => {
		lastClassified = classified;
		recordProviderHealthFailure(health, model, classified);
		if (parsed.options.previousResponseId) return false;
		if (commitGate.state === "committed") return false;
		const action = decideAttempt({
			route: compiled,
			state: conductorExecutionState(
				compiled,
				attemptedTargets,
				attemptedCredentials,
				retryCount,
				fallbackCount,
				currentTarget,
				siblingsExhausted,
				"probing",
			),
			classification: classified,
			commitState: "probing",
		});
		if (action.type === "sibling_credential") {
			siblingsExhausted = true;
			pendingFallback = currentTarget;
			retryCount += 1;
			return true;
		}
		if (action.type === "fallback_target") {
			// New target gets a fresh sibling-credential budget.
			siblingsExhausted = false;
			pendingFallback = action.targetModelId;
			fallbackCount += 1;
			retryCount += 1;
			return true;
		}
		return false;
	};

	const bindCurrentTarget = (targetId: string): Response | undefined | "skipped" => {
		currentTarget = targetId;
		const resolved = bootOpts.resolveModel(currentTarget);
		if (!resolved) {
			attemptedTargets.add(currentTarget);
			return "skipped";
		}
		model = resolved;
		const kindRejection = chatRouteRejection(model);
		if (kindRejection) return formatError(400, "invalid_request_error", kindRejection);
		const incompatible = openaiImageFileCompatError(model);
		if (incompatible) return incompatible;
		const skip = targetSkipReason(compiled, health, currentTarget, model);
		if (skip !== undefined) {
			attemptedTargets.add(currentTarget);
			const skipped = traces.record({
				requestId,
				routeId: compiled.id,
				generation: compiled.generation,
				selectedTarget: currentTarget,
				disposition: "skipped",
				reason: skip,
			});
			logger.debug("auth-gateway route decision", redactedDecisionSummary(skipped));
			return "skipped";
		}
		attemptedTargets.add(currentTarget);
		return undefined;
	};

	const pickTarget = (): Response | undefined => {
		for (;;) {
			let targetId: string | undefined;
			if (pendingFallback !== undefined) {
				targetId = pendingFallback;
				pendingFallback = undefined;
			} else {
				targetId = parsed.options.previousResponseId
					? attemptedTargets.has(currentTarget)
						? undefined
						: currentTarget
					: dispatchTargetId(compiled, stateNow(), commitGate.state, cacheStore, fingerprint, currentTarget);
			}
			if (targetId === undefined) {
				if (lastClassified) return classifiedError(lastClassified);
				if (attemptedTargets.size > 0) {
					return formatError(502, "upstream_error", "Upstream request failed");
				}
				return unknownModelResponse(formatError, modelId);
			}
			const bound = bindCurrentTarget(targetId);
			if (bound === "skipped") {
				if (lastClassified) {
					const action = decideAttempt({
						route: compiled,
						state: conductorExecutionState(
							compiled,
							attemptedTargets,
							attemptedCredentials,
							retryCount,
							fallbackCount,
							currentTarget,
							siblingsExhausted,
							"probing",
						),
						classification: lastClassified,
						commitState: "probing",
					});
					if (action.type === "fallback_target") {
						siblingsExhausted = false;
						pendingFallback = action.targetModelId;
					}
				}
				continue;
			}
			return bound;
		}
	};

	const resolveCredential = async (): Promise<AttemptPrep> => {
		let apiKey: string | undefined;
		if (
			parsed.options.previousResponseId &&
			!bootOpts.storage.peekApiKeyOverrides(model.provider) &&
			bootOpts.storage.listStoredCredentials(model.provider).length > 1
		) {
			return {
				type: "respond",
				response: formatError(
					400,
					"invalid_request_error",
					"Response continuation requires an unambiguous credential",
				),
			};
		}
		try {
			apiKey = await bootOpts.storage.getApiKey(model.provider, sessionId, {
				modelId: model.id,
				signal: controller.signal,
				requestId,
			});
		} catch (error) {
			if (controller.signal.aborted) return { type: "respond", response: clientClosedResponse(route) };
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
			traces.record({
				requestId,
				routeId: compiled.id,
				generation: compiled.generation,
				selectedTarget: currentTarget,
				disposition: "skipped",
				reason: "credential_lookup_failed",
			});
			if (considerFallback(classified)) return { type: "retry" };
			return { type: "respond", response: classifiedError(classified) };
		}
		if (controller.signal.aborted) return { type: "respond", response: clientClosedResponse(route) };
		if (!apiKey) {
			const skipped = traces.record({
				requestId,
				routeId: compiled.id,
				generation: compiled.generation,
				selectedTarget: currentTarget,
				disposition: "skipped",
				reason: "credential_unavailable",
			});
			logger.debug("auth-gateway route decision", redactedDecisionSummary(skipped));
			const unconfigured = !bootOpts.storage.hasAuth(model.provider);
			const classified: GatewayErrorClassification = {
				status: unconfigured ? 503 : 401,
				type: unconfigured ? "upstream_error" : "authentication_error",
				message: `No credential available for provider ${model.provider}`,
				owner: unconfigured ? "provider" : "credential",
				disposition: unconfigured ? "provider_unavailable" : "credential_transient",
			};
			// No key means there is no sibling credential to rotate — skip straight
			// to disposition-compiled credential_transient fallbacks when present.
			siblingsExhausted = true;
			if (considerFallback(classified)) return { type: "retry" };
			return {
				type: "respond",
				response: formatError(classified.status, classified.type, classified.message),
			};
		}
		const activeCredentialId = bootOpts.storage
			.listOAuthAccounts(model.provider, sessionId)
			.find(account => account.active)?.credentialId;
		if (activeCredentialId !== undefined) attemptedCredentials.add(activeCredentialId);
		const dispatched = traces.record({
			requestId,
			routeId: compiled.id,
			generation: compiled.generation,
			selectedTarget: currentTarget,
			disposition: "dispatched",
		});
		logger.debug("auth-gateway route decision", redactedDecisionSummary(dispatched));
		return { type: "key", apiKey };
	};

	const buildAttemptStreamOpts = (apiKey: string): SimpleStreamOptions => {
		const streamOpts = buildStreamOptions(parsed, model.api, controller.signal);
		if (bootOpts.fetch) streamOpts.fetch = bootOpts.fetch;
		const lease = acquireAttemptLease(apiKey);
		streamOpts.providerSessionState = lease.states;
		streamOpts.apiKey = parsed.options.previousResponseId
			? apiKey
			: buildGatewayApiKeyResolver(
					bootOpts.storage,
					model,
					sessionId,
					apiKey,
					controller.signal,
					route.label,
					peer,
					resolvedKey =>
						lease.updateAccount(
							resolveGatewayAccount(bootOpts.storage, model.provider, sessionId, resolvedKey),
						),
					requestId,
				);
		// openai-responses wraps the downstream body in observeSseCommit. Feeding
		// onSseEvent as well double-counts prelude bytes and trips the 4 MiB cap at ~2 MiB.
		if (!commitGateObservesDownstreamSse(route.label)) {
			attachCommitGateSseObserver(streamOpts, commitGate, route.label);
		}
		return streamOpts;
	};

	const attemptHookCtx = () => ({
		requestId,
		routeId: compiled.id,
		target: currentTarget,
		generation: compiled.generation,
	});

	if (!parsed.stream) {
		try {
			for (let attempt = 0; attempt < attemptCap; attempt++) {
				if (attempt > 0) commitGate.reset();
				if (controller.signal.aborted) return clientClosedResponse(route);
				const picked = pickTarget();
				if (picked) return picked;
				const cred = await resolveCredential();
				if (cred.type === "retry") {
					await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
					releaseAttemptLease();
					bootOpts.storage.releaseTurnReservation(requestId);
					continue;
				}
				if (cred.type === "respond") {
					await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
					return cred.response;
				}
				try {
					await runHook(bootOpts.hooks?.beforeAttempt, attemptHookCtx());
				} catch (error) {
					releaseAttemptLease();
					bootOpts.storage.releaseTurnReservation(requestId);
					throw error;
				}
				const streamOpts = buildAttemptStreamOpts(cred.apiKey);
				logger.info("auth-gateway request", {
					requestId,
					format: route.label,
					model: parsed.modelId,
					resolvedProvider: model.provider,
					resolvedModel: model.id,
					stream: parsed.stream,
					peer,
				});
				try {
					const message = await renewReservationUntilSettled(
						bootOpts.storage,
						requestId,
						completeSimple(model, parsed.context, streamOpts),
					);
					recordGatewayUsage(bootOpts.storage, model, client, message.usage, message.timestamp || undefined);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						const errorMessage =
							message.errorMessage ??
							(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
						logger.warn("auth-gateway non-streaming failed", {
							format: route.label,
							reason: message.stopReason,
							error: errorMessage,
							peer,
						});
						if (message.stopReason === "aborted") {
							await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
							return formatError(499, "request_aborted", errorMessage);
						}
						const classified = classifyAssistantFailure(message);
						if (messageHasBillableUsage(message)) {
							recordProviderHealthFailure(health, model, classified);
							await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
							return formatError(classified.status, classified.type, errorMessage);
						}
						if (considerFallback(classified)) {
							await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
							releaseAttemptLease();
							bootOpts.storage.releaseTurnReservation(requestId);
							continue;
						}
						await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
						return formatError(classified.status, classified.type, errorMessage);
					}
					bootOpts.storage.settleQuotaProbeSuccess(requestId);
					health.recordSuccess(model.provider, model.id);
					rememberPromptCacheHit(cacheStore, fingerprint, model, sessionId, currentTarget);
					await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: true });
					await runHook(bootOpts.hooks?.afterRequest, {
						requestId,
						routeId: compiled.id,
						generation: compiled.generation,
						ok: true,
					});
					return json(
						200,
						route.module.encodeResponse(message, parsed.modelId),
						gatewayResponseHeaders(model, { requestId, message, startedAt }),
					);
				} catch (error) {
					if (controller.signal.aborted) return clientClosedResponse(route);
					const classified = classifyGatewayError(error);
					logger.warn("auth-gateway non-streaming aborted", {
						format: route.label,
						error: classified.message,
						peer,
					});
					if (considerFallback(classified)) {
						await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
						releaseAttemptLease();
						bootOpts.storage.releaseTurnReservation(requestId);
						continue;
					}
					await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
					return classifiedError(classified);
				} finally {
					// Every non-streaming outcome — answered, upstream error,
					// thrown, client gone — is done with the provider state here.
					releaseAttemptLease();
				}
			}
			if (lastClassified) return classifiedError(lastClassified);
			return formatError(502, "upstream_error", "Upstream request failed");
		} finally {
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
		}
	}

	for (let attempt = 0; attempt < attemptCap; attempt++) {
		if (attempt > 0) commitGate.reset();
		if (controller.signal.aborted) {
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			return clientClosedResponse(route);
		}
		const picked = pickTarget();
		if (picked) {
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			return picked;
		}
		const cred = await resolveCredential();
		if (cred.type === "retry") {
			await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			continue;
		}
		if (cred.type === "respond") {
			await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			return cred.response;
		}
		try {
			await runHook(bootOpts.hooks?.beforeAttempt, attemptHookCtx());
		} catch (error) {
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			throw error;
		}
		const streamOpts = buildAttemptStreamOpts(cred.apiKey);
		logger.info("auth-gateway request", {
			requestId,
			format: route.label,
			model: parsed.modelId,
			resolvedProvider: model.provider,
			resolvedModel: model.id,
			stream: parsed.stream,
			peer,
		});
		let events: AssistantMessageEventStream;
		try {
			events = streamSimple(model, parsed.context, streamOpts);
		} catch (error) {
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway streamSimple threw", { format: route.label, error: classified.message, peer });
			if (considerFallback(classified)) {
				await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
				releaseAttemptLease();
				bootOpts.storage.releaseTurnReservation(requestId);
				continue;
			}
			await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			return classifiedError(classified);
		}
		if (!commitGateObservesDownstreamSse(route.label)) observeAssistantCommit(events, commitGate);
		const settled = renewReservationUntilSettled(bootOpts.storage, requestId, events.result());
		void settled
			.then(message =>
				recordGatewayUsage(bootOpts.storage, model, client, message.usage, message.timestamp || undefined),
			)
			.catch(() => {})
			.finally(() => releaseAttemptLease());
		let sseStream = route.module.encodeStream(events, parsed.modelId, parsed.options, {
			signal: controller.signal,
			onCancel: reason => {
				if (!controller.signal.aborted) {
					controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
				}
			},
		});
		if (route.label === "openai-responses") {
			sseStream = observeSseCommit(sseStream, commitGate);
		}
		const held = await holdSseUntilCommit(sseStream, commitGate, settled);
		if (held.type === "failed") {
			if (held.message && messageHasBillableUsage(held.message)) {
				const errorMessage =
					held.message.errorMessage ??
					(held.message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				if (held.message.stopReason === "aborted") {
					await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
					releaseAttemptLease();
					bootOpts.storage.releaseTurnReservation(requestId);
					return formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyAssistantFailure(held.message);
				recordProviderHealthFailure(health, model, classified);
				await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
				releaseAttemptLease();
				bootOpts.storage.releaseTurnReservation(requestId);
				return formatError(classified.status, classified.type, errorMessage);
			}
			const classified = held.message ? classifyAssistantFailure(held.message) : classifyGatewayError(held.error);
			logger.warn("auth-gateway stream attempt failed before commit", {
				format: route.label,
				error: classified.message,
				peer,
			});
			if (considerFallback(classified)) {
				await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
				releaseAttemptLease();
				bootOpts.storage.releaseTurnReservation(requestId);
				continue;
			}
			await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			return classifiedError(classified);
		}
		if (controller.signal.aborted) {
			await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			return clientClosedResponse(route);
		}
		const outcome = settleGatewayStream(
			settled,
			bootOpts,
			health,
			model,
			requestId,
			() => rememberPromptCacheHit(cacheStore, fingerprint, model, sessionId, currentTarget),
			async ok => {
				await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok });
				await runHook(bootOpts.hooks?.afterRequest, {
					requestId,
					routeId: compiled.id,
					generation: compiled.generation,
					ok,
				});
			},
		);
		sseStream = releaseTurnOnStreamEnd(held.stream, bootOpts.storage, requestId, undefined, outcome);
		return new Response(sseStream, {
			status: 200,
			headers: {
				...gatewayResponseHeaders(model, { requestId }),
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				// Disable proxy buffering (nginx and ingress controllers honor this).
				// Without it the SSE stream gets held until the buffer flushes, which
				// stalls the long-thinking-budget calls we exist to support.
				"X-Accel-Buffering": "no",
			},
		});
	}
	releaseAttemptLease();
	bootOpts.storage.releaseTurnReservation(requestId);
	if (lastClassified) return classifiedError(lastClassified);
	return formatError(502, "upstream_error", "Upstream request failed");
}

/**
 * Pi-native fast path: `POST /v1/pi/stream`. Accepts the canonical pi-ai
 * `Context` directly (no wire-format round-trip) and emits a bandwidth-shrunk
 * event stream matching `pi-agent`'s `streamProxy`. Skips the OpenAI /
 * Anthropic / Responses translation layers — those exist to bridge foreign
 * SDKs (llm-git, anthropic-sdk, openai-sdk), and bridging back to pi-native
 * just to bridge forward again is wasted work.
 *
 * Every other gateway concern (bearer auth, model resolve, credential fetch,
 * abort mirroring, codex temperature/topP strip, prefix-cache key derivation,
 * Claude-Code OAuth shaping inside `streamSimple`) still applies — only
 * `parseRequest`/`encodeResponse`/`encodeStream` differ from the format-endpoint
 * path.
 */
async function handlePiNative(
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
	health: ProviderHealthBook,
	cacheStore: PromptCacheAffinityStore,
	sessionStates: AuthGatewaySessionStateStore,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => piNative.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		return piNative.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return aborted();

	let parsed: piNative.PiNativeParsedRequest;
	try {
		parsed = piNative.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		return piNative.formatError(400, "invalid_request_error", message);
	}

	const compiled = (bootOpts.routeRegistry ?? new RouteRegistry(bootOpts.resolveModel)).resolve(parsed.modelId, {
		vision: requestNeeds(parsed.context).vision === true,
	});
	if (!compiled) {
		return unknownModelResponse(piNative.formatError, parsed.modelId);
	}
	const firstTarget = bootOpts.routeRegistry?.pickInitialTarget(compiled) ?? pickInitialRouteTarget(compiled);
	if (firstTarget === undefined) {
		return unknownModelResponse(piNative.formatError, parsed.modelId);
	}
	const attemptedTargets = new Set<string>();
	const initial = resolveFirstAvailableTarget(
		compiled,
		id => bootOpts.resolveModel(id),
		firstTarget,
		attemptedTargets,
	);
	let currentTarget = initial.target;
	if (initial.model === undefined) {
		return unknownModelResponse(piNative.formatError, currentTarget);
	}
	let model: Model<Api> = initial.model;
	const kindRejection = chatRouteRejection(model);
	if (kindRejection) return piNative.formatError(400, "invalid_request_error", kindRejection);
	const client = resolveClientIdentity(req.headers);
	// Pi-native already parsed `streamOpts.sessionId` (when set by the
	// client); fall back to the derived key so credential-stickiness lines
	// up with cache-prefix stickiness — same identity used for both means
	// the next turn of this conversation reuses the same credential until
	// it hits a usage cap, then markUsageLimitReached can hand off.
	const clientKey = normalizeClientSessionKey(parsed.options.sessionId);
	const sessionId = clientKey ?? deriveSessionId(parsed.modelId, parsed.context);
	parsed.options.sessionId ??= sessionId;

	const traces = bootOpts.decisionTraces ?? new RouteDecisionTraceLog();
	const commitGate = new StreamCommitGate();
	const formatError: FormatErrorFn = (status, type, message) => {
		const response = piNative.formatError(status, type, message);
		response.headers.set("x-request-id", requestId);
		response.headers.set("request-id", requestId);
		return response;
	};
	const fingerprint = resolvePromptCacheKey(body, req.headers) ?? sessionId;
	const attemptedCredentials = new Set<number>();
	let retryCount = 0;
	let fallbackCount = 0;
	let pendingFallback: string | undefined;
	let lastClassified: GatewayErrorClassification | undefined;
	let siblingsExhausted = false;
	// One dispatch + one sibling-credential retry per target, plus a spare iteration.
	const attemptCap = compiled.targets.length * 2 + 1;

	const stateNow = (): ExecutionState =>
		conductorExecutionState(
			compiled,
			attemptedTargets,
			attemptedCredentials,
			retryCount,
			fallbackCount,
			currentTarget,
			siblingsExhausted,
			commitGate.state,
		);

	const classifiedError = (classified: GatewayErrorClassification): Response =>
		formatError(classified.status, classified.type, classified.message);

	// Per-session provider learning, owned by this gateway instance. The map is
	// non-serializable, so `parseRequest` cannot accept one from the wire and
	// every turn would otherwise re-learn each lesson from a fresh upstream
	// rejection. Acquired per attempt — a target fallback re-acquires against
	// the new model — and released on every exit path.
	let attemptLease: AuthGatewaySessionStateLease | undefined;
	const acquireAttemptLease = (apiKey: string): AuthGatewaySessionStateLease => {
		attemptLease?.release();
		attemptLease = sessionStates.acquire({
			clientKey,
			model,
			context: parsed.context,
			account: resolveGatewayAccount(bootOpts.storage, model.provider, sessionId, apiKey),
		});
		return attemptLease;
	};
	const releaseAttemptLease = () => {
		attemptLease?.release();
		attemptLease = undefined;
	};

	const considerFallback = (classified: GatewayErrorClassification): boolean => {
		lastClassified = classified;
		recordProviderHealthFailure(health, model, classified);
		if (parsed.options.previousResponseId) return false;
		if (commitGate.state === "committed") return false;
		const action = decideAttempt({
			route: compiled,
			state: conductorExecutionState(
				compiled,
				attemptedTargets,
				attemptedCredentials,
				retryCount,
				fallbackCount,
				currentTarget,
				siblingsExhausted,
				"probing",
			),
			classification: classified,
			commitState: "probing",
		});
		if (action.type === "sibling_credential") {
			siblingsExhausted = true;
			pendingFallback = currentTarget;
			retryCount += 1;
			return true;
		}
		if (action.type === "fallback_target") {
			// New target gets a fresh sibling-credential budget.
			siblingsExhausted = false;
			pendingFallback = action.targetModelId;
			fallbackCount += 1;
			retryCount += 1;
			return true;
		}
		return false;
	};

	const bindCurrentTarget = (targetId: string): Response | undefined | "skipped" => {
		currentTarget = targetId;
		const resolved = bootOpts.resolveModel(currentTarget);
		if (!resolved) {
			attemptedTargets.add(currentTarget);
			return "skipped";
		}
		model = resolved;
		const boundKindRejection = chatRouteRejection(model);
		if (boundKindRejection) return formatError(400, "invalid_request_error", boundKindRejection);
		const skip = targetSkipReason(compiled, health, currentTarget, model);
		if (skip !== undefined) {
			attemptedTargets.add(currentTarget);
			const skipped = traces.record({
				requestId,
				routeId: compiled.id,
				generation: compiled.generation,
				selectedTarget: currentTarget,
				disposition: "skipped",
				reason: skip,
			});
			logger.debug("auth-gateway route decision", redactedDecisionSummary(skipped));
			return "skipped";
		}
		attemptedTargets.add(currentTarget);
		return undefined;
	};

	const pickTarget = (): Response | undefined => {
		for (;;) {
			let targetId: string | undefined;
			if (pendingFallback !== undefined) {
				targetId = pendingFallback;
				pendingFallback = undefined;
			} else {
				targetId = parsed.options.previousResponseId
					? attemptedTargets.has(currentTarget)
						? undefined
						: currentTarget
					: dispatchTargetId(compiled, stateNow(), commitGate.state, cacheStore, fingerprint, currentTarget);
			}
			if (targetId === undefined) {
				if (lastClassified) return classifiedError(lastClassified);
				if (attemptedTargets.size > 0) {
					return formatError(502, "upstream_error", "Upstream request failed");
				}
				return unknownModelResponse(formatError, parsed.modelId);
			}
			const bound = bindCurrentTarget(targetId);
			if (bound === "skipped") {
				if (lastClassified) {
					const action = decideAttempt({
						route: compiled,
						state: conductorExecutionState(
							compiled,
							attemptedTargets,
							attemptedCredentials,
							retryCount,
							fallbackCount,
							currentTarget,
							siblingsExhausted,
							"probing",
						),
						classification: lastClassified,
						commitState: "probing",
					});
					if (action.type === "fallback_target") {
						siblingsExhausted = false;
						pendingFallback = action.targetModelId;
					}
				}
				continue;
			}
			return bound;
		}
	};

	const resolveCredential = async (): Promise<AttemptPrep> => {
		let apiKey: string | undefined;
		if (
			parsed.options.previousResponseId &&
			!bootOpts.storage.peekApiKeyOverrides(model.provider) &&
			bootOpts.storage.listStoredCredentials(model.provider).length > 1
		) {
			return {
				type: "respond",
				response: formatError(
					400,
					"invalid_request_error",
					"Response continuation requires an unambiguous credential",
				),
			};
		}
		try {
			apiKey = await bootOpts.storage.getApiKey(model.provider, sessionId, {
				modelId: model.id,
				signal: controller.signal,
				requestId,
			});
		} catch (error) {
			if (controller.signal.aborted) return { type: "respond", response: aborted() };
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
			traces.record({
				requestId,
				routeId: compiled.id,
				generation: compiled.generation,
				selectedTarget: currentTarget,
				disposition: "skipped",
				reason: "credential_lookup_failed",
			});
			if (considerFallback(classified)) return { type: "retry" };
			return { type: "respond", response: classifiedError(classified) };
		}
		if (controller.signal.aborted) return { type: "respond", response: aborted() };
		if (!apiKey) {
			const skipped = traces.record({
				requestId,
				routeId: compiled.id,
				generation: compiled.generation,
				selectedTarget: currentTarget,
				disposition: "skipped",
				reason: "credential_unavailable",
			});
			logger.debug("auth-gateway route decision", redactedDecisionSummary(skipped));
			const unconfigured = !bootOpts.storage.hasAuth(model.provider);
			const classified: GatewayErrorClassification = {
				status: unconfigured ? 503 : 401,
				type: unconfigured ? "upstream_error" : "authentication_error",
				message: `No credential available for provider ${model.provider}`,
				owner: unconfigured ? "provider" : "credential",
				disposition: unconfigured ? "provider_unavailable" : "credential_transient",
			};
			// No key means there is no sibling credential to rotate — skip straight
			// to disposition-compiled credential_transient fallbacks when present.
			siblingsExhausted = true;
			if (considerFallback(classified)) return { type: "retry" };
			return {
				type: "respond",
				response: formatError(classified.status, classified.type, classified.message),
			};
		}
		const activeCredentialId = bootOpts.storage
			.listOAuthAccounts(model.provider, sessionId)
			.find(account => account.active)?.credentialId;
		if (activeCredentialId !== undefined) attemptedCredentials.add(activeCredentialId);
		const dispatched = traces.record({
			requestId,
			routeId: compiled.id,
			generation: compiled.generation,
			selectedTarget: currentTarget,
			disposition: "dispatched",
		});
		logger.debug("auth-gateway route decision", redactedDecisionSummary(dispatched));
		return { type: "key", apiKey };
	};

	const buildAttemptStreamOpts = (apiKey: string): SimpleStreamOptions => {
		// Build the SimpleStreamOptions actually handed to `streamSimple`. We
		// trust the client's options (already allow-listed by `parseRequest`) and
		// only inject server-controlled fields. The codex sampling strip mirrors
		// `buildStreamOptions` — Codex rejects every one with a 400 (#3117).
		const lease = acquireAttemptLease(apiKey);
		const streamOpts: SimpleStreamOptions = {
			...parsed.options,
			apiKey,
			signal: controller.signal,
			cursorExternalToolExecutor: true,
			providerSessionState: lease.states,
		};
		if (bootOpts.fetch) streamOpts.fetch = bootOpts.fetch;
		streamOpts.apiKey = parsed.options.previousResponseId
			? apiKey
			: buildGatewayApiKeyResolver(
					bootOpts.storage,
					model,
					sessionId,
					apiKey,
					controller.signal,
					"pi-native",
					peer,
					resolvedKey =>
						lease.updateAccount(
							resolveGatewayAccount(bootOpts.storage, model.provider, sessionId, resolvedKey),
						),
					requestId,
				);
		if (model.api === "openai-codex-responses") {
			delete streamOpts.temperature;
			delete streamOpts.topP;
			delete streamOpts.topK;
			delete streamOpts.minP;
			delete streamOpts.stopSequences;
			delete streamOpts.presencePenalty;
			delete streamOpts.frequencyPenalty;
			delete streamOpts.repetitionPenalty;
		}
		// Merge gateway-captured passthrough headers under the client's own
		// headers — the client's values win when they collide.
		const captured = captureRequestHeaders(req.headers);
		streamOpts.headers = { ...captured, ...(streamOpts.headers ?? {}) };
		streamOpts.sessionId ??= sessionId;
		if (!commitGateObservesDownstreamSse("pi-native")) {
			attachCommitGateSseObserver(streamOpts, commitGate, "pi-native");
		}
		return streamOpts;
	};

	const attemptHookCtx = () => ({
		requestId,
		routeId: compiled.id,
		target: currentTarget,
		generation: compiled.generation,
	});

	if (!parsed.stream) {
		try {
			for (let attempt = 0; attempt < attemptCap; attempt++) {
				if (attempt > 0) commitGate.reset();
				if (controller.signal.aborted) return aborted();
				const picked = pickTarget();
				if (picked) return picked;
				const cred = await resolveCredential();
				if (cred.type === "retry") {
					await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
					releaseAttemptLease();
					bootOpts.storage.releaseTurnReservation(requestId);
					continue;
				}
				if (cred.type === "respond") {
					await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
					return cred.response;
				}
				try {
					await runHook(bootOpts.hooks?.beforeAttempt, attemptHookCtx());
				} catch (error) {
					releaseAttemptLease();
					bootOpts.storage.releaseTurnReservation(requestId);
					throw error;
				}
				const streamOpts = buildAttemptStreamOpts(cred.apiKey);
				logger.info("auth-gateway request", {
					requestId,
					format: "pi-native",
					model: parsed.modelId,
					resolvedProvider: model.provider,
					resolvedModel: model.id,
					stream: parsed.stream,
					peer,
				});
				try {
					const message = await renewReservationUntilSettled(
						bootOpts.storage,
						requestId,
						completeSimple(model, parsed.context, streamOpts),
					);
					recordGatewayUsage(bootOpts.storage, model, client, message.usage, message.timestamp || undefined);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						const errorMessage =
							message.errorMessage ??
							(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
						logger.warn("auth-gateway non-streaming failed", {
							format: "pi-native",
							reason: message.stopReason,
							error: errorMessage,
							peer,
						});
						if (message.stopReason === "aborted") {
							await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
							return formatError(499, "request_aborted", errorMessage);
						}
						const classified = classifyAssistantFailure(message);
						if (messageHasBillableUsage(message)) {
							recordProviderHealthFailure(health, model, classified);
							await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
							return formatError(classified.status, classified.type, errorMessage);
						}
						if (considerFallback(classified)) {
							await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
							releaseAttemptLease();
							bootOpts.storage.releaseTurnReservation(requestId);
							continue;
						}
						await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
						return formatError(classified.status, classified.type, errorMessage);
					}
					bootOpts.storage.settleQuotaProbeSuccess(requestId);
					health.recordSuccess(model.provider, model.id);
					rememberPromptCacheHit(cacheStore, fingerprint, model, sessionId, currentTarget);
					await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: true });
					return json(200, { message }, gatewayResponseHeaders(model, { requestId, message, startedAt }));
				} catch (error) {
					if (controller.signal.aborted) return aborted();
					const classified = classifyGatewayError(error);
					logger.warn("auth-gateway non-streaming aborted", {
						format: "pi-native",
						error: classified.message,
						peer,
					});
					if (considerFallback(classified)) {
						await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
						releaseAttemptLease();
						bootOpts.storage.releaseTurnReservation(requestId);
						continue;
					}
					await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
					return classifiedError(classified);
				}
			}
			if (lastClassified) return classifiedError(lastClassified);
			return formatError(502, "upstream_error", "Upstream request failed");
		} finally {
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
		}
	}

	for (let attempt = 0; attempt < attemptCap; attempt++) {
		if (attempt > 0) commitGate.reset();
		if (controller.signal.aborted) {
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			return aborted();
		}
		const picked = pickTarget();
		if (picked) {
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			return picked;
		}
		const cred = await resolveCredential();
		if (cred.type === "retry") {
			await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			continue;
		}
		if (cred.type === "respond") {
			await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			return cred.response;
		}
		try {
			await runHook(bootOpts.hooks?.beforeAttempt, attemptHookCtx());
		} catch (error) {
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			throw error;
		}
		const streamOpts = buildAttemptStreamOpts(cred.apiKey);
		logger.info("auth-gateway request", {
			requestId,
			format: "pi-native",
			model: parsed.modelId,
			resolvedProvider: model.provider,
			resolvedModel: model.id,
			stream: parsed.stream,
			peer,
		});
		let events: AssistantMessageEventStream;
		try {
			events = streamSimple(model, parsed.context, streamOpts);
		} catch (error) {
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway streamSimple threw", { format: "pi-native", error: classified.message, peer });
			if (considerFallback(classified)) {
				await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
				releaseAttemptLease();
				bootOpts.storage.releaseTurnReservation(requestId);
				continue;
			}
			await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			return classifiedError(classified);
		}
		if (!commitGateObservesDownstreamSse("pi-native")) observeAssistantCommit(events, commitGate);
		const settled = renewReservationUntilSettled(bootOpts.storage, requestId, events.result());
		void settled
			.then(message =>
				recordGatewayUsage(bootOpts.storage, model, client, message.usage, message.timestamp || undefined),
			)
			.catch(() => {})
			.finally(() => releaseAttemptLease());
		let sseStream = piNative.encodeStream(events, parsed.modelId, parsed.options, {
			signal: controller.signal,
			onCancel: reason => {
				if (!controller.signal.aborted) {
					controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
				}
			},
		});
		sseStream = observeSseCommit(sseStream, commitGate);
		const held = await holdSseUntilCommit(sseStream, commitGate, settled);
		if (held.type === "failed") {
			if (held.message && messageHasBillableUsage(held.message)) {
				const errorMessage =
					held.message.errorMessage ??
					(held.message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				if (held.message.stopReason === "aborted") {
					await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
					releaseAttemptLease();
					bootOpts.storage.releaseTurnReservation(requestId);
					return formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyAssistantFailure(held.message);
				recordProviderHealthFailure(health, model, classified);
				await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
				releaseAttemptLease();
				bootOpts.storage.releaseTurnReservation(requestId);
				return formatError(classified.status, classified.type, errorMessage);
			}
			const classified = held.message ? classifyAssistantFailure(held.message) : classifyGatewayError(held.error);
			logger.warn("auth-gateway stream attempt failed before commit", {
				format: "pi-native",
				error: classified.message,
				peer,
			});
			if (considerFallback(classified)) {
				await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
				releaseAttemptLease();
				bootOpts.storage.releaseTurnReservation(requestId);
				continue;
			}
			await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			return classifiedError(classified);
		}
		if (controller.signal.aborted) {
			await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok: false });
			releaseAttemptLease();
			bootOpts.storage.releaseTurnReservation(requestId);
			return aborted();
		}
		const outcome = settleGatewayStream(
			settled,
			bootOpts,
			health,
			model,
			requestId,
			() => rememberPromptCacheHit(cacheStore, fingerprint, model, sessionId, currentTarget),
			async ok => {
				await runHook(bootOpts.hooks?.afterAttempt, { ...attemptHookCtx(), ok });
				await runHook(bootOpts.hooks?.afterRequest, {
					requestId,
					routeId: compiled.id,
					generation: compiled.generation,
					ok,
				});
			},
		);
		sseStream = releaseTurnOnStreamEnd(held.stream, bootOpts.storage, requestId, undefined, outcome);
		return new Response(sseStream, {
			status: 200,
			headers: {
				...gatewayResponseHeaders(model, { requestId }),
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			},
		});
	}
	releaseAttemptLease();
	bootOpts.storage.releaseTurnReservation(requestId);
	if (lastClassified) return classifiedError(lastClassified);
	return formatError(502, "upstream_error", "Upstream request failed");
}

/**
 * Snapshot of `GET /v1/usage` — `fetchUsageReports` already caches reports at
 * a 5-minute per-credential TTL (with jitter, plus last-good fallback on
 * failure) inside `AuthStorage`, so this handler is a thin wrapper that
 * surfaces the same data to HTTP callers (notably the macOS usage widget).
 */
async function handleUsage(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const reports = (await storage.usage.reports?.({ signal })) ?? [];
	// Drop the heavy provider-specific `raw` payload — UI consumers only need
	// `limits` + `metadata`. Match the broker's `/v1/usage` shape so a single
	// client struct (Swift widget, llm-git, ...) works against either endpoint.
	const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
	return json(200, { generatedAt: Date.now(), reports: trimmed });
}

/**
 * Per-credential health probe surfaced on `GET /v1/credentials/check`. Tells
 * the caller exactly which row in their broker is producing 401s — the
 * aggregate `/v1/usage` endpoint silently drops failed credentials, which is
 * the wrong shape when you're diagnosing auth.
 *
 * The probe is sequential (one credential at a time) to avoid synchronized
 * N-account fan-out tripping per-IP rate limits on provider `/usage`
 * endpoints. For multi-account pools that's the difference between getting
 * a clean diagnosis and getting a 429 storm.
 */
async function handleCredentialsCheck(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const credentials = await storage.health.check({ signal });
	return json(200, { generatedAt: Date.now(), credentials });
}

/**
 * Row shape for `GET /v1/models`. Beyond the OpenAI-standard `id`/`object`/
 * `owned_by`, rows advertise the catalog metadata OpenAI-compatible clients
 * (omp's own proxy discovery, Zed's openai_compatible provider, ...) read to
 * size and capability-gate discovered models: `context_length`,
 * `max_output_tokens`, `input_modalities`, and `supports_tools` (only emitted
 * when the catalog explicitly reports `false`; absent means usable).
 */
interface ModelListRow {
	id: string;
	object: "model";
	owned_by: string;
	api: Api;
	kind?: ModelKind;
	display_name: string;
	context_length?: number;
	max_output_tokens?: number;
	input_modalities: ("text" | "image")[];
	supports_tools?: boolean;
}

function handleModelsList(opts: AuthGatewayBootOptions): Response {
	const seen = new Set<string>();
	const data: ModelListRow[] = [];
	for (const model of opts.listModels?.() ?? []) {
		const id = `${model.provider}/${model.id}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const row: ModelListRow = {
			id,
			object: "model",
			owned_by: model.provider,
			api: model.api,
			display_name: model.name,
			input_modalities: model.input,
		};
		if (modelKind(model) !== "chat") row.kind = modelKind(model);
		if (model.contextWindow != null) row.context_length = model.contextWindow;
		if (model.maxTokens != null) row.max_output_tokens = model.maxTokens;
		if (model.supportsTools === false) row.supports_tools = false;
		data.push(row);
	}
	return json(200, { object: "list", data });
}

interface RouteListRow {
	id: string;
	generation: number;
	targets: readonly string[];
	fallbacks: CompiledRoute["fallbacks"];
}

function handleRoutesList(registry: RouteRegistry): Response {
	const data: RouteListRow[] = [];
	for (const route of registry.list()) {
		data.push({
			id: route.id,
			generation: route.generation,
			targets: route.targets,
			fallbacks: route.fallbacks,
		});
	}
	return json(200, { object: "list", generation: registry.generation, data });
}

function handleRouteGet(registry: RouteRegistry, id: string): Response {
	const route = registry.get(id);
	if (!route) {
		return json(404, { error: `Unknown route: ${id}` });
	}
	const row: RouteListRow = {
		id: route.id,
		generation: route.generation,
		targets: route.targets,
		fallbacks: route.fallbacks,
	};
	return json(200, row);
}

async function handleRoutePut(registry: RouteRegistry, id: string, req: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		return json(400, { error: `Invalid JSON body: ${String(error)}` });
	}

	try {
		if (isRecord(body) && Object.hasOwn(body, "id")) {
			if (body.id !== id) {
				throw new AIError.ValidationError(`Route definition id must equal path id "${id}"`);
			}
		} else if (isRecord(body)) {
			body = { ...body, id };
		}
		const definition = parseRouteDefinition(body);
		registry.register(definition);
	} catch (error) {
		if (error instanceof AIError.ValidationError) {
			return json(400, { error: error.message });
		}
		throw error;
	}
	return handleRouteGet(registry, id);
}

function handleRouteDelete(registry: RouteRegistry, id: string): Response {
	if (!registry.unregister(id)) {
		return json(404, { error: `Unknown route: ${id}` });
	}
	return new Response(null, { status: 204 });
}

function handleExecutionTraces(traces: RouteDecisionTraceLog, id: string): Response {
	const recorded = traces.get(id);
	if (recorded.length === 0) {
		return json(404, { error: `Unknown execution: ${id}` });
	}
	const data: RouteDecisionTrace[] = [];
	for (const trace of recorded) {
		const row: RouteDecisionTrace = {
			requestId: trace.requestId,
			routeId: trace.routeId,
			generation: trace.generation,
			selectedTarget: trace.selectedTarget,
			disposition: trace.disposition,
			recordedAtMs: trace.recordedAtMs,
		};
		if (trace.reason !== undefined) row.reason = trace.reason;
		data.push(row);
	}
	return json(200, { object: "list", data });
}

interface HealthRouteRow {
	id: string;
	generation: number;
	targets: readonly string[];
}

function handleHealthRoutes(registry: RouteRegistry): Response {
	const data: HealthRouteRow[] = [];
	for (const route of registry.list()) {
		data.push({
			id: route.id,
			generation: route.generation,
			targets: route.targets,
		});
	}
	return json(200, { object: "list", generation: registry.generation, data });
}

interface CredentialListRow {
	id: number;
	provider: string;
	type: "api_key" | "oauth";
}

function handleCredentialsList(storage: AuthStorage): Response {
	const data: CredentialListRow[] = [];
	for (const entry of storage.exportSnapshot().credentials) {
		data.push({
			id: entry.id,
			provider: entry.provider,
			type: entry.credential.type,
		});
	}
	return json(200, { object: "list", data });
}

async function handleCredentialDisable(storage: AuthStorage, id: string): Promise<Response> {
	const ok = await storage.disableCredentialByIdAsync(Number(id), "gateway");
	if (!ok) {
		return json(404, { error: `No credential with id=${id}` });
	}
	return json(200, { ok: true });
}

async function handleCredentialPin(storage: AuthStorage, id: string, req: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		return json(400, { error: `Invalid JSON body: ${String(error)}` });
	}
	if (!isRecord(body) || typeof body.provider !== "string" || typeof body.sessionId !== "string") {
		return json(400, { error: "provider and sessionId are required" });
	}
	if (body.provider.length === 0 || body.sessionId.length === 0) {
		return json(400, { error: "provider and sessionId are required" });
	}
	if (!storage.pinSessionOAuthAccount(body.provider, body.sessionId, Number(id))) {
		return json(404, { error: `No credential with id=${id}` });
	}
	return json(200, { ok: true });
}

/** `GET /v1/videos/:id` (poll) and `GET /v1/videos/:id/content` (download); group 1 = id, group 2 = `/content`. */
const VIDEO_JOB_PATH = /^\/v1\/videos\/([^/]+)(\/content)?$/;

export function startAuthGateway(opts: AuthGatewayBootOptions): AuthGatewayServerHandle {
	const registry = opts.routeRegistry ?? new RouteRegistry(opts.resolveModel);
	if (opts.routes?.length) registry.replaceAll([...registry.list(), ...opts.routes]);
	const traces = opts.decisionTraces ?? new RouteDecisionTraceLog();
	const health = new ProviderHealthBook();
	const cacheStore = new PromptCacheAffinityStore();
	// Owned by this server instance so two gateways in one process never share
	// (or tear down) each other's provider state, and so `close()` can drain it.
	const sessionStates = new AuthGatewaySessionStateStore();
	const boot: AuthGatewayBootOptions = {
		...opts,
		routeRegistry: registry,
		decisionTraces: traces,
	};
	const bind = parseBind(boot.bind ?? DEFAULT_AUTH_GATEWAY_BIND);
	const tokens = new Set<string>(boot.bearerTokens);
	const version = boot.version;

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const peer = resolvePeer(req);
			// CORS preflight is always answered without auth — browsers send
			// preflights pre-authentication and a 401 here breaks the actual
			// request before the bearer is ever attached.
			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders(req) });
			}
			try {
				if (req.method === "GET" && pathname === "/healthz") {
					return withCors(json(200, { ok: true, version }), req);
				}
				if (!isAuthorized(req, tokens)) {
					logger.info("auth-gateway request unauthorized", { method: req.method, path: pathname, peer });
					return withCors(json(401, { error: "unauthorized" }), req);
				}

				// Aggregated usage — backed by AuthStorage's 5-min per-credential cache.
				// Same shape as the broker's `/v1/usage`, so widget/llm-git speak to either with the
				// same client struct.
				if (req.method === "GET" && pathname === "/v1/usage") {
					return withCors(await handleUsage(boot.storage, req.signal), req);
				}

				// Per-credential auth probe — diagnoses which row in a multi-account
				// pool is producing 401s. Aggregated `/v1/usage` silently drops failed
				// credentials, so we need a separate endpoint that captures errors.
				if (req.method === "GET" && pathname === "/v1/credentials/check") {
					return withCors(await handleCredentialsCheck(boot.storage, req.signal), req);
				}
				if (req.method === "GET" && pathname === "/v1/credentials") {
					return withCors(handleCredentialsList(boot.storage), req);
				}
				const credentialAction = /^\/v1\/credentials\/([^/]+)\/(disable|pin)$/.exec(pathname);
				if (req.method === "POST" && credentialAction) {
					const credentialId = credentialAction[1]!;
					if (credentialAction[2] === "disable") {
						return withCors(await handleCredentialDisable(boot.storage, credentialId), req);
					}
					return withCors(await handleCredentialPin(boot.storage, credentialId, req), req);
				}

				if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
					return withCors(await handleCountTokens(req, boot.resolveModel), req);
				}
				if (req.method === "POST" && pathname === "/v1/realtime") {
					return withCors(json(501, { error: "not available on this gateway" }), req);
				}

				// TypeSafe System One judgments (jev). TypeSafe SDKs and omp's own
				// judge point `TYPESAFE_BASE_URL` at the gateway; OpenRouter SDKs
				// reach the same handler through their Decisions path.
				if (req.method === "POST" && (pathname === "/v1/systemone" || pathname === "/alpha/decisions")) {
					return withCors(await handleSystemOne(boot, req, peer), req);
				}

				// Image generation: OpenAI `/v1/images/generations` + OpenRouter `/v1/images`
				// (JSON), and OpenAI multipart / OpenRouter JSON edits.
				if (req.method === "POST" && (pathname === "/v1/images/generations" || pathname === "/v1/images")) {
					return withCors(await handleImageGenerations(boot, req, peer), req);
				}
				if (req.method === "POST" && pathname === "/v1/images/edits") {
					return withCors(await handleImageEdits(boot, req, peer), req);
				}

				// Text-to-speech, OpenAI/OpenRouter wire; answers raw audio bytes.
				if (req.method === "POST" && pathname === "/v1/audio/speech") {
					return withCors(await handleSpeech(boot, req, peer), req);
				}

				// Speech-to-text, OpenAI multipart or OpenRouter JSON base64 wire.
				if (req.method === "POST" && pathname === "/v1/audio/transcriptions") {
					return withCors(await handleTranscriptions(boot, req, peer), req);
				}

				// Embeddings, OpenAI wire (OpenRouter is compatible).
				if (req.method === "POST" && pathname === "/v1/embeddings") {
					return withCors(await handleEmbeddings(boot, req, peer), req);
				}

				// Rerank, OpenRouter wire.
				if (req.method === "POST" && pathname === "/v1/rerank") {
					return withCors(await handleRerank(boot, req, peer), req);
				}

				// Video generation, OpenRouter's asynchronous wire: submit, then poll
				// and download by the gateway-issued job id (stateless — the id
				// encodes provider, model, and upstream job).
				if (req.method === "POST" && pathname === "/v1/videos") {
					return withCors(await handleVideoSubmit(boot, req, peer), req);
				}
				const videoJob = req.method === "GET" ? VIDEO_JOB_PATH.exec(pathname) : null;
				if (videoJob) {
					const gatewayId = decodeURIComponent(videoJob[1]!);
					const handler = videoJob[2] ? handleVideoContent : handleVideoPoll;
					return withCors(await handler(boot, req, peer, gatewayId), req);
				}
				// Provider-format dispatch.
				let formatRoute = FORMAT_ROUTES[pathname];
				let pathModel: string | undefined;
				const geminiPath = GEMINI_MODEL_PATH.exec(pathname);
				if (!formatRoute && geminiPath) {
					formatRoute = { module: geminiV1beta, label: "gemini-v1beta" };
					try {
						pathModel = decodeURIComponent(geminiPath[1]!);
					} catch {
						pathModel = geminiPath[1];
					}
				}
				if (formatRoute && req.method === "POST") {
					const geminiStream =
						formatRoute.label === "gemini-v1beta" ? pathname.includes("streamGenerateContent") : undefined;
					return withCors(
						await handleFormatEndpoint(
							formatRoute,
							boot,
							req,
							peer,
							health,
							cacheStore,
							sessionStates,
							pathModel,
							geminiStream,
						),
						req,
					);
				}

				// Pi-native fast path. Same auth + provider plumbing as the
				// foreign-wire routes, just without the wire-format translation.
				if (req.method === "POST" && pathname === "/v1/pi/stream") {
					return withCors(await handlePiNative(boot, req, peer, health, cacheStore, sessionStates), req);
				}

				// Model catalog.
				if (req.method === "GET" && pathname === "/v1/models") {
					return withCors(handleModelsList(boot), req);
				}

				// Virtual routes — registered ids only, not catalog models.
				if (req.method === "GET" && pathname === "/v1/routes") {
					return withCors(handleRoutesList(registry), req);
				}
				let routeId: string | undefined;
				if (pathname.startsWith("/v1/routes/")) {
					try {
						routeId = decodeURIComponent(pathname.slice("/v1/routes/".length));
					} catch {
						return withCors(json(400, { error: "Invalid encoded route id" }), req);
					}
				}
				if (req.method === "GET" && pathname.startsWith("/v1/routes/")) {
					const id = routeId!;
					if (id.length === 0) {
						return withCors(handleRoutesList(registry), req);
					}
					return withCors(handleRouteGet(registry, id), req);
				}
				if (req.method === "PUT" && pathname.startsWith("/v1/routes/")) {
					const id = routeId!;
					if (id.length === 0) {
						return withCors(json(404, { error: `No route: PUT ${pathname}` }), req);
					}
					return withCors(await handleRoutePut(registry, id, req), req);
				}
				if (req.method === "DELETE" && pathname.startsWith("/v1/routes/")) {
					const id = routeId!;
					if (id.length === 0) {
						return withCors(json(404, { error: `No route: DELETE ${pathname}` }), req);
					}
					return withCors(handleRouteDelete(registry, id), req);
				}
				if (req.method === "GET" && pathname === "/v1/health/routes") {
					return withCors(handleHealthRoutes(registry), req);
				}
				if (req.method === "GET" && pathname.startsWith("/v1/executions/")) {
					const id = pathname.slice("/v1/executions/".length);
					if (id.length === 0) {
						return withCors(json(404, { error: `No route: GET ${pathname}` }), req);
					}
					return withCors(handleExecutionTraces(traces, id), req);
				}

				// Route-table miss: no format module to defer to, so we emit a
				// plain JSON 404 rather than guessing at a protocol-specific envelope.
				return withCors(json(404, { error: `No route: ${req.method} ${pathname}` }), req);
			} catch (error) {
				logger.error("auth-gateway handler crashed", {
					method: req.method,
					path: pathname,
					peer,
					error: String(error),
				});
				return withCors(json(500, { error: "internal error" }), req);
			}
		},
		// Max-out Bun's idle timeout. Long thinking-budget calls can sit idle
		// for minutes before the first token arrives; the default kills them.
		idleTimeout: 255,
	});

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		close: async () => {
			server.stop(true);
			// Drain after the listener is down: the retained provider states own
			// sockets and timers (Codex WebSockets, GitLab Duo workflows), so the
			// process can't settle until each one is closed.
			sessionStates.close();
		},
	};
}
