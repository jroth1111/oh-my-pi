import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, resolveCredentialIdentityKey } from "../src/auth-storage";

for (const type of ["oauth", "api_key"] as const) {
	it(`resolves only the specified ${type} row even when the session hashes to its sibling`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "continuation-row-target-"));
		const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
		});
		const provider = "unit-row-owner";
		try {
			await storage.credentials.set(
				provider,
				type === "api_key"
					? [
							{ type: "api_key", key: "first" },
							{ type: "api_key", key: "second" },
						]
					: [
							{
								type: "oauth",
								access: "first",
								refresh: "first-refresh",
								expires: Date.now() + 3_600_000,
								accountId: "first",
							},
							{
								type: "oauth",
								access: "second",
								refresh: "second-refresh",
								expires: Date.now() + 3_600_000,
								accountId: "second",
							},
						],
			);
			const rows = storage.credentials.list(provider);
			const selected = rows[1 - (Bun.hash.xxHash32("row-target-session") % 2)]!;
			const expected = selected.credential.type === "oauth" ? selected.credential.access : selected.credential.key;
			expect(
				await storage.keys.getWithCredential(provider, "row-target-session", { credentialId: selected.id }),
			).toMatchObject({ apiKey: expected, credentialId: selected.id });
			expect(
				await storage.keys.get(provider, "row-target-session", {
					credentialId: Math.max(...rows.map(row => row.id)) + 1,
				}),
			).toBeUndefined();
			if (type === "oauth") {
				const other = rows.find(row => row.id !== selected.id)!;
				const identity = resolveCredentialIdentityKey(provider, other.credential);
				if (!identity) throw new Error("Expected sibling identity");
				const restriction = storage.sessions.restrict(provider, "restricted", [identity]);
				await expect(
					storage.keys.getWithCredential(provider, "restricted", { credentialId: selected.id }),
				).rejects.toThrow("restricted");
				storage.sessions.unrestrict(provider, "restricted", restriction);
			}
		} finally {
			storage.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
}
