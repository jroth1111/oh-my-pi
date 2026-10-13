import * as AIError from "../error";
import { type GatewayErrorDisposition, RETRYABLE_GATEWAY_DISPOSITIONS } from "../error/gateway";
import type { Api, Model } from "../types";
import type { AffinityLevel, StatePortability } from "./affinity";

export type TargetNode = { type: "target"; model: string; weight?: number };

export type FallbackNode = {
	type: "fallback";
	on: readonly GatewayErrorDisposition[];
	children: readonly RouteNode[];
};

export type BalanceNode = { type: "balance"; strategy: "rr" | "weighted"; children: readonly RouteNode[] };
export type ConditionalNode = { type: "conditional"; when: { vision?: boolean }; children: readonly RouteNode[] };
export type DomainNode = { type: "domain"; name: string; children: readonly RouteNode[] };
export type RouteRefNode = { type: "route-ref"; route: string };
export type RouteNode = TargetNode | FallbackNode | BalanceNode | ConditionalNode | DomainNode | RouteRefNode;

export interface RouteRequestFacts {
	vision: boolean;
}

export interface RouteDefinition {
	id: string;
	root: RouteNode;
	affinity?: AffinityLevel;
	portability?: StatePortability;
}

export interface CompiledRoute {
	generation: number;
	id: string;
	requestFacts?: Readonly<RouteRequestFacts>;
	affinity?: AffinityLevel;
	portability?: Readonly<StatePortability>;
	root: RouteNode;
	/** DFS target model ids in visit order (primary first). */
	targets: readonly string[];
	/**
	 * Union of next unused target ids per disposition (listing / diagnostics).
	 * Runtime failover uses {@link fallbackByTarget} so nested rules stay scoped.
	 */
	fallbacks: Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>>;
	/**
	 * From-target → disposition → next targets. Nested fallback edges only apply
	 * when the failing target is inside that fallback branch.
	 */
	fallbackByTarget: Readonly<
		Partial<Record<string, Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>>>>
	>;
}

type ResolveModel = (modelId: string) => Model<Api> | undefined;

const MAX_ROUTE_SELECTION_STATES = 4096;

type NodeCompile = {
	targets: string[];
	entries: string[];
	/** disposition → fromTarget → tos */
	fallbacksByFrom: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>>;
};

/** Target IDs are arbitrary data, including Object.prototype property names. */
function routeRecord<T>(): Partial<Record<string, T>> {
	return Object.create(null) as Partial<Record<string, T>>;
}

/**
 * Compiled-route registry: virtual fallback trees plus a single-target wrap for
 * concrete models. Unknown ids stay undefined (gateway 404). No YAML loader.
 */
export class RouteRegistry {
	#generation = 1;
	#resolveModel: ResolveModel;
	#routes = new Map<string, CompiledRoute>();
	#definitions = new Map<string, RouteNode>();
	#policies = new Map<string, { affinity?: AffinityLevel; portability?: Readonly<StatePortability> }>();
	#models = new WeakMap<CompiledRoute, ReadonlyMap<string, Model<Api>>>();
	#selections = new Map<string, { signature: string; position: number; credits: number[] }>();

	constructor(resolveModel: ResolveModel) {
		this.#resolveModel = resolveModel;
	}

	get generation(): number {
		return this.#generation;
	}

	/** Register/replace a virtual route. Bumps generation. Rejects cycles and empty fallback children. */
	register(definition: RouteDefinition): void {
		this.registerMany([definition]);
	}

	/** Validate the whole boot batch before mutation; references are independent of declaration order. */
	registerMany(definitions: readonly RouteDefinition[]): void {
		if (definitions.length) this.#applyDefinitions(definitions, false);
	}

	/** Atomically replace the complete virtual registry; refs can only name incoming definitions. */
	replaceAll(definitions: readonly RouteDefinition[]): void {
		this.#applyDefinitions(definitions, true);
	}

	#applyDefinitions(definitions: readonly RouteDefinition[], replace: boolean): void {
		const roots = new Map(replace ? undefined : this.#definitions);
		const ids = new Set<string>();
		for (const definition of definitions) {
			if (!definition.id.trim() || definition.id === "." || definition.id === "..")
				throw new AIError.ValidationError("Route id cannot be empty or a dot segment");
			if (ids.has(definition.id)) throw new AIError.ValidationError(`Duplicate route id: ${definition.id}`);
			ids.add(definition.id);
			roots.set(definition.id, definition.root);
		}
		const nextDefinitions = new Map(replace ? undefined : this.#definitions);
		const nextRoutes = new Map(replace ? undefined : this.#routes);
		const nextPolicies = new Map(replace ? undefined : this.#policies);
		let generation = this.#generation + (replace ? 1 : 0);
		for (const definition of definitions) {
			const expanded = expandRouteRefs(definition.root, id => roots.get(id), new Set([definition.id]));
			compileNode(expanded, new Set());
			const root = copyNode(expanded);
			const policy = {
				...(definition.affinity !== undefined ? { affinity: definition.affinity } : {}),
				...(definition.portability !== undefined
					? { portability: Object.freeze({ ...definition.portability }) }
					: {}),
			};
			const compiled = this.#compile(definition.id, root, replace ? generation : ++generation, undefined, policy);
			nextDefinitions.set(definition.id, root);
			nextRoutes.set(definition.id, compiled);
			nextPolicies.set(definition.id, policy);
		}
		this.#generation = generation;
		this.#definitions = nextDefinitions;
		this.#routes = nextRoutes;
		this.#policies = nextPolicies;
		this.#selections.clear();
	}

	/** Remove a registered virtual route. Existing request snapshots remain valid. */
	unregister(id: string): boolean {
		if (!this.#routes.delete(id)) return false;
		this.#definitions.delete(id);
		this.#policies.delete(id);
		this.#selections.clear();
		this.#generation += 1;
		return true;
	}

	/** A route's model snapshots remain private and are never resolved again during dispatch. */
	getModel(route: CompiledRoute, target: string | undefined = route.targets[0]): Model<Api> | undefined {
		return target === undefined ? undefined : this.#models.get(route)?.get(target);
	}

	#compile(
		id: string,
		source: RouteNode,
		generation: number,
		facts?: RouteRequestFacts,
		policy: { affinity?: AffinityLevel; portability?: Readonly<StatePortability> } = this.#policies.get(id) ?? {},
	): CompiledRoute {
		const resolved = new Map<string, Model<Api> | undefined>();
		const models = new Map<string, Model<Api>>();
		const normalize = (node: RouteNode): RouteNode => {
			if (node.type === "route-ref") throw new AIError.ValidationError("Unresolved route-ref");
			if (node.type !== "target") return copyNode({ ...node, children: node.children.map(normalize) });
			if (!resolved.has(node.model)) resolved.set(node.model, this.#resolveModel(node.model));
			const model = resolved.get(node.model);
			const target = model ? `${model.provider}/${model.id}` : node.model;
			if (model) models.set(target, model);
			return Object.freeze({ ...node, model: target });
		};
		const root = normalize(source);
		const compiled = compileNode(root, new Set());
		const route: CompiledRoute = Object.freeze({
			generation,
			id,
			...policy,
			...(facts ? { requestFacts: Object.freeze({ ...facts }) } : {}),
			root,
			targets: Object.freeze([...compiled.targets]),
			fallbacks: freezeFallbacksUnion(compiled.fallbacksByFrom, compiled.targets),
			fallbackByTarget: freezeFallbacksByTarget(compiled.fallbacksByFrom),
		});
		this.#models.set(route, models);
		return route;
	}

	/** A registered virtual route only; never wraps a concrete catalog model. */
	get(id: string): CompiledRoute | undefined {
		return this.#routes.has(id) ? this.resolve(id) : undefined;
	}

	/** Virtual routes only, with the same current catalog snapshots used by request resolution. */
	list(): readonly CompiledRoute[] {
		return Object.freeze(
			[...this.#routes.keys()].flatMap(id => {
				const route = this.resolve(id);
				return route ? [route] : [];
			}),
		);
	}

	/** Choose at each actual balance node, never among fallback-only descendants. */
	pickInitialTarget(compiled: CompiledRoute): string | undefined {
		const choose = (node: RouteNode, path: string): string | undefined => {
			if (node.type === "target") return node.model;
			if (node.type === "route-ref" || node.children.length === 0) return undefined;
			let index = 0;
			if (node.type === "balance") {
				const key = JSON.stringify([compiled.id, compiled.generation, compiled.requestFacts?.vision, path]);
				const signature = JSON.stringify(node);
				let state = this.#selections.get(key);
				if (!state || state.signature !== signature)
					state = { signature, position: 0, credits: node.children.map(() => 0) };
				if (node.strategy === "rr") index = state.position++ % node.children.length;
				else {
					const weights = node.children.map(child => (child.type === "target" ? (child.weight ?? 1) : 1));
					const scale = weights.reduce((maximum, weight) => Math.max(maximum, weight), 0);
					let total = 0;
					for (let i = 0; i < weights.length; i++) {
						const weight = weights[i]! / scale;
						total += weight;
						state.credits[i] = state.credits[i]! + weight;
						if (state.credits[i]! > state.credits[index]!) index = i;
					}
					state.credits[index] = state.credits[index]! - total;
				}
				this.#selections.delete(key);
				this.#selections.set(key, state);
				if (this.#selections.size > MAX_ROUTE_SELECTION_STATES)
					this.#selections.delete(this.#selections.keys().next().value!);
			}
			return choose(node.children[index]!, `${path}/${index}`);
		};
		return choose(compiled.root, "");
	}

	resolve(modelId: string, facts?: RouteRequestFacts): CompiledRoute | undefined {
		const virtual = this.#routes.get(modelId);
		if (virtual) {
			const source = this.#definitions.get(modelId)!;
			const selected = facts ? selectRequestNode(source, facts) : source;
			return selected ? this.#compile(modelId, selected, virtual.generation, facts) : undefined;
		}
		const model = this.#resolveModel(modelId);
		if (!model) return undefined;
		const target = `${model.provider}/${model.id}`;
		const route: CompiledRoute = Object.freeze({
			generation: this.#generation,
			id: modelId,
			root: Object.freeze({ type: "target", model: target }),
			targets: Object.freeze([target]),
			fallbacks: Object.freeze({}),
			fallbackByTarget: Object.freeze({}),
		});
		this.#models.set(route, new Map([[target, model]]));
		return route;
	}
}

function compileNode(
	node: RouteNode,
	seenOnPath: ReadonlySet<string>,
	active: ReadonlySet<RouteNode> = new Set(),
): NodeCompile {
	if (active.has(node)) throw new AIError.ValidationError("Route cycle: a node repeats on one structural path");
	const activeChildren = new Set(active);
	activeChildren.add(node);
	if (node.type === "target") {
		if (seenOnPath.has(node.model)) {
			throw new AIError.ValidationError(`Route cycle: model "${node.model}" repeats on one path`);
		}
		return { targets: [node.model], entries: [node.model], fallbacksByFrom: {} };
	}
	if (node.type === "route-ref") throw new AIError.ValidationError("Unresolved route-ref");
	if (node.children.length === 0) {
		throw new AIError.ValidationError("Fallback node has empty children");
	}

	const targets: string[] = [];
	const fallbacksByFrom: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>> = routeRecord();
	const sequential = new Set(seenOnPath);
	const childParts: Array<{ fromTargets: string[]; after: string[] }> = [];
	const entryTargetsPerChild: string[][] = [];
	const allTargetsPerChild: string[][] = [];
	for (const child of node.children) {
		// Independent ancestor copy per sibling. Fallback subtrees must not
		// inherit sequential sibling targets — those are other leaves.
		const childSeen = new Set(child.type === "target" ? sequential : seenOnPath);
		const part = compileNode(child, childSeen, activeChildren);
		targets.push(...part.targets);
		allTargetsPerChild.push([...part.targets]);
		entryTargetsPerChild.push(part.entries);
		mergeFallbacksByFrom(fallbacksByFrom, part.fallbacksByFrom);
		if (child.type === "target") sequential.add(child.model);
	}
	// fallbackByTarget is keyed by model id; the same id in multiple sibling
	// subtrees would merge nested edges across unreached branches.
	const owner = new Map<string, number>();
	for (let i = 0; i < allTargetsPerChild.length; i += 1) {
		for (const id of allTargetsPerChild[i]!) {
			const prev = owner.get(id);
			if (prev !== undefined && prev !== i) {
				throw new AIError.ValidationError(`Ambiguous cross-branch reuse of model "${id}" under one fallback`);
			}
			owner.set(id, i);
		}
	}
	// Every target in a child inherits outer edges to later subtree entry targets.
	for (let i = 0; i < entryTargetsPerChild.length; i += 1) {
		const suffix: string[] = [];
		for (let j = i + 1; j < entryTargetsPerChild.length; j += 1) {
			suffix.push(...entryTargetsPerChild[j]!);
		}
		childParts.push({ fromTargets: allTargetsPerChild[i]!, after: suffix });
	}
	const dispositions =
		node.type === "fallback"
			? node.on
			: node.type === "domain" || node.type === "balance"
				? RETRYABLE_GATEWAY_DISPOSITIONS
				: [];
	for (const disposition of dispositions) {
		let byFrom = fallbacksByFrom[disposition];
		if (!byFrom) {
			byFrom = routeRecord();
			fallbacksByFrom[disposition] = byFrom;
		}
		for (let i = 0; i < childParts.length; i++) {
			const part = childParts[i]!;
			if (node.type === "balance") part.after = entryTargetsPerChild.filter((_, index) => index !== i).flat();
			if (part.after.length === 0) continue;
			for (const from of part.fromTargets) {
				const existing = byFrom[from];
				byFrom[from] = existing ? [...existing, ...part.after] : [...part.after];
			}
		}
	}
	const entries =
		node.type === "fallback" || node.type === "domain"
			? (entryTargetsPerChild[0] ?? [])
			: entryTargetsPerChild.flat();
	return { targets, entries, fallbacksByFrom };
}

function copyNode(node: RouteNode): RouteNode {
	if (node.type === "target") {
		return Object.freeze({ ...node });
	}
	if (node.type === "route-ref") return Object.freeze({ ...node });
	const children = Object.freeze(node.children.map(copyNode));
	if (node.type === "fallback") return Object.freeze({ ...node, on: Object.freeze([...node.on]), children });
	if (node.type === "conditional") return Object.freeze({ ...node, when: Object.freeze({ ...node.when }), children });
	return Object.freeze({ ...node, children });
}

function expandRouteRefs(
	node: RouteNode,
	lookup: (id: string) => RouteNode | undefined,
	references: ReadonlySet<string>,
	active: ReadonlySet<RouteNode> = new Set(),
	depth = 0,
): RouteNode {
	if (depth > 256) throw new AIError.ValidationError("Route tree exceeds the maximum depth of 256");
	if (active.has(node)) throw new AIError.ValidationError("Route structural cycle");
	const descendants = new Set(active);
	descendants.add(node);
	if (node.type === "route-ref") {
		if (references.has(node.route)) throw new AIError.ValidationError(`Route reference cycle: ${node.route}`);
		const resolved = lookup(node.route);
		if (!resolved) throw new AIError.ValidationError(`Unresolved route-ref: ${node.route}`);
		return expandRouteRefs(resolved, lookup, new Set([...references, node.route]), descendants, depth + 1);
	}
	if (node.type === "target") {
		if (!node.model.trim()) throw new AIError.ValidationError("Target node missing model");
		if (node.weight !== undefined && (!Number.isFinite(node.weight) || node.weight <= 0))
			throw new AIError.ValidationError("Target weight must be positive and finite");
		return { ...node };
	}
	if (!node.children.length) throw new AIError.ValidationError("Route node has empty children");
	if (node.type === "conditional") {
		if (node.children.length > 2)
			throw new AIError.ValidationError("Conditional routes accept a matching branch and optional alternative");
		if (node.when.vision !== undefined && typeof node.when.vision !== "boolean")
			throw new AIError.ValidationError("Conditional when.vision must be a boolean");
	}
	if (node.type === "balance" && node.strategy !== "rr" && node.strategy !== "weighted")
		throw new AIError.ValidationError("Unknown balance strategy");
	if (node.type === "domain" && !node.name.trim()) throw new AIError.ValidationError("Domain node missing name");
	return copyNode({
		...node,
		children: node.children.map(child => expandRouteRefs(child, lookup, references, descendants, depth + 1)),
	});
}

function selectRequestNode(node: RouteNode, facts: RouteRequestFacts): RouteNode | undefined {
	if (node.type === "target" || node.type === "route-ref") return node;
	if (node.type === "conditional") {
		const matches = node.when.vision === undefined || node.when.vision === facts.vision;
		const selected = node.children[matches ? 0 : 1];
		return selected ? selectRequestNode(selected, facts) : undefined;
	}
	const children = node.children.flatMap(child => {
		const selected = selectRequestNode(child, facts);
		return selected ? [selected] : [];
	});
	return children.length ? copyNode({ ...node, children }) : undefined;
}

function mergeFallbacksByFrom(
	dest: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>>,
	src: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>>,
): void {
	for (const key of Object.keys(src) as GatewayErrorDisposition[]) {
		const fromMap = src[key];
		if (!fromMap) continue;
		let destFrom = dest[key];
		if (!destFrom) {
			destFrom = routeRecord();
			dest[key] = destFrom;
		}
		for (const [from, tos] of Object.entries(fromMap)) {
			if (!tos || tos.length === 0) continue;
			const existing = destFrom[from];
			destFrom[from] = existing ? [...existing, ...tos] : [...tos];
		}
	}
}

function freezeFallbacksUnion(
	fallbacksByFrom: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>>,
	targets: readonly string[],
): Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>> {
	const out: Partial<Record<GatewayErrorDisposition, readonly string[]>> = routeRecord();
	for (const key of Object.keys(fallbacksByFrom) as GatewayErrorDisposition[]) {
		const fromMap = fallbacksByFrom[key];
		if (!fromMap) continue;
		const seen = new Set<string>();
		const list: string[] = [];
		for (const source of targets) {
			const tos = fromMap[source];
			if (!tos) continue;
			for (const id of tos) {
				if (seen.has(id)) continue;
				seen.add(id);
				list.push(id);
			}
		}
		if (list.length > 0) out[key] = Object.freeze(list);
	}
	return Object.freeze(out);
}

function freezeFallbacksByTarget(
	fallbacksByFrom: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>>,
): Readonly<Partial<Record<string, Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>>>>> {
	const byTarget: Partial<Record<string, Partial<Record<GatewayErrorDisposition, string[]>>>> = routeRecord();
	for (const disposition of Object.keys(fallbacksByFrom) as GatewayErrorDisposition[]) {
		const fromMap = fallbacksByFrom[disposition];
		if (!fromMap) continue;
		for (const [from, tos] of Object.entries(fromMap)) {
			if (!tos || tos.length === 0) continue;
			let dest = byTarget[from];
			if (!dest) {
				dest = routeRecord();
				byTarget[from] = dest;
			}
			const existing = dest[disposition];
			dest[disposition] = existing ? [...existing, ...tos] : [...tos];
		}
	}
	const out: Partial<Record<string, Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>>>> =
		routeRecord();
	for (const [from, dispMap] of Object.entries(byTarget)) {
		if (!dispMap) continue;
		const frozen: Partial<Record<GatewayErrorDisposition, readonly string[]>> = routeRecord();
		for (const disposition of Object.keys(dispMap) as GatewayErrorDisposition[]) {
			const list = dispMap[disposition];
			if (!list || list.length === 0) continue;
			frozen[disposition] = Object.freeze([...list]);
		}
		out[from] = Object.freeze(frozen);
	}
	return Object.freeze(out);
}
