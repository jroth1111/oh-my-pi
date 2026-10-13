import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "../src/api-registry";
import { createAuthGatewayRouter, startAuthGateway } from "../src/auth-gateway";
import { GatewayCredentialTurn, withGatewayCredentialTurn } from "../src/auth-gateway/turn-lifecycle";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel, registerMockApi } from "../src/providers/mock";
import type { AssistantMessage } from "../src/types";

afterEach(() => {
	vi.restoreAllMocks();
	clearCustomApis();
});

async function withStorage(run: (storage: AuthStorage) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-turn-lifecycle-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
	});
	try {
		await run(storage);
	} finally {
		storage.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
}

const routes = ["/v1/pi/stream", "/v1/chat/completions", "/v1/messages", "/v1/responses"] as const;
function body(route: string, modelId: string, stream: boolean, input: string): string {
	if (route === "/v1/pi/stream")
		return JSON.stringify({
			modelId,
			context: { messages: [{ role: "user", content: input, timestamp: 0 }] },
			options: { sessionId: "same-session" },
			stream,
		});
	if (route === "/v1/responses")
		return JSON.stringify({ model: modelId, input, prompt_cache_key: "same-session", stream });
	return JSON.stringify({
		model: modelId,
		messages: [{ role: "user", content: input }],
		metadata: { session_id: "same-session" },
		max_tokens: 100,
		stream,
	});
}

for (const route of routes)
	for (const stream of [false, true])
		for (const outcome of ["stop", "error", "aborted"] as const)
			for (const type of ["oauth", "api_key"] as const) {
				it(`settles ${type} probes only on canonical ${outcome} through ${route} (${stream ? "stream" : "complete"}, no raw SSE)`, async () => {
					await withStorage(async storage => {
						registerMockApi();
						const provider = `unit-lifecycle-${type}`;
						await storage.credentials.set(
							provider,
							type === "api_key"
								? { type: "api_key", key: "fixture-bearer" }
								: {
										type: "oauth",
										access: "fixture-bearer",
										refresh: "fixture-refresh",
										expires: Date.now() + 3_600_000,
										accountId: "fixture-account",
									},
						);
						const id = storage.credentials.list(provider)[0]!.id;
						storage.blocks.upsert({
							credentialId: id,
							providerKey: `${provider}:${type}`,
							blockScope: "",
							blockedUntilMs: Date.now() + 60_000,
							quotaOrigin: true,
						});
						const owners: string[] = [];
						let resolvedRequestId: string | undefined;
						const getKey = storage.keys.getWithCredential.bind(storage.keys);
						vi.spyOn(storage.keys, "getWithCredential").mockImplementation(async (...args) => {
							const key = await getKey(...args);
							resolvedRequestId = args[2]?.requestId;
							return key;
						});
						const mock = createMockModel({
							provider,
							id: "canonical-lifecycle",
							handler: (_context, options) => {
								// This transport deliberately emits no raw SSE; validate the real selection and probe before returning canonical events.
								expect(options?.apiKey).toBe("fixture-bearer");
								const hold = storage.coordination.activeTurnReservation(
									id,
									storage.coordination.getCredentialIncarnation(id),
								);
								if (!resolvedRequestId) throw new Error("Inference dispatched without its request identity");
								owners.push(resolvedRequestId);
								const probing = owners.length === 1 || outcome !== "stop";
								expect(storage.coordination.hasInflightProbe(resolvedRequestId)).toBe(probing);
								if (probing) expect(hold?.requestId).toBe(resolvedRequestId);
								else expect(hold).toBeUndefined();
								return owners.length === 1 && outcome !== "stop"
									? {
											content: [],
											stopReason: outcome,
											errorMessage: "HTTP 400: invalid fixture input",
										}
									: { content: [owners.length === 1 ? "first recovered" : "next recovered"] };
							},
						});
						const gateway = startAuthGateway({
							storage,
							bind: "127.0.0.1:0",
							bearerTokens: ["opaque-lifecycle-client-token"],
							resolveModel: () => mock.model,
						});
						const post = (input: string) =>
							fetch(`${gateway.url}${route}`, {
								method: "POST",
								headers: {
									Authorization: "Bearer opaque-lifecycle-client-token",
									"Content-Type": "application/json",
								},
								body: body(route, mock.id, stream, input),
							});
						try {
							const first = await post("first turn");
							expect(first.status).toBe(stream || outcome === "stop" ? 200 : outcome === "aborted" ? 499 : 400);
							await first.text();
							expect(mock.calls).toHaveLength(1);
							expect(storage.blocks.list([id])).toHaveLength(outcome === "stop" ? 0 : 1);
							expect(storage.coordination.hasInflightProbe(owners[0]!)).toBe(false);
							expect(storage.coordination.activeTurnReservation(id, 1)).toBeUndefined();
							const next = await post("next turn");
							expect(next.status).toBe(200);
							expect(await next.text()).toContain("next recovered");
							expect(mock.calls).toHaveLength(2);
							expect(owners[0]).not.toBe(owners[1]);
							expect(storage.blocks.list([id])).toEqual([]);
						} finally {
							await gateway.close();
						}
					});
				});
			}

for (const route of ["/v1/pi/stream", "/v1/responses"] as const) {
	it(`releases ${route} admission on a client abort just after key resolution`, async () => {
		await withStorage(async storage => {
			registerMockApi();
			await storage.credentials.set("unit-post-resolve-abort", { type: "api_key", key: "fixture-bearer" });
			const id = storage.credentials.list("unit-post-resolve-abort")[0]!.id;
			const mock = createMockModel({
				provider: "unit-post-resolve-abort",
				id: "abort-fixture",
				handler: () => {
					throw new Error("Aborted request reached inference");
				},
			});
			const client = new AbortController();
			const original = storage.keys.getWithCredential.bind(storage.keys);
			vi.spyOn(storage.keys, "getWithCredential").mockImplementation(async (...args) => {
				const resolved = await original(...args);
				client.abort(new Error("fixture disconnect"));
				return resolved;
			});
			const router = createAuthGatewayRouter({ storage, resolveModel: () => mock.model });
			try {
				const response = await router.route(
					new Request(`http://127.0.0.1${route}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: body(route, mock.id, false, "abort turn"),
						signal: client.signal,
					}),
					"fixture",
				);
				expect(response.status).toBe(499);
				expect(mock.calls).toHaveLength(0);
				expect(storage.coordination.activeTurnReservation(id, 1)).toBeUndefined();
			} finally {
				router.close();
			}
		});
	});
}

it("renews a silent active turn beyond its initial TTL without needing stream chunks", async () => {
	await withStorage(async storage => {
		await storage.credentials.set("unit-quiet-turn", { type: "api_key", key: "fixture" });
		const id = storage.credentials.list("unit-quiet-turn")[0]!.id;
		let now = Date.now();
		vi.useFakeTimers();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		storage.coordination.tryAcquireTurnReservation({
			credentialId: id,
			incarnation: 1,
			requestId: "quiet",
			ttlMs: 90,
		});
		const turn = new GatewayCredentialTurn(storage, "quiet", new AbortController(), 90);
		try {
			for (let index = 0; index < 4; index++) {
				now += 30;
				vi.advanceTimersByTime(30);
			}
			expect(
				storage.coordination.tryAcquireTurnReservation({ credentialId: id, incarnation: 1, requestId: "other" }).ok,
			).toBe(false);
		} finally {
			turn.release();
			vi.useRealTimers();
			clock.mockRestore();
		}
		expect(
			storage.coordination.tryAcquireTurnReservation({ credentialId: id, incarnation: 1, requestId: "other" }).ok,
		).toBe(true);
	});
});

it("releases a stored turn when the body reader rejects without pretending the probe succeeded", async () => {
	await withStorage(async storage => {
		await storage.credentials.set("unit-reader-failure", { type: "api_key", key: "fixture" });
		const id = storage.credentials.list("unit-reader-failure")[0]!.id;
		storage.blocks.upsert({
			credentialId: id,
			providerKey: "unit-reader-failure:api_key",
			blockScope: "",
			blockedUntilMs: Date.now() + 60_000,
			quotaOrigin: true,
		});
		await storage.keys.get("unit-reader-failure", "reader", { requestId: "reader" });
		const request = new AbortController();
		const turn = new GatewayCredentialTurn(storage, "reader", request);
		const outcomes: boolean[] = [];
		const wrapped = turn.wrap(
			new ReadableStream({
				pull(controller) {
					controller.error(new Error("fixture reader failure"));
				},
			}),
			() => {
				throw new Error("Reader failure must not consult canonical success");
			},
			async ok => {
				outcomes.push(ok);
			},
		);
		await expect(new Response(wrapped).text()).rejects.toThrow("fixture reader failure");
		expect(request.signal.aborted).toBe(true);
		expect(storage.coordination.activeTurnReservation(id, 1)).toBeUndefined();
		expect(storage.coordination.hasInflightProbe("reader")).toBe(false);
		expect(storage.blocks.list([id])).toHaveLength(1);
		expect(outcomes).toEqual([false]);
	});
});

it("cancels upstream before waiting for a canonical result that cannot yet settle", async () => {
	await withStorage(async storage => {
		await storage.credentials.set("unit-cancel-order", { type: "api_key", key: "fixture" });
		const id = storage.credentials.list("unit-cancel-order")[0]!.id;
		await storage.keys.get("unit-cancel-order", "cancel", { requestId: "cancel" });
		const request = new AbortController();
		const turn = new GatewayCredentialTurn(storage, "cancel", request);
		const pending = Promise.withResolvers<AssistantMessage>();
		let canonicalRead = false;
		let upstreamCanceled = false;
		const outcomes: boolean[] = [];
		const wrapped = turn.wrap(
			new ReadableStream<Uint8Array>({
				cancel() {
					upstreamCanceled = request.signal.aborted;
				},
			}),
			() => {
				canonicalRead = true;
				return pending.promise;
			},
			async ok => {
				expect(upstreamCanceled).toBe(true);
				outcomes.push(ok);
			},
		);
		await wrapped.cancel("fixture client disconnect");
		expect(upstreamCanceled).toBe(true);
		expect(canonicalRead).toBe(false);
		expect(outcomes).toEqual([false]);
		expect(storage.coordination.activeTurnReservation(id, 1)).toBeUndefined();
	});
});

for (const wrapped of [false, true]) {
	it(`releases admission if response assembly throws ${wrapped ? "after" : "before"} wrapping a stream`, async () => {
		await withStorage(async storage => {
			await storage.credentials.set("unit-assembly-failure", { type: "api_key", key: "fixture" });
			const id = storage.credentials.list("unit-assembly-failure")[0]!.id;
			const request = new AbortController();
			let canceled = false;
			await expect(
				withGatewayCredentialTurn(storage, "assembly", request, async turn => {
					await storage.keys.get("unit-assembly-failure", "assembly", { requestId: "assembly" });
					if (wrapped)
						turn.wrap(
							new ReadableStream<Uint8Array>({
								cancel() {
									canceled = true;
								},
							}),
							() => undefined,
						);
					throw new Error("fixture response assembly failure");
				}),
			).rejects.toThrow("fixture response assembly failure");
			expect(request.signal.aborted).toBe(true);
			expect(storage.coordination.activeTurnReservation(id, 1)).toBeUndefined();
			if (wrapped) expect(canceled).toBe(true);
		});
	});
}
