import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { RouteRegistry, startAuthGateway } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { completedResponse } from "./fixtures/responses-completed";

afterEach(() => vi.restoreAllMocks());

for (const native of [false, true])
	for (const stream of [false, true])
		it(`continues on the actual fallback owner through ${native ? "pi-native" : "Responses"} (${stream ? "stream" : "complete"})`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-fallback-owner-"));
			const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
				usageProviderResolver: () => undefined,
				rankingStrategyResolver: () => undefined,
			});
			const models = ["primary", "backup"].map(id =>
				buildModel({
					id,
					provider: `fixture-${id}`,
					name: id,
					api: "openai-responses",
					baseUrl: `https://${id}.example/v1`,
					reasoning: false,
					input: ["text"],
					contextWindow: 8192,
					maxTokens: 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}),
			);
			for (const id of ["primary", "backup"])
				await storage.credentials.set(`fixture-${id}`, { type: "api_key", key: `fixture-${id}-key` });
			const registry = new RouteRegistry(id => models.find(model => model.id === id));
			registry.register({
				id: "owned-route",
				root: {
					type: "fallback",
					on: ["context_overflow"],
					children: [
						{ type: "target", model: "primary" },
						{ type: "target", model: "backup" },
					],
				},
			});
			const requests: Array<{ model: unknown; previous: unknown; bearer: string | null }> = [];
			const gateway = startAuthGateway({
				bind: "127.0.0.1:0",
				bearerTokens: ["fallback-owner-fixture-client"],
				storage,
				resolveModel: () => undefined,
				routeRegistry: registry,
				fetch: async (_url, init) => {
					const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
					requests.push({
						model: body.model,
						previous: body.previous_response_id,
						bearer: new Headers(init?.headers).get("authorization"),
					});
					if (body.model === "primary")
						return new Response(
							[
								{ type: "response.created", response: { id: "resp_discarded" } },
								{
									type: "response.failed",
									response: {
										id: "resp_discarded",
										status: "failed",
										error: { message: "HTTP 400: maximum context length exceeded" },
									},
								},
							]
								.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
								.join(""),
							{ headers: { "Content-Type": "text/event-stream" } },
						);
					return completedResponse(`resp_surviving_${requests.length}`);
				},
			});
			const post = (previous?: string) =>
				fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/responses"}`, {
					method: "POST",
					headers: { Authorization: "Bearer fallback-owner-fixture-client", "Content-Type": "application/json" },
					body: JSON.stringify(
						native
							? {
									modelId: "owned-route",
									context: { messages: [{ role: "user", content: "fixture turn", timestamp: 0 }] },
									options: { store: true, previousResponseId: previous },
									stream,
								}
							: {
									model: "owned-route",
									input: "fixture turn",
									store: true,
									previous_response_id: previous,
									stream,
								},
					),
				});
			try {
				const first = await post();
				expect(first.status).toBe(200);
				expect(first.headers.get("x-litellm-model-id")).toBe("backup");
				const body = await first.text();
				expect(body).toContain("resp_surviving_2");
				expect(body).not.toContain("resp_discarded");
				const continued = await post("resp_surviving_2");
				expect(continued.status).toBe(200);
				await continued.text();
				expect(requests).toEqual([
					{ model: "primary", previous: undefined, bearer: "Bearer fixture-primary-key" },
					{ model: "backup", previous: undefined, bearer: "Bearer fixture-backup-key" },
					{ model: "backup", previous: "resp_surviving_2", bearer: "Bearer fixture-backup-key" },
				]);
			} finally {
				await gateway.close();
				storage.close();
				await fs.rm(directory, { recursive: true });
			}
		});

for (const native of [false, true])
	for (const reference of ["tool-output", "user-image", "user-file"] as const)
		it(`rejects a file-incompatible fallback before credential lookup for ${reference} through ${native ? "pi-native" : "Responses"}`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-fallback-files-"));
			const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
				usageProviderResolver: () => undefined,
				rankingStrategyResolver: () => undefined,
			});
			const models = ["primary", "backup"].map(id =>
				buildModel({
					id,
					provider: `fixture-${id}`,
					name: id,
					api: id === "primary" ? "openai-responses" : "openai-completions",
					baseUrl: `https://${id}.example/v1`,
					reasoning: false,
					input: ["text", "image"],
					contextWindow: 8192,
					maxTokens: 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}),
			);
			for (const id of ["primary", "backup"])
				await storage.credentials.set(`fixture-${id}`, { type: "api_key", key: `fixture-${id}-key` });
			const registry = new RouteRegistry(id => models.find(model => model.id === id));
			registry.register({
				id: "file-route",
				root: {
					type: "fallback",
					on: ["context_overflow"],
					children: [
						{ type: "target", model: "primary" },
						{ type: "target", model: "backup" },
					],
				},
			});
			const dispatched: unknown[] = [];
			const lookedUpProviders: string[] = [];
			const getWithCredential = storage.keys.getWithCredential.bind(storage.keys);
			vi.spyOn(storage.keys, "getWithCredential").mockImplementation((...args) => {
				lookedUpProviders.push(args[0]);
				return getWithCredential(...args);
			});
			const gateway = startAuthGateway({
				bind: "127.0.0.1:0",
				bearerTokens: ["file-fallback-fixture-client"],
				storage,
				resolveModel: () => undefined,
				routeRegistry: registry,
				fetch: async (_url, init) => {
					const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
					dispatched.push(body.model);
					return new Response(
						`data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: "HTTP 400: maximum context length exceeded" } } })}\n\n`,
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				},
			});
			try {
				const response = await fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/responses"}`, {
					method: "POST",
					headers: { Authorization: "Bearer file-fallback-fixture-client", "Content-Type": "application/json" },
					body: JSON.stringify(
						native
							? {
									modelId: "file-route",
									stream: false,
									context:
										reference === "tool-output"
											? {
													messages: [
														{
															role: "toolResult",
															toolCallId: "file_call",
															toolName: "read",
															content: [
																{
																	type: "image",
																	data: "",
																	mimeType: "image/png",
																	providerFile: { provider: "openai", id: "file_fixture" },
																},
															],
															isError: false,
															timestamp: 0,
														},
													],
												}
											: {
													messages: [
														{
															role: "user",
															content: [{ type: "text", text: "file fixture" }],
															timestamp: 0,
															providerPayload: {
																type: "openaiResponsesHistory",
																provider: "fixture-primary",
																dt: true,
																items: [
																	{
																		type: "message",
																		role: "user",
																		content: [
																			{
																				type:
																					reference === "user-file" ? "input_file" : "input_image",
																				file_id: "file_fixture",
																			},
																		],
																	},
																],
															},
														},
													],
												},
								}
							: {
									model: "file-route",
									stream: false,
									input:
										reference === "tool-output"
											? [
													{
														type: "function_call_output",
														call_id: "file_call",
														output: [{ type: "input_image", file_id: "file_fixture" }],
													},
												]
											: [
													{
														role: "user",
														content: [
															{
																type: reference === "user-file" ? "input_file" : "input_image",
																file_id: "file_fixture",
															},
														],
													},
												],
								},
					),
				});
				expect(response.status).toBe(400);
				expect(await response.text()).toContain("Responses-compatible upstream");
				expect(dispatched).toEqual(["primary"]);
				expect(lookedUpProviders).not.toContain("fixture-backup");
				for (const row of storage.credentials.list("fixture-backup"))
					expect(
						storage.coordination.activeTurnReservation(
							row.id,
							storage.coordination.getCredentialIncarnation(row.id),
						),
					).toBeUndefined();
			} finally {
				await gateway.close();
				storage.close();
				await fs.rm(directory, { recursive: true });
			}
		});
