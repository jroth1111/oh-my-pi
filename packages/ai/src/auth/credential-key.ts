/** The structured OAuth key form preserves the bearer alongside provider metadata. */
export function extractStructuredApiKeyToken(apiKey: string): string | undefined {
	if (!apiKey.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(apiKey);
		return typeof parsed === "object" && parsed !== null && "token" in parsed && typeof parsed.token === "string"
			? parsed.token
			: undefined;
	} catch {
		return undefined;
	}
}
