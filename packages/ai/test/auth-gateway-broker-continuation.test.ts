import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "../src/auth-broker";
import { startAuthGateway } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { completedResponse } from "./fixtures/responses-completed";

for (const native of [false, true])
	for (const cold of [false, true]) {
		for (const type of ["oauth", "api_key"] as const) {
			it(`resumes ${native ? "pi-native" : "Responses"} on the owning ${type} account after a broker-client gateway restart (${cold ? "discarded" : "persisted"} affinity)`, async () => {
				const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-broker-owner-"));
				const brokerStorage = await AuthStorage.create(path.join(directory, "broker-auth.db"), {
					usageProviderResolver: () => undefined,
					rankingStrategyResolver: () => undefined,
				});
				const provider = "unit-broker-response-owner";
				await brokerStorage.credentials.set(
					provider,
					type === "api_key"
						? [
								{ type: "api_key", key: "owner-live-bearer" },
								{ type: "api_key", key: "sibling-live-bearer" },
							]
						: [
								{
									type: "oauth",
									access: "owner-live-bearer",
									refresh: "owner-live-refresh",
									expires: Date.now() + 3_600_000,
									accountId: "owner",
								},
								{
									type: "oauth",
									access: "sibling-live-bearer",
									refresh: "sibling-live-refresh",
									expires: Date.now() + 3_600_000,
									accountId: "sibling",
								},
							],
				);
				const broker = startAuthBroker({
					storage: brokerStorage,
					bind: "127.0.0.1:0",
					bearerTokens: ["opaque-owned-broker-token"],
					disableRefresher: true,
				});
				const client = new AuthBrokerClient({ url: broker.url, token: "opaque-owned-broker-token" });
				const metadataPath = path.join(directory, "private", "gateway-state.db");
				const open = async (reverse = false) => {
					const initial = await client.fetchSnapshot();
					if (initial.status !== 200) throw new Error("Expected an owned broker snapshot");
					const remote = new RemoteAuthCredentialStore({
						client,
						initialSnapshot: reverse
							? { ...initial.snapshot, credentials: [...initial.snapshot.credentials].reverse() }
							: initial.snapshot,
						metadataCachePath: metadataPath,
					});
					const storage = new AuthStorage(remote, {
						usageProviderResolver: () => undefined,
						rankingStrategyResolver: () => undefined,
					});
					await storage.credentials.reload();
					return { remote, storage };
				};
				let current = await open();
				const owner = current.storage.credentials.list(provider)[Bun.hash.xxHash32("broker-owned-session") % 2]!;
				const ownerBearer = `Bearer ${owner.credential.type === "oauth" ? owner.credential.access : owner.credential.key}`;
				if (type === "oauth") current.storage.sessions.pin(provider, "broker-owned-session", owner.id);
				const model = buildModel({
					id: "broker-owner",
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
				const requests: Array<{ bearer: string | null; previous: unknown }> = [];
				const start = () =>
					startAuthGateway({
						storage: current.storage,
						bind: "127.0.0.1:0",
						bearerTokens: ["opaque-broker-gateway-client-token"],
						resolveModel: () => model,
						fetch: async (_url, init) => {
							const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
							requests.push({
								bearer: new Headers(init?.headers).get("authorization"),
								previous: payload.previous_response_id,
							});
							return completedResponse(`resp_broker_owner_${requests.length}`);
						},
					});
				let gateway = start();
				const post = (previous?: string) =>
					fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/responses"}`, {
						method: "POST",
						headers: {
							Authorization: "Bearer opaque-broker-gateway-client-token",
							"Content-Type": "application/json",
						},
						body: JSON.stringify(
							native
								? {
										modelId: model.id,
										context: {
											messages: [
												{ role: "user", content: previous ? "new input" : "seed input", timestamp: 0 },
											],
										},
										stream: false,
										options: {
											store: true,
											sessionId: previous ? undefined : "broker-owned-session",
											previousResponseId: previous,
										},
									}
								: {
										model: model.id,
										input: previous ? "new input" : "seed input",
										stream: false,
										store: true,
										prompt_cache_key: previous ? undefined : "broker-owned-session",
										previous_response_id: previous,
									},
						),
					});
				try {
					const first = await post();
					expect(first.status).toBe(200);
					await first.text();
					if (cold) current.storage.sessions.release(provider, "broker-owned-session");
					current.remote.setCache(
						"unrelated-cache",
						"raw-secret-not-for-disk",
						Math.floor(Date.now() / 1000) + 60,
					);
					await gateway.close();
					current.storage.close();
					current = await open(true);
					gateway = start();
					const continued = await post("resp_broker_owner_1");
					expect(continued.status).toBe(200);
					await continued.text();
					expect(requests).toEqual([
						{ bearer: ownerBearer, previous: undefined },
						{ bearer: ownerBearer, previous: "resp_broker_owner_1" },
					]);
					expect(current.remote.getCache("unrelated-cache")).toBeNull();
					const database = new Database(metadataPath, { readonly: true });
					try {
						const tables = database
							.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
							.all();
						expect(tables).toEqual([{ name: "private_metadata" }]);
						const rows = database
							.query<{ key: string; value: string }, []>("SELECT key, value FROM private_metadata")
							.all();
						expect(rows.length).toBeGreaterThan(0);
						for (const secret of [
							"owner-live-bearer",
							"owner-live-refresh",
							"sibling-live-bearer",
							"raw-secret-not-for-disk",
						])
							expect(JSON.stringify(rows)).not.toContain(secret);
					} finally {
						database.close();
					}
				} finally {
					await gateway.close();
					current.storage.close();
					await broker.close();
					brokerStorage.close();
					await fs.rm(directory, { recursive: true, force: true });
				}
			});
		}
	}
