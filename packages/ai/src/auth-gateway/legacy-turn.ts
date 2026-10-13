import type { AuthStorage } from "../auth-storage";
import { DEFAULT_TURN_RESERVATION_TTL_MS } from "../auth/types";
import type { StreamCommitGate } from "./stream-commit-gate";

/** Existing fork SDK entry point; the normal gateway uses its request-owned lifecycle. */
export function renewReservationUntilSettled<T>(
	storage: AuthStorage,
	requestId: string,
	pending: Promise<T>,
): Promise<T> {
	const timer = setInterval(
		() => storage.coordination.renewTurnReservation(requestId),
		DEFAULT_TURN_RESERVATION_TTL_MS / 2,
	);
	timer.unref?.();
	return pending.finally(() => clearInterval(timer));
}

export function releaseTurnOnStreamEnd(
	stream: ReadableStream<Uint8Array>,
	storage: AuthStorage,
	requestId: string,
	commitGate?: StreamCommitGate,
	settled?: Promise<unknown>,
): ReadableStream<Uint8Array> {
	const reader = stream.getReader();
	let released = false;
	const release = (success: boolean): void => {
		if (released) return;
		released = true;
		if (success) storage.settleQuotaProbeSuccess(requestId);
		storage.releaseTurnReservation(requestId);
	};
	return new ReadableStream({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (!done) {
					controller.enqueue(value);
					return;
				}
				const result = await settled;
				const canonical = typeof result === "object" && result !== null && "stopReason" in result;
				const success = canonical
					? result.stopReason === "stop" || result.stopReason === "length" || result.stopReason === "toolUse"
					: settled === undefined && commitGate?.sawSuccessfulTerminal === true;
				release(success);
				controller.close();
			} catch (error) {
				release(false);
				controller.error(error);
			}
		},
		cancel(reason) {
			release(false);
			return reader.cancel(reason);
		},
	});
}
