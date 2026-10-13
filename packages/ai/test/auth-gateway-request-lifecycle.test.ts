import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "../src/api-registry";
import {
	startAuthGateway,
	createAuthGatewayRouter,
	type GatewayHooks,
	type AuthGatewayServerHandle,
	runHook,
} from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel, type MockModel, registerMockApi } from "../src/providers/mock";

afterEach(clearCustomApis);

for (const native of [false, true]) {
	for (const stream of [false, true]) {
		for (const fails of [false, true]) {
			it(`finalizes ${native ? "pi-native" : "chat"} ${stream ? "streaming" : "JSON"} ${fails ? "failure" : "success"} hooks once`, async () => {
				registerMockApi();
				const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-lifecycle-"));
				const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
					usageProviderResolver: () => undefined,
				});
				storage.keys.setRuntime("openrouter", "fixture-key");
				const events: string[] = [];
				const hooks: GatewayHooks = {
					beforeRequest: () => {
						events.push("beforeRequest");
					},
					beforeAttempt: () => {
						events.push("beforeAttempt");
					},
					afterAttempt: ctx => {
						events.push(`afterAttempt:${ctx.ok}`);
					},
					afterRequest: ctx => {
						events.push(`afterRequest:${ctx.ok}`);
					},
				};
				const mock = createMockModel({
					provider: "openrouter",
					id: "model",
					handler: fails
						? () => {
								throw new Error("service unavailable");
							}
						: { content: ["ok"] },
				});
				const gateway = startAuthGateway({
					bind: "127.0.0.1:0",
					bearerTokens: ["client"],
					storage,
					hooks,
					resolveModel: id => (id === "model" ? mock : undefined),
				});
				try {
					const body = native
						? { modelId: "model", context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, stream }
						: { model: "model", messages: [{ role: "user", content: "hi" }], stream };
					const response = await fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
						method: "POST",
						headers: { Authorization: "Bearer client", "Content-Type": "application/json" },
						body: JSON.stringify(body),
					});
					await response.text();
					expect(events).toEqual([
						"beforeRequest",
						"beforeAttempt",
						`afterAttempt:${!fails}`,
						`afterRequest:${!fails}`,
					]);
					expect(response.headers.get("x-request-id")).toBeTruthy();
					expect(response.headers.get("request-id")).toBe(response.headers.get("x-request-id"));
				} finally {
					await gateway.close();
					storage.close();
					await fs.rm(directory, { recursive: true, force: true });
				}
			});
		}
	}
}

async function withHookRoute(
	hooks: GatewayHooks,
	run: (
		gateway: AuthGatewayServerHandle,
		primary: MockModel,
		backup: MockModel,
		storage: AuthStorage,
	) => Promise<void>,
	failPrimary = false,
): Promise<void> {
	registerMockApi();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-hook-contract-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
		usageProviderResolver: () => undefined,
	});
	storage.keys.setRuntime("fixture-hook", "fixture-key");
	const primary = createMockModel({
		provider: "fixture-hook",
		id: "primary",
		handler: failPrimary
			? { stopReason: "error", errorMessage: "HTTP 503: service unavailable" }
			: { content: ["ok"] },
	});
	const backup = createMockModel({ provider: "fixture-hook", id: "backup", handler: { content: ["backup"] } });
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["client"],
		storage,
		hooks,
		resolveModel: id => (id === "primary" ? primary : id === "backup" ? backup : undefined),
		routes: [
			{
				id: "route",
				root: {
					type: "fallback",
					on: ["provider_unavailable"],
					children: [
						{ type: "target", model: "primary" },
						{ type: "target", model: "backup" },
					],
				},
			},
		],
	});
	try {
		await run(gateway, primary, backup, storage);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
}

function sendHookRequest(gateway: AuthGatewayServerHandle, native = false, stream = false): Promise<Response> {
	return fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
		method: "POST",
		headers: { Authorization: "Bearer client", "Content-Type": "application/json" },
		body: JSON.stringify(
			native
				? {
						modelId: "route",
						context: { messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
						stream,
					}
				: { model: "route", messages: [{ role: "user", content: "fixture" }], stream },
		),
	});
}

for (const hook of ["beforeRequest", "beforeAttempt"] as const) {
	it(`${hook} rejection is a gateway failure, finalizes the request and never dispatches a provider`, async () => {
		const outcomes: boolean[] = [];
		await withHookRoute(
			{
				[hook]: async () => {
					throw new Error("HTTP 503: hook fixture unavailable");
				},
				afterRequest: ctx => {
					outcomes.push(ctx.ok);
				},
			},
			async (gateway, primary, backup) => {
				const response = await sendHookRequest(gateway);
				expect(response.status).toBe(500);
				expect(await response.text()).toContain("hook fixture unavailable");
				expect(primary.calls).toHaveLength(0);
				expect(backup.calls).toHaveLength(0);
				expect(outcomes).toEqual([false]);
				expect(response.headers.get("request-id")).toBe(response.headers.get("x-request-id"));
			},
		);
	});
}

it("awaits request admission before native dispatch and isolates mutable hook context", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let requestId = "";
	await withHookRoute(
		{
			beforeRequest: async ctx => {
				requestId = ctx.requestId;
				ctx.requestId = "mutated-hook-copy";
				entered.resolve();
				await release.promise;
			},
			beforeAttempt: ctx => {
				expect(ctx.requestId).toBe(requestId);
				ctx.target = "fixture-hook/backup";
			},
		},
		async (gateway, primary, backup) => {
			const pending = sendHookRequest(gateway, true);
			try {
				await entered.promise;
				expect(primary.calls).toHaveLength(0);
			} finally {
				release.resolve();
			}
			const response = await pending;
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("ok");
			expect(primary.calls).toHaveLength(1);
			expect(backup.calls).toHaveLength(0);
			expect(response.headers.get("x-request-id")).toBe(requestId);
		},
	);
});

it("finalizes each real fallback attempt but only one overall request", async () => {
	const order: string[] = [];
	await withHookRoute(
		{
			beforeRequest: () => {
				order.push("request");
			},
			beforeAttempt: ctx => {
				order.push(`before:${ctx.target}`);
			},
			afterAttempt: ctx => {
				order.push(`after:${ctx.target}:${ctx.ok}`);
			},
			afterRequest: ctx => {
				order.push(`done:${ctx.ok}`);
			},
		},
		async (gateway, primary, backup) => {
			const response = await sendHookRequest(gateway, false, true);
			expect(await response.text()).toContain("backup");
			expect(primary.calls).toHaveLength(1);
			expect(backup.calls).toHaveLength(1);
			expect(order).toEqual([
				"request",
				"before:fixture-hook/primary",
				"after:fixture-hook/primary:false",
				"before:fixture-hook/backup",
				"after:fixture-hook/backup:true",
				"done:true",
			]);
		},
		true,
	);
});

it("public runHook preserves the original synchronous and asynchronous rejection", async () => {
	const failure = new Error("public hook fixture failure");
	for (const fn of [
		() => {
			throw failure;
		},
		async () => {
			throw failure;
		},
	]) {
		await expect(runHook(fn, undefined)).rejects.toBe(failure);
	}
});

it("does not start provider work if the caller aborts while an async attempt hook is pending", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const outcomes: boolean[] = [];
	const hooks: GatewayHooks = {
		beforeAttempt: async () => {
			entered.resolve();
			await release.promise;
		},
		afterRequest: ctx => {
			outcomes.push(ctx.ok);
		},
	};
	await withHookRoute(hooks, async (_gateway, primary, backup, storage) => {
		const router = createAuthGatewayRouter({
			storage,
			hooks,
			resolveModel: id => (id === "primary" ? primary : undefined),
		});
		const client = new AbortController();
		try {
			const pending = router.route(
				new Request("http://fixture/v1/chat/completions", {
					method: "POST",
					signal: client.signal,
					body: JSON.stringify({ model: "primary", messages: [{ role: "user", content: "fixture" }] }),
				}),
				"fixture",
			);
			await entered.promise;
			client.abort(new Error("fixture client abort"));
			release.resolve();
			const response = await pending;
			expect(response.status).toBe(499);
			await response.text();
			expect(primary.calls).toHaveLength(0);
			expect(backup.calls).toHaveLength(0);
			expect(outcomes).toEqual([false]);
		} finally {
			release.resolve();
			router.close();
		}
	});
});

for (const hook of ["afterAttempt", "afterRequest"] as const) {
	it(`does not redispatch a completed model turn when ${hook} fails`, async () => {
		registerMockApi();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-hook-replay-"));
		const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
			usageProviderResolver: () => undefined,
		});
		storage.keys.setRuntime("openrouter", "fixture-key");
		const primary = createMockModel({ provider: "openrouter", id: "primary", handler: { content: ["ok"] } });
		const backup = createMockModel({ provider: "openrouter", id: "backup", handler: { content: ["backup"] } });
		const hooks: GatewayHooks = {
			[hook]: () => {
				throw new Error("HTTP 503: observer service unavailable");
			},
		};
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["client"],
			storage,
			hooks,
			resolveModel: id => (id === "primary" ? primary : id === "backup" ? backup : undefined),
			routes: [
				{
					id: "route",
					root: {
						type: "fallback",
						on: ["provider_unavailable", "provider_transient"],
						children: [
							{ type: "target", model: "primary" },
							{ type: "target", model: "backup" },
						],
					},
				},
			],
		});
		try {
			const response = await fetch(`${gateway.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: "Bearer client", "Content-Type": "application/json" },
				body: JSON.stringify({ model: "route", messages: [{ role: "user", content: "hi" }], stream: false }),
			});
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(primary.calls).toHaveLength(1);
			expect(backup.calls).toHaveLength(0);
		} finally {
			await gateway.close();
			storage.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
}
