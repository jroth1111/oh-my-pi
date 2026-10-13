import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "../src/api-registry";
import { RouteRegistry, startAuthGateway } from "../src/auth-gateway";
import type { RouteNode, RouteDefinition, AuthGatewayServerHandle } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel, registerMockApi } from "../src/providers/mock";

afterEach(clearCustomApis);
const inference = { Authorization: "Bearer graph-fixture-client" };
const admin = { Authorization: "Bearer graph-fixture-admin" };
const target = (model: string, weight?: number): RouteNode => ({
	type: "target",
	model,
	...(weight !== undefined ? { weight } : {}),
});

async function withGraph(
	run: (gateway: AuthGatewayServerHandle, registry: RouteRegistry, calls: string[]) => Promise<void>,
	failures: ReadonlySet<string> = new Set(),
	bootRoutes: readonly RouteDefinition[] = [{ id: "work", root: target("a") }],
): Promise<void> {
	registerMockApi();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-advanced-graph-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
		usageProviderResolver: () => undefined,
	});
	storage.keys.setRuntime("graph-fixture", "fixture-key");
	const calls: string[] = [];
	const models = new Map(
		["a", "b", "c", "d"].map(id => [
			id,
			createMockModel({
				provider: "graph-fixture",
				id,
				handler: () => {
					calls.push(id);
					return failures.has(id)
						? { stopReason: "error", errorMessage: "HTTP 503: service unavailable" }
						: { content: [`served-${id}`] };
				},
			}),
		]),
	);
	for (const model of models.values()) model.input.push("image");
	const registry = new RouteRegistry(id => models.get(id));
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["graph-fixture-client"],
		storage,
		resolveModel: id => models.get(id),
		routeRegistry: registry,
		routes: bootRoutes,
		allowManagement: true,
		adminBearerTokens: ["graph-fixture-admin"],
	});
	try {
		await run(gateway, registry, calls);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
}

async function replace(gateway: AuthGatewayServerHandle, root: RouteNode): Promise<void> {
	const response = await fetch(`${gateway.url}/v1/routes/work`, {
		method: "PUT",
		headers: admin,
		body: JSON.stringify({ root }),
	});
	expect(response.status).toBe(200);
	await response.text();
}

async function infer(gateway: AuthGatewayServerHandle, native = false, vision = false): Promise<Response> {
	return fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
		method: "POST",
		headers: { ...inference, "Content-Type": "application/json" },
		body: JSON.stringify(
			native
				? {
						modelId: "work",
						stream: false,
						context: {
							messages: [
								{
									role: "user",
									timestamp: 0,
									content: vision
										? [
												{ type: "text", text: "fixture" },
												{ type: "image", data: "AA==", mimeType: "image/png" },
											]
										: "fixture",
								},
							],
						},
					}
				: {
						model: "work",
						messages: [
							{
								role: "user",
								content: vision
									? [
											{ type: "text", text: "fixture" },
											{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
										]
									: "fixture",
							},
						],
					},
		),
	});
}

for (const native of [false, true]) {
	it(`balances the actual nested branch across ${native ? "native" : "chat"} requests without starting fallback-only leaves`, async () => {
		await withGraph(async (gateway, _registry, calls) => {
			await replace(gateway, {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [{ type: "balance", strategy: "rr", children: [target("a"), target("b")] }, target("c")],
			});
			for (let i = 0; i < 4; i++) {
				const response = await infer(gateway, native);
				expect(response.status).toBe(200);
				await response.text();
			}
			expect(calls).toEqual(["a", "b", "a", "b"]);
		});
	});
	it(`evaluates vision conditionals before ${native ? "native" : "chat"} dispatch`, async () => {
		await withGraph(async (gateway, _registry, calls) => {
			await replace(gateway, { type: "conditional", when: { vision: true }, children: [target("a"), target("b")] });
			for (const vision of [false, true]) {
				const response = await infer(gateway, native, vision);
				expect(response.status).toBe(200);
				await response.text();
			}
			expect(calls).toEqual(["b", "a"]);
		});
	});
}

it("exhausts balanced alternatives before crossing a later domain tier", async () => {
	await withGraph(
		async (gateway, _registry, calls) => {
			await replace(gateway, {
				type: "domain",
				name: "subscription-first",
				children: [{ type: "balance", strategy: "rr", children: [target("a"), target("b")] }, target("c")],
			});
			const response = await infer(gateway);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("served-c");
			expect(calls).toEqual(["a", "b", "c"]);
		},
		new Set(["a", "b"]),
	);
});

it("weighted dispatch gives equally healthy targets their configured share", async () => {
	await withGraph(async (gateway, _registry, calls) => {
		await replace(gateway, { type: "balance", strategy: "weighted", children: [target("a", 1), target("b", 3)] });
		for (let i = 0; i < 12; i++) {
			const response = await infer(gateway);
			expect(response.status).toBe(200);
			await response.text();
		}
		expect(calls.filter(id => id === "a")).toHaveLength(3);
		expect(calls.filter(id => id === "b")).toHaveLength(9);
	});
});

it("rejects a self-referencing PUT without changing the existing route or generation", async () => {
	await withGraph(async (gateway, registry, calls) => {
		const before = registry.generation;
		const rejected = await fetch(`${gateway.url}/v1/routes/work`, {
			method: "PUT",
			headers: admin,
			body: JSON.stringify({ root: { type: "route-ref", route: "work" } }),
		});
		expect(rejected.status).toBe(400);
		expect(await rejected.text()).toMatch(/cycle/i);
		expect(registry.generation).toBe(before);
		const response = await infer(gateway);
		expect(response.status).toBe(200);
		await response.text();
		expect(calls).toEqual(["a"]);
	});
});

it("starts composite balance children only at their entry targets", async () => {
	await withGraph(async (gateway, _registry, calls) => {
		await replace(gateway, {
			type: "balance",
			strategy: "rr",
			children: [
				{ type: "fallback", on: ["provider_unavailable"], children: [target("a"), target("b")] },
				target("c"),
			],
		});
		for (let i = 0; i < 4; i++) {
			const response = await infer(gateway);
			expect(response.status).toBe(200);
			await response.text();
		}
		expect(calls).toEqual(["a", "c", "a", "c"]);
	});
});

it("boot references resolve from the complete incoming set before HTTP dispatch", async () => {
	await withGraph(
		async (gateway, _registry, calls) => {
			const response = await infer(gateway);
			expect(response.status).toBe(200);
			await response.text();
			expect(calls).toEqual(["b"]);
		},
		new Set(),
		[
			{ id: "work", root: { type: "route-ref", route: "base" } },
			{ id: "base", root: target("b") },
		],
	);
});

it("batch replacement uses new reference roots rather than stale registration order and remains atomic on invalid batches", async () => {
	await withGraph(async (gateway, registry, calls) => {
		registry.register({ id: "base", root: target("a") });
		registry.replaceAll([
			{ id: "work", root: { type: "route-ref", route: "base" } },
			{ id: "base", root: target("b") },
		]);
		const generation = registry.generation;
		const response = await infer(gateway);
		expect(response.status).toBe(200);
		await response.text();
		expect(calls).toEqual(["b"]);
		for (const definitions of [
			[{ id: "work", root: { type: "route-ref", route: "base" } }],
			[
				{ id: "work", root: { type: "route-ref", route: "base" } },
				{ id: "base", root: { type: "route-ref", route: "work" } },
			],
			[
				{ id: "work", root: target("a") },
				{ id: "work", root: target("b") },
			],
		] satisfies RouteDefinition[][]) {
			expect(() => registry.replaceAll(definitions)).toThrow();
			expect(registry.generation).toBe(generation);
			const readback = await infer(gateway);
			expect(readback.status).toBe(200);
			await readback.text();
		}
		expect(calls).toEqual(["b", "b", "b", "b"]);
	});
});

for (const [first, second, rounds, expectedFirst, expectedSecond] of [
	[1, 5000, 5001, 1, 5000],
	[0.25, 0.75, 100, 25, 75],
	[1e308, 3e307, 130, 100, 30],
] as const) {
	it(`weighted selection honors the ${first}:${second} ratio without clamps, truncation or overflow`, async () => {
		await withGraph(async (gateway, registry) => {
			await replace(gateway, {
				type: "balance",
				strategy: "weighted",
				children: [target("a", first), target("b", second)],
			});
			const route = registry.resolve("work");
			if (!route) throw new Error("Missing weighted route");
			const picks = new Map<string | undefined, number>();
			for (let i = 0; i < rounds; i++) {
				const picked = registry.pickInitialTarget(route);
				picks.set(picked, (picks.get(picked) ?? 0) + 1);
			}
			expect(picks).toEqual(
				new Map([
					["graph-fixture/a", expectedFirst],
					["graph-fixture/b", expectedSecond],
				]),
			);
		});
	});
}

it("rejects malformed behavioral nodes at PUT rather than failing the next inference", async () => {
	await withGraph(async (gateway, registry, calls) => {
		const generation = registry.generation;
		for (const root of [
			{ type: "conditional", when: { vision: true }, children: [target("a"), target("b"), target("c")] },
			{ type: "conditional", when: { vision: "yes" }, children: [target("a")] },
			{ type: "balance", strategy: "random", children: [target("a")] },
			{ type: "balance", strategy: "rr", children: [] },
			{ type: "domain", name: " ", children: [target("a")] },
			{ type: "target", model: "a", weight: 0 },
			{ type: "target", model: "a", weight: "3" },
		]) {
			const response = await fetch(`${gateway.url}/v1/routes/work`, {
				method: "PUT",
				headers: admin,
				body: JSON.stringify({ root }),
			});
			expect(response.status).toBe(400);
			await response.text();
			expect(registry.generation).toBe(generation);
		}
		const response = await infer(gateway);
		expect(response.status).toBe(200);
		await response.text();
		expect(calls).toEqual(["a"]);
	});
});
