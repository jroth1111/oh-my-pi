import type { Usage } from "../types";

/** Any reported work or charge makes a transparent replay unsafe. */
export function hasBillableUsage(usage: Usage): boolean {
	return [
		usage.input,
		usage.output,
		usage.cacheRead,
		usage.cacheWrite,
		usage.totalTokens,
		usage.reasoningTokens ?? 0,
		usage.premiumRequests ?? 0,
		usage.cost.input,
		usage.cost.output,
		usage.cost.cacheRead,
		usage.cost.cacheWrite,
		usage.cost.total,
		usage.orchestration?.input ?? 0,
		usage.orchestration?.output ?? 0,
		usage.orchestration?.cacheRead ?? 0,
		usage.credits?.cost ?? 0,
		usage.credits?.committedCost ?? 0,
		usage.credits?.acuCost ?? 0,
	].some(value => value > 0);
}
