import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAuthGatewayRouter, startAuthGateway } from "../src/auth-gateway";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

const client = { Authorization: "Bearer credential-fixture-client" };
const admin = { Authorization: "Bearer credential-fixture-admin" };
const keyProvider = "credential-fixture-key";
const oauthProvider = "credential-fixture-oauth";

async function withManagement(
	run: (
		url: string,
		storage: AuthStorage,
		store: SqliteAuthCredentialStore,
		keyId: number,
		oauthId: number,
	) => Promise<void>,
	allowManagement = true,
	noAuth = false,
): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-credential-management-"));
	const store = await SqliteAuthCredentialStore.open(path.join(directory, "auth.db"));
	const storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
	await storage.credentials.set(keyProvider, { type: "api_key", key: "fixture-private-api-key" });
	await storage.credentials.set(oauthProvider, [
		{
			type: "oauth",
			access: "fixture-private-oauth-access",
			refresh: "fixture-private-oauth-refresh",
			expires: Date.now() + 60 * 60_000,
			accountId: "fixture-account-one",
		},
		{
			type: "oauth",
			access: "fixture-second-oauth-access",
			refresh: "fixture-second-oauth-refresh",
			expires: Date.now() + 60 * 60_000,
			accountId: "fixture-account-two",
		},
	]);
	const keyId = storage.credentials.list(keyProvider)[0]!.id;
	const oauthId = storage.credentials.list(oauthProvider)[1]!.id;
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: noAuth ? [] : ["credential-fixture-client"],
		storage,
		resolveModel: () => undefined,
		allowManagement,
		adminBearerTokens: ["credential-fixture-admin"],
	});
	try {
		await run(gateway.url, storage, store, keyId, oauthId);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
}

it("lists stored credential identities without bearer, refresh, key or account data", async () => {
	await withManagement(async (url, _storage, _store, keyId, oauthId) => {
		const denied = await fetch(`${url}/v1/credentials`);
		expect(denied.status).toBe(401);
		await denied.text();
		for (const headers of [client, admin]) {
			const response = await fetch(`${url}/v1/credentials`, { headers });
			expect(response.status).toBe(200);
			const text = await response.text();
			expect(text).not.toContain("fixture-private");
			expect(text).not.toContain("fixture-account");
			const payload = JSON.parse(text) as { object: string; data: { id: number; provider: string; type: string }[] };
			expect(payload.object).toBe("list");
			expect(payload.data).toHaveLength(3);
			expect(payload.data.find(row => row.id === keyId)).toEqual({
				id: keyId,
				provider: keyProvider,
				type: "api_key",
			});
			expect(payload.data.find(row => row.id === oauthId)).toEqual({
				id: oauthId,
				provider: oauthProvider,
				type: "oauth",
			});
			for (const row of payload.data) expect(Object.keys(row).sort()).toEqual(["id", "provider", "type"]);
		}
	});
});

for (const noAuth of [false, true]) {
	it(`ordinary ${noAuth ? "no-auth" : "inference"} requests cannot disable or pin credentials`, async () => {
		await withManagement(
			async (url, storage, store, keyId, oauthId) => {
				for (const [id, action] of [
					[keyId, "disable"],
					[oauthId, "pin"],
				] as const) {
					const response = await fetch(`${url}/v1/credentials/${id}/${action}`, {
						method: "POST",
						headers: noAuth ? undefined : client,
						body: JSON.stringify({ provider: oauthProvider, sessionId: "fixture-session" }),
					});
					expect(response.status).toBe(403);
					await response.text();
				}
				expect(store.listAuthCredentials(keyProvider).map(row => row.id)).toEqual([keyId]);
				expect(storage.sessions.explicitCredentialId(oauthProvider, "fixture-session")).toBeUndefined();
			},
			true,
			noAuth,
		);
	});
}

it("disabled management cannot change stored credentials even with an admin token", async () => {
	await withManagement(async (url, _storage, store, keyId) => {
		const response = await fetch(`${url}/v1/credentials/${keyId}/disable`, { method: "POST", headers: admin });
		expect(response.status).toBe(404);
		await response.text();
		expect(store.listAuthCredentials(keyProvider).map(row => row.id)).toEqual([keyId]);
	}, false);
});

it("an admin mutation is independently reflected in durable rows and exact subsequent selection", async () => {
	await withManagement(async (url, storage, store, keyId, oauthId) => {
		const pin = await fetch(`${url}/v1/credentials/${oauthId}/pin`, {
			method: "POST",
			headers: admin,
			body: JSON.stringify({ provider: oauthProvider, sessionId: "fixture-session" }),
		});
		expect(pin.status).toBe(200);
		expect(await pin.json()).toEqual({ ok: true });
		expect(storage.sessions.explicitCredentialId(oauthProvider, "fixture-session")).toBe(oauthId);
		expect(await storage.keys.get(oauthProvider, "fixture-session")).toBe("fixture-second-oauth-access");
		const disable = await fetch(`${url}/v1/credentials/${keyId}/disable`, { method: "POST", headers: admin });
		expect(disable.status).toBe(200);
		expect(await disable.json()).toEqual({ ok: true });
		expect(store.listAuthCredentials(keyProvider)).toEqual([]);
		expect(store.listAuthCredentials(oauthProvider)).toHaveLength(2);
		const rows = await fetch(`${url}/v1/credentials`, { headers: client });
		const list = (await rows.json()) as { data: { id: number }[] };
		expect(list.data.map(row => row.id)).not.toContain(keyId);
		const inference = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: admin, body: "{}" });
		expect(inference.status).toBe(401);
		await inference.text();
	});
});

it("invalid IDs, misplaced tokens and a wrong-provider pin do not mutate storage", async () => {
	await withManagement(async (url, storage, store, keyId, oauthId) => {
		for (const suffix of ["NaN", "0", "-1", "1e3", "9007199254740992", "%GG"]) {
			const response = await fetch(`${url}/v1/credentials/${suffix}/disable`, { method: "POST", headers: admin });
			expect(response.status).toBe(400);
			await response.text();
		}
		const misplaced = await fetch(`${url}/v1/credentials/${keyId}/disable?token=credential-fixture-admin`, {
			method: "POST",
			headers: admin,
		});
		expect(misplaced.status).toBe(400);
		await misplaced.text();
		const wrongProvider = await fetch(`${url}/v1/credentials/${oauthId}/pin`, {
			method: "POST",
			headers: admin,
			body: JSON.stringify({ provider: keyProvider, sessionId: "fixture-session" }),
		});
		expect(wrongProvider.status).toBe(404);
		await wrongProvider.text();
		expect(store.listAuthCredentials(keyProvider).map(row => row.id)).toEqual([keyId]);
		expect(storage.sessions.explicitCredentialId(keyProvider, "fixture-session")).toBeUndefined();
		const empty = createAuthGatewayRouter({
			storage,
			resolveModel: () => undefined,
			allowManagement: true,
			adminBearerTokens: [],
		});
		try {
			const response = await empty.route(
				new Request(`http://fixture/v1/credentials/${keyId}/disable`, { method: "POST" }),
				"fixture",
			);
			expect(response.status).toBe(403);
			await response.text();
			expect(store.listAuthCredentials(keyProvider).map(row => row.id)).toEqual([keyId]);
		} finally {
			empty.close();
		}
	});
});
