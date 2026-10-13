import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { startAuthGateway } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";

function responsesCompletion(id: string): Response {
	const events = [
		{ type: "response.created", response: { id } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${id}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok" }],
			},
		},
		{
			type: "response.completed",
			response: { id, status: "completed", usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

for (const native of [false, true]) {
	it(`honors ${native ? "pi-native" : "Responses"} storage opt-out even after an official-endpoint session has warmed its chain`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-storage-optout-"));
		const storage = await AuthStorage.create(path.join(directory, "auth.db"));
		storage.keys.setRuntime("openai", "fixture-upstream-key");
		const model = buildModel({
			id: "gpt-4o",
			name: "Fixture",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 100,
		});
		const payloads: Array<Record<string, unknown>> = [];
		const gateway = startAuthGateway({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: ["opaque-privacy-client-token"],
			resolveModel: () => model,
			fetch: async (_url, init) => {
				payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return responsesCompletion(`response_${payloads.length}`);
			},
		});
		const post = (store: boolean, followup: boolean) => {
			const messages = followup
				? [
						{ role: "user", content: "seed", timestamp: 1 },
						{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
						{ role: "user", content: "next", timestamp: 3 },
					]
				: [{ role: "user", content: "seed", timestamp: 1 }];
			const body = native
				? {
						modelId: model.id,
						context: { messages },
						stream: false,
						options: { sessionId: "privacy-session", store, seed: 7, logitBias: { "42": -1 } },
					}
				: { model: model.id, input: messages, stream: false, prompt_cache_key: "privacy-session", store };
			return fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/responses"}`, {
				method: "POST",
				headers: { Authorization: "Bearer opaque-privacy-client-token", "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		};
		try {
			const first = await post(true, false);
			expect(first.status).toBe(200);
			await first.text();
			const second = await post(false, true);
			expect(second.status).toBe(200);
			await second.text();
			expect(payloads).toHaveLength(2);
			expect(payloads[1]?.store).toBe(false);
			expect(payloads[1]).not.toHaveProperty("previous_response_id");
			expect(payloads[1]).not.toHaveProperty("seed");
			expect(payloads[1]).not.toHaveProperty("logit_bias");
			expect(JSON.stringify(payloads[1]?.input)).toContain("seed");
			expect(JSON.stringify(payloads[1]?.input)).toContain("next");
		} finally {
			await gateway.close();
			storage.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
}

it("routes Responses text.format to the nested JSON-schema contract required by Chat Completions", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-cross-schema-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"));
	storage.keys.setRuntime("openai", "fixture-upstream-key");
	const model = buildModel({
		id: "gpt-4o",
		name: "Fixture",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 100,
	});
	let payload: Record<string, unknown> | undefined;
	const gateway = startAuthGateway({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens: ["opaque-schema-client-token"],
		resolveModel: () => model,
		fetch: async (_url, init) => {
			payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const format = payload.response_format as Record<string, unknown> | undefined;
			if (!format?.json_schema)
				return Response.json({ error: { message: "Chat requires nested json_schema" } }, { status: 400 });
			return new Response(
				`data: ${JSON.stringify({ id: "chat_schema", choices: [{ index: 0, delta: { role: "assistant", content: '{"answer":true}' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "chat_schema", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	try {
		const response = await fetch(`${gateway.url}/v1/responses`, {
			method: "POST",
			headers: { Authorization: "Bearer opaque-schema-client-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				model: model.id,
				input: "schema fixture",
				stream: false,
				text: {
					format: {
						type: "json_schema",
						name: "answer",
						description: "fixture shape",
						schema: { type: "object", properties: { answer: { type: "boolean" } } },
						strict: false,
					},
				},
			}),
		});
		expect(response.status).toBe(200);
		await response.text();
		expect(payload?.response_format).toEqual({
			type: "json_schema",
			json_schema: {
				name: "answer",
				description: "fixture shape",
				schema: { type: "object", properties: { answer: { type: "boolean" } } },
				strict: false,
			},
		});
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
