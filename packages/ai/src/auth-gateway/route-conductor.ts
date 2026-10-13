import type { GatewayErrorClassification, GatewayErrorDisposition } from "../error/gateway";
import type { CompiledRoute } from "./route-graph";
import type { StreamCommitState } from "./stream-commit-gate";

export type ConductorAction =
	| { type: "dispatch"; targetModelId: string }
	| { type: "sibling_credential" }
	| { type: "fallback_target"; targetModelId: string }
	| { type: "terminal" };

export interface ExecutionState {
	routeId: string;
	generation: number;
	attemptedTargets: ReadonlySet<string>;
	retryCount: number;
	fallbackCount: number;
	committed: boolean;
	currentTarget: string;
	/** True after a sibling-credential retry for the current target failed. */
	siblingsExhausted: boolean;
}

function firstUnused(ids: readonly string[] | undefined, attempted: ReadonlySet<string>): string | undefined {
	if (!ids) return undefined;
	for (const id of ids) {
		if (!attempted.has(id)) return id;
	}
	return undefined;
}

function fallbackTargets(
	route: CompiledRoute,
	currentTarget: string,
	disposition: GatewayErrorDisposition,
): readonly string[] | undefined {
	const scoped = route.fallbackByTarget[currentTarget]?.[disposition];
	// Cache preference can start a flat fallback on a later target. Availability
	// failure must try unused predecessors before tertiary output can commit.
	// Nested graphs and context/credential failures retain their scoped edges.
	if (
		(disposition === "provider_transient" ||
			disposition === "provider_unavailable" ||
			disposition === "model_unavailable") &&
		route.root.type === "fallback" &&
		route.root.on.includes(disposition) &&
		route.root.children.every(child => child.type === "target")
	) {
		return [...route.targets.slice(0, route.targets.indexOf(currentTarget)), ...(scoped ?? [])];
	}
	return scoped;
}

/**
 * Pure next-action picker. Does not select accounts or perform I/O.
 * Cross-model failover is forbidden once the stream has left `probing`.
 */
export function decideAttempt(args: {
	route: CompiledRoute;
	state: ExecutionState;
	classification?: GatewayErrorClassification;
	commitState: StreamCommitState;
}): ConductorAction {
	const { state, classification, commitState } = args;
	const route = args.route;

	if (
		commitState !== "probing" ||
		state.committed ||
		state.routeId !== route.id ||
		state.generation !== route.generation
	) {
		return { type: "terminal" };
	}

	if (!classification) {
		const next = firstUnused(route.targets, state.attemptedTargets);
		return next === undefined ? { type: "terminal" } : { type: "dispatch", targetModelId: next };
	}

	const { disposition } = classification;
	if (!route.targets.includes(state.currentTarget)) return { type: "terminal" };
	switch (disposition) {
		case "cancelled":
		case "request_terminal":
		case "policy_terminal":
		case "gateway_terminal":
			return { type: "terminal" };
		case "credential_quota":
		case "credential_transient":
		case "credential_permanent": {
			if (!state.siblingsExhausted) {
				return { type: "sibling_credential" };
			}
			const next = firstUnused(fallbackTargets(route, state.currentTarget, disposition), state.attemptedTargets);
			return next === undefined ? { type: "terminal" } : { type: "fallback_target", targetModelId: next };
		}
		case "provider_transient":
		case "provider_unavailable":
		case "model_unavailable":
		case "context_overflow": {
			const next = firstUnused(fallbackTargets(route, state.currentTarget, disposition), state.attemptedTargets);
			return next === undefined ? { type: "terminal" } : { type: "fallback_target", targetModelId: next };
		}
		default: {
			const _never: never = disposition;
			void _never;
			return { type: "terminal" };
		}
	}
}
