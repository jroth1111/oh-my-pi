import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import * as oauth from "../src/registry/oauth";

const provider = "unit-quota-origin";
let dir: string;
let store: SqliteAuthCredentialStore;
let storage: AuthStorage;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-probe-origin-"));
	store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
	storage = new AuthStorage(store, {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => ({
			findWindowLimits: () => ({}),
			windowDefaults: { primaryMs: 60_000, secondaryMs: 60_000 },
			blockScope: () => "scope:requested",
			blockScopes: () => ["scope:requested", "model-policy:denied"],
		}),
		configValueResolver: async value => value,
	});
	vi.spyOn(oauth, "getOAuthProvider").mockReturnValue({
		id: provider,
		name: "Fixture",
		login: async () => "unused",
		refreshToken: async credentials => credentials,
		getApiKey: credentials => credentials.access,
	});
	await storage.credentials.set(provider, [
		{ type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 },
	]);
});
afterEach(async () => {
	vi.restoreAllMocks();
	store.close();
	await fs.rm(dir, { recursive: true, force: true });
});

it("does not recover a revoked bearer through a quota probe", async () => {
	expect(await storage.limits.invalidateMatching(provider, "fixture-access")).toBe(true);
	expect(await storage.keys.get(provider, "fresh", { requestId: "fresh" })).toBeUndefined();
});

it("does not bypass a global Retry-After through an unrelated requested scope", async () => {
	const id = storage.credentials.list(provider)[0]!.id;
	store.upsertCredentialBlock({
		credentialId: id,
		providerKey: `${provider}:oauth`,
		blockScope: "",
		blockedUntilMs: Date.now() + 60_000,
		retryAfter: true,
	});
	expect(await storage.keys.get(provider, "fresh", { requestId: "fresh" })).toBeUndefined();
});

it("does not bypass a model-policy block even when a quota cooldown is also probeable", async () => {
	const id = storage.credentials.list(provider)[0]!.id;
	await storage.limits.markReached(provider, undefined, { credentialId: id });
	store.upsertCredentialBlock({
		credentialId: id,
		providerKey: `${provider}:oauth`,
		blockScope: "model-policy:denied",
		blockedUntilMs: Date.now() + 60_000,
	});
	expect(await storage.keys.get(provider, "fresh", { requestId: "fresh" })).toBeUndefined();
});

it("reuses the same request's recovery lease across repeated credential resolution", async () => {
	const id = storage.credentials.list(provider)[0]!.id;
	await storage.limits.markReached(provider, undefined, { credentialId: id });
	expect(await storage.keys.get(provider, "same", { requestId: "same" })).toBe("fixture-access");
	expect(await storage.keys.get(provider, "same", { requestId: "same" })).toBe("fixture-access");
	expect(await storage.keys.get(provider, "other", { requestId: "other" })).toBeUndefined();
	expect(storage.coordination.settleQuotaProbeSuccess("same")).toBe(true);
	expect(storage.blocks.list([id])).toEqual([]);
});

it("holds unknown legacy blocks until expiry rather than guessing quota provenance", async () => {
	const id = storage.credentials.list(provider)[0]!.id;
	store.upsertCredentialBlock({
		credentialId: id,
		providerKey: `${provider}:oauth`,
		blockScope: "",
		blockedUntilMs: Date.now() + 60_000,
	});
	expect(await storage.keys.get(provider, "fresh", { requestId: "fresh" })).toBeUndefined();
});

it("recovers a persisted global quota block through its actual scope after restart", async () => {
	const id = storage.credentials.list(provider)[0]!.id;
	store.upsertCredentialBlock({
		credentialId: id,
		providerKey: `${provider}:oauth`,
		blockScope: "",
		blockedUntilMs: Date.now() + 60_000,
		quotaOrigin: true,
	});
	storage = new AuthStorage(store, {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => ({
			findWindowLimits: () => ({}),
			windowDefaults: { primaryMs: 60_000, secondaryMs: 60_000 },
			blockScope: () => "unrelated-scope",
		}),
	});
	await storage.credentials.reload();
	expect(await storage.keys.get(provider, "fresh", { requestId: "fresh" })).toBe("fixture-access");
	expect(storage.coordination.settleQuotaProbeSuccess("fresh")).toBe(true);
	expect(storage.blocks.list([id])).toEqual([]);
});

it("does not let an old quota success clear a newer authentication block", async () => {
	const id = storage.credentials.list(provider)[0]!.id;
	await storage.limits.markReached(provider, undefined, { credentialId: id });
	expect(await storage.keys.get(provider, "probe", { requestId: "probe" })).toBe("fixture-access");
	expect(await storage.limits.invalidateMatching(provider, "fixture-access")).toBe(true);
	expect(storage.coordination.settleQuotaProbeSuccess("probe")).toBe(false);
	expect(await storage.keys.get(provider, "next", { requestId: "next" })).toBeUndefined();
});

it("preserves non-quota provenance when a longer quota block is merged into the same scope", async () => {
	const id = storage.credentials.list(provider)[0]!.id;
	const block = {
		credentialId: id,
		providerKey: `${provider}:oauth`,
		blockScope: "",
		blockedUntilMs: Date.now() + 30_000,
	};
	store.upsertCredentialBlock(block);
	store.upsertCredentialBlock({ ...block, blockedUntilMs: Date.now() + 60_000, quotaOrigin: true });
	expect(await storage.keys.get(provider, "fresh", { requestId: "fresh" })).toBeUndefined();
});

it("migrates a v8 block without inventing quota origin or losing its credential", async () => {
	const id = storage.credentials.list(provider)[0]!.id;
	store.upsertCredentialBlock({
		credentialId: id,
		providerKey: `${provider}:oauth`,
		blockScope: "",
		blockedUntilMs: Date.now() + 60_000,
	});
	store.close();
	const legacy = new Database(path.join(dir, "auth.db"));
	legacy.run("ALTER TABLE auth_credential_blocks DROP COLUMN quota_origin");
	legacy.run("ALTER TABLE auth_credential_blocks DROP COLUMN retry_after");
	legacy.run("UPDATE auth_schema_version SET version = 8 WHERE id = 1");
	legacy.close();
	store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
	storage = new AuthStorage(store, {
		rankingStrategyResolver: () => undefined,
		usageProviderResolver: () => undefined,
	});
	await storage.credentials.reload();
	expect(storage.credentials.list(provider).map(row => row.id)).toEqual([id]);
	expect(await storage.keys.get(provider, "fresh", { requestId: "fresh" })).toBeUndefined();
	expect(storage.blocks.list([id])[0]).not.toHaveProperty("quotaOrigin");
});

it("keeps an API-key authentication block effective when it is the only row", async () => {
	await storage.credentials.set(provider, [{ type: "api_key", key: "only-key" }]);
	expect(await storage.limits.invalidateMatching(provider, "only-key")).toBe(true);
	expect(await storage.keys.get(provider, "fresh", { requestId: "fresh" })).toBeUndefined();
});

it("does not treat two independent quota meters as recovered by a single probe", async () => {
	const id = storage.credentials.list(provider)[0]!.id;
	for (const blockScope of ["scope:requested", ""])
		store.upsertCredentialBlock({
			credentialId: id,
			providerKey: `${provider}:oauth`,
			blockScope,
			blockedUntilMs: Date.now() + 60_000,
			quotaOrigin: true,
		});
	expect(await storage.keys.get(provider, "fresh", { requestId: "fresh" })).toBeUndefined();
	expect(storage.blocks.list([id])).toHaveLength(2);
});

it("does not consume or strand recovery leases during non-invasive account selection", async () => {
	const id = storage.credentials.list(provider)[0]!.id;
	await storage.limits.markReached(provider, undefined, { credentialId: id });
	expect(await storage.keys.get(provider, "catalog-probe", { recordAffinity: false })).toBeUndefined();
	expect(await storage.keys.get(provider, "real-turn", { requestId: "real-turn" })).toBe("fixture-access");
	expect(storage.coordination.settleQuotaProbeSuccess("real-turn")).toBe(true);
});

it("does not probe cooling OAuth when a healthy stored API key can serve", async () => {
	await storage.credentials.set(provider, [
		{ type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 },
		{ type: "api_key", key: "healthy-key" },
	]);
	const id = storage.credentials.list(provider).find(row => row.credential.type === "oauth")!.id;
	await storage.limits.markReached(provider, undefined, { credentialId: id });
	expect(await storage.keys.getWithCredential(provider, "fresh", { requestId: "fresh" })).toMatchObject({
		apiKey: "healthy-key",
	});
	expect(storage.coordination.hasInflightProbe("fresh")).toBe(false);
	expect(storage.coordination.hasCoolingDownCredentials(provider)).toBe(false);
	const healthy = storage.credentials.list(provider).find(row => row.credential.type === "api_key")!;
	const explicit = storage.coordination.tryAcquireTurnReservation({
		credentialId: healthy.id,
		incarnation: 1,
		requestId: "explicit-policy",
	});
	if (!explicit.ok) throw new Error("Expected an explicit fixture reservation");
	expect(storage.coordination.hasCoolingDownCredentials(provider)).toBe(true);
	explicit.reservation.release();
	expect(storage.coordination.hasCoolingDownCredentials(provider)).toBe(false);
	expect(storage.coordination.tryAcquireQuotaProbeLease(id, "scope:requested")).toBeTypeOf("string");
});

it("tries healthy non-login API keys before probing a blocked login key", async () => {
	await storage.credentials.set(provider, [
		{ type: "api_key", key: "blocked-login", source: "login" },
		{ type: "api_key", key: "healthy-key" },
	]);
	const id = storage.credentials
		.list(provider)
		.find(row => row.credential.type === "api_key" && row.credential.source === "login")!.id;
	await storage.limits.markReached(provider, undefined, { credentialId: id });
	expect(await storage.keys.get(provider, "fresh", { requestId: "fresh" })).toBe("healthy-key");
	expect(storage.coordination.tryAcquireQuotaProbeLease(id, "scope:requested")).toBeTypeOf("string");
});

it("releases anonymous probes whose key material cannot be resolved", async () => {
	let materialAvailable = false;
	storage = new AuthStorage(store, {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
		configValueResolver: async key => (materialAvailable ? key : undefined),
	});
	await storage.credentials.set(provider, [{ type: "api_key", key: "fixture-key" }]);
	const id = storage.credentials.list(provider)[0]!.id;
	await storage.limits.markReached(provider, undefined, { credentialId: id });
	expect(await storage.keys.get(provider, "first")).toBeUndefined();
	materialAvailable = true;
	expect(await storage.keys.get(provider, "second")).toBe("fixture-key");
	expect(storage.coordination.settleAnonymousQuotaProbe(id, "")).toBe(true);
	expect(storage.blocks.list([id])).toEqual([]);
});

it("does not label an older process's shared-block update as a known quota recovery", async () => {
	storage = new AuthStorage(store, {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => ({
			findWindowLimits: () => ({}),
			windowDefaults: { primaryMs: 60_000, secondaryMs: 60_000 },
			blockScope: () => "chat",
		}),
	});
	await storage.credentials.set("openai-codex", [
		{ type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 },
	]);
	const id = storage.credentials.list("openai-codex")[0]!.id;
	store.upsertCredentialBlock({
		credentialId: id,
		providerKey: "openai-codex:oauth",
		blockScope: "chat",
		blockedUntilMs: Date.now() + 60_000,
		quotaOrigin: true,
	});
	const legacy = new Database(path.join(dir, "auth.db"));
	try {
		legacy.run(
			"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, 'openai-codex:oauth', 'shared', ?, ?) ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET blocked_until_ms = excluded.blocked_until_ms, updated_at = excluded.updated_at",
			[id, Date.now() + 120_000, Math.floor(Date.now() / 1000)],
		);
	} finally {
		legacy.close();
	}
	expect(await storage.keys.get("openai-codex", "fresh", { requestId: "fresh" })).toBeUndefined();
	expect(store.listCredentialBlocks([id]).every(block => block.quotaOrigin !== true)).toBe(true);
});

it("does not vend ranked blocked API keys when every row is unavailable", async () => {
	await storage.credentials.set(provider, [
		{ type: "api_key", key: "first" },
		{ type: "api_key", key: "second" },
	]);
	for (const key of ["first", "second"]) expect(await storage.limits.invalidateMatching(provider, key)).toBe(true);
	expect(await storage.keys.get(provider, "fresh", { requestId: "fresh" })).toBeUndefined();
});
