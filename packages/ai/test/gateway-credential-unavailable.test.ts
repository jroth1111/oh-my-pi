import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { startAuthGateway } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";

it("distinguishes gateway bearer rejection from an unavailable upstream credential", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-no-credential-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"));
	const model = buildModel({
		id: "fixture",
		name: "fixture",
		api: "openai-completions",
		provider: "unit-missing-credential",
		baseUrl: "https://upstream.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	});
	let upstreamRequests = 0;
	const gateway = startAuthGateway({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens: ["client"],
		resolveModel: () => model,
		fetch: async () => {
			upstreamRequests++;
			throw new Error("must not dispatch without credentials");
		},
	});
	try {
		const rejected = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "fixture" }], stream: false }),
		});
		expect(rejected.status).toBe(401);
		for (const [endpoint, body] of [
			["/v1/chat/completions", { model: model.id, messages: [{ role: "user", content: "fixture" }], stream: false }],
			[
				"/v1/pi/stream",
				{
					modelId: model.id,
					context: { messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
					stream: false,
				},
			],
		] as const) {
			const response = await fetch(`${gateway.url}${endpoint}`, {
				method: "POST",
				headers: { Authorization: "Bearer client", "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(503);
			await response.text();
		}
		expect(upstreamRequests).toBe(0);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
