/** Connect's five-byte streaming envelope, independent of protobuf/JSON payloads. */
export function frameConnectPayload(payload: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + payload.length);
	frame[0] = flags;
	frame.writeUInt32BE(payload.length, 1);
	frame.set(payload, 5);
	return frame;
}

export interface ConnectFrame {
	flags: number;
	payload: Buffer;
}

/** Yield complete envelopes immediately, reject partial EOF, and cancel on early exit. */
export async function* readConnectFrames(
	body: ReadableStream<Uint8Array>,
	maxFrameBytes = 16 * 1024 * 1024,
): AsyncGenerator<ConnectFrame> {
	const reader = body.getReader();
	let pending = Buffer.alloc(0);
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (pending.length) throw new Error("Connect stream ended with a truncated envelope");
				return;
			}
			pending = Buffer.concat([pending, value]);
			let offset = 0;
			while (offset + 5 <= pending.length) {
				const flags = pending[offset]!;
				const size = pending.readUInt32BE(offset + 1);
				if (size > maxFrameBytes) throw new Error("Connect envelope exceeds the configured size limit");
				if (offset + 5 + size > pending.length) break;
				const payload = pending.subarray(offset + 5, offset + 5 + size);
				offset += 5 + size;
				yield { flags, payload };
			}
			pending = pending.subarray(offset);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
