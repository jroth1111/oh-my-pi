import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-wave-a-turn";

function oauth(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage in-flight turn reservations", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let storage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-turn-res-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		storage = null;
		if (tempDir) await removeWithRetries(tempDir);
	});

	it("lets a second acquire see the first and succeed after release", () => {
		if (!storage) throw new Error("setup failed");
		const first = storage.coordination.tryAcquireTurnReservation({
			credentialId: 7,
			incarnation: 1,
			requestId: "req-1",
		});
		expect(first.ok).toBe(true);
		const second = storage.coordination.tryAcquireTurnReservation({
			credentialId: 7,
			incarnation: 1,
			requestId: "req-2",
		});
		expect(second.ok).toBe(false);
		if (second.ok || second.reason !== "held") throw new Error("second acquire must observe the first");
		expect(second.heldByRequestId).toBe("req-1");

		if (!first.ok) throw new Error("first acquire must succeed");
		first.reservation.release();
		const third = storage.coordination.tryAcquireTurnReservation({
			credentialId: 7,
			incarnation: 1,
			requestId: "req-3",
		});
		expect(third.ok).toBe(true);
	});

	it("does not pin an expired reservation forever", () => {
		if (!storage) throw new Error("setup failed");
		const first = storage.coordination.tryAcquireTurnReservation({
			credentialId: 9,
			incarnation: 1,
			requestId: "ttl-1",
			ttlMs: 0,
		});
		expect(first.ok).toBe(true);
		const second = storage.coordination.tryAcquireTurnReservation({
			credentialId: 9,
			incarnation: 1,
			requestId: "ttl-2",
		});
		expect(second.ok).toBe(true);
	});

	it("makes a reserved credential invisible to a concurrent getApiKey selector", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [oauth("a"), oauth("b")]);
		const rows = storage.credentials.list(PROVIDER);
		const idA = rows[0]?.id;
		if (idA === undefined) throw new Error("missing credential");
		const held = storage.coordination.tryAcquireTurnReservation({
			credentialId: idA,
			incarnation: storage.coordination.getCredentialIncarnation(idA),
			requestId: "inflight-a",
		});
		expect(held.ok).toBe(true);
		const key = await storage.keys.get(PROVIDER, "other-selector");
		expect(key).not.toBe("access-a");
		expect(key).toBe("access-b");
	});

	it("does not turn request identities into a healthy OAuth concurrency limit", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [oauth("a"), oauth("b")]);
		const first = await storage.keys.get(PROVIDER, "same-session", { requestId: "req-a" });
		const second = await storage.keys.get(PROVIDER, "same-session", { requestId: "req-b" });
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).toBe(second);
		for (const row of storage.credentials.list(PROVIDER))
			expect(storage.coordination.activeTurnReservation(row.id, 1)).toBeUndefined();
	});

	it("does not let an old release() kill a renewed same-requestId reservation (negative)", () => {
		if (!storage) throw new Error("setup failed");
		const first = storage.coordination.tryAcquireTurnReservation({
			credentialId: 3,
			incarnation: 1,
			requestId: "same",
			ttlMs: 60_000,
		});
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error("first acquire must succeed");
		const renewed = storage.coordination.tryAcquireTurnReservation({
			credentialId: 3,
			incarnation: 1,
			requestId: "same",
			ttlMs: 60_000,
		});
		expect(renewed.ok).toBe(true);
		first.reservation.release();
		const other = storage.coordination.tryAcquireTurnReservation({
			credentialId: 3,
			incarnation: 1,
			requestId: "other",
		});
		expect(other.ok).toBe(false);
	});

	it("getApiKey with the holder's requestId still vends the reserved credential", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [oauth("a"), oauth("b")]);
		const rows = storage.credentials.list(PROVIDER);
		const idA = rows[0]?.id;
		if (idA === undefined) throw new Error("missing credential");
		const held = storage.coordination.tryAcquireTurnReservation({
			credentialId: idA,
			incarnation: storage.coordination.getCredentialIncarnation(idA),
			requestId: "holder",
		});
		expect(held.ok).toBe(true);
		const key = await storage.keys.get(PROVIDER, "holder-session", { requestId: "holder" });
		expect(key).toBe("access-a");
	});

	it("shares healthy stored API keys without creating implicit exclusive holds", async () => {
		if (!storage) throw new Error("setup failed");
		const apiProvider = `${PROVIDER}-api-keys`;
		await storage.credentials.set(apiProvider, [
			{ type: "api_key", key: "key-a", source: "login" },
			{ type: "api_key", key: "key-b", source: "login" },
		]);
		const first = await storage.keys.get(apiProvider, "same-session", { requestId: "api-req-a" });
		const second = await storage.keys.get(apiProvider, "same-session", { requestId: "api-req-b" });
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).toBe(second);
		for (const row of storage.credentials.list(apiProvider))
			expect(storage.coordination.activeTurnReservation(row.id, 1)).toBeUndefined();
	});

	it("does not resurrect an expired reservation during renewal", () => {
		if (!storage) throw new Error("setup failed");
		storage.coordination.tryAcquireTurnReservation({
			credentialId: 7,
			incarnation: 1,
			requestId: "expired",
			ttlMs: 0,
		});
		storage.coordination.renewTurnReservation("expired");
		expect(
			storage.coordination.tryAcquireTurnReservation({ credentialId: 7, incarnation: 1, requestId: "next" }).ok,
		).toBe(true);
	});

	it.each([NaN, Infinity, -1])("rejects invalid TTL %s without stranding a hold", ttlMs => {
		if (!storage) throw new Error("setup failed");
		const coordination = storage.coordination;
		expect(() =>
			coordination.tryAcquireTurnReservation({ credentialId: 7, incarnation: 1, requestId: "bad", ttlMs }),
		).toThrow();
		expect(coordination.activeTurnReservation(7, 1)).toBeUndefined();
	});

	it("rejects stale incarnations and fences old releases after a physical replacement", async () => {
		if (!storage || !store) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, { type: "api_key", key: "old-key" });
		const id = storage.credentials.list(PROVIDER)[0]!.id;
		const old = storage.coordination.tryAcquireTurnReservation({
			credentialId: id,
			incarnation: 1,
			requestId: "old",
		});
		if (!old.ok) throw new Error("Expected old reservation");
		store.updateAuthCredential(id, { type: "api_key", key: "new-key" });
		await storage.credentials.reload();
		expect(
			storage.coordination.tryAcquireTurnReservation({ credentialId: id, incarnation: 1, requestId: "stale" }),
		).toEqual({ ok: false, reason: "stale-incarnation" });
		const next = storage.coordination.tryAcquireTurnReservation({
			credentialId: id,
			incarnation: 2,
			requestId: "next",
		});
		expect(next.ok).toBe(true);
		old.reservation.release();
		storage.coordination.renewTurnReservation("old");
		expect(storage.coordination.activeTurnReservation(id, 2)?.requestId).toBe("next");
	});

	it("does not consume an exclusive turn hold during non-invasive selection", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [oauth("a")]);
		const id = storage.credentials.list(PROVIDER)[0]!.id;
		expect(await storage.keys.get(PROVIDER, "preview", { requestId: "preview", recordAffinity: false })).toBe(
			"access-a",
		);
		expect(storage.coordination.activeTurnReservation(id, 1)).toBeUndefined();
	});

	it("captures the prepared replacement incarnation without serializing its healthy traffic", async () => {
		if (!storage || !store) throw new Error("setup failed");
		const database = store;
		let prepared = false;
		Object.assign(database, {
			prepareForRequest: async (id: number) => {
				if (!prepared) {
					prepared = true;
					database.updateAuthCredential(id, oauth("replacement"));
				}
			},
		});
		await storage.credentials.set(PROVIDER, [oauth("old")]);
		const id = storage.credentials.list(PROVIDER)[0]!.id;
		expect(await storage.keys.get(PROVIDER, "owner", { requestId: "owner" })).toBe("access-replacement");
		expect(storage.coordination.getCredentialIncarnation(id)).toBe(2);
		expect(storage.coordination.activeTurnReservation(id, 2)).toBeUndefined();
		expect(await storage.keys.get(PROVIDER, "other", { requestId: "other" })).toBe("access-replacement");
	});

	it("captures the physical identity returned by a forced OAuth refresh without imposing single-flight", async () => {
		if (!store) throw new Error("setup failed");
		storage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
			refreshOAuthCredential: async () => oauth("refreshed-account"),
		});
		await storage.credentials.set(PROVIDER, [oauth("old")]);
		const id = storage.credentials.list(PROVIDER)[0]!.id;
		expect(await storage.keys.get(PROVIDER, "owner", { requestId: "owner", forceRefresh: true })).toBe(
			"access-refreshed-account",
		);
		expect(storage.coordination.getCredentialIncarnation(id)).toBe(2);
		expect(storage.coordination.activeTurnReservation(id, 2)).toBeUndefined();
		expect(await storage.keys.get(PROVIDER, "other", { requestId: "other" })).toBe("access-refreshed-account");
	});

	it("rechecks an explicit foreign hold after concurrent asynchronous material resolution", async () => {
		if (!store) throw new Error("setup failed");
		const barrier = Promise.withResolvers<void>();
		let firstReference: string | undefined;
		let preparing = 0;
		let heldId: number | undefined;
		storage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
			configValueResolver: async reference => {
				firstReference ??= reference;
				if (reference === firstReference) {
					if (++preparing === 2) {
						const row = storage!.credentials
							.list(PROVIDER)
							.find(row => row.credential.type === "api_key" && row.credential.key === reference);
						if (!row) throw new Error("Missing selected fixture row");
						heldId = row.id;
						expect(
							storage!.coordination.tryAcquireTurnReservation({
								credentialId: row.id,
								incarnation: 1,
								requestId: "explicit-owner",
							}).ok,
						).toBe(true);
						barrier.resolve();
					}
					await barrier.promise;
				}
				return reference;
			},
		});
		await storage.credentials.set(PROVIDER, [
			{ type: "api_key", key: "key-a" },
			{ type: "api_key", key: "key-b" },
		]);
		const keys = await Promise.all([
			storage.keys.getWithCredential(PROVIDER, "same-session", { requestId: "first" }),
			storage.keys.getWithCredential(PROVIDER, "same-session", { requestId: "second" }),
		]);
		expect(keys[0]?.apiKey).toBeDefined();
		expect(keys[1]?.apiKey).toBeDefined();
		expect(keys[0]?.credentialId).not.toBe(heldId);
		expect(keys[1]?.credentialId).not.toBe(heldId);
		expect(keys[0]?.credentialId).toBe(keys[1]?.credentialId);
		storage.coordination.releaseTurnReservation("first");
		expect(storage.coordination.activeTurnReservation(heldId!, 1)?.requestId).toBe("explicit-owner");
	});

	it("does not use a timed cooldown key when its healthy sibling is reserved", async () => {
		if (!storage || !store) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [
			{ type: "api_key", key: "healthy" },
			{ type: "api_key", key: "cooled" },
		]);
		const [healthy, cooled] = storage.credentials.list(PROVIDER);
		storage.coordination.tryAcquireTurnReservation({
			credentialId: healthy!.id,
			incarnation: 1,
			requestId: "active",
		});
		store.upsertCredentialBlock({
			credentialId: cooled!.id,
			providerKey: `${PROVIDER}:api_key`,
			blockScope: "",
			blockedUntilMs: Date.now() + 60_000,
			retryAfter: true,
			quotaOrigin: true,
		});
		expect(await storage.keys.get(PROVIDER, "other", { requestId: "other" })).toBeUndefined();
		expect(storage.coordination.activeTurnReservation(cooled!.id, 1)).toBeUndefined();
	});

	it("does not strand reservations when stored key material is unavailable", async () => {
		if (!store) throw new Error("setup failed");
		storage = new AuthStorage(store, { configValueResolver: async () => undefined });
		await storage.credentials.set(PROVIDER, { type: "api_key", key: "unavailable-reference" });
		const id = storage.credentials.list(PROVIDER)[0]!.id;
		expect(await storage.keys.get(PROVIDER, "missing-material", { requestId: "missing-material" })).toBeUndefined();
		expect(storage.coordination.activeTurnReservation(id, 1)).toBeUndefined();
	});
});
