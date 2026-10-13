/**
 * omp auth-gateway router and HTTP server.
 *
 * Accepts any provider-format request (OpenAI chat-completions, Anthropic
 * messages, OpenAI Responses) and dispatches through pi-ai's `streamSimple()`
 * — which handles credential injection, anthropic-beta headers, codex
 * websocket transport, and all the per-provider intricacies. The gateway is
 * pure protocol translation: foreign wire → omp Context → pi-ai stream() →
 * omp events → foreign wire.
 *
 * Endpoints:
 *   GET  /healthz                          → unauth; ok + version
 *   GET  /v1/usage                         → aggregated provider usage (5-min per-credential cache via AuthStorage)
 *   GET  /v1/credentials/check             → per-credential auth probe (diagnose 401s in a multi-account pool)
 *   GET  /v1/models                        → list known models from the registry
 *   GET  /v1/routes                        → list registered virtual routes
 *   GET  /v1/routes/:id                    → inspect one registered virtual route
 *   PUT  /v1/routes/:id                    → register/replace a route (opt-in admin)
 *   DELETE /v1/routes/:id                  → remove a route (opt-in admin)
 *   POST /v1/chat/completions              → OpenAI chat-completions in/out
 *   POST /v1/messages                      → Anthropic messages in/out
 *   POST /v1/responses                     → OpenAI Responses in/out
 *   POST /v1/pi/stream                     → native pi-ai stream in/out
 *   POST /v1/systemone | /alpha/decisions  → TypeSafe System One judgments (routes/systemone)
 *   POST /v1/images[/generations|/edits]   → image generation, OpenAI/OpenRouter wire (routes/images)
 *   POST /v1/audio/speech                  → text-to-speech, raw audio out (routes/speech)
 *   POST /v1/audio/transcriptions          → speech-to-text, multipart or JSON base64 in (routes/transcriptions)
 *
 * Chat routes live in this file; every other modality is a `routes/*` module
 * built on the shared plumbing in `dispatch.ts`. {@link createAuthGatewayRouter}
 * answers the `/v1/*` routes for any transport: {@link startAuthGateway}
 * serves them over HTTP behind bearer auth, `stdio.ts` over JSON lines.
 */

import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { type ModelKind, modelKind } from "@oh-my-pi/pi-catalog/types";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "../auth-storage";
import { ValidationError } from "../error";
import * as anthropicMessages from "../providers/anthropic-messages-server";
import * as geminiV1beta from "../providers/gemini-v1beta-server";
import { handleCountTokens } from "../providers/anthropic-count-tokens-server";
import * as openaiChat from "../providers/openai-chat-server";
import * as openaiResponses from "../providers/openai-responses-server";
import * as piNative from "../providers/pi-native-server";
export * from "./legacy-turn";
import type { Api, Context, Model, SimpleStreamOptions } from "../types";
import { deterministicUuid } from "../utils/deterministic-id";
import { parseBind } from "../utils/parse-bind";
import { resolvePeer } from "../utils/resolve-peer";
import { runGatewayChatExecution } from "./chat-execution";
import { RouteDecisionTraceLog } from "./decision-trace";
import {
	type AuthGatewayBootOptions,
	type AuthGatewayRouteOptions,
	mirrorRequestAbort,
	normalizeClientSessionKey,
} from "./dispatch";
import {
	captureRequestHeaders,
	corsHeaders,
	hasMisplacedBearer,
	isAuthorized,
	json,
	resolveClientIdentity,
	resolvePromptCacheKey,
	withCors,
} from "./http";
import {
	type GatewayResponseOwner,
	type GatewayResponseOwnership,
	responseEndpointIdentity,
} from "./response-ownership";
import { RouteRegistry } from "./route-graph";
import { ProviderHealthBook } from "./provider-health";
import { PromptCacheAffinityStore } from "./prompt-cache-store";
import { routeRequestFacts } from "./request-facts";
import { parseRouteDefinition } from "./route-definitions";
import { handleEmbeddings } from "./routes/embeddings";
import { handleImageEdits, handleImageGenerations } from "./routes/images";
import { handleRerank } from "./routes/rerank";
import { handleSpeech } from "./routes/speech";
import { handleSystemOne } from "./routes/systemone";
import { handleTranscriptions } from "./routes/transcriptions";
import { handleVideoContent, handleVideoPoll, handleVideoSubmit } from "./routes/video";
import { AuthGatewaySessionStateStore } from "./session-state";
import type {
	AuthGatewayParsedRequestOptions,
	AuthGatewayServerHandle,
	AuthGatewayFormatModule as FormatModule,
	AuthGatewayParsedRequest as ParsedFormatRequest,
} from "./types";
import { DEFAULT_AUTH_GATEWAY_BIND } from "./types";

// `parseBind` lives in ../utils/parse-bind so the gateway and broker can't
// drift on accepted inputs (e.g. empty hostname, IPv6 brackets).

interface FormatRoute {
	module: FormatModule;
	label: string;
	pathModel?: string;
	pathStreaming?: boolean;
}

const GEMINI_MODEL_PATH = /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/;
const FORMAT_ROUTES: Record<string, FormatRoute> = {
	"/v1/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/grok/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/messages": { module: anthropicMessages, label: "anthropic-messages" },
	"/v1/responses": { module: openaiResponses, label: "openai-responses" },
	"/backend-api/codex/responses": { module: openaiResponses, label: "openai-responses" },
	"/backend-api/responses": { module: openaiResponses, label: "openai-responses" },
	"/v1beta/models/generateContent": { module: geminiV1beta, label: "gemini-v1beta", pathStreaming: false },
	"/v1beta/models/streamGenerateContent": { module: geminiV1beta, label: "gemini-v1beta", pathStreaming: true },
};

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
 *
 * The derivation MUST stay byte-stable: AuthStorage persists credential pins
 * under this id, so changing it re-routes every in-flight conversation.
 * `toolsJson` lets the caller share one `JSON.stringify(context.tools)` with
 * {@link AuthGatewaySessionStateStore.acquire}.
 */
function deriveSessionId(modelId: string, context: Context, toolsJson = serializeTools(context)): string {
	const parts: string[] = [modelId];
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		parts.push(context.systemPrompt.join("\n\n"));
	}
	if (toolsJson !== undefined) {
		parts.push(toolsJson);
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

/** `JSON.stringify(context.tools)`, or `undefined` when the request declares none. */
function serializeTools(context: Context): string | undefined {
	return context.tools && context.tools.length > 0 ? JSON.stringify(context.tools) : undefined;
}

function buildStreamOptions(parsed: ParsedFormatRequest, api: Api, signal: AbortSignal): SimpleStreamOptions {
	const opts: SimpleStreamOptions = {
		signal,
		cursorExternalToolExecutor: true,
	};
	const { options } = parsed;
	applyParsedGatewayOptions(opts, options);
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
		opts.thinkingBudgets = {
			...opts.thinkingBudgets,
			...options.thinkingBudgets,
		};
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
	if (options.responseMimeType !== undefined) opts.responseMimeType = options.responseMimeType;
	if (options.responseSchema !== undefined) opts.responseSchema = options.responseSchema;
	if (options.responseJsonSchema !== undefined) opts.responseJsonSchema = options.responseJsonSchema;
}

function clientClosedResponse(route: { module: FormatModule }): Response {
	return route.module.formatError(499, "request_aborted", "client closed request");
}

function continuationRejection(
	storage: AuthStorage,
	model: Model<Api>,
	previousId: string | undefined,
	owner: Readonly<GatewayResponseOwner> | undefined,
	headers?: Record<string, string>,
): string | undefined {
	if (!previousId) return undefined;
	if (owner?.credentialId !== undefined) {
		const explicit = storage.sessions.explicitCredentialId(model.provider, owner.sessionId);
		if (explicit !== undefined && explicit !== owner.credentialId)
			return "previous_response_id belongs to another account";
	}
	if (model.api !== "openai-responses" && model.api !== "azure-openai-responses") {
		return "previous_response_id requires an OpenAI or Azure Responses upstream";
	}
	if (
		owner &&
		(owner.target !== `${model.provider}/${model.id}` ||
			owner.api !== model.api ||
			owner.endpoint !== responseEndpointIdentity(model, headers))
	) {
		return "previous_response_id belongs to another upstream deployment";
	}
	if (
		!owner &&
		storage.peekApiKeyOverrides(model.provider) === undefined &&
		storage.credentials.list(model.provider).length > 1
	) {
		return "Unknown previous_response_id is ambiguous across multiple stored credentials";
	}
	return undefined;
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
function chatRouteRejection(model: Model<Api>, context: Context): string | undefined {
	const kind = modelKind(model);
	const route = KIND_ROUTES[kind];
	if (route) return `Model ${model.provider}/${model.id} is a ${kind} model; use ${route}`;
	if (
		model.api !== "openai-responses" &&
		model.api !== "azure-openai-responses" &&
		model.api !== "openai-codex-responses" &&
		context.messages.some(message => {
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
					isRecord(item) &&
					Array.isArray(item.content) &&
					item.content.some(
						part =>
							isRecord(part) &&
							(part.type === "input_image" || part.type === "input_file") &&
							typeof part.file_id === "string" &&
							part.file_id.length > 0,
					),
			);
		})
	)
		return "OpenAI file references require a Responses-compatible upstream model";
	return undefined;
}

// (handlePassthrough removed — see note above.)

async function handleFormatEndpoint(
	route: FormatRoute,
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	sessionStates: AuthGatewaySessionStateStore,
	responseOwners: GatewayResponseOwnership,
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
	if (route.pathModel !== undefined || route.pathStreaming !== undefined) {
		if (!isRecord(body))
			return route.module.formatError(400, "invalid_request_error", "Request body must be an object");
		if (route.pathModel !== undefined && body.model !== undefined && body.model !== route.pathModel)
			return route.module.formatError(400, "invalid_request_error", "Body model must match the model-action path");
		body = {
			...body,
			...(route.pathModel !== undefined ? { model: route.pathModel } : {}),
			stream: route.pathStreaming,
		};
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
	const registry = bootOpts.routeRegistry ?? new RouteRegistry(bootOpts.resolveModel);
	const client = resolveClientIdentity(req.headers);

	// Parse the wire-format request BEFORE resolving the credential so we
	// have a stable per-conversation `sessionId` to thread into AuthStorage.
	// Sticky-credential tracking and `markUsageLimitReached` both key off
	// this id; without it `getApiKey` would re-roundrobin every request
	// and `markUsageLimitReached` would no-op (it can only mark the
	// credential it last handed out to that session).
	let parsed: ParsedFormatRequest;
	try {
		parsed = route.module.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const message = error instanceof Error ? error.message : String(error);
		return route.module.formatError(400, "invalid_request_error", message);
	}
	const compiled = registry.resolve(modelId, routeRequestFacts(parsed.context));
	if (!compiled) return route.module.formatError(404, "invalid_request_error", `Unknown model: ${modelId}`);
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

	// Sticky credential id: honour the client's `prompt_cache_key` when
	// supplied (so external session ids align), then a remembered
	// `previous_response_id` chain key (a continuation's context holds only the
	// new input, so content derivation cannot reproduce the original session —
	// without this lookup each hop can land on a different account whose store
	// does not know the referenced response), otherwise derive from
	// modelId + system + tools + first message. Mirrored into
	// streamOpts.sessionId / promptCacheKey by `buildStreamOptions`.
	const clientKey = normalizeClientSessionKey(parsed.options.promptCacheKey);
	const previousId = parsed.options.previousResponseId;
	const previousOwner = previousId ? responseOwners.get(previousId) : undefined;
	const toolsJson = clientKey === undefined ? serializeTools(parsed.context) : undefined;
	const sessionId =
		previousOwner?.sessionId ?? clientKey ?? deriveSessionId(parsed.modelId, parsed.context, toolsJson);
	parsed.options.promptCacheKey = sessionId;
	return runGatewayChatExecution({
		boot: bootOpts,
		registry,
		compiled,
		requestId,
		controller,
		peer,
		startedAt,
		label: route.label,
		requestedModelId: parsed.modelId,
		context: parsed.context,
		stream: parsed.stream,
		client,
		sessionId,
		clientKey,
		toolsJson,
		previousId,
		previousOwner,
		requestHeaders: parsed.options.headers,
		cacheFingerprint: Bun.SHA256.hash(
			JSON.stringify([compiled.id, resolvePromptCacheKey(body, req.headers) ?? sessionId]),
			"hex",
		),
		requiresNativeSurface:
			parsed.options.responseMimeType !== undefined ||
			parsed.options.responseSchema !== undefined ||
			parsed.options.responseJsonSchema !== undefined
				? "gemini-v1beta"
				: undefined,
		sessionStates,
		responseOwners,
		validateModel: target => {
			const rejection =
				chatRouteRejection(target, parsed.context) ??
				continuationRejection(bootOpts.storage, target, previousId, previousOwner, parsed.options.headers);
			if (rejection) return rejection;
			return undefined;
		},
		buildOptions: (target, signal) => buildStreamOptions(parsed, target.api, signal),
		encodeResponse: message => route.module.encodeResponse(message, parsed.modelId, parsed.options),
		encodeStream: (events, control) => route.module.encodeStream(events, parsed.modelId, parsed.options, control),
		formatError: route.module.formatError,
	});
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
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	sessionStates: AuthGatewaySessionStateStore,
	responseOwners: GatewayResponseOwnership,
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

	const registry = bootOpts.routeRegistry ?? new RouteRegistry(bootOpts.resolveModel);
	const compiled = registry.resolve(parsed.modelId, routeRequestFacts(parsed.context));
	if (!compiled) {
		return piNative.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	const client = resolveClientIdentity(req.headers);
	// Prefer the native cache identity, then the explicit session/header
	// identity; fall back to the derived key so credential-stickiness lines
	// up with cache-prefix stickiness — same identity used for both means
	// the next turn of this conversation reuses the same credential until
	// it hits a usage cap, then markUsageLimitReached can hand off.
	const clientKey =
		normalizeClientSessionKey(parsed.options.promptCacheKey) ??
		normalizeClientSessionKey(parsed.options.sessionId) ??
		normalizeClientSessionKey(resolvePromptCacheKey(body, req.headers));
	const previousId = parsed.options.previousResponseId;
	const previousOwner = previousId ? responseOwners.get(previousId) : undefined;
	const requestHeaders = {
		...captureRequestHeaders(req.headers),
		...parsed.options.headers,
	};
	const toolsJson = clientKey === undefined ? serializeTools(parsed.context) : undefined;
	const sessionId =
		previousOwner?.sessionId ?? clientKey ?? deriveSessionId(parsed.modelId, parsed.context, toolsJson);
	parsed.options.sessionId = sessionId;
	return runGatewayChatExecution({
		boot: bootOpts,
		registry,
		compiled,
		requestId,
		controller,
		peer,
		startedAt,
		label: "pi-native",
		requestedModelId: parsed.modelId,
		context: parsed.context,
		stream: parsed.stream,
		client,
		sessionId,
		clientKey,
		toolsJson,
		previousId,
		previousOwner,
		requestHeaders,
		cacheFingerprint: Bun.SHA256.hash(JSON.stringify([compiled.id, sessionId]), "hex"),
		requiresNativeSurface:
			parsed.options.responseMimeType !== undefined ||
			parsed.options.responseSchema !== undefined ||
			parsed.options.responseJsonSchema !== undefined
				? "gemini-v1beta"
				: undefined,
		sessionStates,
		responseOwners,
		validateModel: target =>
			chatRouteRejection(target, parsed.context) ??
			continuationRejection(bootOpts.storage, target, previousId, previousOwner, requestHeaders),
		buildOptions: (target, signal) => {
			const options: SimpleStreamOptions = {
				...parsed.options,
				headers: requestHeaders,
				signal,
				cursorExternalToolExecutor: true,
				sessionId,
			};
			if (target.api === "openai-codex-responses") {
				delete options.temperature;
				delete options.topP;
				delete options.topK;
				delete options.minP;
				delete options.stopSequences;
				delete options.presencePenalty;
				delete options.frequencyPenalty;
				delete options.repetitionPenalty;
			}
			return options;
		},
		encodeResponse: message => ({ message }),
		encodeStream: (events, control) => piNative.encodeStream(events, parsed.modelId, parsed.options, control),
		formatError: piNative.formatError,
	});
}

/**
 * Snapshot of `GET /v1/usage` — `fetchUsageReports` already caches reports at
 * a 5-minute per-credential TTL (with jitter, plus last-good fallback on
 * failure) inside `AuthStorage`, so this handler is a thin wrapper that
 * surfaces the same data to HTTP callers (notably the macOS usage widget).
 */
async function handleUsage(opts: AuthGatewayRouteOptions, signal: AbortSignal): Promise<Response> {
	const reports = (await opts.storage.usage.reports?.({ signal })) ?? [];
	// Drop the heavy provider-specific `raw` payload — UI consumers only need
	// `limits` + `metadata`. Match the broker's `/v1/usage` shape so a single
	// client struct (Swift widget, llm-git, ...) works against either endpoint.
	const trimmed = reports
		.filter(report => !opts.excludeProviders?.has(report.provider))
		.map(({ raw: _raw, ...rest }) => rest);
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
async function handleCredentialsCheck(opts: AuthGatewayRouteOptions, signal: AbortSignal): Promise<Response> {
	const credentials = await opts.storage.health.check({
		signal,
		excludeProviders: opts.excludeProviders,
	});
	return json(200, { generatedAt: Date.now(), credentials });
}

/**
 * Row shape for `GET /v1/models`. Beyond the OpenAI-standard `id`/`object`/
 * `owned_by`, rows advertise the catalog metadata OpenAI-compatible clients
 * (omp's own proxy discovery, Zed's openai_compatible provider, ...) read to
 * size and capability-gate discovered models: `context_length`,
 * `max_output_tokens`, `input_modalities`, and `supports_tools` (only emitted
 * when the catalog explicitly reports `false`; absent means usable). `kind` is
 * emitted for non-chat rows (`judge`, `image`, `tts`, `stt`, `embedding`,
 * `rerank`, `video`) so clients can keep them off chat routes; absent means chat.
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

function handleModelsList(opts: AuthGatewayRouteOptions): Response {
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

function handleRoutesList(registry: RouteRegistry): Response {
	const data = registry
		.list()
		.map(({ id, generation, targets, fallbacks }) => ({ id, generation, targets, fallbacks }));
	return json(200, { object: "list", generation: registry.generation, data });
}

function handleRouteGet(registry: RouteRegistry, id: string): Response {
	const route = registry.get(id);
	if (!route) return json(404, { error: `Unknown route: ${id}` });
	const { generation, targets, fallbacks } = route;
	return json(200, { id, generation, targets, fallbacks });
}

async function handleRoutePut(registry: RouteRegistry, id: string, req: Request): Promise<Response> {
	let body: unknown;
	try {
		body = Bun.JSON5.parse(await req.text());
	} catch {
		return json(400, { error: "Invalid JSON/JSON5 body" });
	}
	try {
		if (!isRecord(body)) throw new ValidationError("Route definition must be an object");
		if (Object.hasOwn(body, "id") && body.id !== id)
			throw new ValidationError("Route definition id must equal path id");
		registry.register(parseRouteDefinition({ ...body, id }));
	} catch (error) {
		if (error instanceof ValidationError) return json(400, { error: error.message });
		throw error;
	}
	return handleRouteGet(registry, id);
}

function handleRouteDelete(registry: RouteRegistry, id: string): Response {
	return registry.unregister(id) ? new Response(null, { status: 204 }) : json(404, { error: `Unknown route: ${id}` });
}

const CREDENTIAL_ACTION_PATH = /^\/v1\/credentials\/([^/]+)\/(disable|pin)$/;

function managementRejection(
	req: Request,
	opts: AuthGatewayRouteOptions,
	adminTokens: ReadonlySet<string>,
): Response | undefined {
	if (opts.allowManagement !== true) return json(404, { error: "management disabled" });
	if (adminTokens.size === 0 || !isAuthorized(req, adminTokens))
		return json(403, { error: "Management mutation requires separate administrator authorization" });
	if (hasMisplacedBearer(req, new URL(req.url), adminTokens))
		return json(400, { error: "gateway bearer token outside Authorization" });
	return undefined;
}

async function handleCredentialsList(storage: AuthStorage): Promise<Response> {
	await storage.credentials.reload();
	const data = storage.credentials
		.snapshot()
		.credentials.map(row => ({ id: row.id, provider: row.provider, type: row.credential.type }));
	return json(200, { object: "list", data });
}

async function handleCredentialAction(
	storage: AuthStorage,
	rawId: string,
	action: string,
	req: Request,
): Promise<Response> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(rawId);
	} catch {
		return json(400, { error: "invalid credential id encoding" });
	}
	const id = Number(decoded);
	if (!/^[1-9]\d*$/.test(decoded) || !Number.isSafeInteger(id)) return json(400, { error: "Invalid credential id" });
	await storage.credentials.reload();
	if (action === "disable") {
		return (await storage.credentials.disable(id, "gateway"))
			? json(200, { ok: true })
			: json(404, { error: `No credential with id=${id}` });
	}
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return json(400, { error: "Invalid JSON body" });
	}
	if (
		!isRecord(body) ||
		typeof body.provider !== "string" ||
		!body.provider.trim() ||
		typeof body.sessionId !== "string" ||
		!body.sessionId.trim()
	)
		return json(400, { error: "provider and sessionId are required" });
	return storage.sessions.pin(body.provider, body.sessionId, id)
		? json(200, { ok: true })
		: json(404, { error: `No credential with id=${id}` });
}

/** `GET /v1/videos/:id` (poll) and `GET /v1/videos/:id/content` (download); group 1 = id, group 2 = `/content`. */
const VIDEO_JOB_PATH = /^\/v1\/videos\/([^/]+)(\/content)?$/;

// Only exact static routes are safe to include in unauthorized request logs.
// Dynamic video IDs and unknown paths may carry credentials.
const LOGGABLE_PATHS: Record<string, true> = {
	"/v1/usage": true,
	"/v1/credentials/check": true,
	"/v1/pi/stream": true,
	"/v1/systemone": true,
	"/alpha/decisions": true,
	"/v1/images/generations": true,
	"/v1/images": true,
	"/v1/images/edits": true,
	"/v1/audio/speech": true,
	"/v1/audio/transcriptions": true,
	"/v1/embeddings": true,
	"/v1/rerank": true,
	"/v1/videos": true,
	"/v1/models": true,
};

/** Only static routes reach logs verbatim; dynamic or unknown paths may carry caller-supplied secrets. */
function loggablePath(pathname: string): string {
	return Object.hasOwn(FORMAT_ROUTES, pathname) || Object.hasOwn(LOGGABLE_PATHS, pathname) ? pathname : "<unrouted>";
}

/** The gateway's `/v1/*` routes, for a transport that has already admitted the caller. */
export interface AuthGatewayRouter {
	/** Answers one request; `peer` names the caller in logs. Never rejects: a crashed route answers 500. */
	route(req: Request, peer: string): Promise<Response>;
	/**
	 * Closes the retained provider session state (Codex WebSockets, GitLab Duo
	 * workflows), whose sockets and timers would otherwise keep the process alive.
	 */
	close(): void;
}

/**
 * The gateway's routes over `opts`, owning their per-session provider state:
 * two routers in one process never share (or tear down) each other's.
 */
export function createAuthGatewayRouter(opts: AuthGatewayRouteOptions): AuthGatewayRouter {
	const routeRegistry = opts.routeRegistry ?? new RouteRegistry(opts.resolveModel);
	routeRegistry.registerMany(opts.routes ?? []);
	const adminTokens = new Set(opts.adminBearerTokens?.filter(token => token.trim().length > 0));
	const boot: AuthGatewayRouteOptions = {
		...opts,
		routeRegistry,
		decisionTraces: opts.decisionTraces ?? new RouteDecisionTraceLog(),
		providerHealth: opts.providerHealth ?? new ProviderHealthBook(),
		promptCacheAffinity: opts.promptCacheAffinity ?? new PromptCacheAffinityStore(),
	};
	const sessionStates = new AuthGatewaySessionStateStore();
	const responseOwners: GatewayResponseOwnership = {
		get: responseId => opts.storage.responses.get(responseId),
		record: (responseId, owner) => opts.storage.responses.record(responseId, owner),
	};
	const route = async (req: Request, peer: string): Promise<Response> => {
		const pathname = new URL(req.url).pathname;
		try {
			// Aggregated usage — backed by AuthStorage's 5-min per-credential cache.
			// Same shape as the broker's `/v1/usage`, so widget/llm-git speak to either with the
			// same client struct.
			if (req.method === "GET" && pathname === "/v1/usage") {
				return await handleUsage(opts, req.signal);
			}

			// Per-credential auth probe — diagnoses which row in a multi-account
			// pool is producing 401s. Aggregated `/v1/usage` silently drops failed
			// credentials, so we need a separate endpoint that captures errors.
			if (req.method === "GET" && pathname === "/v1/credentials/check") {
				return await handleCredentialsCheck(opts, req.signal);
			}

			// Provider-format dispatch.
			if (req.method === "POST") {
				const geminiPath = GEMINI_MODEL_PATH.exec(pathname);
				if (geminiPath) {
					let pathModel: string;
					try {
						pathModel = decodeURIComponent(geminiPath[1]!);
					} catch {
						return geminiV1beta.formatError(400, "invalid_request_error", "invalid model path encoding");
					}
					return await handleFormatEndpoint(
						{
							module: geminiV1beta,
							label: "gemini-v1beta",
							pathModel,
							pathStreaming: geminiPath[2] === "streamGenerateContent",
						},
						boot,
						req,
						peer,
						sessionStates,
						responseOwners,
					);
				}
			}
			if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
				return await handleCountTokens(req, id => {
					const compiled = routeRegistry.resolve(id);
					return compiled?.targets
						.map(target => routeRegistry.getModel(compiled, target))
						.find(model => model !== undefined);
				});
			}
			if (req.method === "GET" && pathname === "/v1/credentials") return await handleCredentialsList(opts.storage);
			const credentialAction = req.method === "POST" ? CREDENTIAL_ACTION_PATH.exec(pathname) : null;
			if (credentialAction) {
				const rejected = managementRejection(req, opts, adminTokens);
				if (rejected) return rejected;
				return await handleCredentialAction(opts.storage, credentialAction[1]!, credentialAction[2]!, req);
			}
			const formatRoute = FORMAT_ROUTES[pathname];
			if (formatRoute && req.method === "POST") {
				return await handleFormatEndpoint(formatRoute, boot, req, peer, sessionStates, responseOwners);
			}

			// Pi-native fast path. Same auth + provider plumbing as the
			// foreign-wire routes, just without the wire-format translation.
			if (req.method === "POST" && pathname === "/v1/pi/stream") {
				return await handlePiNative(boot, req, peer, sessionStates, responseOwners);
			}

			// TypeSafe System One judgments (jev). TypeSafe SDKs and omp's own
			// judge point `TYPESAFE_BASE_URL` at the gateway; OpenRouter SDKs
			// reach the same handler through their Decisions path.
			if (req.method === "POST" && (pathname === "/v1/systemone" || pathname === "/alpha/decisions")) {
				return await handleSystemOne(opts, req, peer);
			}

			// Image generation: OpenAI `/v1/images/generations` + OpenRouter `/v1/images`
			// (JSON), and OpenAI multipart / OpenRouter JSON edits.
			if (req.method === "POST" && (pathname === "/v1/images/generations" || pathname === "/v1/images")) {
				return await handleImageGenerations(opts, req, peer);
			}
			if (req.method === "POST" && pathname === "/v1/images/edits") {
				return await handleImageEdits(opts, req, peer);
			}

			// Text-to-speech, OpenAI/OpenRouter wire; answers raw audio bytes.
			if (req.method === "POST" && pathname === "/v1/audio/speech") {
				return await handleSpeech(opts, req, peer);
			}

			// Speech-to-text, OpenAI multipart or OpenRouter JSON base64 wire.
			if (req.method === "POST" && pathname === "/v1/audio/transcriptions") {
				return await handleTranscriptions(opts, req, peer);
			}

			// Embeddings, OpenAI wire (OpenRouter is compatible).
			if (req.method === "POST" && pathname === "/v1/embeddings") {
				return await handleEmbeddings(opts, req, peer);
			}

			// Rerank, OpenRouter wire.
			if (req.method === "POST" && pathname === "/v1/rerank") {
				return await handleRerank(opts, req, peer);
			}

			// Video generation, OpenRouter's asynchronous wire: submit, then poll
			// and download by the gateway-issued job id (stateless — the id
			// encodes provider, model, and upstream job).
			if (req.method === "POST" && pathname === "/v1/videos") {
				return await handleVideoSubmit(opts, req, peer);
			}
			const videoJob = req.method === "GET" ? VIDEO_JOB_PATH.exec(pathname) : null;
			if (videoJob) {
				const gatewayId = decodeURIComponent(videoJob[1]);
				const handler = videoJob[2] ? handleVideoContent : handleVideoPoll;
				return await handler(opts, req, peer, gatewayId);
			}

			// Model catalog.
			if (req.method === "POST" && pathname === "/v1/realtime")
				return json(501, { error: "not available on this gateway" });
			if (req.method === "GET" && pathname === "/v1/health/routes")
				return json(200, {
					object: "list",
					generation: routeRegistry.list()[0]?.generation ?? 0,
					data: routeRegistry
						.list()
						.map(route => ({ id: route.id, generation: route.generation, targets: route.targets })),
				});
			if (req.method === "GET" && pathname === "/v1/routes") return handleRoutesList(routeRegistry);
			if (
				(req.method === "GET" || req.method === "PUT" || req.method === "DELETE") &&
				pathname.startsWith("/v1/routes/")
			) {
				const rawId = pathname.slice("/v1/routes/".length);
				if (req.method !== "GET") {
					const rejected = managementRejection(req, opts, adminTokens);
					if (rejected) return rejected;
				}
				if (!rawId)
					return req.method === "GET" ? handleRoutesList(routeRegistry) : json(404, { error: "Missing route id" });
				let id: string;
				try {
					id = decodeURIComponent(rawId);
				} catch {
					return json(400, { error: "invalid route id encoding" });
				}
				if (req.method === "PUT") return await handleRoutePut(routeRegistry, id, req);
				if (req.method === "DELETE") return handleRouteDelete(routeRegistry, id);
				return handleRouteGet(routeRegistry, id);
			}
			if (req.method === "GET" && pathname === "/v1/models") {
				return handleModelsList(opts);
			}
			if (req.method === "GET" && pathname.startsWith("/v1/executions/")) {
				const requestId = pathname.slice("/v1/executions/".length);
				const traces = boot.decisionTraces?.list().filter(entry => entry.requestId === requestId) ?? [];
				return traces.length
					? json(200, { ...traces[0], object: "list", data: traces })
					: json(404, { error: "unknown execution" });
			}

			// Route-table miss: no format module to defer to, so we emit a
			// plain JSON 404 rather than guessing at a protocol-specific envelope.
			return json(404, { error: `No route: ${req.method} ${pathname}` });
		} catch (error) {
			logger.error("auth-gateway handler crashed", {
				method: req.method,
				path: loggablePath(pathname),
				peer,
				error: String(error),
			});
			return json(500, { error: "internal error" });
		}
	};
	return { route, close: () => sessionStates.close() };
}

export function startAuthGateway(opts: AuthGatewayBootOptions): AuthGatewayServerHandle {
	const bind = parseBind(opts.bind ?? DEFAULT_AUTH_GATEWAY_BIND);
	const tokens = new Set<string>(opts.bearerTokens);
	const adminTokens = new Set(opts.adminBearerTokens?.filter(token => token.trim().length > 0));
	const allTokens = new Set([...tokens, ...adminTokens]);
	const version = opts.version;
	const router = createAuthGatewayRouter(opts);

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		fetch: async (req, server): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const socketPeer = server.requestIP(req)?.address ?? "unknown";
			// CORS preflight is always answered without auth — browsers send
			// preflights pre-authentication and a 401 here breaks the actual
			// request before the bearer is ever attached.
			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders(req) });
			}
			if (req.method === "GET" && pathname === "/healthz") {
				return withCors(json(200, { ok: true, version }), req);
			}
			const routePath = pathname === "/v1/routes" || pathname.startsWith("/v1/routes/");
			const adminSurface =
				(routePath && (req.method === "GET" || req.method === "PUT" || req.method === "DELETE")) ||
				(req.method === "POST" && CREDENTIAL_ACTION_PATH.test(pathname)) ||
				(req.method === "GET" && (pathname === "/v1/credentials" || pathname.startsWith("/v1/executions/")));
			const adminAuthorized = adminTokens.size > 0 && isAuthorized(req, adminTokens);
			if (!isAuthorized(req, tokens) && !(adminSurface && adminAuthorized)) {
				logger.info("auth-gateway request unauthorized", {
					method: req.method,
					path: loggablePath(pathname),
					peer: socketPeer,
				});
				return withCors(json(401, { error: "unauthorized" }), req);
			}
			if (hasMisplacedBearer(req, url, allTokens)) {
				return withCors(json(400, { error: "gateway bearer token outside Authorization" }), req);
			}
			const peer = resolvePeer(req, socketPeer, opts.trustProxyHeaders);
			const response = await router.route(req, peer);
			if (response.headers.get("content-type")?.startsWith("text/event-stream")) server.timeout(req, 0);
			return withCors(response, req);
		},
		// Max-out Bun's idle timeout. Long thinking-budget calls can sit idle
		// for minutes before the first token arrives; the default kills them.
		idleTimeout: opts.idleTimeout ?? 255,
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
			router.close();
		},
	};
}
