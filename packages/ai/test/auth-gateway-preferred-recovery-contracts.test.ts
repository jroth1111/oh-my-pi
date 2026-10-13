import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "../src/api-registry";
import { RouteRegistry, startAuthGateway } from "../src/auth-gateway";
import type { AuthGatewayServerHandle, RouteNode } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel, registerMockApi } from "../src/providers/mock";
import type { MockResponse } from "../src/providers/mock";

afterEach(clearCustomApis);
const unavailable: MockResponse = { content: [], stopReason: "error", errorMessage: "HTTP 503: service unavailable" };
const contextOverflow: MockResponse = {
	content: [],
	stopReason: "error",
	errorMessage: "HTTP 400: maximum context length exceeded",
};
const formats = ["/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/pi/stream"] as const;
const target = (model: string): RouteNode => ({ type: "target", model });

async function withRecovery(
	root: RouteNode,
	run: (gateway: AuthGatewayServerHandle, calls: string[], outcomes: Map<string, MockResponse>) => Promise<void>,
	missing: readonly string[] = [],
): Promise<void> {
	registerMockApi();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-preferred-recovery-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
		usageProviderResolver: () => undefined,
	});
	const calls: string[] = [];
	const outcomes = new Map<string, MockResponse>([["a", unavailable]]);
	const models = ["a", "b", "c", "d"]
		.filter(id => !missing.includes(id))
		.map(id => {
			storage.keys.setRuntime(`recovery-${id}`, `fixture-key-${id}`);
			return createMockModel({
				provider: `recovery-${id}`,
				id,
				handler: () => {
					calls.push(id);
					return outcomes.get(id) ?? { content: [`served-${id}`] };
				},
			});
		});
	const registry = new RouteRegistry(id => models.find(model => model.id === id));
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		storage,
		bearerTokens: ["preferred-recovery-fixture-client"],
		resolveModel: () => undefined,
		routeRegistry: registry,
		routes: [{ id: "recover", root }],
	});
	try {
		await run(gateway, calls, outcomes);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
}

function send(gateway: AuthGatewayServerHandle, format: string, stream: boolean): Promise<Response> {
	return fetch(`${gateway.url}${format}`, {
		method: "POST",
		headers: {
			Authorization: "Bearer preferred-recovery-fixture-client",
			"Content-Type": "application/json",
			"x-prompt-cache-key": "preferred-recovery-fixture-key",
		},
		body: JSON.stringify(
			format === "/v1/pi/stream"
				? {
						modelId: "recover",
						context: { messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
						stream,
					}
				: format === "/v1/responses"
					? { model: "recover", input: "fixture", stream }
					: { model: "recover", messages: [{ role: "user", content: "fixture" }], max_tokens: 100, stream },
		),
	});
}

for (const format of formats)
	for (const stream of [false, true])
		for (const third of [false, true])
			it(`recovers the unused primary before any tertiary after preferred failure: ${format}, ${stream ? "SSE" : "JSON"}, ${third ? 3 : 2} targets`, async () => {
				await withRecovery(
					{
						type: "fallback",
						on: ["provider_unavailable"],
						children: [target("a"), target("b"), ...(third ? [target("c")] : [])],
					},
					async (gateway, calls, outcomes) => {
						const warm = await send(gateway, format, stream);
						expect(await warm.text()).toContain("served-b");
						outcomes.delete("a");
						outcomes.set("b", unavailable);
						const recovered = await send(gateway, format, stream);
						expect(recovered.status).toBe(200);
						expect(await recovered.text()).toContain("served-a");
						expect(calls).toEqual(["a", "b", "b", "a"]);
					},
				);
			});

for (const stream of [false, true]) {
	it(`does not backtrack after a preferred context-overflow failure (${stream ? "SSE" : "JSON"})`, async () => {
		await withRecovery(
			{ type: "fallback", on: ["provider_unavailable", "context_overflow"], children: [target("a"), target("b")] },
			async (gateway, calls, outcomes) => {
				expect(await (await send(gateway, "/v1/chat/completions", stream)).text()).toContain("served-b");
				outcomes.delete("a");
				outcomes.set("b", contextOverflow);
				expect(await (await send(gateway, "/v1/chat/completions", stream)).text()).toContain("context length");
				expect(calls).toEqual(["a", "b", "b"]);
			},
		);
	});

	it(`does not retry a preferred failure with billable usage (${stream ? "SSE" : "JSON"})`, async () => {
		await withRecovery(
			{ type: "fallback", on: ["provider_unavailable"], children: [target("a"), target("b")] },
			async (gateway, calls, outcomes) => {
				expect(await (await send(gateway, "/v1/chat/completions", stream)).text()).toContain("served-b");
				outcomes.delete("a");
				outcomes.set("b", { ...unavailable, usage: { input: 1 } });
				expect(await (await send(gateway, "/v1/chat/completions", stream)).text()).toContain("service unavailable");
				expect(calls).toEqual(["a", "b", "b"]);
			},
		);
	});

	it(`continues the initiating availability edge past a missing intermediate (${stream ? "SSE" : "JSON"})`, async () => {
		await withRecovery(
			{ type: "fallback", on: ["provider_unavailable"], children: [target("a"), target("b"), target("c")] },
			async (gateway, calls) => {
				expect(await (await send(gateway, "/v1/chat/completions", stream)).text()).toContain("served-c");
				expect(calls).toEqual(["a", "c"]);
			},
			["b"],
		);
	});

	it(`skips a missing nested entry without entering its unrelated quota-only branch (${stream ? "SSE" : "JSON"})`, async () => {
		await withRecovery(
			{
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					target("a"),
					{ type: "fallback", on: ["credential_quota"], children: [target("b"), target("c")] },
					target("d"),
				],
			},
			async (gateway, calls) => {
				expect(await (await send(gateway, "/v1/chat/completions", stream)).text()).toContain("served-d");
				expect(calls).toEqual(["a", "d"]);
			},
			["b"],
		);
	});
}

it("does not backtrack after preferred output is committed", async () => {
	await withRecovery(
		{ type: "fallback", on: ["provider_unavailable"], children: [target("a"), target("b")] },
		async (gateway, calls, outcomes) => {
			expect(await (await send(gateway, "/v1/chat/completions", true)).text()).toContain("served-b");
			outcomes.delete("a");
			outcomes.set("b", { ...unavailable, content: ["committed-b"] });
			expect(await (await send(gateway, "/v1/chat/completions", true)).text()).toContain("committed-b");
			expect(calls).toEqual(["a", "b", "b"]);
		},
	);
});
