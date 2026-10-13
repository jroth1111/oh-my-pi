import { logger } from "@oh-my-pi/pi-utils";
import type { CredentialCacheStore } from "./store";
import type { ResponseOwnersApi, StoredResponseOwner } from "./types";

export const RESPONSE_OWNER_CACHE_PREFIX = "response:owner:v1:";
const RESPONSE_OWNER_TTL_SEC = 30 * 24 * 60 * 60;
const MAX_MEMORY_OWNERS = 4096;

interface CachedOwner {
	owner: Readonly<StoredResponseOwner>;
	expiresAtSec: number;
}

/** Bounded hot lookup backed by expiring durable metadata, not a second credential store. */
export class ResponseOwners implements ResponseOwnersApi {
	readonly #store: CredentialCacheStore;
	readonly #owners = new Map<string, CachedOwner>();

	constructor(store: CredentialCacheStore) {
		this.#store = store;
	}

	get(responseId: string): Readonly<StoredResponseOwner> | undefined {
		const nowSec = Math.floor(Date.now() / 1000);
		const memory = this.#owners.get(responseId);
		if (memory && memory.expiresAtSec > nowSec) return memory.owner;
		this.#owners.delete(responseId);
		try {
			const raw = this.#store.getCache(this.#key(responseId));
			if (raw === null) return undefined;
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
			const record = parsed as Record<string, unknown>;
			const fields: unknown = record.owner;
			if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return undefined;
			const owner = fields as Record<string, unknown>;
			if (
				typeof record.expiresAtSec !== "number" ||
				!Number.isFinite(record.expiresAtSec) ||
				record.expiresAtSec <= nowSec ||
				typeof owner.sessionId !== "string" ||
				typeof owner.target !== "string" ||
				typeof owner.provider !== "string" ||
				typeof owner.api !== "string" ||
				typeof owner.endpoint !== "string" ||
				typeof owner.account !== "string" ||
				(owner.credentialId !== undefined &&
					(typeof owner.credentialId !== "number" ||
						!Number.isSafeInteger(owner.credentialId) ||
						owner.credentialId < 1))
			)
				return undefined;
			const binding: StoredResponseOwner = {
				sessionId: owner.sessionId,
				target: owner.target,
				provider: owner.provider,
				api: owner.api,
				endpoint: owner.endpoint,
				account: owner.account,
				...(owner.credentialId !== undefined ? { credentialId: owner.credentialId as number } : {}),
			};
			const cached = { owner: Object.freeze(binding), expiresAtSec: record.expiresAtSec };
			this.#remember(responseId, cached);
			return cached.owner;
		} catch {
			logger.debug("Failed to read persisted response ownership");
			return undefined;
		}
	}

	record(responseId: string | undefined, owner: StoredResponseOwner): void {
		if (!responseId) return;
		const cached = {
			owner: Object.freeze({
				sessionId: owner.sessionId,
				target: owner.target,
				provider: owner.provider,
				api: owner.api,
				endpoint: owner.endpoint,
				account: owner.account,
				...(owner.credentialId !== undefined ? { credentialId: owner.credentialId } : {}),
			}),
			expiresAtSec: Math.floor(Date.now() / 1000) + RESPONSE_OWNER_TTL_SEC,
		};
		this.#remember(responseId, cached);
		try {
			this.#store.setCache(this.#key(responseId), JSON.stringify(cached), cached.expiresAtSec);
		} catch {
			logger.debug("Failed to persist response ownership");
		}
	}

	#key(responseId: string): string {
		return `${RESPONSE_OWNER_CACHE_PREFIX}${Bun.SHA256.hash(responseId, "hex")}`;
	}

	#remember(responseId: string, cached: CachedOwner): void {
		this.#owners.delete(responseId);
		if (this.#owners.size >= MAX_MEMORY_OWNERS) this.#owners.delete(this.#owners.keys().next().value!);
		this.#owners.set(responseId, cached);
	}
}
