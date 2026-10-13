import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { classifyGatewayError } from "../src/error/gateway";
import { streamAnthropic } from "../src/providers/anthropic";
import { streamOpenAICompletions } from "../src/providers/openai-completions";

it("retains an explicit no-retry directive on the gateway's actual HTTP error", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-retry-directive-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"));
	storage.keys.setRuntime("anthropic", "fixture-key");
	const model = buildModel({
		id: "claude-sonnet-4-6",
		name: "Fixture",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	});
	let requests = 0;
	const gateway = startAuthGateway({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens: ["client"],
		resolveModel: () => model,
		fetch: async () => {
			requests++;
			return Response.json(
				{ type: "error", error: { type: "api_error", message: "fixture upstream failure" } },
				{ status: 503, headers: { "x-should-retry": "false" } },
			);
		},
	});
	try {
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: "Bearer client",
				"Content-Type": "application/json",
				Origin: "https://client.example",
			},
			body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "fixture" }], stream: false }),
		});
		expect(response.status).toBe(503);
		expect(response.headers.get("x-should-retry")).toBe("false");
		expect(response.headers.get("access-control-expose-headers")?.split(/,\s*/)).toContain("x-should-retry");
		expect(requests).toBe(1);
		await response.text();
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

it("retains parenthesized provider failure statuses through the gateway classifier", () => {
	expect(classifyGatewayError("Factory Gemini generate failed (400): Unknown error")).toMatchObject({
		status: 400,
		owner: "request",
		disposition: "request_terminal",
	});
	expect(classifyGatewayError("Factory Gemini generate failed (503): Unknown error")).toMatchObject({
		status: 503,
		owner: "provider",
	});
});

it("rotates a structured 402 quota response even when its message is generic", async () => {
	const model = buildModel({
		id: "fixture",
		name: "Fixture",
		api: "openai-completions",
		provider: "unit-quota",
		baseUrl: "https://quota.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	});
	const result = await streamOpenAICompletions(
		model,
		{ messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
		{
			apiKey: "fixture-key",
			fetch: async () =>
				Response.json(
					{ error: { code: "insufficient-account-funds", message: "Upstream request failed", type: "api_error" } },
					{ status: 402 },
				),
		},
	).result();
	expect(classifyGatewayError(JSON.parse(JSON.stringify(result)))).toMatchObject({
		status: 402,
		owner: "quota",
		disposition: "credential_quota",
	});
});

for (const [status, directive, disposition] of [
	[400, "true", "provider_transient"],
	[503, "false", "request_terminal"],
	[409, undefined, "provider_transient"],
	[409, "false", "request_terminal"],
] as const) {
	it(`preserves ${status}/${directive ?? "default"} retry intent after a real provider stream is finalized and serialized`, async () => {
		const model = buildModel({
			id: "claude-sonnet-4-6",
			name: "Fixture",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		});
		const result = await streamAnthropic(
			model,
			{ messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
			{
				apiKey: "fixture-key",
				providerRetryWait: async () => {},
				fetch: async () =>
					Response.json(
						{ type: "error", error: { type: "api_error", message: "fixture upstream failure" } },
						{
							status,
							headers: {
								"retry-after-ms": "0",
								...(directive === undefined ? {} : { "x-should-retry": directive }),
							},
						},
					),
			},
		).result();
		const durable: unknown = JSON.parse(JSON.stringify(result));
		expect(result.stopReason).toBe("error");
		expect(classifyGatewayError(durable)).toMatchObject({ status, disposition });
	});
}

for (const [status, owner, disposition] of [
	[404, "model", "model_unavailable"],
	[503, "provider", "provider_unavailable"],
] as const) {
	it(`preserves structured model rejection without downgrading an authoritative ${status} after provider finalization`, async () => {
		const model = buildModel({
			id: "fixture",
			name: "Fixture",
			api: "openai-completions",
			provider: "unit-model-rejection",
			baseUrl: "https://models.example/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		});
		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
			{
				apiKey: "fixture-key",
				providerRetryWait: async () => {},
				fetch: async () =>
					Response.json(
						{ error: { code: "model_not_found", message: "Resource missing", type: "api_error" } },
						{ status, headers: { "retry-after-ms": "0" } },
					),
			},
		).result();
		expect(classifyGatewayError(JSON.parse(JSON.stringify(result)))).toMatchObject({ status, owner, disposition });
	});
}
