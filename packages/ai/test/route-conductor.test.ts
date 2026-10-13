import { describe, expect, it } from "bun:test";
import type { CompiledRoute } from "@oh-my-pi/pi-ai/auth-gateway";
import { decideAttempt, type ExecutionState } from "@oh-my-pi/pi-ai/auth-gateway/route-conductor";
import type { GatewayErrorClassification, GatewayErrorDisposition } from "@oh-my-pi/pi-ai/error";
import { RouteRegistry } from "../src/auth-gateway/route-graph";

function route(
	overrides: {
		targets?: readonly string[];
		fallbacks?: Partial<Record<GatewayErrorDisposition, readonly string[]>>;
	} = {},
): CompiledRoute {
	const fallbacks = overrides.fallbacks ?? { provider_unavailable: ["backup", "tertiary"] };
	return {
		generation: 1,
		id: "virtual/primary",
		root: { type: "target", model: "primary" },
		targets: overrides.targets ?? [
			...new Set(["primary", "backup", ...Object.values(fallbacks).flatMap(value => value ?? [])]),
		],
		fallbacks,
		fallbackByTarget: { primary: fallbacks },
	};
}

function state(overrides: Partial<ExecutionState> = {}): ExecutionState {
	return {
		routeId: "virtual/primary",
		generation: 1,
		attemptedTargets: new Set(),
		retryCount: 0,
		fallbackCount: 0,
		committed: false,
		currentTarget: "primary",
		siblingsExhausted: false,
		...overrides,
	};
}

function classification(disposition: GatewayErrorDisposition): GatewayErrorClassification {
	return {
		status: 503,
		type: "error",
		message: disposition,
		owner: "provider",
		disposition,
	};
}

describe("decideAttempt", () => {
	it("dispatches the first unused target when classification is absent", () => {
		const action = decideAttempt({
			route: route(),
			state: state({ attemptedTargets: new Set(["primary"]) }),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "dispatch", targetModelId: "backup" });
	});

	it("returns terminal after commit even when fallbacks remain (negative)", () => {
		const fallbacks = { provider_unavailable: ["backup"] as const };
		const probingCommitted = decideAttempt({
			route: route({ fallbacks }),
			state: state({ committed: true }),
			classification: classification("provider_unavailable"),
			commitState: "probing",
		});
		const streamCommitted = decideAttempt({
			route: route({ fallbacks }),
			state: state(),
			classification: classification("provider_unavailable"),
			commitState: "committed",
		});
		const streamTerminated = decideAttempt({
			route: route({ fallbacks }),
			state: state(),
			classification: classification("provider_unavailable"),
			commitState: "terminated",
		});
		expect(probingCommitted).toEqual({ type: "terminal" });
		expect(streamCommitted).toEqual({ type: "terminal" });
		expect(streamTerminated).toEqual({ type: "terminal" });
	});

	it("returns sibling_credential on credential_transient", () => {
		const action = decideAttempt({
			route: route(),
			state: state({ attemptedTargets: new Set(["primary"]) }),
			classification: classification("credential_transient"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "sibling_credential" });
	});

	it("returns sibling_credential on credential_permanent before exhaustion", () => {
		const action = decideAttempt({
			route: route(),
			state: state({ attemptedTargets: new Set(["primary"]) }),
			classification: classification("credential_permanent"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "sibling_credential" });
	});

	it("falls back to the first unused fallbacks-map id on provider_unavailable", () => {
		const action = decideAttempt({
			route: route({ fallbacks: { provider_unavailable: ["backup", "tertiary"] } }),
			state: state({ attemptedTargets: new Set(["primary", "backup"]) }),
			classification: classification("provider_unavailable"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "fallback_target", targetModelId: "tertiary" });
	});

	it("falls back to quota targets once siblings are exhausted", () => {
		const action = decideAttempt({
			route: route({ fallbacks: { credential_quota: ["claude", "gemini"] } }),
			state: state({ attemptedTargets: new Set(["primary"]), siblingsExhausted: true }),
			classification: classification("credential_quota"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "fallback_target", targetModelId: "claude" });
	});

	it("falls back to configured targets after permanent credential failure exhausts siblings", () => {
		const action = decideAttempt({
			route: route({ fallbacks: { credential_permanent: ["foreign/provider-model"] } }),
			state: state({ attemptedTargets: new Set(["primary"]), siblingsExhausted: true }),
			classification: classification("credential_permanent"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "fallback_target", targetModelId: "foreign/provider-model" });
	});

	it("returns terminal on request_terminal", () => {
		const action = decideAttempt({
			route: route(),
			state: state({ attemptedTargets: new Set(["primary"]) }),
			classification: classification("request_terminal"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "terminal" });
	});

	it("returns terminal when fallbacks are exhausted (negative)", () => {
		const action = decideAttempt({
			route: route({ fallbacks: { provider_unavailable: ["backup"] } }),
			state: state({ attemptedTargets: new Set(["primary", "backup"]) }),
			classification: classification("provider_unavailable"),
			commitState: "probing",
		});
		expect(action).toEqual({ type: "terminal" });
	});
});

it("does not enter a nested-only branch from an unrelated target or the diagnostic union", () => {
	const registry = new RouteRegistry(() => undefined);
	registry.register({
		id: "nested",
		root: {
			type: "fallback",
			on: ["credential_quota"],
			children: [
				{ type: "target", model: "A" },
				{
					type: "fallback",
					on: ["context_overflow"],
					children: [
						{ type: "target", model: "B" },
						{ type: "target", model: "C" },
					],
				},
				{ type: "target", model: "D" },
			],
		},
	});
	const compiled = registry.resolve("nested")!;
	const snapshot = (currentTarget: string, attempted: string[]): ExecutionState =>
		state({
			routeId: compiled.id,
			generation: compiled.generation,
			currentTarget,
			attemptedTargets: new Set(attempted),
			siblingsExhausted: true,
		});
	expect(
		decideAttempt({
			route: compiled,
			state: snapshot("A", ["A"]),
			classification: classification("context_overflow"),
			commitState: "probing",
		}),
	).toEqual({ type: "terminal" });
	expect(
		decideAttempt({
			route: compiled,
			state: snapshot("A", ["A"]),
			classification: classification("credential_quota"),
			commitState: "probing",
		}),
	).toEqual({ type: "fallback_target", targetModelId: "B" });
	expect(
		decideAttempt({
			route: compiled,
			state: snapshot("B", ["A", "B"]),
			classification: classification("credential_quota"),
			commitState: "probing",
		}),
	).toEqual({ type: "fallback_target", targetModelId: "D" });
	expect(
		decideAttempt({
			route: compiled,
			state: snapshot("B", ["A", "B"]),
			classification: classification("context_overflow"),
			commitState: "probing",
		}),
	).toEqual({ type: "fallback_target", targetModelId: "C" });
	expect(
		decideAttempt({
			route: compiled,
			state: snapshot("D", ["A", "B", "D"]),
			classification: classification("context_overflow"),
			commitState: "probing",
		}),
	).toEqual({ type: "terminal" });
});

for (const disposition of ["cancelled", "request_terminal", "policy_terminal", "gateway_terminal"] as const) {
	it(`never dispatches a configured fallback for ${disposition}`, () => {
		expect(
			decideAttempt({
				route: route({ fallbacks: { [disposition]: ["backup"] } }),
				state: state({ siblingsExhausted: true }),
				classification: classification(disposition),
				commitState: "probing",
			}),
		).toEqual({ type: "terminal" });
	});
}

it("rejects stale route identities and generations without mutating execution state", () => {
	const compiled = route();
	for (const execution of [
		state({ generation: 0 }),
		state({ routeId: "other" }),
		state({ currentTarget: "not-in-route" }),
	]) {
		const before = { ...execution, attemptedTargets: [...execution.attemptedTargets] };
		expect(
			decideAttempt({
				route: compiled,
				state: execution,
				classification: classification("provider_unavailable"),
				commitState: "probing",
			}),
		).toEqual({ type: "terminal" });
		expect({ ...execution, attemptedTargets: [...execution.attemptedTargets] }).toEqual(before);
	}
});

for (const disposition of ["provider_unavailable", "provider_transient", "model_unavailable"] as const)
	it(`tries unused earlier flat targets before later candidates for ${disposition}`, () => {
		const registry = new RouteRegistry(() => undefined);
		registry.register({
			id: "preferred-flat",
			root: {
				type: "fallback",
				on: [disposition],
				children: [
					{ type: "target", model: "A" },
					{ type: "target", model: "B" },
					{ type: "target", model: "C" },
				],
			},
		});
		const compiled = registry.resolve("preferred-flat")!;
		expect(
			decideAttempt({
				route: compiled,
				state: state({
					routeId: compiled.id,
					generation: compiled.generation,
					currentTarget: "B",
					attemptedTargets: new Set(["B"]),
				}),
				classification: classification(disposition),
				commitState: "probing",
			}),
		).toEqual({ type: "fallback_target", targetModelId: "A" });
	});

it("keeps backwards recovery inside explicitly declared flat availability policies", () => {
	const registry = new RouteRegistry(() => undefined);
	registry.register({
		id: "context-only",
		root: {
			type: "fallback",
			on: ["context_overflow"],
			children: [
				{ type: "target", model: "A" },
				{ type: "target", model: "B" },
				{ type: "target", model: "C" },
			],
		},
	});
	const compiled = registry.resolve("context-only")!;
	const execution = state({
		routeId: compiled.id,
		generation: compiled.generation,
		currentTarget: "B",
		attemptedTargets: new Set(["B"]),
	});
	expect(
		decideAttempt({
			route: compiled,
			state: execution,
			classification: classification("provider_unavailable"),
			commitState: "probing",
		}),
	).toEqual({ type: "terminal" });
	expect(
		decideAttempt({
			route: compiled,
			state: execution,
			classification: classification("context_overflow"),
			commitState: "probing",
		}),
	).toEqual({ type: "fallback_target", targetModelId: "C" });
});
