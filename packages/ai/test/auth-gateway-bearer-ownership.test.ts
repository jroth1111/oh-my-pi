import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveGatewayAccount } from "../src/auth-gateway/dispatch";
import { AuthStorage } from "../src/auth-storage";

it("attributes the actual OAuth bearer when a shared session is pinned to another account", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-bearer-owner-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"));
	const provider = "unit-oauth-owner";
	try {
		await storage.credentials.set(provider, [
			{
				type: "oauth",
				access: "first-bearer",
				refresh: "first-refresh",
				expires: Date.now() + 600000,
				accountId: "first-account",
				projectId: "first-project",
			},
			{
				type: "oauth",
				access: "second-bearer",
				refresh: "second-refresh",
				expires: Date.now() + 600000,
				accountId: "second-account",
				projectId: "second-project",
			},
		]);
		const second = storage.credentials
			.list(provider)
			.find(row => row.credential.type === "oauth" && row.credential.access === "second-bearer")!;
		expect(storage.sessions.pin(provider, "shared-session", second.id)).toBe(true);
		const firstOwner = resolveGatewayAccount(storage, provider, "shared-session", "first-bearer");
		const secondOwner = resolveGatewayAccount(storage, provider, "shared-session", "second-bearer");
		expect(firstOwner.startsWith("oauth:")).toBe(true);
		expect(firstOwner).not.toBe(secondOwner);
		expect(
			resolveGatewayAccount(
				storage,
				provider,
				"shared-session",
				JSON.stringify({ token: "first-bearer", projectId: "first-project" }),
			),
		).toBe(firstOwner);
		storage.keys.setRuntime(provider, "override-key");
		expect(resolveGatewayAccount(storage, provider, "shared-session", "override-key").startsWith("key:")).toBe(true);
	} finally {
		storage.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
