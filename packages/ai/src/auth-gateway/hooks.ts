export interface GatewayHookContext {
	requestId: string;
	routeId: string;
	target?: string;
	generation: number;
}

export interface GatewayHooks {
	beforeRequest?(ctx: GatewayHookContext): void | Promise<void>;
	beforeAttempt?(ctx: GatewayHookContext): void | Promise<void>;
	afterAttempt?(ctx: GatewayHookContext & { ok: boolean }): void | Promise<void>;
	afterRequest?(ctx: GatewayHookContext & { ok: boolean }): void | Promise<void>;
}

/**
 * Invoke an optional gateway hook. Missing hooks are a no-op; thrown errors
 * propagate to the caller.
 */
export async function runHook<T>(fn: ((arg: T) => void | Promise<void>) | undefined, arg: T): Promise<void> {
	if (fn === undefined) return;
	await fn(arg);
}

/** Hook failures belong to the gateway, never to a completed provider attempt. */
export class GatewayHookError extends Error {
	readonly owner = "gateway";
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "GatewayHookError";
	}
}

/** Preserve runHook's public rejection contract while tagging gateway dispatch failures. */
export async function runGatewayHook<T>(fn: ((arg: T) => void | Promise<void>) | undefined, arg: T): Promise<void> {
	try {
		await runHook(fn, arg);
	} catch (error) {
		throw new GatewayHookError(error);
	}
}

/** Per-request completion guard shared by JSON returns, stream settlement and cancellation. */
export class GatewayRequestLifecycle {
	#hooks: GatewayHooks | undefined;
	#context: GatewayHookContext;
	#finished = false;
	constructor(hooks: GatewayHooks | undefined, context: GatewayHookContext) {
		this.#hooks = hooks;
		this.#context = { ...context };
	}
	async before(): Promise<void> {
		await runGatewayHook(this.#hooks?.beforeRequest, { ...this.#context });
	}
	async after(ok: boolean): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		await runGatewayHook(this.#hooks?.afterRequest, { ...this.#context, ok });
	}
}
