import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthStorage,
	type AuthCredential,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "openai-codex";

function oauth(args: { suffix: string; accountId?: string; email?: string; orgId?: string }): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${args.suffix}`,
		refresh: `refresh-${args.suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: args.accountId,
		email: args.email,
		orgId: args.orgId,
	};
}

describe("AuthStorage credential incarnation and workspace fan-out", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let storage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-incarnation-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store, {
			rankingStrategyResolver: () => undefined,
			usageProviderResolver: () => undefined,
		});
	});

	afterEach(async () => {
		store?.close();
		store = null;
		storage = null;
		if (tempDir) await removeWithRetries(tempDir);
	});

	it("increments incarnation and purges blocks on a confirmed identity change", async () => {
		if (!storage || !store) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [oauth({ suffix: "a", accountId: "acc-old", email: "old@example.com" })]);
		const id = storage.credentials.list(PROVIDER)[0]?.id;
		if (id === undefined) throw new Error("missing credential");
		expect(storage.coordination.getCredentialIncarnation(id)).toBe(1);
		await storage.limits.markReached(PROVIDER, undefined, { credentialId: id });
		expect(storage.blocks.list([id]).length).toBeGreaterThan(0);

		store.updateAuthCredential(id, oauth({ suffix: "a2", accountId: "acc-new", email: "new@example.com" }));
		await storage.credentials.reload();
		expect(storage.coordination.getCredentialIncarnation(id)).toBe(2);
		expect(storage.blocks.list([id])).toEqual([]);
	});

	it("does not treat missing or malformed identity as a switch (negative)", async () => {
		if (!storage || !store) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [oauth({ suffix: "a", accountId: "acc-old", email: "old@example.com" })]);
		const id = storage.credentials.list(PROVIDER)[0]?.id;
		if (id === undefined) throw new Error("missing credential");
		await storage.limits.markReached(PROVIDER, undefined, { credentialId: id });

		store.updateAuthCredential(id, {
			type: "oauth",
			access: "access-stripped",
			refresh: "refresh-stripped",
			expires: Date.now() + 3_600_000,
		});
		await storage.credentials.reload();
		expect(storage.coordination.getCredentialIncarnation(id)).toBe(1);
		expect(storage.blocks.list([id])).toHaveLength(1);
	});

	it("does not bump incarnation when identity is only enriched with new fields", async () => {
		if (!storage || !store) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [
			oauth({ suffix: "a", accountId: "acc-same", email: "same@example.com" }),
		]);
		const id = storage.credentials.list(PROVIDER)[0]?.id;
		if (id === undefined) throw new Error("missing credential");
		await storage.limits.markReached(PROVIDER, undefined, { credentialId: id });
		const probe = storage.coordination.tryAcquireQuotaProbeLease(id, "");
		store.updateAuthCredential(
			id,
			oauth({ suffix: "a", accountId: "acc-same", email: "same@example.com", orgId: "org-new" }),
		);
		await storage.credentials.reload();
		expect(storage.coordination.getCredentialIncarnation(id)).toBe(1);
		expect(storage.blocks.list([id])).toHaveLength(1);
		expect(storage.coordination.recordQuotaProbeSuccess(id, "", probe)).toBe(true);
	});

	const base = oauth({ suffix: "same-token", accountId: "account", orgId: "old-org" });
	const replacements: Array<{ name: string; previous: AuthCredential; next: AuthCredential }> = [
		{ name: "organization with unchanged bearer bytes", previous: base, next: { ...base, orgId: "new-org" } },
		{
			name: "API-key bytes",
			previous: { type: "api_key", key: "old-key" },
			next: { type: "api_key", key: "new-key" },
		},
		{ name: "OAuth to API key", previous: base, next: { type: "api_key", key: "new-key" } },
		{ name: "API key to OAuth", previous: { type: "api_key", key: "old-key" }, next: base },
		{
			name: "project within the same account",
			previous: { ...base, projectId: "old-project" },
			next: { ...base, projectId: "new-project" },
		},
		{
			name: "project identifiers containing a fingerprint separator",
			previous: { ...base, projectId: "old|project:unchanged" },
			next: { ...base, projectId: "new|project:unchanged" },
		},
	];
	for (const { name, previous, next } of replacements) {
		it(`does not transfer cooldown or probe success when replacing ${name}`, async () => {
			if (!storage || !store) throw new Error("setup failed");
			await storage.credentials.set(PROVIDER, [previous]);
			const id = storage.credentials.list(PROVIDER)[0]!.id;
			await storage.limits.markReached(PROVIDER, undefined, { credentialId: id });
			const probe = storage.coordination.tryAcquireQuotaProbeLease(id, "");
			store.updateAuthCredential(id, next);
			await storage.credentials.reload();
			expect(storage.coordination.getCredentialIncarnation(id)).toBe(2);
			expect(storage.blocks.list([id])).toEqual([]);
			expect(storage.coordination.recordQuotaProbeSuccess(id, "", probe)).toBe(false);
			await storage.limits.markReached(PROVIDER, undefined, { credentialId: id });
			expect(storage.coordination.tryAcquireQuotaProbeLease(id, "")).toBeTypeOf("string");
		});
	}

	it("retains quota state and a live probe across ordinary OAuth token refresh", async () => {
		if (!storage || !store) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [base]);
		const id = storage.credentials.list(PROVIDER)[0]!.id;
		await storage.limits.markReached(PROVIDER, undefined, { credentialId: id });
		const probe = storage.coordination.tryAcquireQuotaProbeLease(id, "");
		store.updateAuthCredential(id, {
			...base,
			access: "new-access",
			refresh: "new-refresh",
			expires: Date.now() + 7_200_000,
		});
		await storage.credentials.reload();
		expect(storage.blocks.list([id])).toHaveLength(1);
		expect(storage.coordination.recordQuotaProbeSuccess(id, "", probe)).toBe(true);
	});

	it("blocks every stored seat of a deactivated workspace but keeps other workspaces usable", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [
			oauth({ suffix: "user-a", accountId: "a", orgId: "shared-workspace" }),
			oauth({ suffix: "user-b", accountId: "b", orgId: "shared-workspace" }),
			oauth({ suffix: "other", accountId: "c", orgId: "other-workspace" }),
		]);
		const ids = storage.credentials.list(PROVIDER).map(row => row.id);
		await storage.limits.rotate(PROVIDER, undefined, {
			credentialId: ids[0],
			error: Object.assign(new Error("deactivated_workspace"), { status: 402 }),
		});
		expect(new Set(storage.blocks.list(ids).map(block => block.credentialId))).toEqual(new Set(ids.slice(0, 2)));
		expect(await storage.keys.get(PROVIDER, "fresh")).toBe("access-other");
	});

	it("does not bump incarnation when a reload merely drops an identity field", async () => {
		if (!storage || !store) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [
			oauth({ suffix: "a", accountId: "acc-same", email: "same@example.com", orgId: "org-old" }),
		]);
		const id = storage.credentials.list(PROVIDER)[0]?.id;
		if (id === undefined) throw new Error("missing credential");
		await storage.limits.markReached(PROVIDER, undefined, { credentialId: id });
		expect(storage.blocks.list([id]).length).toBeGreaterThan(0);
		// Same account, orgId temporarily absent: inconclusive, not a switch.
		store.updateAuthCredential(id, oauth({ suffix: "a", accountId: "acc-same", email: "same@example.com" }));
		await storage.credentials.reload();
		expect(storage.coordination.getCredentialIncarnation(id)).toBe(1);
		expect(storage.blocks.list([id]).length).toBeGreaterThan(0);
	});

	it("does not fan out a plain 402 payment_required without deactivated_workspace (negative)", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [
			oauth({ suffix: "team-a", accountId: "chatgpt-shared", email: "shared@example.com", orgId: "ws-team-a" }),
			oauth({
				suffix: "team-a-sibling",
				accountId: "chatgpt-shared",
				email: "shared-alias@example.com",
				orgId: "ws-team-a-seat",
			}),
		]);
		const rows = storage.credentials.list(PROVIDER);
		const byAccess = new Map(
			rows.map(row => {
				const cred = row.credential;
				if (cred.type !== "oauth") throw new Error("expected oauth");
				return [cred.access, row.id] as const;
			}),
		);
		const idA = byAccess.get("access-team-a");
		const idSibling = byAccess.get("access-team-a-sibling");
		if (idA === undefined || idSibling === undefined) throw new Error("expected two credentials");
		await storage.limits.rotate(PROVIDER, undefined, {
			credentialId: idA,
			error: Object.assign(new Error("payment_required"), { status: 402 }),
		});
		const blocked = new Set(storage.blocks.list([idA, idSibling]).map(block => block.credentialId));
		expect(blocked.has(idA)).toBe(true);
		expect(blocked.has(idSibling)).toBe(false);
	});

	it("does not fan deactivated_workspace across distinct organization-qualified identities", async () => {
		if (!storage) throw new Error("setup failed");
		await storage.credentials.set(PROVIDER, [
			oauth({ suffix: "team-a", accountId: "chatgpt-shared", email: "shared@example.com", orgId: "ws-team-a" }),
			oauth({
				suffix: "team-a-sibling",
				accountId: "chatgpt-shared",
				email: "shared-alias@example.com",
				orgId: "ws-team-a-seat",
			}),
			oauth({ suffix: "team-b", accountId: "chatgpt-other", email: "other@example.com", orgId: "ws-team-b" }),
		]);
		const rows = storage.credentials.list(PROVIDER);
		expect(rows.length).toBe(3);
		const byAccess = new Map(
			rows.map(row => {
				const cred = row.credential;
				if (cred.type !== "oauth") throw new Error("expected oauth");
				return [cred.access, row.id] as const;
			}),
		);
		const idA = byAccess.get("access-team-a");
		const idSibling = byAccess.get("access-team-a-sibling");
		const idOther = byAccess.get("access-team-b");
		if (idA === undefined || idSibling === undefined || idOther === undefined) {
			throw new Error("expected three distinct credentials");
		}

		await storage.limits.rotate(PROVIDER, undefined, {
			credentialId: idA,
			error: Object.assign(new Error("deactivated_workspace"), { status: 402 }),
		});

		const blocked = new Set(storage.blocks.list([idA, idSibling, idOther]).map(block => block.credentialId));
		expect(blocked.has(idA)).toBe(true);
		// Shared accountId alone must not fan out across different org workspaces.
		expect(blocked.has(idSibling)).toBe(false);
		expect(blocked.has(idOther)).toBe(false);

		const key = await storage.keys.get(PROVIDER, "fresh-session");
		expect(key === "access-team-a-sibling" || key === "access-team-b").toBe(true);
	});
});
