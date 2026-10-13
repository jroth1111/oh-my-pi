/** Translate JSON-schema envelopes between the two OpenAI wire dialects without losing explicit false. */
export function normalizeOpenAIResponseFormat(format: unknown, dialect: "chat" | "responses"): unknown {
	if (typeof format !== "object" || format === null || Array.isArray(format)) return format;
	const record = format as Record<string, unknown>;
	if (record.type !== "json_schema") return format;
	const nested = record.json_schema;
	const schema =
		dialect === "chat" && nested === undefined && record.schema !== undefined
			? record
			: dialect === "responses" && typeof nested === "object" && nested !== null && !Array.isArray(nested)
				? (nested as Record<string, unknown>)
				: undefined;
	if (!schema) return format;
	const fields = {
		name: schema.name ?? "response",
		...(schema.description !== undefined ? { description: schema.description } : {}),
		schema: schema.schema,
		...(schema.strict !== undefined ? { strict: schema.strict } : {}),
	};
	return dialect === "chat" ? { type: "json_schema", json_schema: fields } : { type: "json_schema", ...fields };
}
