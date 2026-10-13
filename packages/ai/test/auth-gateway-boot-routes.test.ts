import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "../src/api-registry";
import { createAuthGatewayRouter, RouteRegistry, serveAuthGatewayStdio, startAuthGateway } from "../src/auth-gateway";
import type { AuthGatewayRouteOptions, RouteDefinition } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel, registerMockApi } from "../src/providers/mock";

afterEach(() => clearCustomApis());

type Transport = "http" | "router" | "stdio";
async function withBootFixture(
	transport: Transport,
	suppliedRegistry: boolean,
	definitions: readonly RouteDefinition[] | undefined,
	native: boolean,
	stream: boolean,
	run: (
		response: Response,
		primaryCalls: number,
		backupCalls: number,
		registry: RouteRegistry | undefined,
	) => Promise<void>,
): Promise<void> {
	registerMockApi();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-boot-routes-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
	});
	storage.keys.setRuntime("fixture-boot", "boot-fixture-key");
	const primary = createMockModel({
		provider: "fixture-boot",
		id: "primary",
		handler: { content: [], stopReason: "error", errorMessage: "HTTP 503: service unavailable" },
	});
	const backup = createMockModel({
		provider: "fixture-boot",
		id: "backup",
		handler: { content: ["booted fallback result"] },
	});
	const resolveModel = (id: string) => (id === "primary" ? primary : id === "backup" ? backup : undefined);
	const registry = suppliedRegistry ? new RouteRegistry(resolveModel) : undefined;
	registry?.register({ id: "existing", root: { type: "target", model: "backup" } });
	const opts: AuthGatewayRouteOptions = { storage, resolveModel, routeRegistry: registry, routes: definitions };
	const http =
		transport === "http"
			? startAuthGateway({ ...opts, bind: "127.0.0.1:0", bearerTokens: ["boot-fixture-client"] })
			: undefined;
	const router = transport !== "http" ? createAuthGatewayRouter(opts) : undefined;
	const endpoint = native ? "/v1/pi/stream" : "/v1/chat/completions";
	const body = native
		? { modelId: "booted", context: { messages: [{ role: "user", content: "boot fixture", timestamp: 0 }] }, stream }
		: { model: "booted", messages: [{ role: "user", content: "boot fixture" }], stream };
	try {
		let response: Response;
		if (http)
			response = await fetch(`${http.url}${endpoint}`, {
				method: "POST",
				headers: { Authorization: "Bearer boot-fixture-client", "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		else if (router && transport === "router")
			response = await router.route(
				new Request(`http://127.0.0.1${endpoint}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
				"fixture",
			);
		else if (router) {
			const frames: Array<{ ready?: boolean; id?: number; status?: number; body?: unknown }> = [];
			await serveAuthGatewayStdio({
				input: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: 42, path: endpoint, body })}\n`));
						controller.close();
					},
				}),
				write: line => frames.push(JSON.parse(line)),
				route: req => router.route(req, "fixture-stdio"),
			});
			expect(frames[0]?.ready).toBe(true);
			const frame = frames.find(item => item.id === 42);
			if (frame?.status === undefined) throw new Error("No stdio response to the fixture request");
			response = new Response(typeof frame.body === "string" ? frame.body : JSON.stringify(frame.body), {
				status: frame.status,
			});
		} else throw new Error("Missing fixture transport");
		// Stream calls are counted during preflight, before response handoff.
		await run(response, primary.calls.length, backup.calls.length, registry);
	} finally {
		if (http) await http.close();
		router?.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
}

const definitions: readonly RouteDefinition[] = [
	{
		id: "booted",
		root: {
			type: "fallback",
			on: ["provider_unavailable"],
			children: [
				{ type: "target", model: "primary" },
				{ type: "target", model: "backup" },
			],
		},
	},
];

for (const transport of ["http", "router", "stdio"] as const)
	for (const suppliedRegistry of [false, true])
		for (const native of [false, true])
			for (const stream of [false, true])
				it(`boots routes through ${transport}, ${suppliedRegistry ? "supplied" : "fresh"} registry, ${native ? "pi-native" : "chat"}, ${stream ? "stream" : "complete"}`, async () => {
					await withBootFixture(
						transport,
						suppliedRegistry,
						definitions,
						native,
						stream,
						async (response, primaryCalls, backupCalls, registry) => {
							expect(response.status).toBe(200);
							expect(await response.text()).toContain("booted fallback result");
							expect(primaryCalls).toBe(1);
							expect(backupCalls).toBe(1);
							if (registry) {
								expect(registry.resolve("booted")?.targets).toEqual([
									"fixture-boot/primary",
									"fixture-boot/backup",
								]);
								expect(registry.resolve("existing")?.targets).toEqual(["fixture-boot/backup"]);
							}
						},
					);
				});

for (const empty of [undefined, []] as const)
	for (const suppliedRegistry of [false, true])
		it(`leaves boot routes absent for ${empty ? "an empty list" : "omitted definitions"} and ${suppliedRegistry ? "supplied" : "fresh"} registry`, async () => {
			await withBootFixture(
				"http",
				suppliedRegistry,
				empty,
				false,
				false,
				async (response, primaryCalls, backupCalls, registry) => {
					expect(response.status).toBe(404);
					expect(await response.text()).toContain("Unknown model: booted");
					expect(primaryCalls).toBe(0);
					expect(backupCalls).toBe(0);
					if (registry) {
						expect(registry.generation).toBe(2);
						expect(registry.resolve("existing")?.targets).toEqual(["fixture-boot/backup"]);
					}
				},
			);
		});
