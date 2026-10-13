import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "../src/api-registry";
import { startAuthGateway } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel, registerMockApi } from "../src/providers/mock";

afterEach(() => clearCustomApis());

for (const type of ["oauth", "api_key"] as const)
	for (const native of [false, true])
		for (const stream of [false, true])
			for (const probe of [false, true])
				it(`${probe ? "keeps recovery exclusive" : "shares a healthy credential"} for ${type}, ${native ? "native" : "chat"}, ${stream ? "stream" : "complete"}`, async () => {
					registerMockApi();
					const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-healthy-concurrency-"));
					const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
						usageProviderResolver: () => undefined,
						rankingStrategyResolver: () => undefined,
					});
					const provider = "unit-profile-sharing";
					await storage.credentials.set(
						provider,
						type === "api_key"
							? { type, key: "sharing-fixture-key" }
							: {
									type,
									access: "sharing-fixture-key",
									refresh: "sharing-fixture-refresh",
									accountId: "fixture-account",
									expires: Date.now() + 3_600_000,
								},
					);
					const row = storage.credentials.list(provider)[0]!;
					if (probe)
						storage.blocks.upsert({
							credentialId: row.id,
							providerKey: `${provider}:${type}`,
							blockScope: "",
							blockedUntilMs: Date.now() + 60_000,
							quotaOrigin: true,
						});
					const entered = Promise.withResolvers<void>();
					const release = Promise.withResolvers<void>();
					let calls = 0;
					const model = createMockModel({
						provider,
						id: "shared-profile",
						handler: async (_context, options) => {
							expect(options?.apiKey).toBe("sharing-fixture-key");
							calls++;
							if (calls === 1) {
								entered.resolve();
								await release.promise;
								return { content: ["first completed"] };
							}
							return { content: ["second completed concurrently"] };
						},
					});
					const gateway = startAuthGateway({
						bind: "127.0.0.1:0",
						bearerTokens: ["sharing-fixture-client"],
						storage,
						resolveModel: id => (id === model.id ? model : undefined),
					});
					const post = (input: string) =>
						fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
							method: "POST",
							headers: { Authorization: "Bearer sharing-fixture-client", "Content-Type": "application/json" },
							body: JSON.stringify(
								native
									? {
											modelId: model.id,
											context: { messages: [{ role: "user", content: input, timestamp: 0 }] },
											stream,
										}
									: { model: model.id, messages: [{ role: "user", content: input }], stream },
							),
							signal: AbortSignal.timeout(8000),
						});
					const first = post("first turn");
					try {
						await entered.promise;
						const second = await post("second turn");
						expect(second.status).toBe(probe ? 503 : 200);
						const body = await second.text();
						if (probe) {
							expect(body).toContain("No credential available");
							expect(calls).toBe(1);
							expect(storage.blocks.list([row.id])).toHaveLength(1);
						} else {
							expect(body).toContain("second completed concurrently");
							expect(calls).toBe(2);
						}
					} finally {
						release.resolve();
						try {
							const response = await first;
							expect(response.status).toBe(200);
							expect(await response.text()).toContain("first completed");
						} finally {
							await gateway.close();
							storage.close();
							await fs.rm(directory, { recursive: true });
						}
					}
				}, 10_000);
