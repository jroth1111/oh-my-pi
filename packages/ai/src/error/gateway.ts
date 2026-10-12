import { stringProperty } from "@oh-my-pi/pi-utils";
import { providerRetryDirective } from "./retryable";
import {
	Flag,
	is,
	isAccountPolicyError,
	isClinePassSurfaceGateMessage,
	isOAuthExpiry,
	isUsageLimit,
	matchesOverflowText,
	status,
} from "./flags";
import {
	is402BillingCapBody,
	isConcurrencyCapExclusion,
	isUsageLimitOutcome,
	parseRateLimitReason,
} from "./rate-limit";

/** Who owns a classified gateway failure. */
export type GatewayErrorOwner =
	| "request"
	| "credential"
	| "quota"
	| "model"
	| "provider"
	| "transport"
	| "policy"
	| "orchestration"
	| "gateway"
	| "cancelled";

/** What a classified gateway failure means for retry / failover. */
export type GatewayErrorDisposition =
	| "credential_permanent"
	| "credential_quota"
	| "credential_transient"
	| "provider_transient"
	| "provider_unavailable"
	| "model_unavailable"
	| "context_overflow"
	| "request_terminal"
	| "policy_terminal"
	| "gateway_terminal"
	| "cancelled";

/** True for structured model-availability codes (`model_not_available`, Copilot's `model_not_available_for_integrator`). */
function modelUnavailableCode(err: unknown): boolean {
	if (typeof err !== "object" || err === null || !("code" in err) || typeof err.code !== "string") return false;
	return /\bmodel_not_(?:available|supported|found)(?:_\w+)?\b/i.test(err.code);
}

/** A gateway-facing classification of an arbitrary upstream/internal error. */
export interface GatewayErrorClassification {
	status: number;
	type: string;
	message: string;
	owner: GatewayErrorOwner;
	disposition: GatewayErrorDisposition;
	/** Explicit transport directive; absent when retryability was only inferred. */
	errorRetryable?: boolean;
}

const RETRYABLE_DISPOSITION: Record<GatewayErrorDisposition, boolean> = {
	// A dead credential must still fail over: rotation retires it and tries
	// a sibling. Attempt caps and sibling-exhaustion bound the loop.
	credential_permanent: true,
	credential_quota: true,
	credential_transient: true,
	provider_transient: true,
	provider_unavailable: true,
	model_unavailable: true,
	context_overflow: false,
	request_terminal: false,
	policy_terminal: false,
	gateway_terminal: false,
	cancelled: false,
};

export const RETRYABLE_GATEWAY_DISPOSITIONS: readonly GatewayErrorDisposition[] = Object.freeze(
	(Object.keys(RETRYABLE_DISPOSITION) as GatewayErrorDisposition[]).filter(
		disposition => RETRYABLE_DISPOSITION[disposition],
	),
);

/** True when a disposition may be retried against another credential or provider. */
export function isRetryableGatewayDisposition(disposition: GatewayErrorDisposition): boolean {
	return RETRYABLE_DISPOSITION[disposition];
}

const PROVIDER_WIDE_PATTERN =
	/\b(?:overloaded|service unavailable|provider.?returned.?error|(?:at|over|insufficient)[ _-]?capacity|capacity[ _-]?(?:exceeded|exhausted)|peak[ _-]?(?:load|demand)|high[ _-]?demand)\b/i;
const TIMEOUT_OR_CONNECTION_PATTERN =
	/\b(?:operation\s+)?timed?\s*out\b|\btimeout\b|\bconnection(?:\s+error|\s+refused)?\b|\bsocket hang up\b|\bfetch failed\b/i;
const POLICY_PATTERN = /\bcyber_policy\b|trusted access for cyber/i;
const MODEL_UNAVAILABLE_PATTERN =
	/\bmodel(?:[-_ ]is)?[-_ ]?(?:not[-_ ]found|not[-_ ]available|unavailable|not[-_ ]supported)(?:[-_ ]\w+)*\b|\b(?:the\s+)?(?:requested\s+)?model(?:\s+[`"'][^`"']+[`"'])?\s+does\s+not\s+exist\b/i;
const INVALID_REQUEST_PATTERN =
	/\b(?:unsupported|invalid_request|invalid request|bad request|malformed|GenerateContentRequest)\b/i;
const GATEWAY_INVARIANT_PATTERN = /\bgateway_terminal\b|\binternal invariant\b/i;

/**
 * Classify an upstream / gateway-internal error into a status code and a
 * format-neutral type. The order is intentional:
 *
 *  1. Honour an explicit numeric `status` property on the thrown error.
 *  2. Parse a status code embedded in the message string. Provider errors
 *     virtually always carry one (`Google API error (400): …`, `HTTP 429`,
 *     `status=503`) and the embedded value is authoritative.
 *  3. Fall through to **word-boundaried** substring heuristics. The old
 *     `lower.includes("rate")` test famously matched `GenerateContentRequest`,
 *     surfacing every Google 400 as a 429 `rate_limit_error`. The patterns here
 *     all require boundaries so they don't collide with provider field names.
 */
export function classifyGatewayError(err: unknown): GatewayErrorClassification {
	const message =
		typeof err === "object" && err !== null
			? (stringProperty(err, "errorClassificationMessage") ??
				stringProperty(err, "errorMessage") ??
				stringProperty(err, "message") ??
				String(err))
			: String(err);

	const errorId =
		typeof err === "object" && err !== null && "errorId" in err && typeof err.errorId === "number"
			? err.errorId
			: undefined;
	if ((err instanceof Error && err.name === "AbortError") || is(errorId, Flag.Abort)) {
		return withOwnerDisposition(err, { status: 499, type: "request_aborted", message });
	}
	if (typeof err === "object" && err !== null && "owner" in err && err.owner === "gateway") {
		return withOwnerDisposition(err, { status: 500, type: "gateway_error", message });
	}
	// Reuse the central extractor for statusCode, response.status and causes.
	// Provider status evidence must outrank incidental wording in its body.
	const httpStatus = status(err) ?? status({ message });
	if (httpStatus !== undefined) return withOwnerDisposition(err, bucketStatus(httpStatus, message));
	if (is(errorId, Flag.ContextOverflow))
		return withOwnerDisposition(err, { status: 400, type: "invalid_request_error", message });
	if (
		!is(errorId, Flag.AccountPolicy) &&
		(is(errorId, Flag.ContentBlocked) ||
			(typeof err === "object" && err !== null && "kind" in err && err.kind === "content-blocked"))
	) {
		return withOwnerDisposition(err, { status: 403, type: "policy_denied", message });
	}

	if (err instanceof Error && err.name === "ValidationError") {
		return withOwnerDisposition(err, { status: 400, type: "invalid_request_error", message });
	}
	if (modelUnavailableCode(err) || MODEL_UNAVAILABLE_PATTERN.test(message)) {
		return withOwnerDisposition(err, { status: 404, type: "invalid_request_error", message });
	}
	if (is(errorId, Flag.AuthFailed) || isOAuthExpiry(message)) {
		return withOwnerDisposition(err, { status: 401, type: "authentication_error", message });
	}
	if (POLICY_PATTERN.test(message) || isAccountPolicyError(err)) {
		return withOwnerDisposition(err, { status: 403, type: "authentication_error", message });
	}

	// This is statusless wording only; authoritative provider 5xx stays retryable.
	if (/\baborted\b|\babort signal\b/i.test(message)) {
		return withOwnerDisposition(err, { status: 499, type: "request_aborted", message });
	}
	if (
		/\brate[- _]?limit(?:s|ed|ing)?\b|\bquota(?:_exceeded| exceeded)?\b|\btoo[- _]many[- _]requests\b/i.test(
			message,
		) ||
		isUsageLimit(message)
	) {
		return withOwnerDisposition(err, { status: 429, type: "rate_limit_error", message });
	}
	if (/\b(?:unauthorized|forbidden)\b/i.test(message)) {
		return withOwnerDisposition(err, { status: 401, type: "authentication_error", message });
	}
	if (
		/\b(?:unsupported|invalid_request|invalid request|bad request|malformed)\b/i.test(message) ||
		matchesOverflowText(message)
	) {
		return withOwnerDisposition(err, { status: 400, type: "invalid_request_error", message });
	}
	return withOwnerDisposition(err, { status: 502, type: "upstream_error", message });
}

function bucketStatus(status: number, message: string): { status: number; type: string; message: string } {
	if (status === 401 || status === 403) return { status, type: "authentication_error", message };
	if (status === 429) return { status, type: "rate_limit_error", message };
	// Request timeout is provider-transient, not a client invalid_request.
	if (status === 408) return { status, type: "upstream_error", message };
	if (status >= 400 && status < 500) return { status, type: "invalid_request_error", message };
	if (status >= 500) return { status, type: "upstream_error", message };
	return { status: 502, type: "upstream_error", message };
}

function withOwnerDisposition(
	err: unknown,
	http: { status: number; type: string; message: string },
): GatewayErrorClassification {
	const { owner, disposition } = classifyOwnerDisposition(err, http);
	const errorRetryable = providerRetryDirective(err);
	return { ...http, owner, disposition, ...(errorRetryable === undefined ? {} : { errorRetryable }) };
}

function classifyOwnerDisposition(
	err: unknown,
	http: { status: number; type: string; message: string },
): { owner: GatewayErrorOwner; disposition: GatewayErrorDisposition } {
	const { status, type, message } = http;

	// Structural cancel evidence only — free-text "aborted" must not beat an
	// authoritative provider status (e.g. "HTTP 503: upstream request aborted"
	// stays retryable). Bare abort wording is handled in the fall-through below
	// once every status-backed branch has declined.
	if (status === 499 || (err instanceof Error && err.name === "AbortError")) {
		return { owner: "cancelled", disposition: "cancelled" };
	}

	// Internal invariant — never a retryable provider failure. Require structural
	// evidence (`owner` / error name): provider 5xx bodies that happen to contain
	// "internal invariant" must not suppress failover.
	let ownerProp: string | undefined;
	if (typeof err === "object" && err !== null && "owner" in err && typeof err.owner === "string") {
		ownerProp = err.owner;
	}
	const errName = err instanceof Error ? err.name : "";
	if (ownerProp === "gateway" || errName === "gateway_terminal" || GATEWAY_INVARIANT_PATTERN.test(errName)) {
		return { owner: "gateway", disposition: "gateway_terminal" };
	}
	// Local configuration failures are deterministic: retrying or failing over
	// a missing base URL / unhandled API cannot succeed.
	if (errName === "ConfigurationError") {
		return { owner: "request", disposition: "request_terminal" };
	}

	// Structural content/policy flags are terminal even when the HTTP mapping
	// is a synthetic 502 (message lacked POLICY_PATTERN). Retrying against a
	// sibling provider would replay a safety rejection.
	let errorId: number | undefined;
	if (typeof err === "object" && err !== null && "errorId" in err && typeof err.errorId === "number") {
		errorId = err.errorId;
	}
	let kind: string | undefined;
	if (typeof err === "object" && err !== null && "kind" in err && typeof err.kind === "string") {
		kind = err.kind;
	}
	if (is(errorId, Flag.Abort)) {
		return { owner: "cancelled", disposition: "cancelled" };
	}
	if (is(errorId, Flag.ContextOverflow)) {
		return { owner: "request", disposition: "context_overflow" };
	}
	// AccountPolicy first: the central classifier attaches ContentBlocked
	// alongside AccountPolicy for account-scoped denials, so testing the
	// generic block first would make rotation unreachable. Explicit
	// `kind === "content-blocked"` keeps its terminal behavior below.
	if (is(errorId, Flag.AccountPolicy)) {
		// Account-scoped policy denial: a sibling credential may hold the
		// entitlement, so rotate instead of terminating the request.
		return { owner: "credential", disposition: "credential_transient" };
	}
	if (is(errorId, Flag.ContentBlocked) || kind === "content-blocked") {
		return { owner: "policy", disposition: "policy_terminal" };
	}
	if (status === 403 && isClinePassSurfaceGateMessage(message)) {
		return { owner: "model", disposition: "model_unavailable" };
	}
	const directive = providerRetryDirective(err);
	if (directive !== undefined)
		return { owner: "provider", disposition: directive ? "provider_transient" : "request_terminal" };

	// Authoritative HTTP buckets first: message heuristics never rebrand a
	// status the provider already chose. A 5xx means what the provider said —
	// wording like "context length" or "revoked" inside an upstream error's
	// echoed detail must not turn it into a non-retryable request/policy
	// disposition. Heuristics apply only within their status range, or as a
	// last-resort fall-through when no status signal exists.
	if (status === 429 || type === "rate_limit_error") {
		// Structured usage-limit evidence beats generic 429 wording: the
		// pre-chain maps "hit your usage limit" phrasing to 429/rate_limit_error.
		if (isUsageLimit(err) || isUsageLimit(message)) {
			return { owner: "quota", disposition: "credential_quota" };
		}
		// Ordinary RPM / "Too many requests" throttles are provider-wide, not
		// credential-scoped — including concurrency caps, which the central
		// contract sheds with backoff instead of burning sibling credentials.
		if (isConcurrencyCapExclusion(status, message)) {
			return { owner: "provider", disposition: "provider_transient" };
		}
		const reason = parseRateLimitReason(message);
		if (
			PROVIDER_WIDE_PATTERN.test(message) ||
			reason === "RATE_LIMIT_EXCEEDED" ||
			reason === "MODEL_CAPACITY_EXHAUSTED" ||
			reason === "SERVER_ERROR"
		) {
			return { owner: "provider", disposition: "provider_transient" };
		}
		return { owner: "credential", disposition: "credential_transient" };
	}

	if (status === 402) {
		// Only opaque / billing-worded 402s are rotatable quota; informative
		// bodies like "A subscription is required for this endpoint" stay out
		// of the credential-quota lane (mirrors isUsageLimitOutcome).
		if (isUsageLimit(err) || is402BillingCapBody(message)) {
			return { owner: "quota", disposition: "credential_quota" };
		}
		return { owner: "provider", disposition: "provider_transient" };
	}

	if (type === "policy_denied") {
		// Synthesized status-less policy denial — stays terminal; real 4xx
		// account-policy rejections rotate via the credential arm below.
		return { owner: "policy", disposition: "policy_terminal" };
	}

	if (status === 401 || status === 403 || type === "authentication_error") {
		// Account-scoped usage caps arrive as 403s on several providers
		// (Devin/Codeium permission_denied, Copilot) — rotate with quota
		// handling instead of burning the credential as transient.
		if (isUsageLimitOutcome(status, message)) {
			return { owner: "quota", disposition: "credential_quota" };
		}
		if (isOAuthExpiry(message)) {
			return { owner: "credential", disposition: "credential_permanent" };
		}
		return { owner: "credential", disposition: "credential_transient" };
	}

	if ((status === 404 || status === 400) && (MODEL_UNAVAILABLE_PATTERN.test(message) || modelUnavailableCode(err))) {
		return { owner: "model", disposition: "model_unavailable" };
	}

	// Policy denials and context overflows are provider decisions delivered on
	// 4xx statuses; on 5xx they are usually quoted upstream detail, not the
	// provider's own verdict. Definitive OAuth failures also surface as
	// 400 `invalid_grant`.
	if (status > 0 && status < 500) {
		if (POLICY_PATTERN.test(message) || isAccountPolicyError(err)) {
			// Account-capability denials (Trusted Access / cyber_policy) are
			// worth retrying with a sibling credential. Content-safety blocks
			// stay terminal via the structural path above.
			return { owner: "credential", disposition: "credential_transient" };
		}
		if (matchesOverflowText(message)) {
			return { owner: "request", disposition: "context_overflow" };
		}
		if (isOAuthExpiry(message)) {
			return { owner: "credential", disposition: "credential_permanent" };
		}
	}

	if (status === 408) {
		return { owner: "provider", disposition: "provider_transient" };
	}

	if ((status === 400 || type === "invalid_request_error") && MODEL_UNAVAILABLE_PATTERN.test(message)) {
		return { owner: "model", disposition: "model_unavailable" };
	}

	if (status === 400 || type === "invalid_request_error") {
		return { owner: "request", disposition: "request_terminal" };
	}

	if (status >= 500) {
		if (TIMEOUT_OR_CONNECTION_PATTERN.test(message)) {
			return { owner: "provider", disposition: "provider_transient" };
		}
		return { owner: "provider", disposition: "provider_unavailable" };
	}

	// No authoritative status signal (fall-through): message heuristics only.
	if (/\baborted\b|\babort signal\b/i.test(message)) {
		return { owner: "cancelled", disposition: "cancelled" };
	}
	if (isUsageLimit(err) || isUsageLimit(message)) {
		return { owner: "quota", disposition: "credential_quota" };
	}
	if (POLICY_PATTERN.test(message)) {
		return { owner: "policy", disposition: "policy_terminal" };
	}
	if (matchesOverflowText(message)) {
		return { owner: "request", disposition: "context_overflow" };
	}
	if (TIMEOUT_OR_CONNECTION_PATTERN.test(message)) {
		return { owner: "transport", disposition: "provider_transient" };
	}
	if (INVALID_REQUEST_PATTERN.test(message)) {
		return { owner: "request", disposition: "request_terminal" };
	}

	return { owner: "provider", disposition: "provider_unavailable" };
}
