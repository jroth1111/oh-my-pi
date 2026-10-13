import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "../src/api-registry";
import { startAuthGateway } from "../src/auth-gateway";
import type { AuthGatewayBootOptions } from "../src/auth-gateway/dispatch";
import type { AuthGatewayServerHandle } from "../src/auth-gateway/types";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel, type MockModel, registerMockApi } from "../src/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

afterEach(clearCustomApis);
const id = "fixture/model % 雪";
const headers = { Authorization: "Bearer protocol-fixture-client", "Content-Type": "application/json" };
const tool = { name: "lookup", parameters: { type: "object", properties: { value: { type: "string" } } } };

interface GeminiEnvelope {
	candidates?: {
		content?: {
			parts?: { functionCall?: { name: string; args: Record<string, unknown>; id?: string }; text?: string }[];
		};
	}[];
}

async function withProtocol(
	run: (gateway: AuthGatewayServerHandle, mock: MockModel) => Promise<void>,
	options: Partial<AuthGatewayBootOptions> = {},
): Promise<void> {
	registerMockApi();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-native-protocol-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
		usageProviderResolver: () => undefined,
	});
	storage.keys.setRuntime("protocol-fixture", "fixture-key");
	storage.keys.setRuntime("google", "fixture-google-key");
	const mock = createMockModel({
		provider: "protocol-fixture",
		id: "served",
		handler: {
			content: [{ type: "toolCall", id: "fixture-call", name: "lookup", arguments: { value: "computed" } }],
		},
	});
	mock.input.push("image");
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		storage,
		bearerTokens: ["protocol-fixture-client"],
		resolveModel: candidate => (candidate === id ? mock : undefined),
		...options,
	});
	try {
		await run(gateway, mock);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
}

for (const streaming of [false, true])
	it(`standard Gemini ${streaming ? "streamGenerateContent" : "generateContent"} uses the action and emits complete tool calls`, async () => {
		await withProtocol(async (gateway, mock) => {
			const response = await fetch(
				`${gateway.url}/v1beta/models/${encodeURIComponent(id)}:${streaming ? "streamGenerateContent" : "generateContent"}?alt=sse`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						stream: !streaming,
						contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AA==" } }] }],
						tools: [{ functionDeclarations: [tool] }],
						toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] } },
					}),
				},
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain(streaming ? "text/event-stream" : "application/json");
			const text = await response.text();
			const envelopes: GeminiEnvelope[] = streaming
				? text
						.split("\n\n")
						.filter(Boolean)
						.map(line => JSON.parse(line.slice("data: ".length)))
				: [JSON.parse(text)];
			const calls = envelopes
				.flatMap(envelope => envelope.candidates?.[0]?.content?.parts ?? [])
				.filter(part => part.functionCall);
			expect(calls).toEqual([{ functionCall: { name: "lookup", args: { value: "computed" }, id: "fixture-call" } }]);
			expect(mock.calls).toHaveLength(1);
			expect(mock.calls[0]?.context.messages[0]).toMatchObject({
				role: "user",
				content: [{ type: "image", mimeType: "image/png", data: "AA==" }],
			});
			expect(mock.calls[0]?.context.tools?.[0]).toMatchObject({ name: "lookup", parameters: tool.parameters });
			expect(mock.calls[0]?.options?.toolChoice).toEqual({ type: "tool", name: "lookup" });
		});
	});

it("Gemini path/model mismatches, malformed escapes and unsupported file parts never reach inference", async () => {
	await withProtocol(async (gateway, mock) => {
		for (const [suffix, body] of [
			[
				`${encodeURIComponent(id)}:generateContent`,
				{ model: "different", contents: [{ role: "user", parts: [{ text: "fixture" }] }] },
			],
			["%GG:generateContent", { contents: [] }],
			[
				`${encodeURIComponent(id)}:generateContent`,
				{
					contents: [
						{
							role: "user",
							parts: [{ fileData: { mimeType: "image/png", fileUri: "gs://fixture/unsupported" } }],
						},
					],
				},
			],
		] as const) {
			const response = await fetch(`${gateway.url}/v1beta/models/${suffix}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
			expect(((await response.json()) as { error: { code: number; status: string } }).error).toMatchObject({
				code: 400,
				status: "INVALID_ARGUMENT",
			});
		}
		expect(mock.calls).toHaveLength(0);
	});
});

it("native Gemini tool history correlates parallel id-less results instead of dropping calls or responses", async () => {
	await withProtocol(async (gateway, mock) => {
		const response = await fetch(`${gateway.url}/v1beta/models/${encodeURIComponent(id)}:generateContent`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				contents: [
					{
						role: "model",
						parts: [
							{ functionCall: { name: "lookup", args: { value: "a" } } },
							{ functionCall: { name: "lookup", args: { value: "b" } } },
						],
					},
					{
						role: "user",
						parts: [
							{ functionResponse: { name: "lookup", response: { output: "a-result" } } },
							{ functionResponse: { name: "lookup", response: { output: "b-result" } } },
						],
					},
				],
			}),
		});
		expect(response.status).toBe(200);
		await response.text();
		const messages = mock.calls[0]!.context.messages;
		const assistant = messages[0];
		if (assistant?.role !== "assistant") throw new Error("Missing tool-call history");
		const calls = assistant.content.filter(part => part.type === "toolCall");
		expect(calls).toHaveLength(2);
		expect(messages.slice(1)).toMatchObject([
			{ role: "toolResult", toolCallId: calls[0]!.id, content: [{ type: "text", text: "a-result" }] },
			{ role: "toolResult", toolCallId: calls[1]!.id, content: [{ type: "text", text: "b-result" }] },
		]);
	});
});

it("Gemini tool disable wins over a named allow-list and multi-name lists do not expose undeclared alternatives", async () => {
	await withProtocol(async (gateway, mock) => {
		const declarations = [tool, { name: "allowed", parameters: {} }, { name: "forbidden", parameters: {} }];
		for (const mode of ["NONE", "ANY"]) {
			const response = await fetch(`${gateway.url}/v1beta/models/${encodeURIComponent(id)}:generateContent`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					contents: [{ role: "user", parts: [{ text: "fixture" }] }],
					tools: [{ functionDeclarations: declarations }],
					toolConfig: { functionCallingConfig: { mode, allowedFunctionNames: ["lookup", "allowed"] } },
				}),
			});
			expect(response.status).toBe(200);
			await response.text();
		}
		expect(mock.calls[0]?.options?.toolChoice).toBe("none");
		expect(mock.calls[1]?.options?.toolChoice).toBe("required");
		expect(mock.calls[1]?.context.tools?.map(tool => tool.name)).toEqual(["lookup", "allowed"]);
	});
});

it("malformed Gemini parts fail before provider lookup instead of disappearing from the turn", async () => {
	await withProtocol(async (gateway, mock) => {
		for (const part of [
			{ inlineData: { mimeType: "image/png" } },
			{ inlineData: { mimeType: "audio/wav", data: "AA==" } },
			{ functionCall: { name: "lookup", args: "not an object" } },
			{ functionCall: { name: "lookup", args: {} } },
			{ functionResponse: { response: { output: "missing name" } } },
			{ executableCode: { language: "PYTHON", code: "fixture" } },
			{ thought: true, text: "unsupported thinking history" },
			{ text: "signed text", thoughtSignature: Buffer.from("fixture signature").toString("base64") },
		]) {
			const response = await fetch(`${gateway.url}/v1beta/models/${encodeURIComponent(id)}:generateContent`, {
				method: "POST",
				headers,
				body: JSON.stringify({ contents: [{ role: "user", parts: [part] }] }),
			});
			expect(response.status).toBe(400);
			await response.text();
		}
		expect(mock.calls).toHaveLength(0);
	});
});

for (const path of ["/backend-api/codex/responses", "/backend-api/responses", "/v1/grok/chat/completions"])
	it(`${path} executes through the normal translated provider pipeline`, async () => {
		await withProtocol(async (gateway, mock) => {
			const responses = path.includes("responses");
			const response = await fetch(`${gateway.url}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(
					responses
						? { model: id, input: "fixture", stream: false, parallel_tool_calls: false }
						: { model: id, messages: [{ role: "user", content: "fixture" }], stream: false },
				),
			});
			expect(response.status).toBe(200);
			const text = await response.text();
			expect(text).toContain("lookup");
			expect(text).toContain("computed");
			expect(mock.calls).toHaveLength(1);
			if (responses) expect(mock.calls[0]?.options?.parallelToolCalls).toBe(false);
		});
	});

it("the count-tokens character estimate includes system, tools and tool choice without dispatch", async () => {
	await withProtocol(async (gateway, mock) => {
		const input = {
			messages: [{ role: "user", content: "fixture" }],
			system: "long-system".repeat(100),
			tools: [tool],
			tool_choice: { type: "tool", name: "lookup" },
		};
		const response = await fetch(`${gateway.url}/v1/messages/count_tokens`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: id, ...input }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ input_tokens: Math.ceil(JSON.stringify(input).length / 4) });
		expect(mock.calls).toHaveLength(0);
		const unauthorized = await fetch(`${gateway.url}/v1/messages/count_tokens`, { method: "POST", body: "{}" });
		expect(unauthorized.status).toBe(401);
		await unauthorized.text();
	});
});

for (const streaming of [false, true])
	for (const option of ["responseSchema", "responseJsonSchema"] as const)
		it(`pi-native ${streaming ? "SSE" : "JSON"} forwards Google ${option} and response MIME type to the real client wire`, async () => {
			const model = buildModel({
				id: "gemini-2.5-flash",
				name: "Google native schema fixture",
				api: "google-generative-ai",
				provider: "google",
				baseUrl: "http://fixture.invalid/v1beta",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 100,
			});
			const schema = {
				type: option === "responseSchema" ? "OBJECT" : "object",
				properties: { value: { type: option === "responseSchema" ? "STRING" : "string" } },
				required: ["value"],
			};
			let captured: Record<string, unknown> | undefined;
			await withProtocol(
				async gateway => {
					const response = await fetch(`${gateway.url}/v1/pi/stream`, {
						method: "POST",
						headers,
						body: JSON.stringify({
							modelId: model.id,
							context: { messages: [{ role: "user", content: "return structured fixture", timestamp: 0 }] },
							options: { responseMimeType: "application/json", [option]: schema },
							stream: streaming,
						}),
					});
					expect(response.status).toBe(200);
					expect(await response.text()).toContain("schema-fixture");
					expect(captured?.generationConfig).toMatchObject({
						responseMimeType: "application/json",
						[option]: schema,
					});
				},
				{
					resolveModel: candidate => (candidate === model.id ? model : undefined),
					fetch: async (_request, init) => {
						captured = JSON.parse(String(init?.body));
						expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("fixture-google-key");
						return new Response(
							`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "schema-fixture" }] }, finishReason: "STOP" }] })}\n\n`,
							{ headers: { "Content-Type": "text/event-stream" } },
						);
					},
				},
			);
		});

for (const streaming of [false, true])
	it(`Google wire ${streaming ? "SSE" : "JSON"} requests retain native schemas and signed tool history, and replies return the tool signature`, async () => {
		const priorSignature = Buffer.from("fixture prior signature").toString("base64");
		const returnedSignature = Buffer.from("fixture returned signature").toString("base64");
		const model = buildModel({
			id: "gemini-2.5-flash",
			name: "Google protocol fixture",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "http://fixture.invalid/v1beta",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 100,
		});
		let captured: Record<string, unknown> | undefined;
		const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
		await withProtocol(
			async gateway => {
				const response = await fetch(
					`${gateway.url}/v1beta/models/${model.id}:${streaming ? "streamGenerateContent" : "generateContent"}`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							contents: [
								{
									role: "model",
									parts: [
										{
											functionCall: { id: "prior-call", name: "lookup", args: { value: "prior" } },
											thoughtSignature: priorSignature,
										},
									],
								},
								{
									role: "user",
									parts: [
										{
											functionResponse: { id: "prior-call", name: "lookup", response: { output: "result" } },
										},
									],
								},
							],
							tools: [{ functionDeclarations: [tool] }],
							generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema },
						}),
					},
				);
				expect(response.status).toBe(200);
				const text = await response.text();
				const replies = (
					streaming
						? text
								.split("\n\n")
								.filter(Boolean)
								.map(frame => JSON.parse(frame.slice("data: ".length)))
						: [JSON.parse(text)]
				) as {
					candidates: { content: { parts: { thoughtSignature?: string }[] } }[];
				}[];
				expect(captured?.generationConfig).toMatchObject({
					responseMimeType: "application/json",
					responseJsonSchema: schema,
				});
				const contents = captured?.contents as {
					parts: { functionCall?: { name: string }; thoughtSignature?: string }[];
				}[];
				expect(contents[0]?.parts.find(part => part.functionCall)?.thoughtSignature).toBe(priorSignature);
				expect(replies[0]?.candidates[0]?.content.parts[0]?.thoughtSignature).toBe(returnedSignature);
			},
			{
				resolveModel: candidate => (candidate === model.id ? model : undefined),
				fetch: async (_request, init) => {
					captured = JSON.parse(String(init?.body));
					expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("fixture-google-key");
					return new Response(
						`data: ${JSON.stringify({
							candidates: [
								{
									content: {
										role: "model",
										parts: [
											{
												functionCall: { id: "new-call", name: "lookup", args: { value: "computed" } },
												thoughtSignature: returnedSignature,
											},
										],
									},
									finishReason: "STOP",
								},
							],
							usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
						})}\n\n`,
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				},
			},
		);
	});
