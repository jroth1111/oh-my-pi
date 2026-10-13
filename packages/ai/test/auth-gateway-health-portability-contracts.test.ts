import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "../src/api-registry";
import { ProviderHealthBook, RouteRegistry, resolveGatewayAccount, startAuthGateway } from "../src/auth-gateway";
import type { AuthGatewayServerHandle, RouteDefinition } from "../src/auth-gateway";
import { responseEndpointIdentity } from "../src/auth-gateway/response-ownership";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel, type MockModel, registerMockApi } from "../src/providers/mock";
import { registerOAuthProvider, unregisterOAuthProviders } from "../src/registry/oauth";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

afterEach(() => {
	vi.restoreAllMocks();
	clearCustomApis();
	unregisterOAuthProviders("health-portability-refresh-fixture");
});
const provider = "health-fixture";
const headers = { Authorization: "Bearer health-fixture-client", "Content-Type": "application/json" };
type Outcome = "success" | "provider" | "model" | "quota";

async function withHealth(
	run: (
		gateway: AuthGatewayServerHandle,
		storage: AuthStorage,
		registry: RouteRegistry,
		health: ProviderHealthBook,
		first: MockModel,
		setOutcome: (outcome: Outcome) => void,
	) => Promise<void>,
): Promise<void> {
	registerMockApi();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-health-portability-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
		usageProviderResolver: () => undefined,
	});
	storage.keys.setRuntime(provider, "fixture-key");
	storage.keys.setRuntime("health-backup", "fixture-backup-key");
	let outcome: Outcome = "success";
	const first = createMockModel({
		provider,
		id: "a",
		handler: () =>
			outcome === "success"
				? { content: ["served-a"] }
				: {
						stopReason: "error",
						errorMessage:
							outcome === "provider"
								? "HTTP 503: service unavailable"
								: outcome === "model"
									? "HTTP 404: model not found"
									: "HTTP 429: quota exceeded",
					},
	});
	const backup = createMockModel({ provider: "health-backup", id: "b", handler: { content: ["served-b"] } });
	const registry = new RouteRegistry(id => (id === "a" ? first : id === "b" ? backup : undefined));
	const health = new ProviderHealthBook();
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		storage,
		bearerTokens: ["health-fixture-client"],
		resolveModel: () => undefined,
		routeRegistry: registry,
		providerHealth: health,
		routes: [
			{
				id: "work",
				affinity: "none",
				root: {
					type: "fallback",
					on: ["provider_unavailable", "model_unavailable"],
					children: [
						{ type: "target", model: "a" },
						{ type: "target", model: "b" },
					],
				},
			},
		],
	});
	try {
		await run(gateway, storage, registry, health, first, value => {
			outcome = value;
		});
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
}

function send(
	gateway: AuthGatewayServerHandle,
	native: boolean,
	stream: boolean,
	extraHeaders: Record<string, string> = {},
): Promise<Response> {
	return fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
		method: "POST",
		headers: { ...headers, ...extraHeaders },
		body: JSON.stringify(
			native
				? { modelId: "work", context: { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, stream }
				: { model: "work", messages: [{ role: "user", content: "fixture" }], stream },
		),
	});
}

for (const native of [false, true])
	for (const stream of [false, true]) {
		it(`counts provider failures once, heals canonical success and skips an open circuit through ${native ? "native" : "chat"} ${stream ? "SSE" : "JSON"}`, async () => {
			await withHealth(async (gateway, _storage, _registry, health, first, setOutcome) => {
				for (const [outcome, state] of [
					["provider", "degraded"],
					["provider", "degraded"],
					["success", "healthy"],
					["provider", "degraded"],
					["provider", "degraded"],
					["provider", "open"],
				] as const) {
					setOutcome(outcome);
					const response = await send(gateway, native, stream);
					await response.text();
					expect(health.state(provider, "a")).toBe(state);
				}
				const before = first.calls.length;
				const skipped = await send(gateway, native, stream);
				expect(await skipped.text()).toContain("served-b");
				expect(first.calls).toHaveLength(before);
			});
		});
		it(`uses captured account identity after key lookup through ${native ? "native" : "chat"} ${stream ? "SSE" : "JSON"}`, async () => {
			await withHealth(async (gateway, storage, registry, _health, first) => {
				storage.keys.removeRuntime(provider);
				await storage.credentials.set(provider, [
					{
						type: "oauth",
						access: "fixture-wrong-account",
						refresh: "fixture-wrong-refresh",
						accountId: "wrong",
						expires: Date.now() + 3600_000,
					},
					{
						type: "oauth",
						access: "fixture-right-account",
						refresh: "fixture-right-refresh",
						accountId: "right",
						expires: Date.now() + 3600_000,
					},
				]);
				const wanted = storage.credentials.list(provider)[1]!.id;
				const key = await storage.keys.getWithCredential(provider, "origin-readback", {
					credentialId: wanted,
					recordAffinity: false,
				});
				if (!key) throw new Error("Fixture key unavailable");
				registry.register({
					id: "work",
					root: { type: "target", model: "a" },
					affinity: "required",
					portability: {
						scope: "account",
						origin: resolveGatewayAccount(storage, provider, "origin-readback", key),
					},
				});
				const response = await send(gateway, native, stream);
				expect(response.status).toBe(200);
				expect(await response.text()).toContain("served-a");
				expect(first.calls).toHaveLength(1);
				expect(first.calls[0]?.options?.apiKey).toBe("fixture-right-account");
			});
		});
		it(`populates deployment identity and refuses incompatible project headers through ${native ? "native" : "chat"} ${stream ? "SSE" : "JSON"}`, async () => {
			await withHealth(async (gateway, _storage, registry, _health, first) => {
				registry.register({
					id: "work",
					root: { type: "target", model: "a" },
					affinity: "required",
					portability: {
						scope: "deployment",
						origin: responseEndpointIdentity(first, { "openai-project": "fixture-project" }),
					},
				});
				const accepted = await send(gateway, native, stream, { "openai-project": "fixture-project" });
				expect(accepted.status).toBe(200);
				await accepted.text();
				const denied = await send(gateway, native, stream, { "openai-project": "other-project" });
				expect(denied.status).toBe(400);
				await denied.text();
				expect(first.calls).toHaveLength(1);
			});
		});
	}

it("model-owned unavailability opens the circuit but quota failures do not", async () => {
	await withHealth(async (gateway, _storage, _registry, health, _first, setOutcome) => {
		setOutcome("quota");
		for (let i = 0; i < 3; i++) {
			const response = await send(gateway, false, false);
			await response.text();
		}
		expect(health.state(provider, "a")).toBe("healthy");
		setOutcome("model");
		for (let i = 0; i < 3; i++) {
			const response = await send(gateway, false, false);
			await response.text();
		}
		expect(health.state(provider, "a")).toBe("open");
	});
});

it("a successful dispatch after the circuit wait resets failures instead of reopening on the next single error", async () => {
	await withHealth(async (gateway, _storage, _registry, health, _first, setOutcome) => {
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			setOutcome("provider");
			for (let i = 0; i < 3; i++) {
				const response = await send(gateway, false, false);
				await response.text();
			}
			expect(health.state(provider, "a")).toBe("open");
			now += 31_000;
			setOutcome("success");
			const healed = await send(gateway, false, false);
			expect(await healed.text()).toContain("served-a");
			expect(health.state(provider, "a")).toBe("healthy");
			setOutcome("provider");
			const failed = await send(gateway, false, false);
			await failed.text();
			expect(health.state(provider, "a")).toBe("degraded");
		} finally {
			clock.mockRestore();
		}
	});
});

it("compiled required-state policy cannot be changed by mutating the registration object", async () => {
	await withHealth(async (gateway, _storage, registry, _health, first) => {
		const definition: RouteDefinition = {
			id: "work",
			root: { type: "target", model: "a" },
			affinity: "required",
			portability: { scope: "provider", origin: provider },
		};
		registry.register(definition);
		definition.portability!.origin = "foreign-provider";
		const response = await send(gateway, false, false);
		expect(response.status).toBe(200);
		await response.text();
		expect(first.calls).toHaveLength(1);
	});
});

it("rejects unsupported tool requests before dispatch and uses only declared model-availability edges", async () => {
	await withHealth(async (gateway, _storage, registry, _health, first) => {
		Object.assign(first, { supportsTools: false });
		const request = () =>
			fetch(`${gateway.url}/v1/chat/completions`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: "work",
					messages: [{ role: "user", content: "fixture" }],
					tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
				}),
			});
		const accepted = await request();
		expect(accepted.status).toBe(200);
		expect(await accepted.text()).toContain("served-b");
		registry.register({
			id: "work",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "a" },
					{ type: "target", model: "b" },
				],
			},
		});
		const denied = await request();
		expect(denied.status).toBe(400);
		await denied.text();
		expect(first.calls).toHaveLength(0);
	});
});

it("native Google schema controls do not silently disappear on a foreign API target", async () => {
	await withHealth(async (gateway, _storage, registry, _health, first) => {
		registry.register({ id: "work", root: { type: "target", model: "a" } });
		const response = await fetch(`${gateway.url}/v1beta/models/work:generateContent`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				contents: [{ role: "user", parts: [{ text: "fixture" }] }],
				generationConfig: { responseMimeType: "application/json" },
			}),
		});
		expect(response.status).toBe(400);
		await response.text();
		expect(first.calls).toHaveLength(0);
	});
});

it("does not dispatch a foreign account returned by authentication refresh on a required-state request", async () => {
	await withHealth(async (_gateway, storage) => {
		storage.keys.removeRuntime(provider);
		let refreshes = 0;
		registerOAuthProvider({
			id: provider,
			name: "Owned refresh fixture",
			sourceId: "health-portability-refresh-fixture",
			async login() {
				throw new Error("Fixture must not log in");
			},
			async refreshToken(credential) {
				refreshes++;
				return { ...credential, access: "foreign-refreshed", accountId: "foreign", expires: Date.now() + 3600_000 };
			},
			getApiKey(credential) {
				return credential.access;
			},
		});
		await storage.credentials.set(provider, {
			type: "oauth",
			access: "initial-owner",
			refresh: "owned-refresh",
			accountId: "owner",
			expires: Date.now() + 3600_000,
		});
		const key = await storage.keys.getWithCredential(provider, "origin", { recordAffinity: false });
		if (!key) throw new Error("Missing owned credential");
		const model = buildModel({
			id: "real-wire-fixture",
			name: "Auth retry fixture",
			provider,
			api: "openai-responses",
			baseUrl: "http://fixture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 100,
		});
		const sent: (string | null)[] = [];
		const actual = startAuthGateway({
			bind: "127.0.0.1:0",
			storage,
			bearerTokens: ["health-fixture-client"],
			resolveModel: id => (id === "real" ? model : undefined),
			routes: [
				{
					id: "work",
					root: { type: "target", model: "real" },
					affinity: "required",
					portability: { scope: "account", origin: resolveGatewayAccount(storage, provider, "origin", key) },
				},
			],
			fetch: async (_url, init) => {
				sent.push(new Headers(init?.headers).get("authorization"));
				return Response.json(
					{ error: { type: "authentication_error", message: "expired fixture bearer" } },
					{ status: 401 },
				);
			},
		});
		try {
			const response = await send(actual, false, false);
			expect(response.status).toBeGreaterThanOrEqual(400);
			await response.text();
			expect(refreshes).toBe(1);
			expect(sent).toEqual(["Bearer initial-owner"]);
		} finally {
			await actual.close();
		}
	});
});
