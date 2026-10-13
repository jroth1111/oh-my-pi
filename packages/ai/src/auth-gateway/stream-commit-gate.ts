import type { ReadableStreamDefaultReader } from "node:stream/web";
import type { AssistantMessageEventStream } from "../utils/event-stream";

/** Compatibility observer for canonical-event consumers outside the gateway. */
export function observeAssistantCommit(
	events: AssistantMessageEventStream,
	gate: StreamCommitGate,
): AssistantMessageEventStream {
	const iterate = events[Symbol.asyncIterator].bind(events);
	events[Symbol.asyncIterator] = async function* () {
		for await (const event of { [Symbol.asyncIterator]: iterate }) {
			if (
				((event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") &&
					event.delta.length > 0) ||
				event.type === "toolcall_end"
			)
				gate.classifyAndObserve("response.output_text.delta", 0);
			yield event;
		}
	};
	return events;
}

/** Classification of one Responses SSE event for commit / failover. */
export type CommitClass = "metadata" | "output" | "terminal-success" | "terminal-retryable" | "terminal-failure";

export type StreamCommitState = "probing" | "committed" | "terminated";

const DEFAULT_MAX_PRELUDE_BYTES = 4 * 1024 * 1024;

/** Downstream SSE observer is used for Responses; upstream onSseEvent must not also feed the gate. */
export function commitGateObservesDownstreamSse(formatLabel: string): boolean {
	return formatLabel === "openai-responses";
}

const METADATA_EVENTS: Record<string, true> = {
	"response.created": true,
	"response.in_progress": true,
	"response.queued": true,
	"response.output_item.added": true,
	"response.content_part.added": true,
	start: true,
	text_start: true,
	thinking_start: true,
	toolcall_start: true,
	message_start: true,
	// Anthropic SSE metadata: message_delta carries usage/stop_reason, and
	// content_block_stop is the structural close of a content block — neither
	// is generated output worth committing the stream over.
	message_delta: true,
	content_block_stop: true,
	heartbeat: true,
	ping: true,
};

/**
 * Prelude gate for Responses SSE. Metadata events stay in `probing`; the first
 * output (or unknown) event, or a 4 MiB prelude cap, commits the stream so a
 * later retryable terminal cannot uncommit. There is no time cap.
 */
export class StreamCommitGate {
	#state: StreamCommitState = "probing";
	#bytes = 0;
	#maxPreludeBytes: number;
	#prelude: Uint8Array[] = [];
	#preludeBytes = 0;
	#successfulTerminal = false;

	constructor(maxPreludeBytes: number = DEFAULT_MAX_PRELUDE_BYTES) {
		this.#maxPreludeBytes = maxPreludeBytes;
	}

	get state(): StreamCommitState {
		return this.#state;
	}
	get sawSuccessfulTerminal(): boolean {
		return this.#successfulTerminal;
	}

	/** Reset to probing for the next fallback attempt (clears prelude). */
	reset(): void {
		this.#state = "probing";
		this.#bytes = 0;
		this.#prelude = [];
		this.#preludeBytes = 0;
		this.#successfulTerminal = false;
	}

	classifyAndObserve(eventType: string, byteLength: number): StreamCommitState {
		if (this.#state === "terminated") return this.#state;
		if (classifyCommitEvent(eventType) === "terminal-success") this.#successfulTerminal = true;

		if (this.#state === "probing") {
			const add = byteLength > 0 ? byteLength : 0;
			this.#bytes = Math.min(this.#bytes + add, this.#maxPreludeBytes);
			if (this.#bytes >= this.#maxPreludeBytes) {
				this.#state = "committed";
			}
		}

		const kind = classifyCommitEvent(eventType);
		if (this.#state === "committed") {
			// Post-commit, every terminal event ends the stream's failover
			// eligibility — including `response.failed` (retryable elsewhere),
			// whose failure must surface to the client instead of re-dispatching.
			if (kind === "terminal-success" || kind === "terminal-retryable" || kind === "terminal-failure") {
				this.#state = "terminated";
			}
			return this.#state;
		}

		if (kind === "output") {
			this.#state = "committed";
			return this.#state;
		}
		if (kind === "terminal-success" || kind === "terminal-retryable" || kind === "terminal-failure") {
			this.#state = "terminated";
			return this.#state;
		}
		return this.#state;
	}

	/** Raw bytes buffered while probing (held frames only). */
	get preludeByteLength(): number {
		return this.#preludeBytes;
	}

	/**
	 * Buffer a raw pre-commit chunk for a HOLDING consumer (one that has not
	 * forwarded it downstream yet). Bounded: returns false once the prelude
	 * cap is reached, forcing the hold to commit rather than grow unboundedly.
	 * The forwarding observation path must not double-buffer.
	 */
	bufferPrelude(chunk: Uint8Array): boolean {
		if (this.#state !== "probing") return false;
		if (this.#preludeBytes + chunk.byteLength > this.#maxPreludeBytes) return false;
		this.#prelude.push(chunk);
		this.#preludeBytes += chunk.byteLength;
		return true;
	}

	/**
	 * Discard and return the held prelude of a FAILED pre-commit attempt — the
	 * failover path drops these frames (they belong to the dead attempt) and
	 * the replacement attempt's stream starts from its own first byte, so the
	 * client observes exactly one response. Committed/terminated gates have no
	 * takeable prelude.
	 */
	takePrelude(): Uint8Array[] | undefined {
		if (this.#prelude.length === 0) return undefined;
		const out = this.#prelude;
		this.#prelude = [];
		this.#preludeBytes = 0;
		return out;
	}
}

/** Thrown/streamed when a held stream hits a pre-commit retryable terminal. */
export class PreludeAbortedError extends Error {
	readonly frames: Uint8Array[];
	readonly eventType: string;
	constructor(frames: Uint8Array[], eventType: string) {
		super(`upstream stream ended before commit (${eventType})`);
		this.name = "PreludeAbortedError";
		this.frames = frames;
		this.eventType = eventType;
	}
}

export function classifyCommitEvent(eventType: string): CommitClass {
	if (!eventType) return "output";
	if (METADATA_EVENTS[eventType]) return "metadata";
	if (eventType === "response.completed" || eventType === "message_stop") return "terminal-success";
	if (eventType === "response.failed") return "terminal-retryable";
	if (eventType === "response.incomplete") return "terminal-success";
	if (eventType === "error" || eventType === "response.error") return "terminal-failure";
	return "output";
}

function nextSseFrame(pending: string): { frame: string; rest: string } | undefined {
	const crlf = pending.indexOf("\r\n\r\n");
	const lf = pending.indexOf("\n\n");
	let index = -1;
	let delimLen = 0;
	if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
		index = crlf;
		delimLen = 4;
	} else if (lf >= 0) {
		index = lf;
		delimLen = 2;
	}
	if (index < 0) return undefined;
	return { frame: pending.slice(0, index), rest: pending.slice(index + delimLen) };
}

function eventTypeFromFrame(frame: string): string {
	if (!frame.split(/\r?\n/).some(line => line.startsWith("data:") || line.startsWith("event:"))) return "heartbeat";
	let eventType = "";
	for (const line of frame.split(/\r?\n/)) {
		if (line.startsWith("event:")) eventType = line.slice(6).trim();
	}
	return eventType;
}

/**
 * HOLD path for seamless pre-commit failover: unlike {@link observeSseCommit},
 * pre-commit frames are buffered — never forwarded — so a dead attempt's
 * metadata never reaches the client. On commit, the held prelude flushes and
 * the live stream forwards unchanged. A pre-commit retryable/failure terminal
 * aborts with {@link PreludeAbortedError} carrying the drained frames, letting
 * the failover loop discard them and dispatch a replacement attempt the client
 * cannot distinguish from the first.
 */
export function holdSseUntilCommit(
	stream: ReadableStream<Uint8Array>,
	gate: StreamCommitGate,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let pending = "";
	let committed = false;
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				const wasCommitted = committed;
				const buffered = !committed && gate.bufferPrelude(chunk);
				if (!committed && !buffered) {
					gate.classifyAndObserve("", chunk.byteLength);
					committed = true;
				}
				pending += decoder.decode(chunk, { stream: true });
				let next = nextSseFrame(pending);
				while (next) {
					const eventType = eventTypeFromFrame(next.frame);
					const state = gate.classifyAndObserve(eventType, next.frame.length);
					pending = next.rest;
					const success = classifyCommitEvent(eventType) === "terminal-success";
					if (!committed && state === "terminated" && !success) {
						throw new PreludeAbortedError(gate.takePrelude() ?? [], eventType);
					}
					if (state === "committed" || success) committed = true;
					next = nextSseFrame(pending);
				}
				if (wasCommitted) controller.enqueue(chunk);
				else if (committed) {
					for (const held of gate.takePrelude() ?? []) controller.enqueue(held);
					if (!buffered) controller.enqueue(chunk);
				}
			},
			flush(controller) {
				if (committed) return;
				pending += decoder.decode();
				if (pending.trim().length > 0)
					throw new PreludeAbortedError(gate.takePrelude() ?? [], "truncated SSE frame");
				const held = gate.takePrelude() ?? [];
				if (held.length === 0) return;
				gate.classifyAndObserve("", 0);
				for (const chunk of held) controller.enqueue(chunk);
			},
		}),
	);
}

export interface HeldSsePumpOptions {
	/** Total attempts including the first. Defaults to 3. */
	maxAttempts?: number;
	/** Canonical failure eligibility; defaults to the terminal event classification. */
	shouldRetry?: (error: PreludeAbortedError) => boolean | Promise<boolean>;
	/** Invoked after each discarded pre-commit attempt. */
	onAbort?: (error: PreludeAbortedError, attempt: number) => void;
	/** Terminal frame enqueued when reopening an attempt throws before any commit. */
	synthesizeFailure?: (error: unknown) => Uint8Array | undefined;
	/** Called exactly once when the pump settles (done, flushed, failed, or cancelled). */
	onSettle?: () => void;
}

/**
 * Decision consumer for {@link holdSseUntilCommit}: pumps held attempts into one
 * downstream body so a pre-commit retryable terminal fails over transparently —
 * the dead attempt's metadata frames are discarded and the replacement attempt's
 * prelude becomes the only prelude the client sees. The first attempt is passed
 * in already open so its setup errors can still surface as HTTP errors to the
 * caller; `openNext` supplies replacements, and `gate.reset()` runs between
 * attempts. Retryable exhaustion (or a pre-commit `terminal-failure`) flushes
 * the last attempt's held frames so the client observes the provider's real
 * terminal event rather than a silent truncation.
 */
export function pumpHeldSseAttempts(
	first: ReadableStream<Uint8Array>,
	openNext: () => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>,
	gate: StreamCommitGate,
	options?: HeldSsePumpOptions,
): ReadableStream<Uint8Array> {
	const maxAttempts = options?.maxAttempts ?? 3;
	let inner: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let settled = false;
	const settle = () => {
		if (!settled) {
			settled = true;
			options?.onSettle?.();
		}
	};
	return new ReadableStream<Uint8Array>({
		async start(out) {
			let sse = first;
			// `start` resolving does not close the stream — every exit path must
			// close/error the controller explicitly.
			const close = () => {
				try {
					out.close();
				} catch {}
			};
			try {
				for (let attempt = 1; ; attempt++) {
					if (settled) return;
					let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
					try {
						const rd = sse.getReader();
						reader = inner = rd;
						for (;;) {
							const { done, value } = await rd.read();
							if (settled) return;
							if (done) {
								close();
								return;
							}
							out.enqueue(value);
						}
					} catch (error) {
						if (settled) return;
						if (!(error instanceof PreludeAbortedError)) {
							try {
								out.error(error);
							} catch {}
							return;
						}
						options?.onAbort?.(error, attempt);
						let retryable = classifyCommitEvent(error.eventType) === "terminal-retryable";
						if (retryable && options?.shouldRetry) {
							try {
								retryable = await options.shouldRetry(error);
							} catch {
								retryable = false;
							}
						}
						if (settled) return;
						if (!retryable || attempt >= maxAttempts) {
							// Honest terminal: flush the dead attempt's held frames so the
							// client sees the provider's real `response.failed`/`error`.
							for (const frame of error.frames) out.enqueue(frame);
							close();
							return;
						}
					} finally {
						inner = undefined;
						if (reader) {
							reader.releaseLock();
							await sse.cancel().catch(() => {});
						}
					}
					try {
						if (settled) return;
						gate.reset();
						sse = await openNext();
					} catch (error) {
						const frame = options?.synthesizeFailure?.(error);
						if (frame) out.enqueue(frame);
						close();
						return;
					}
				}
			} finally {
				settle();
			}
		},
		async cancel(reason) {
			settle();
			if (inner) await inner.cancel(reason).catch(() => {});
		},
	});
}

/**
 * Observe encoded SSE bytes into a {@link StreamCommitGate} without altering the
 * downstream payload. Observe-only counterpart to {@link holdSseUntilCommit} —
 * frames pass through unbuffered, so a pre-commit terminal is classified but
 * not held back.
 */
export function observeSseCommit(
	stream: ReadableStream<Uint8Array>,
	gate: StreamCommitGate,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let pending = "";
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				pending += decoder.decode(chunk, { stream: true });
				let next = nextSseFrame(pending);
				while (next) {
					gate.classifyAndObserve(eventTypeFromFrame(next.frame), next.frame.length);
					pending = next.rest;
					next = nextSseFrame(pending);
				}
				controller.enqueue(chunk);
			},
			flush() {
				if (pending.length === 0) return;
				gate.classifyAndObserve(eventTypeFromFrame(pending) || "heartbeat", pending.length);
			},
		}),
	);
}
