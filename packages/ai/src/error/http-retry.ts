/** Canonical transient HTTP status set shared by provider clients. */
export function isTransientStatus(status: number | undefined): boolean {
	return status !== undefined && (status === 408 || status === 429 || status >= 500);
}

/** Anthropic's server directive takes precedence over its transient status set. */
export function shouldRetryAnthropicResponse(response: Pick<Response, "status" | "headers">): boolean {
	const directive = response.headers.get("x-should-retry");
	if (directive === "true") return true;
	if (directive === "false") return false;
	return isTransientStatus(response.status) || response.status === 409;
}
