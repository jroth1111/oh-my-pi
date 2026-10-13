import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "../src/api-registry";
import { PromptCacheAffinityStore, RouteRegistry, startAuthGateway } from "../src/auth-gateway";
import type { AuthGatewayServerHandle } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel, registerMockApi } from "../src/providers/mock";

afterEach(clearCustomApis);
const formats = ["/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/pi/stream"] as const;
const cacheKey = "private-fixture-conversation-key";
const headers = {
	Authorization: "Bearer cache-fixture-client",
	"Content-Type": "application/json",
	"x-prompt-cache-key": cacheKey,
};

async function withCache(
	run: (
		gateway: AuthGatewayServerHandle,
		storage: AuthStorage,
		registry: RouteRegistry,
		cache: PromptCacheAffinityStore,
		calls: string[],
		recover: () => void,
		partial: () => void,
	) => Promise<void>,
	stored = false,
): Promise<void> {
	registerMockApi();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-cache-preference-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
		usageProviderResolver: () => undefined,
	});
	storage.keys.setRuntime("cache-first", "first-fixture-key");
	if (stored) await storage.credentials.set("cache-backup", { type: "api_key", key: "backup-fixture-key" });
	else storage.keys.setRuntime("cache-backup", "backup-fixture-key");
	let failure = true;
	let partialFailure = false;
	const calls: string[] = [];
	const first = createMockModel({
		provider: "cache-first",
		id: "a",
		handler: () => {
			calls.push("a");
			return failure
				? {
						content: partialFailure ? ["partial-failed"] : [],
						stopReason: "error",
						errorMessage: "HTTP 503: service unavailable",
					}
				: { content: ["served-a"] };
		},
	});
	const second = createMockModel({
		provider: "cache-backup",
		id: "b",
		handler: () => {
			calls.push("b");
			return { content: ["served-b"] };
		},
	});
	const registry = new RouteRegistry(id => (id === "a" ? first : id === "b" ? second : undefined));
	const cache = new PromptCacheAffinityStore();
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		storage,
		bearerTokens: ["cache-fixture-client"],
		resolveModel: () => undefined,
		routeRegistry: registry,
		promptCacheAffinity: cache,
		routes: [
			{
				id: "work",
				root: {
					type: "fallback",
					on: ["provider_unavailable"],
					children: [
						{ type: "target", model: "a" },
						{ type: "target", model: "b" },
					],
				},
			},
		],
	});
	try {
		await run(
			gateway,
			storage,
			registry,
			cache,
			calls,
			() => {
				failure = false;
			},
			() => {
				partialFailure = true;
			},
		);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
}

function send(
	gateway: AuthGatewayServerHandle,
	format: string,
	stream: boolean,
	headerKey: string = cacheKey,
	message = "fixture",
	nativeOptions?: Record<string, unknown>,
): Promise<Response> {
	return fetch(`${gateway.url}${format}`, {
		method: "POST",
		headers: headerKey
			? { ...headers, "x-prompt-cache-key": headerKey }
			: { Authorization: headers.Authorization, "Content-Type": "application/json" },
		body: JSON.stringify(
			format === "/v1/pi/stream"
				? {
						modelId: "work",
						context: { messages: [{ role: "user", content: message, timestamp: 0 }] },
						stream,
						...(nativeOptions ? { options: nativeOptions } : {}),
					}
				: format === "/v1/responses"
					? { model: "work", input: "fixture", stream }
					: { model: "work", messages: [{ role: "user", content: "fixture" }], max_tokens: 100, stream },
		),
	});
}

for (const format of formats)
	for (const stream of [false, true])
		it(`remembers a completed fallback and prefers it on the next ${format} ${stream ? "SSE" : "JSON"} turn`, async () => {
			await withCache(async (gateway, _storage, _registry, cache, calls, recover) => {
				const first = await send(gateway, format, stream);
				expect(first.status).toBe(200);
				expect(await first.text()).toContain("served-b");
				recover();
				const second = await send(gateway, format, stream);
				expect(second.status).toBe(200);
				expect(await second.text()).toContain("served-b");
				expect(calls).toEqual(["a", "b", "b"]);
				expect(cache.lookup(cacheKey)).toBeUndefined();
				const fingerprint = Bun.SHA256.hash(JSON.stringify(["work", cacheKey]), "hex");
				expect(cache.lookup(fingerprint)).toMatchObject({ provider: "cache-backup", model: "cache-backup/b" });
			});
		});

it("does not remember a committed partial failure as a successful target", async () => {
	await withCache(async (gateway, _storage, registry, _cache, calls, _recover, partial) => {
		registry.register({
			id: "work",
			affinity: "preferred",
			root: {
				type: "balance",
				strategy: "rr",
				children: [
					{ type: "target", model: "a" },
					{ type: "target", model: "b" },
				],
			},
		});
		partial();
		const failed = await send(gateway, "/v1/chat/completions", true);
		expect(await failed.text()).toContain("partial-failed");
		const next = await send(gateway, "/v1/chat/completions", false);
		expect(await next.text()).toContain("served-b");
		expect(calls).toEqual(["a", "b"]);
	});
});

it("invalidates a cached credential when the stored row is replaced rather than pinning the replacement", async () => {
	await withCache(async (gateway, storage, _registry, _cache, calls, recover) => {
		const first = await send(gateway, "/v1/chat/completions", false);
		expect(await first.text()).toContain("served-b");
		await storage.credentials.set("cache-backup", { type: "api_key", key: "replacement-fixture-key" });
		recover();
		const next = await send(gateway, "/v1/chat/completions", false);
		expect(await next.text()).toContain("served-a");
		expect(calls).toEqual(["a", "b", "a"]);
	}, true);
});

it("the TTL expires cache preference and returns to normal route selection", async () => {
	await withCache(async (gateway, _storage, _registry, cache, calls, recover) => {
		const first = await send(gateway, "/v1/chat/completions", false);
		await first.text();
		const fingerprint = Bun.SHA256.hash(JSON.stringify(["work", cacheKey]), "hex");
		const hit = cache.lookup(fingerprint);
		if (!hit) throw new Error("Missing serving affinity");
		cache.remember(fingerprint, hit, Date.now() - 31 * 60_000);
		recover();
		const next = await send(gateway, "/v1/chat/completions", false);
		expect(await next.text()).toContain("served-a");
		expect(calls).toEqual(["a", "b", "a"]);
	});
});

it("a changed route generation invalidates the old serving hint even when its target still exists", async () => {
	await withCache(async (gateway, _storage, registry, _cache, calls, recover) => {
		const first = await send(gateway, "/v1/chat/completions", false);
		await first.text();
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
		recover();
		const next = await send(gateway, "/v1/chat/completions", false);
		expect(await next.text()).toContain("served-a");
		expect(calls).toEqual(["a", "b", "a"]);
	});
});

it("explicit preferred affinity can override a balanced route's normal cursor", async () => {
	await withCache(async (gateway, _storage, registry, _cache, calls, recover) => {
		registry.register({
			id: "work",
			affinity: "preferred",
			root: {
				type: "balance",
				strategy: "rr",
				children: [
					{ type: "target", model: "a" },
					{ type: "target", model: "b" },
				],
			},
		});
		const first = await send(gateway, "/v1/chat/completions", false);
		await first.text();
		recover();
		for (let i = 0; i < 2; i++) {
			const response = await send(gateway, "/v1/chat/completions", false);
			expect(await response.text()).toContain("served-b");
		}
		expect(calls).toEqual(["a", "b", "b", "b"]);
	});
});

for (const identity of ["promptCacheKey", "sessionId"] as const)
	it(`pi-native nested ${identity} is the lookup fingerprint even when the first-message delta changes`, async () => {
		await withCache(async (gateway, _storage, _registry, _cache, calls, recover) => {
			const first = await send(gateway, "/v1/pi/stream", false, "", "first prefix", {
				[identity]: "nested-private-cache-key",
			});
			expect(await first.text()).toContain("served-b");
			recover();
			const next = await send(gateway, "/v1/pi/stream", false, "", "different delta", {
				[identity]: "nested-private-cache-key",
			});
			expect(await next.text()).toContain("served-b");
			expect(calls).toEqual(["a", "b", "b"]);
		});
	});

it("pi-native promptCacheKey takes precedence over changing session and header identities", async () => {
	await withCache(async (gateway, _storage, _registry, cache, calls, recover) => {
		const first = await send(gateway, "/v1/pi/stream", false, "first-header", "first prefix", {
			promptCacheKey: "stable-nested-key",
			sessionId: "first-session",
		});
		expect(await first.text()).toContain("served-b");
		recover();
		const next = await send(gateway, "/v1/pi/stream", false, "different-header", "different delta", {
			promptCacheKey: "stable-nested-key",
			sessionId: "different-session",
		});
		expect(await next.text()).toContain("served-b");
		expect(calls).toEqual(["a", "b", "b"]);
		const fingerprint = Bun.SHA256.hash(JSON.stringify(["work", "stable-nested-key"]), "hex");
		expect(cache.lookup(fingerprint)).toMatchObject({ model: "cache-backup/b" });
	});
});
