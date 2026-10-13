import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "../src/api-registry";
import { RouteRegistry, startAuthGateway } from "../src/auth-gateway";
import type { AuthGatewayServerHandle } from "../src/auth-gateway/types";
import { AuthStorage } from "../src/auth-storage";
import { ProviderResponseError } from "../src/error";
import type { GatewayErrorDisposition } from "../src/error/gateway";
import { createMockModel, type MockModel, registerMockApi } from "../src/providers/mock";

afterEach(() => clearCustomApis());

const formats = ["/v1/pi/stream", "/v1/chat/completions", "/v1/messages", "/v1/responses"] as const;
function requestBody(format: string, stream: boolean): string {
	if (format === "/v1/pi/stream")
		return JSON.stringify({
			modelId: "routed",
			context: {
				messages: [{ role: "user", content: "fixture", timestamp: 0 }],
			},
			stream,
		});
	if (format === "/v1/responses") return JSON.stringify({ model: "routed", input: "fixture", stream });
	return JSON.stringify({
		model: "routed",
		messages: [{ role: "user", content: "fixture" }],
		max_tokens: 100,
		stream,
	});
}

async function withGateway(
	format: string,
	stream: boolean,
	on: GatewayErrorDisposition,
	primaryOutcome: "unavailable" | "missing" | "policy" | "partial" | "charged" | "probe",
	run: (response: Response, calls: string[], storage: AuthStorage) => Promise<void>,
): Promise<void> {
	registerMockApi();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-conductor-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
	});
	const calls: string[] = [];
	const primary = createMockModel({
		provider: "fixture-primary",
		id: "primary",
		handler: async () => {
			calls.push("primary");
			await Promise.resolve();
			if (primaryOutcome === "policy")
				throw new ProviderResponseError("Request blocked by Google (SAFETY)", {
					kind: "content-blocked",
				});
			return {
				content: primaryOutcome === "partial" ? ["primary partial"] : [],
				stopReason: "error",
				errorMessage: "HTTP 503: service unavailable",
				usage: primaryOutcome === "charged" ? { premiumRequests: 1 } : undefined,
			};
		},
	});
	const backup = createMockModel({
		provider: "fixture-backup",
		id: "backup",
		handler: (_context, options) => {
			calls.push("backup");
			expect(options?.apiKey).toBe("backup-fixture-key");
			const primaryId = storage.credentials.list("fixture-primary")[0]?.id;
			if (primaryId !== undefined)
				expect(
					storage.coordination.activeTurnReservation(
						primaryId,
						storage.coordination.getCredentialIncarnation(primaryId),
					),
				).toBeUndefined();
			return { content: ["backup result"] };
		},
	});
	if (primaryOutcome !== "missing")
		await storage.credentials.set("fixture-primary", {
			type: "api_key",
			key: "primary-fixture-key",
		});
	await storage.credentials.set("fixture-backup", {
		type: "api_key",
		key: "backup-fixture-key",
	});
	const registry = new RouteRegistry(id => (id === "primary" ? primary : id === "backup" ? backup : undefined));
	if (primaryOutcome === "probe") {
		const id = storage.credentials.list("fixture-primary")[0]!.id;
		storage.blocks.upsert({
			credentialId: id,
			providerKey: "fixture-primary:api_key",
			blockScope: "",
			blockedUntilMs: Date.now() + 60_000,
			quotaOrigin: true,
		});
	}
	registry.register({
		id: "routed",
		root: {
			type: "fallback",
			on: [on],
			children: [
				{ type: "target", model: "primary" },
				{ type: "target", model: "backup" },
			],
		},
	});
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["conductor-fixture-client"],
		storage,
		resolveModel: () => undefined,
		routeRegistry: registry,
	});
	try {
		const response = await fetch(`${gateway.url}${format}`, {
			method: "POST",
			headers: {
				Authorization: "Bearer conductor-fixture-client",
				"Content-Type": "application/json",
			},
			body: requestBody(format, stream),
		});
		await run(response, calls, storage);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
}

for (const format of formats)
	for (const stream of [false, true]) {
		it(`routes asynchronous pre-output failure through ${format} (${stream ? "stream" : "complete"})`, async () => {
			await withGateway(format, stream, "provider_unavailable", "unavailable", async (response, calls) => {
				expect(response.status).toBe(200);
				const body = await response.text();
				expect(body).toContain("backup result");
				expect(body).not.toContain("service unavailable");
				expect(calls).toEqual(["primary", "backup"]);
			});
		});
		it(`routes missing credentials only along declared edges through ${format} (${stream ? "stream" : "complete"})`, async () => {
			await withGateway(format, stream, "provider_unavailable", "missing", async (response, calls) => {
				expect(response.status).toBe(200);
				expect(await response.text()).toContain("backup result");
				expect(calls).toEqual(["backup"]);
			});
			await withGateway(format, stream, "context_overflow", "missing", async (response, calls) => {
				expect(response.status).toBe(503);
				expect(await response.text()).toContain("No credential available");
				expect(calls).toEqual([]);
			});
		});
		it(`does not replay policy-blocked or charged turns through ${format} (${stream ? "stream" : "complete"})`, async () => {
			for (const outcome of ["policy", "charged"] as const)
				await withGateway(format, stream, "provider_unavailable", outcome, async (response, calls) => {
					const body = await response.text();
					expect(body).not.toContain("backup result");
					expect(calls).toEqual(["primary"]);
				});
		});
	}

for (const format of formats)
	it(`never replays committed output through ${format}`, async () => {
		await withGateway(format, true, "provider_unavailable", "partial", async (response, calls) => {
			expect(await response.text()).toContain("primary partial");
			expect(calls).toEqual(["primary"]);
		});
	});

async function withScenario(
	run: (
		storage: AuthStorage,
		post: (registry: RouteRegistry, format: string, stream: boolean) => Promise<Response>,
	) => Promise<void>,
): Promise<void> {
	registerMockApi();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-conductor-scenario-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
	});
	const gateways: AuthGatewayServerHandle[] = [];
	try {
		await run(storage, async (registry, format, stream) => {
			const gateway = startAuthGateway({
				bind: "127.0.0.1:0",
				bearerTokens: ["scenario-fixture-client"],
				storage,
				routeRegistry: registry,
				resolveModel: () => undefined,
			});
			gateways.push(gateway);
			return fetch(`${gateway.url}${format}`, {
				method: "POST",
				headers: { Authorization: "Bearer scenario-fixture-client", "Content-Type": "application/json" },
				body: requestBody(format, stream),
			});
		});
	} finally {
		for (const gateway of gateways) await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
}

function fallbackRegistry(models: MockModel[], on: GatewayErrorDisposition): RouteRegistry {
	const registry = new RouteRegistry(id => models.find(model => model.id === id));
	registry.register({
		id: "routed",
		root: { type: "fallback", on: [on], children: models.map(model => ({ type: "target", model: model.id })) },
	});
	return registry;
}

for (const format of ["/v1/pi/stream", "/v1/chat/completions"] as const)
	for (const stream of [false, true])
		it(`routes unresolved targets only along model-unavailable edges through ${format} (${stream ? "stream" : "complete"})`, async () => {
			await withScenario(async (storage, post) => {
				storage.keys.setRuntime("fixture-unknown", "unknown-target-fixture-key");
				const backup = createMockModel({
					provider: "fixture-unknown",
					id: "backup",
					handler: { content: ["catalog fallback survived"] },
				});
				for (const on of ["context_overflow", "model_unavailable"] as const) {
					const registry = new RouteRegistry(id => (id === "backup" ? backup : undefined));
					registry.register({
						id: "routed",
						root: {
							type: "fallback",
							on: [on],
							children: [
								{ type: "target", model: "unknown-primary" },
								{ type: "target", model: "backup" },
							],
						},
					});
					const response = await post(registry, format, stream);
					expect(response.status).toBe(on === "model_unavailable" ? 200 : 404);
					const body = await response.text();
					expect(body).toContain(on === "model_unavailable" ? "catalog fallback survived" : "Unknown model");
					expect(backup.calls).toHaveLength(on === "model_unavailable" ? 1 : 0);
				}
			});
		});

for (const format of formats)
	for (const stream of [false, true]) {
		it(`exhausts sibling credentials independently on each target through ${format} (${stream ? "stream" : "complete"})`, async () => {
			await withScenario(async (storage, post) => {
				const calls: string[] = [];
				const models = ["a", "b"].map(id =>
					createMockModel({
						provider: `fixture-${id}`,
						id,
						handler: (_context, options) => {
							calls.push(`${id}:${options?.apiKey}`);
							return { content: [], stopReason: "error", errorMessage: "HTTP 429: hit your usage limit" };
						},
					}),
				);
				models.push(
					createMockModel({ provider: "fixture-c", id: "c", handler: { content: ["last target survived"] } }),
				);
				for (const id of ["a", "b"])
					await storage.credentials.set(`fixture-${id}`, [
						{ type: "api_key", key: `${id}-1` },
						{ type: "api_key", key: `${id}-2` },
					]);
				await storage.credentials.set("fixture-c", { type: "api_key", key: "c-1" });
				const response = await post(fallbackRegistry(models, "credential_quota"), format, stream);
				expect(response.status).toBe(200);
				expect(await response.text()).toContain("last target survived");
				expect(calls.slice(0, 2).sort()).toEqual(["a:a-1", "a:a-2"]);
				expect(calls.slice(2).sort()).toEqual(["b:b-1", "b:b-2"]);
				expect(models[2]?.calls).toHaveLength(1);
				for (const provider of ["fixture-a", "fixture-b", "fixture-c"])
					for (const row of storage.credentials.list(provider))
						expect(
							storage.coordination.activeTurnReservation(
								row.id,
								storage.coordination.getCredentialIncarnation(row.id),
							),
						).toBeUndefined();
			});
		});
		it(`tries a permanent credential sibling without requiring a fallback edge through ${format} (${stream ? "stream" : "complete"})`, async () => {
			await withScenario(async (storage, post) => {
				await storage.credentials.set("fixture-permanent", [
					{ type: "api_key", key: "expired" },
					{ type: "api_key", key: "working" },
				]);
				let firstBearer: string | undefined;
				const primary = createMockModel({
					provider: "fixture-permanent",
					id: "a",
					handler: (_context, options) => {
						if (firstBearer === undefined) {
							firstBearer = String(options?.apiKey);
							return { content: [], stopReason: "error", errorMessage: "HTTP 400: invalid_grant" };
						}
						expect(options?.apiKey).not.toBe(firstBearer);
						return { content: ["sibling survived"] };
					},
				});
				const registry = new RouteRegistry(id => (id === "a" ? primary : undefined));
				registry.register({ id: "routed", root: { type: "target", model: "a" } });
				const response = await post(registry, format, stream);
				expect(response.status).toBe(200);
				expect(await response.text()).toContain("sibling survived");
				expect(primary.calls.map(call => call.options?.apiKey).sort()).toEqual(["expired", "working"]);
			});
		});
	}

for (const format of ["/v1/pi/stream", "/v1/responses"] as const)
	it(`retains nested branch conditions on actual requests through ${format}`, async () => {
		await withScenario(async (storage, post) => {
			const models = ["a", "b", "c", "d"].map(id =>
				createMockModel({
					provider: "fixture-nested",
					id,
					handler:
						id === "a"
							? { content: [], stopReason: "error", errorMessage: "HTTP 503: service unavailable" }
							: { content: [`surviving ${id}`] },
				}),
			);
			storage.keys.setRuntime("fixture-nested", "nested-fixture-key");
			const registry = new RouteRegistry(id => models.find(model => model.id === id));
			registry.register({
				id: "routed",
				root: {
					type: "fallback",
					on: ["provider_unavailable"],
					children: [
						{
							type: "fallback",
							on: ["context_overflow"],
							children: [
								{ type: "target", model: "a" },
								{ type: "target", model: "b" },
							],
						},
						{
							type: "fallback",
							on: ["context_overflow"],
							children: [
								{ type: "target", model: "c" },
								{ type: "target", model: "d" },
							],
						},
					],
				},
			});
			const response = await post(registry, format, true);
			expect(await response.text()).toContain("surviving c");
			expect(models.map(model => model.calls.length)).toEqual([1, 0, 1, 0]);
		});
	});

for (const format of ["/v1/pi/stream", "/v1/responses"] as const)
	for (const stream of [false, true])
		it(`does not clear the failed primary probe when its backup succeeds through ${format} (${stream ? "stream" : "complete"})`, async () => {
			await withGateway(format, stream, "provider_unavailable", "probe", async (response, calls, storage) => {
				expect(await response.text()).toContain("backup result");
				expect(calls).toEqual(["primary", "backup"]);
				const id = storage.credentials.list("fixture-primary")[0]!.id;
				expect(storage.blocks.list([id])).toHaveLength(1);
				expect(
					storage.coordination.activeTurnReservation(id, storage.coordination.getCredentialIncarnation(id)),
				).toBeUndefined();
			});
		});
