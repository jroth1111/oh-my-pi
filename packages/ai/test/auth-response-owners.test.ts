import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type StoredResponseOwner, SqliteAuthCredentialStore } from "../src/auth-storage";

afterEach(() => vi.restoreAllMocks());

async function withStorage(
	run: (storage: AuthStorage, store: SqliteAuthCredentialStore) => Promise<void>,
): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "response-owner-cache-"));
	const store = await SqliteAuthCredentialStore.open(path.join(directory, "auth.db"));
	const storage = new AuthStorage(store);
	try {
		await run(storage, store);
	} finally {
		storage.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
}

function owner(): StoredResponseOwner {
	return {
		sessionId: "session",
		target: "openai/model",
		provider: "openai",
		api: "openai-responses",
		endpoint: "deployment-hash",
		account: "account-hash",
	};
}

it("recovers evicted response bindings from the durable store without retaining mutable input", async () => {
	await withStorage(async storage => {
		const original = owner();
		storage.responses.record("resp_oldest", original);
		original.account = "changed-input";
		for (let index = 0; index < 4096; index++) storage.responses.record(`resp_${index}`, owner());
		expect(storage.responses.get("resp_oldest")).toEqual(owner());
		expect(Object.isFrozen(storage.responses.get("resp_oldest"))).toBe(true);
	});
});

it("does not serve expired response ownership from its hot lookup", async () => {
	await withStorage(async storage => {
		const now = Date.now();
		storage.responses.record("resp_expired", owner());
		vi.spyOn(Date, "now").mockReturnValue(now + 31 * 24 * 60 * 60 * 1000);
		expect(storage.responses.get("resp_expired")).toBeUndefined();
	});
});

it("fails closed on malformed persisted bindings and discards unrecognized fields", async () => {
	await withStorage(async (storage, store) => {
		const key = `response:owner:v1:${Bun.SHA256.hash("resp_metadata", "hex")}`;
		const expiresAtSec = Math.floor(Date.now() / 1000) + 60;
		store.setCache(key, "{invalid", expiresAtSec);
		expect(storage.responses.get("resp_metadata")).toBeUndefined();
		store.setCache(key, JSON.stringify({ owner: { ...owner(), account: 123 }, expiresAtSec }), expiresAtSec);
		expect(storage.responses.get("resp_metadata")).toBeUndefined();
		store.setCache(
			key,
			JSON.stringify({ owner: { ...owner(), authorization: "must-not-propagate" }, expiresAtSec }),
			expiresAtSec,
		);
		expect(storage.responses.get("resp_metadata")).toEqual(owner());
	});
});
