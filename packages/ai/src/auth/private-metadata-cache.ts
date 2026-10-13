import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { openSqliteDatabaseSync } from "@oh-my-pi/pi-utils/sqlite";
import { SESSION_STICKY_CACHE_PREFIX } from "./affinity";
import { RESPONSE_OWNER_CACHE_PREFIX } from "./response-owners";

const DELETE_EXPIRED = "DELETE FROM private_metadata WHERE expires_at <= ?";

/** Only routing metadata may reach this database; bearer and usage caches remain ephemeral. */
export function isPrivateAuthMetadataKey(key: string): boolean {
	return key.startsWith(SESSION_STICKY_CACHE_PREFIX) || key.startsWith(RESPONSE_OWNER_CACHE_PREFIX);
}

/** Private, expiring session/response state for broker clients, never a local credential database. */
export class PrivateAuthMetadataCache {
	readonly #db: Database;
	#nextCleanupAtMs = 0;

	constructor(file: string) {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		this.#db = openSqliteDatabaseSync(file, db => {
			fs.chmodSync(file, 0o600);
			db.run("PRAGMA journal_mode=WAL");
			db.run(
				"CREATE TABLE IF NOT EXISTS private_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL) WITHOUT ROWID",
			);
			db.query(DELETE_EXPIRED).run(Math.floor(Date.now() / 1000));
			return db;
		});
		this.#nextCleanupAtMs = Date.now() + 60 * 60 * 1000;
	}

	getCache(key: string): string | null {
		if (!isPrivateAuthMetadataKey(key)) return null;
		return (
			this.#db
				.query<{ value: string }, [string, number]>(
					"SELECT value FROM private_metadata WHERE key = ? AND expires_at > ?",
				)
				.get(key, Math.floor(Date.now() / 1000))?.value ?? null
		);
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		if (!isPrivateAuthMetadataKey(key)) throw new Error("Only private routing metadata may be persisted");
		if (Date.now() >= this.#nextCleanupAtMs) this.cleanExpiredCache();
		this.#db
			.query(
				"INSERT INTO private_metadata (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
			)
			.run(key, value, expiresAtSec);
	}

	deleteCachePrefix(prefix: string): void {
		this.#db.query("DELETE FROM private_metadata WHERE substr(key, 1, ?) = ?").run(prefix.length, prefix);
	}

	cleanExpiredCache(): void {
		this.#db.query(DELETE_EXPIRED).run(Math.floor(Date.now() / 1000));
		this.#nextCleanupAtMs = Date.now() + 60 * 60 * 1000;
	}

	close(): void {
		this.#db.close();
	}
}
