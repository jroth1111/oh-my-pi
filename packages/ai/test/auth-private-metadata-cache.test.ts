import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PrivateAuthMetadataCache } from "../src/auth/private-metadata-cache";

it("persists only private routing keys and prunes expired rows without touching live metadata", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-auth-metadata-"));
	const file = path.join(directory, "private", "state.db");
	let cache = new PrivateAuthMetadataCache(file);
	try {
		const live = "session:sticky:provider:live";
		const expired = "response:owner:v1:expired";
		const expiresAtSec = Math.floor(Date.now() / 1000);
		cache.setCache(live, "non-secret routing metadata", expiresAtSec + 60);
		cache.setCache(expired, "expired routing metadata", expiresAtSec - 1);
		expect(() => cache.setCache("usage:bearer", "must-not-persist", expiresAtSec + 60)).toThrow(
			"Only private routing metadata",
		);
		expect(cache.getCache(expired)).toBeNull();
		cache.close();
		cache = new PrivateAuthMetadataCache(file);
		expect(cache.getCache(live)).toBe("non-secret routing metadata");
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		const readback = new Database(file, { readonly: true });
		try {
			expect(readback.query<{ key: string }, []>("SELECT key FROM private_metadata").all()).toEqual([{ key: live }]);
		} finally {
			readback.close();
		}
		cache.deleteCachePrefix("session:sticky:provider:");
		expect(cache.getCache(live)).toBeNull();
	} finally {
		cache.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
