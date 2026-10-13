import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { startAuthGateway } from "../src/auth-gateway";
import { resolveGatewayAccount } from "../src/auth-gateway/dispatch";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { completedResponse } from "./fixtures/responses-completed";

afterEach(() => vi.restoreAllMocks());

it("carries the rotated account snapshot into a reopened held Responses attempt", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-held-account-"));
	const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(directory, "auth.db")), {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
		refreshOAuthCredential: async (_provider, _id, credential) => credential,
	});
	const provider = "unit-held-account";
	await storage.credentials.set(provider, [
		{
			type: "oauth",
			access: "retired",
			refresh: "retired-refresh",
			expires: Date.now() + 3_600_000,
			accountId: "retired",
		},
		{
			type: "oauth",
			access: "survivor",
			refresh: "survivor-refresh",
			expires: Date.now() + 3_600_000,
			accountId: "survivor",
		},
	]);
	storage.sessions.pin(provider, "held-account-session", storage.credentials.list(provider)[0]!.id);
	const model = buildModel({
		id: "held-account-model",
		name: "Fixture",
		provider,
		api: "openai-responses",
		baseUrl: "https://held.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 100,
	});
	const bearers: Array<string | null> = [];
	let failedAttemptSignal: AbortSignal | undefined;
	const gateway = startAuthGateway({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens: ["opaque-held-account-client-token"],
		resolveModel: () => model,
		fetch: async (_url, init) => {
			const bearer = new Headers(init?.headers).get("authorization");
			bearers.push(bearer);
			if (bearer === "Bearer retired")
				return Response.json({ error: { message: "Expired fixture bearer" } }, { status: 401 });
			const signal = init?.signal;
			if (!signal) throw new Error("Expected an upstream attempt abort scope");
			failedAttemptSignal ??= signal;
			if (signal === failedAttemptSignal)
				return Response.json(
					{ error: { message: "Fixture upstream unavailable", type: "api_error" } },
					{ status: 503, headers: { "retry-after-ms": "0" } },
				);
			return completedResponse("resp_held_survivor");
		},
	});
	try {
		const response = await fetch(`${gateway.url}/v1/responses`, {
			method: "POST",
			headers: { Authorization: "Bearer opaque-held-account-client-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				model: model.id,
				input: "fixture",
				stream: true,
				prompt_cache_key: "held-account-session",
			}),
		});
		const body = await response.text();
		expect(response.status).toBe(200);
		expect(body).toContain("response.completed");
		expect(body).not.toContain("response.failed");
		const rotatedAt = bearers.indexOf("Bearer survivor");
		expect(rotatedAt).toBeGreaterThan(0);
		expect(bearers.slice(rotatedAt).every(bearer => bearer === "Bearer survivor")).toBe(true);
		expect(storage.responses.get("resp_held_survivor")?.account).toBe(
			resolveGatewayAccount(storage, provider, "held-account-session", "survivor"),
		);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

for (const native of [false, true]) {
	it(`resumes a stored ${native ? "pi-native" : "Responses"} response after reopening the gateway and credential database`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-owner-restart-"));
		const database = path.join(directory, "auth.db");
		const provider = "unit-persisted-owner";
		let storage = new AuthStorage(await SqliteAuthCredentialStore.open(database), {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
		});
		await storage.credentials.set(provider, [
			{
				type: "oauth",
				access: "owner",
				refresh: "owner-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "owner",
			},
			{
				type: "oauth",
				access: "sibling",
				refresh: "sibling-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "sibling",
			},
		]);
		storage.sessions.pin(provider, "persisted-session", storage.credentials.list(provider)[0]!.id);
		const model = buildModel({
			id: "persisted-owner-model",
			name: "Fixture",
			provider,
			api: "openai-responses",
			baseUrl: "https://owner.example/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 100,
		});
		const requests: Array<{ bearer: string | null; previous: unknown; store: unknown }> = [];
		const start = () =>
			startAuthGateway({
				storage,
				bind: "127.0.0.1:0",
				bearerTokens: ["opaque-restart-client-token"],
				resolveModel: () => model,
				fetch: async (_url, init) => {
					const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
					requests.push({
						bearer: new Headers(init?.headers).get("authorization"),
						previous: payload.previous_response_id,
						store: payload.store,
					});
					return completedResponse(`resp_persisted_${requests.length}`);
				},
			});
		let gateway = start();
		const post = (previous?: string) =>
			fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/responses"}`, {
				method: "POST",
				headers: { Authorization: "Bearer opaque-restart-client-token", "Content-Type": "application/json" },
				body: JSON.stringify(
					native
						? {
								modelId: model.id,
								context: {
									messages: [{ role: "user", content: previous ? "new input" : "seed input", timestamp: 0 }],
								},
								stream: false,
								options: {
									sessionId: previous ? undefined : "persisted-session",
									previousResponseId: previous,
									store: true,
								},
							}
						: {
								model: model.id,
								input: previous ? "new input" : "seed input",
								stream: false,
								store: true,
								prompt_cache_key: previous ? undefined : "persisted-session",
								previous_response_id: previous,
							},
				),
			});
		try {
			const first = await post();
			expect(first.status).toBe(200);
			await first.text();
			await gateway.close();
			storage.close();
			storage = new AuthStorage(await SqliteAuthCredentialStore.open(database), {
				usageProviderResolver: () => undefined,
				rankingStrategyResolver: () => undefined,
			});
			await storage.credentials.reload();
			gateway = start();
			const continued = await post("resp_persisted_1");
			expect(continued.status).toBe(200);
			await continued.text();
			expect(requests).toEqual([
				{ bearer: "Bearer owner", previous: undefined, store: true },
				{ bearer: "Bearer owner", previous: "resp_persisted_1", store: true },
			]);
			model.baseUrl = "https://another-deployment.example/v1";
			const wrongDeployment = await post("resp_persisted_1");
			expect(wrongDeployment.status).toBe(400);
			await wrongDeployment.text();
			expect(requests).toHaveLength(2);
		} finally {
			await gateway.close();
			storage.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it(`preserves ${native ? "pi-native" : "Responses"} ownership when a peer refreshes after credential selection`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-owner-snapshot-"));
		const store = await SqliteAuthCredentialStore.open(path.join(directory, "auth.db"));
		const storage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
		});
		const provider = "unit-snapshot-owner";
		const credential = {
			type: "oauth" as const,
			access: "owner-old",
			refresh: "owner-refresh",
			expires: Date.now() + 3_600_000,
			accountId: "owner",
			projectId: "project",
		};
		await storage.credentials.set(provider, [credential]);
		const id = storage.credentials.list(provider)[0]!.id;
		const original = storage.keys.getWithCredential.bind(storage.keys);
		let selected = false;
		vi.spyOn(storage.keys, "getWithCredential").mockImplementation(async (...args) => {
			const resolved = await original(...args);
			if (!selected) {
				selected = true;
				store.updateAuthCredential(id, { ...credential, access: "owner-peer-refresh", refresh: "peer-refresh" });
				await storage.credentials.reload();
			}
			return resolved;
		});
		const model = buildModel({
			id: "owner-model",
			name: "Fixture",
			provider,
			api: "openai-responses",
			baseUrl: "https://owner.example/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 100,
		});
		const bearers: Array<string | null> = [];
		const gateway = startAuthGateway({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: ["opaque-snapshot-client-token"],
			resolveModel: () => model,
			fetch: async (_url, init) => {
				bearers.push(new Headers(init?.headers).get("authorization"));
				return completedResponse(`resp_snapshot_${bearers.length}`);
			},
		});
		const post = (previous?: string) =>
			fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/responses"}`, {
				method: "POST",
				headers: { Authorization: "Bearer opaque-snapshot-client-token", "Content-Type": "application/json" },
				body: JSON.stringify(
					native
						? {
								modelId: model.id,
								context: { messages: [{ role: "user", content: "snapshot fixture", timestamp: 0 }] },
								stream: false,
								options: { previousResponseId: previous },
							}
						: { model: model.id, input: "snapshot fixture", stream: false, previous_response_id: previous },
				),
			});
		try {
			const first = await post();
			expect(first.status).toBe(200);
			await first.text();
			const second = await post("resp_snapshot_1");
			expect(second.status).toBe(200);
			await second.text();
			expect(bearers).toEqual(["Bearer owner-old", "Bearer owner-peer-refresh"]);
		} finally {
			await gateway.close();
			storage.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	for (const outcome of ["recovered", "still-unauthorized", "different-account"] as const) {
		it(`keeps ${native ? "pi-native" : "Responses"} continuation retries on their owner when refresh is ${outcome}`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-owned-refresh-"));
			const store = await SqliteAuthCredentialStore.open(path.join(directory, "auth.db"));
			const refreshed: number[] = [];
			const storage = new AuthStorage(store, {
				usageProviderResolver: () => undefined,
				rankingStrategyResolver: () => undefined,
				refreshOAuthCredential: async (_provider, id, credential) => {
					refreshed.push(id);
					return {
						...credential,
						accountId: outcome === "different-account" ? "replacement" : credential.accountId,
						access: "owner-new",
						refresh: "owner-refresh-new",
						expires: Date.now() + 7_200_000,
					};
				},
			});
			const provider = "unit-owned-refresh";
			await storage.credentials.set(provider, [
				{
					type: "oauth",
					access: "owner-old",
					refresh: "owner-refresh",
					expires: Date.now() + 3_600_000,
					accountId: "owner",
				},
				{
					type: "oauth",
					access: "sibling",
					refresh: "sibling-refresh",
					expires: Date.now() + 3_600_000,
					accountId: "sibling",
				},
			]);
			const owner = storage.credentials
				.list(provider)
				.find(row => row.credential.type === "oauth" && row.credential.accountId === "owner")!;
			storage.sessions.pin(provider, "owned-session", owner.id);
			const model = buildModel({
				id: "owner-model",
				name: "Fixture",
				provider,
				api: "openai-responses",
				baseUrl: "https://owner.example/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10000,
				maxTokens: 100,
			});
			let continuation = false;
			const requests: Array<{ bearer: string | null; previous: unknown }> = [];
			const gateway = startAuthGateway({
				storage,
				bind: "127.0.0.1:0",
				bearerTokens: ["opaque-refresh-client-token"],
				resolveModel: () => model,
				fetch: async (_url, init) => {
					const bearer = new Headers(init?.headers).get("authorization");
					const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
					requests.push({ bearer, previous: payload.previous_response_id });
					if (continuation && (bearer === "Bearer owner-old" || outcome === "still-unauthorized"))
						return Response.json(
							{ error: { message: "Unexpected authentication rejection", type: "api_error" } },
							{ status: 401 },
						);
					return completedResponse(continuation ? "resp_after_refresh" : "resp_owned_seed");
				},
			});
			const post = (previous?: string) =>
				fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/responses"}`, {
					method: "POST",
					headers: { Authorization: "Bearer opaque-refresh-client-token", "Content-Type": "application/json" },
					body: JSON.stringify(
						native
							? {
									modelId: model.id,
									context: { messages: [{ role: "user", content: "owned fixture", timestamp: 0 }] },
									stream: false,
									options: { sessionId: "owned-session", previousResponseId: previous },
								}
							: {
									model: model.id,
									input: "owned fixture",
									stream: false,
									prompt_cache_key: "owned-session",
									previous_response_id: previous,
								},
					),
				});
			try {
				const first = await post();
				expect(first.status).toBe(200);
				await first.text();
				continuation = true;
				const second = await post("resp_owned_seed");
				expect(second.status).toBe(outcome === "recovered" ? 200 : 401);
				await second.text();
				expect(refreshed).toEqual([owner.id]);
				const expected = [
					{ bearer: "Bearer owner-old", previous: undefined },
					{ bearer: "Bearer owner-old", previous: "resp_owned_seed" },
				];
				if (outcome !== "different-account")
					expected.push({ bearer: "Bearer owner-new", previous: "resp_owned_seed" });
				expect(requests).toEqual(expected);
				if (outcome === "recovered") {
					const sibling = storage.credentials
						.list(provider)
						.find(row => row.credential.type === "oauth" && row.credential.accountId === "sibling")!;
					storage.sessions.pin(provider, "owned-session", sibling.id);
					const rejected = await post("resp_owned_seed");
					expect(rejected.status).toBe(400);
					await rejected.text();
					expect(requests).toHaveLength(3);
				}
			} finally {
				await gateway.close();
				storage.close();
				await fs.rm(directory, { recursive: true, force: true });
			}
		});
	}
}

it("rejects pi-native Codex continuation IDs before any upstream request", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-codex-continuation-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"));
	const model = buildModel({
		id: "codex-fixture",
		name: "codex-fixture",
		provider: "unit-codex",
		api: "openai-codex-responses",
		baseUrl: "https://codex.example",
		reasoning: false,
		input: ["text"],
		contextWindow: 10000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	storage.keys.setRuntime(model.provider, "fixture-key");
	let requests = 0;
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["client"],
		storage,
		resolveModel: () => model,
		fetch: async () => {
			requests++;
			return completedResponse("unexpected");
		},
	});
	try {
		const response = await fetch(`${gateway.url}/v1/pi/stream`, {
			method: "POST",
			headers: { Authorization: "Bearer client", "Content-Type": "application/json" },
			body: JSON.stringify({
				modelId: model.id,
				context: { messages: [{ role: "user", content: "next", timestamp: 0 }] },
				options: { previousResponseId: "resp_seed" },
				stream: false,
			}),
		});
		expect(response.status).toBe(400);
		expect(requests).toBe(0);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

for (const native of [false, true]) {
	it(`keeps ${native ? "pi-native" : "Responses"} returned IDs on their owning stored credential and rejects replacement accounts`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-response-owner-"));
		const storage = await AuthStorage.create(path.join(directory, "auth.db"));
		const provider = "unit-response-owner";
		await storage.credentials.set(provider, [
			{ type: "api_key", key: "first-account" },
			{ type: "api_key", key: "second-account" },
		]);
		const model = buildModel({
			id: "owner-model",
			name: "owner-model",
			provider,
			api: "openai-responses",
			baseUrl: "https://owner.example/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 10000,
			maxTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const requests: Array<{ authorization: string | null; payload: Record<string, unknown> }> = [];
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["client"],
			storage,
			resolveModel: id => (id === model.id ? model : undefined),
			fetch: async (_input, init) => {
				requests.push({
					authorization: new Headers(init?.headers).get("authorization"),
					payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
				});
				return completedResponse(`resp_owned_${requests.length}`);
			},
		});
		const post = (text: string, previous?: string) =>
			fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/responses"}`, {
				method: "POST",
				headers: { Authorization: "Bearer client", "Content-Type": "application/json" },
				body: JSON.stringify(
					native
						? {
								modelId: model.id,
								context: { messages: [{ role: "user", content: text, timestamp: 0 }] },
								stream: false,
								options: { store: true, previousResponseId: previous },
							}
						: { model: model.id, input: text, stream: false, store: true, previous_response_id: previous },
				),
			});
		try {
			const first = await post("conversation seed");
			expect(first.status).toBe(200);
			const firstBody = (await first.json()) as { id?: string; message?: { responseId?: string } };
			const responseId = native ? firstBody.message?.responseId : firstBody.id;
			expect(responseId).toBe("resp_owned_1");
			const next = await post("different continuation input", responseId);
			expect(next.status).toBe(200);
			expect(requests).toHaveLength(2);
			expect(requests[1]?.authorization).toBe(requests[0]?.authorization);
			expect(requests[1]?.payload.previous_response_id).toBe(responseId);
			storage.keys.setRuntime(provider, "replacement-account");
			const rejected = await post("cannot cross accounts", responseId);
			expect(rejected.status).toBe(400);
			expect(requests).toHaveLength(2);
		} finally {
			await gateway.close();
			storage.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
}

for (const native of [false, true]) {
	for (const override of ["runtime", "config"] as const) {
		it(`forwards ${native ? "pi-native" : "Responses"} continuations with a pinned ${override} key despite stale stored rows`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-continuation-wire-"));
			const storage = await AuthStorage.create(path.join(directory, "auth.db"));
			const provider = "unit-continuation-wire";
			await storage.credentials.set(provider, [
				{ type: "api_key", key: "stale-first" },
				{ type: "api_key", key: "stale-second" },
			]);
			if (override === "runtime") storage.keys.setRuntime(provider, "pinned-key");
			else storage.keys.setConfig(provider, "pinned-key");
			const model = buildModel({
				id: "wire-model",
				name: "wire-model",
				provider,
				api: "openai-responses",
				baseUrl: "https://fixture.example/v1",
				reasoning: false,
				input: ["text"],
				contextWindow: 10000,
				maxTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
			const requests: Array<{ authorization: string | null; payload: Record<string, unknown> }> = [];
			const gateway = startAuthGateway({
				bind: "127.0.0.1:0",
				bearerTokens: ["client"],
				storage,
				resolveModel: id => (id === model.id ? model : undefined),
				fetch: async (_input, init) => {
					requests.push({
						authorization: new Headers(init?.headers).get("authorization"),
						payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
					});
					return completedResponse("resp_followup");
				},
			});
			try {
				const body = native
					? {
							modelId: model.id,
							context: { messages: [{ role: "user", content: "next", timestamp: 0 }] },
							stream: false,
							options: {
								previousResponseId: "resp_seed",
								store: true,
								parallelToolCalls: false,
								user: "fixture-user",
								responseFormat: { type: "json_object" },
							},
						}
					: {
							model: model.id,
							input: "next",
							previous_response_id: "resp_seed",
							store: true,
							stream: false,
							parallel_tool_calls: false,
							user: "fixture-user",
							text: { format: { type: "json_object" } },
						};
				const response = await fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/responses"}`, {
					method: "POST",
					headers: { Authorization: "Bearer client", "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				expect(response.status).toBe(200);
				expect(requests).toHaveLength(1);
				expect(requests[0]).toMatchObject({
					authorization: "Bearer pinned-key",
					payload: {
						previous_response_id: "resp_seed",
						store: true,
						parallel_tool_calls: false,
						user: "fixture-user",
						text: { format: { type: "json_object" } },
					},
				});
				expect(await response.text()).toContain("resp_followup");
			} finally {
				await gateway.close();
				storage.close();
				await fs.rm(directory, { recursive: true, force: true });
			}
		});
	}
}
