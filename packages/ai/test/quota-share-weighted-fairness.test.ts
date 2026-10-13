import { describe, expect, it } from "bun:test";
import { pickQuotaShare, type QuotaShareInput } from "../src/auth-gateway/quota-share";

describe("weighted quota scheduling", () => {
	for (const heavyWeight of [3, 5000]) {
		it(`preserves a 1:${heavyWeight} weighted share over complete scheduling cycles`, () => {
			const pool: QuotaShareInput[] = [
				{ id: "light", weight: 1, inFlight: 0, saturated: false },
				{ id: "heavy", weight: heavyWeight, inFlight: 0, saturated: false },
			];
			const rounds = (heavyWeight + 1) * 4;
			let heavyPicks = 0;
			for (let round = 0; round < rounds; round++) {
				const pick = pickQuotaShare(pool)!;
				if (pick.id === "heavy") heavyPicks++;
				for (const candidate of pool)
					candidate.deficit = pick.deficitUpdates.find(update => update.id === candidate.id)!.deficit;
			}
			expect(heavyPicks).toBe(heavyWeight * 4);
		});
	}
});
