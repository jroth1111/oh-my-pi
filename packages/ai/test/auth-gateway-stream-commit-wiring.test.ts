import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { Usage } from "@oh-my-pi/pi-ai";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

async function boot(mock: MockModel) {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-commit-wire-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("openrouter", "test-key");
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gateway-commit-fixture-token"],
		storage,
		resolveModel: () => mock.model,
		version: "test",
	});
	return {
		url: handle.url,
		close: async () => {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

async function postResponses(url: string, model: string): Promise<Response> {
	return fetch(`${url}/v1/responses`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: "Bearer gateway-commit-fixture-token" },
		body: JSON.stringify({ model, input: "hi", stream: true }),
	});
}

describe("auth-gateway StreamCommitGate wiring", () => {
	it("does not replay a canonical aborted turn before output", async () => {
		const mock = createMockModel({ provider: "openrouter", id: "mock/canonical-abort" });
		mock.push({ content: [], stopReason: "aborted", errorMessage: "fixture canonical cancellation" });
		mock.push({ content: ["must not replay cancelled work"] });
		const gateway = await boot(mock);
		try {
			const response = await postResponses(gateway.url, mock.id);
			const body = await response.text();
			expect(mock.calls).toHaveLength(1);
			expect(body).toContain("response.failed");
			expect(body).not.toContain("must not replay cancelled work");
		} finally {
			await gateway.close();
		}
	});

	it("holds the Responses prelude and fails over without exposing the dead attempt", async () => {
		const mock = createMockModel({ provider: "openrouter", id: "mock/commit-failover" });
		// Attempt 1 dies pre-commit with a retryable terminal; attempt 2 succeeds.
		mock.push({ throw: new Error("upstream exploded") });
		mock.push({ content: ["recovered"] });
		const gw = await boot(mock);
		try {
			const res = await postResponses(gw.url, "mock/commit-failover");
			expect(res.status).toBe(200);
			const body = await res.text();
			// The failover is transparent: the client sees only the surviving
			// attempt — one prelude, the recovery content, and no failed frame
			// or error text from the discarded first attempt.
			expect(mock.calls.length).toBe(2);
			expect(body).toContain("recovered");
			expect(body).not.toContain("upstream exploded");
			expect(body.match(/event: response\.created/g)?.length).toBe(1);
			expect(body).not.toContain("event: response.failed");
			expect(body).toContain("event: response.completed");
		} finally {
			await gw.close();
		}
	});

	it("forwards the surviving attempt unchanged once output commits", async () => {
		const mock = createMockModel({ provider: "openrouter", id: "mock/commit-responses" });
		mock.push({ content: ["hello"] });
		const gw = await boot(mock);
		try {
			const res = await postResponses(gw.url, "mock/commit-responses");
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("hello");
			expect(mock.calls.length).toBe(1);
		} finally {
			await gw.close();
		}
	});

	const billingCases: Array<{
		name: string;
		usage: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> };
	}> = [
		{ name: "token", usage: { input: 1 } },
		{ name: "total-token", usage: { totalTokens: 1 } },
		{ name: "premium-request", usage: { premiumRequests: 1 } },
		{ name: "cost", usage: { cost: { total: 0.01 } } },
		{ name: "orchestration", usage: { orchestration: { input: 1, output: 0, cacheRead: 0 } } },
		{ name: "committed-credit", usage: { credits: { cost: 0, committedCost: 1, acuCost: 0 } } },
	];
	for (const { name, usage } of billingCases) {
		it(`does not replay a pre-output failure with ${name} billing`, async () => {
			const mock = createMockModel({ provider: "openrouter", id: `mock/billed-${name}` });
			mock.push({ content: [], stopReason: "error", errorMessage: "503 upstream overloaded", usage });
			mock.push({ content: ["must not replay"] });
			const gateway = await boot(mock);
			try {
				const response = await postResponses(gateway.url, mock.id);
				const body = await response.text();
				expect(mock.calls).toHaveLength(1);
				expect(body).toContain("response.failed");
				expect(body).not.toContain("must not replay");
			} finally {
				await gateway.close();
			}
		});
	}

	it("echoes the upstream response id so previous_response_id can resolve", async () => {
		const mock = createMockModel({ provider: "openrouter", id: "mock/commit-respid" });
		mock.push({ content: ["ok"], responseId: "resp_upstream_123" });
		const gw = await boot(mock);
		try {
			const res = await postResponses(gw.url, "mock/commit-respid");
			expect(res.status).toBe(200);
			const body = await res.text();
			// The emitted envelope must name the provider-stored id, not a
			// locally minted one — a client's next `previous_response_id` can
			// only resolve against what upstream actually persisted.
			const created = body.match(/event: response\.created\ndata: ([^\n]+)/);
			expect(created).not.toBeNull();
			const parsed = JSON.parse(created![1]!) as { response: { id: string } };
			expect(parsed.response.id).toBe("resp_upstream_123");
			const completed = body.match(/event: response\.completed\ndata: ([^\n]+)/);
			expect(JSON.parse(completed![1]!).response.id).toBe("resp_upstream_123");
		} finally {
			await gw.close();
		}
	});
});
