import { DEFAULT_TURN_RESERVATION_TTL_MS, type AuthStorage } from "../auth-storage";
import type { AssistantMessage } from "../types";

/** Owns selection-time reservations and probes until the canonical inference outcome is known. */
export class GatewayCredentialTurn {
	readonly #storage: AuthStorage;
	readonly #requestId: string;
	readonly #controller: AbortController;
	readonly #onAbort = () => this.release();
	#timer: NodeJS.Timeout | undefined;
	#released = false;
	#streamOwned = false;
	#cancelSource: ((reason: unknown) => Promise<void>) | undefined;

	constructor(
		storage: AuthStorage,
		requestId: string,
		controller: AbortController,
		ttlMs = DEFAULT_TURN_RESERVATION_TTL_MS,
	) {
		if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > Number.MAX_SAFE_INTEGER - Date.now())
			throw new RangeError("Active turn TTL must be a positive finite duration");
		this.#storage = storage;
		this.#requestId = requestId;
		this.#controller = controller;
		if (controller.signal.aborted) {
			this.release();
			return;
		}
		controller.signal.addEventListener("abort", this.#onAbort, { once: true });
		this.#timer = setInterval(
			() => storage.coordination.renewTurnReservation(requestId, ttlMs),
			Math.max(1, Math.min(60_000, Math.floor(ttlMs / 3))),
		);
		this.#timer.unref();
	}

	get streamOwned(): boolean {
		return this.#streamOwned;
	}

	finish(message: Pick<AssistantMessage, "stopReason">): void {
		if (this.#released) return;
		if (
			!this.#controller.signal.aborted &&
			(message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse")
		)
			this.#storage.coordination.settleQuotaProbeSuccess(this.#requestId);
		this.release();
	}

	release(): void {
		if (this.#released) return;
		this.#released = true;
		clearInterval(this.#timer);
		this.#controller.signal.removeEventListener("abort", this.#onAbort);
		this.#storage.coordination.releaseTurnReservation(this.#requestId);
	}

	abort(reason: unknown): void {
		if (!this.#controller.signal.aborted) this.#controller.abort(reason);
		this.release();
		void this.#cancelSource?.(reason).catch(() => {});
	}

	/** EOF is not success: encoded errors may close normally, and transports need not emit raw SSE. */
	wrap(
		source: ReadableStream<Uint8Array>,
		result: () => Promise<AssistantMessage> | undefined,
		onSettled?: (ok: boolean) => Promise<void>,
	): ReadableStream<Uint8Array> {
		const reader = source.getReader();
		let settled = false;
		const settle = async (ok: boolean) => {
			if (settled) return;
			settled = true;
			await onSettled?.(ok);
		};
		this.#cancelSource = reason => reader.cancel(reason);
		this.#streamOwned = true;
		return new ReadableStream<Uint8Array>({
			pull: async controller => {
				try {
					const next = await reader.read();
					if (!next.done) {
						controller.enqueue(next.value);
						return;
					}
					if (this.#released) {
						await settle(false);
						reader.releaseLock();
						controller.close();
						return;
					}
					const message = await result();
					if (message) this.finish(message);
					else this.release();
					await settle(
						!this.#controller.signal.aborted &&
							(message?.stopReason === "stop" ||
								message?.stopReason === "length" ||
								message?.stopReason === "toolUse"),
					);
					reader.releaseLock();
					controller.close();
				} catch (error) {
					this.abort(error);
					let failure = error;
					try {
						await settle(false);
					} catch (settlementError) {
						failure = settlementError;
					}
					controller.error(failure);
					try {
						await reader.cancel(error);
					} catch {
						/* Preserve the original reader failure. */
					}
					reader.releaseLock();
				}
			},
			cancel: async reason => {
				// Abort upstream before awaiting anything: result() may only settle after encoder cancellation.
				this.abort(reason);
				try {
					await reader.cancel(reason);
				} finally {
					reader.releaseLock();
					await settle(false);
				}
			},
		});
	}
}

/** Covers every post-selection exit, including errors before a stream can be handed to the client. */
export async function withGatewayCredentialTurn(
	storage: AuthStorage,
	requestId: string,
	controller: AbortController,
	run: (turn: GatewayCredentialTurn) => Promise<Response>,
): Promise<Response> {
	const turn = new GatewayCredentialTurn(storage, requestId, controller);
	try {
		const response = await run(turn);
		if (!turn.streamOwned) turn.release();
		return response;
	} catch (error) {
		turn.abort(error);
		throw error;
	}
}
