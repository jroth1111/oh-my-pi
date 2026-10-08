import { describe, expect, it } from "bun:test";
import { generateOfflineSeedCatalog } from "../scripts/generate-models";
import { buildModel } from "../src/build";

describe("offline provider seed regeneration", () => {
	it("replaces stale private rows with KDL seeds without changing upstream providers", () => {
		const upstream = buildModel({
			id: "upstream-model",
			provider: "openai",
			api: "openai-completions",
			name: "Upstream Model",
			baseUrl: "https://example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 65536,
			maxTokens: 4096,
		});
		const snapshot = { openai: { "upstream-model": upstream }, grokbot: { "private-account-only": upstream } };
		const result = generateOfflineSeedCatalog(snapshot, ["grokbot"]);
		const persisted = JSON.parse(JSON.stringify(result));
		expect(persisted.openai).toEqual(snapshot.openai);
		expect(persisted.grokbot["private-account-only"]).toBeUndefined();
		expect(persisted.grokbot["sand-automation"].sandToolsWire).toBe("automation");
		expect(persisted.grokbot.default.sandWireModelId).toBe("sand-default");
		expect(snapshot.grokbot["private-account-only"]).toBe(upstream);
	});

	it("rejects providers without authored bundled seeds instead of emptying their catalog", () => {
		expect(() => generateOfflineSeedCatalog({}, ["not-a-provider"])).toThrow("has no bundled seed");
	});
});
