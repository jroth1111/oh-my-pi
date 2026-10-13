import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { startAuthGateway } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";

it("does not replay a held failure when the upstream explicitly forbids retry", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-held-no-retry-"));
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
		bearerTokens: ["held-no-retry-client"],
		resolveModel: () => model,
		fetch: async () => {
			requests++;
			return Response.json(
				{ type: "error", error: { type: "api_error", message: "fixture failure" } },
				{ status: 503, headers: { "x-should-retry": "false" } },
			);
		},
	});
	try {
		const response = await fetch(`${gateway.url}/v1/responses`, {
			method: "POST",
			headers: { Authorization: "Bearer held-no-retry-client", "Content-Type": "application/json" },
			body: JSON.stringify({ model: model.id, input: "fixture", stream: true }),
		});
		expect(await response.text()).toContain("response.failed");
		expect(requests).toBe(1);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
});
