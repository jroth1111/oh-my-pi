import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import {
	AuthBrokerClient,
	AUTH_BROKER_CAPABILITIES_HEADER,
	AUTH_BROKER_CAPABILITY_RETRY_AFTER_BLOCKS,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "../src/auth-broker";

let dir: string;
let store: SqliteAuthCredentialStore;
let storage: AuthStorage;
let server: AuthBrokerServerHandle;
let remote: RemoteAuthCredentialStore | undefined;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-broker-provenance-"));
	store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
	storage = new AuthStorage(store);
	await storage.credentials.set("unit-provenance", [{ type: "api_key", key: "fixture-key" }]);
	server = await startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: ["fixture-token"] });
});
afterEach(async () => {
	remote?.close();
	remote = undefined;
	await server.close();
	storage.close();
	store.close();
	await fs.rm(dir, { recursive: true, force: true });
});

it("negotiates provenance and carries provider waits through broker-backed selection", async () => {
	const id = storage.credentials.list("unit-provenance")[0]!.id;
	const client = new AuthBrokerClient({ url: server.url, token: "fixture-token" });
	await client.fetchSnapshot();
	await client.upsertCredentialBlock(id, {
		providerKey: "unit-provenance:api_key",
		blockScope: "",
		blockedUntilMs: Date.now() + 60_000,
		quotaOrigin: true,
		retryAfter: true,
	});
	const result = await client.fetchSnapshot();
	if (result.status !== 200) throw new Error("expected snapshot");
	remote = new RemoteAuthCredentialStore({ client, initialSnapshot: result.snapshot, streamSnapshots: false });
	const reader = new AuthStorage(remote, { configValueResolver: async value => value });
	await reader.credentials.reload();
	expect(await reader.keys.get("unit-provenance", "turn", { requestId: "turn" })).toBeUndefined();
	expect(store.listCredentialBlocks([id])[0]).toMatchObject({ quotaOrigin: true, retryAfter: true });
	const legacy = await fetch(`${server.url}/v1/snapshot`, { headers: { Authorization: "Bearer fixture-token" } });
	const body = (await legacy.json()) as { credentials: Array<{ blocks: Array<Record<string, unknown>> }> };
	expect(body.credentials[0].blocks[0]).not.toHaveProperty("quotaOrigin");
	expect(body.credentials[0].blocks[0]).not.toHaveProperty("retryAfter");
});

it("does not send optional fields to a legacy broker that rejects unknown request keys", async () => {
	let posted: Record<string, unknown> | undefined;
	const client = new AuthBrokerClient({
		url: "http://broker.invalid",
		token: "fixture-token",
		fetchImpl: Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
				const extra = Object.keys(posted).some(
					key => !["providerKey", "blockScope", "blockedUntilMs", "updatedAtMs"].includes(key),
				);
				return Response.json(extra ? { error: "unknown keys" } : { ok: true }, { status: extra ? 400 : 200 });
			},
			{ preconnect: fetch.preconnect },
		),
	});
	expect(
		(
			await client.upsertCredentialBlock(1, {
				providerKey: "unit:api_key",
				blockScope: "",
				blockedUntilMs: Date.now() + 60_000,
				quotaOrigin: true,
				retryAfter: true,
			})
		).ok,
	).toBe(true);
	expect(posted).not.toHaveProperty("quotaOrigin");
	expect(posted).not.toHaveProperty("retryAfter");
});

for (const streaming of [false, true])
	it(`preserves Retry-After-only fork clients without exposing quota-origin (${streaming ? "SSE" : "HTTP"})`, async () => {
		const id = storage.credentials.list("unit-provenance")[0]!.id;
		storage.blocks.upsert({
			credentialId: id,
			providerKey: "unit-provenance:api_key",
			blockScope: "",
			blockedUntilMs: Date.now() + 60_000,
			retryAfter: true,
			quotaOrigin: true,
		});
		const response = await fetch(`${server.url}/v1/snapshot${streaming ? "/stream" : ""}`, {
			headers: {
				Authorization: "Bearer fixture-token",
				[AUTH_BROKER_CAPABILITIES_HEADER]: AUTH_BROKER_CAPABILITY_RETRY_AFTER_BLOCKS,
			},
		});
		expect(response.status).toBe(200);
		let body: { credentials: { blocks: Record<string, unknown>[] }[] };
		if (streaming) {
			const reader = response.body!.getReader();
			try {
				const chunk = await reader.read();
				const text = new TextDecoder().decode(chunk.value);
				const data = text.split("\n").find(line => line.startsWith("data: "));
				if (!data) throw new Error("Missing initial SSE snapshot");
				body = JSON.parse(data.slice(6));
			} finally {
				await reader.cancel();
			}
		} else body = (await response.json()) as { credentials: { blocks: Record<string, unknown>[] }[] };
		expect(body.credentials[0]?.blocks[0]?.retryAfter).toBe(true);
		expect(body.credentials[0]?.blocks[0]).not.toHaveProperty("quotaOrigin");
	});
