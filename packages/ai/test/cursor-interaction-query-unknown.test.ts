// Contract: unnamed interaction-query auto-approval is limited to verified
// WebFetch field 9; other unknown length-delimited variants stay unanswered.
import { describe, expect, it } from "bun:test";
import type * as http2 from "node:http2";
import { create, fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { handleInteractionQuery } from "@oh-my-pi/pi-ai/providers/cursor/interaction-query";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	type InteractionQuery,
	InteractionQuerySchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";

import type { ProtoUnknownField } from "@oh-my-pi/pi-catalog/discovery/protobuf";

type ProtoUnknownBag = { $unknown?: ProtoUnknownField[] };

function decodeConnectFrame(frame: Buffer): AgentClientMessage {
	const flags = frame[0]!;
	const length = frame.readUInt32BE(1);
	expect(flags & 0b1).toBe(0); // not compressed
	return fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + length));
}

function dispatchQuery(query: InteractionQuery): Promise<Buffer[]> {
	const frames: Buffer[] = [];
	const h2Request = {
		write(chunk: Buffer) {
			frames.push(Buffer.from(chunk));
			return true;
		},
	} as unknown as http2.ClientHttp2Stream;
	handleInteractionQuery(query, h2Request);
	return Promise.resolve(frames);
}

describe("cursor interaction query unknown-field fallback", () => {
	it("approves unnamed field-9 permission queries used by hosted WebFetch", async () => {
		const query = create(InteractionQuerySchema, { id: 18 });
		const bag: ProtoUnknownBag = query;
		bag.$unknown = [{ no: 9, wireType: 2, data: new Uint8Array([0x02, 0x0a, 0x00]) }];
		const frames = await dispatchQuery(query);
		expect(frames).toHaveLength(1);
		const client = decodeConnectFrame(frames[0]!);
		expect(client.message.case).toBe("interactionResponse");
		if (client.message.case !== "interactionResponse") {
			throw new Error("expected interactionResponse");
		}
		expect(client.message.value.id).toBe(18);
		// A legacy unnamed query still receives a wire reply the current codec
		// decodes as the verified WebFetch approval, not a fabricated variant.
		const result = client.message.value.result;
		expect(result.case).toBe("webFetchRequestResponse");
		if (result.case !== "webFetchRequestResponse") throw new Error("expected WebFetch response");
		expect(result.value.result.case).toBe("approved");
	});

	it("leaves unknown non-WebFetch interaction query fields unanswered", async () => {
		const query = create(InteractionQuerySchema, { id: 21 });
		const bag: ProtoUnknownBag = query;
		bag.$unknown = [{ no: 12, wireType: 2, data: new Uint8Array([0x02, 0x0a, 0x00]) }];
		expect(await dispatchQuery(query)).toEqual([]);
	});
});
