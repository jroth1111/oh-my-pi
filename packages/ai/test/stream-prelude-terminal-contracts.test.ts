import { describe, expect, it } from "bun:test";
import { holdSseUntilCommit, StreamCommitGate } from "../src/auth-gateway/stream-commit-gate";

describe("stream prelude terminal contracts", () => {
	for (const oneChunk of [false, true]) {
		it(`observes a failed terminal after output in ${oneChunk ? "one chunk" : "later chunks"} without duplicating bytes`, async () => {
			const opening = 'event: response.output_text.delta\ndata: {"delta":"ok"}\n\n';
			const terminal = "event: response.failed\ndata: {}\n\n";
			const source = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of oneChunk ? [opening + terminal] : [opening, terminal])
						controller.enqueue(new TextEncoder().encode(chunk));
					controller.close();
				},
			});
			const gate = new StreamCommitGate();
			expect(await new Response(holdSseUntilCommit(source, gate)).text()).toBe(opening + terminal);
			expect(gate.state).toBe("terminated");
		});
	}
	it("keeps SSE comment heartbeats pre-commit", async () => {
		const bytes = ": ping\n\nevent: response.failed\ndata: {}\n\n";
		await expect(
			new Response(holdSseUntilCommit(new Response(bytes).body!, new StreamCommitGate())).text(),
		).rejects.toThrow();
	});
	it("rejects truncated pre-commit SSE instead of inventing a successful terminal", async () => {
		const bytes = "event: response.failed\ndata: {";
		await expect(
			new Response(holdSseUntilCommit(new Response(bytes).body!, new StreamCommitGate())).text(),
		).rejects.toThrow();
	});
	it("forwards a terminal chunk that crosses the prelude cap without retrying", async () => {
		const bytes = "event: response.failed\ndata: {}\n\n";
		expect(await new Response(holdSseUntilCommit(new Response(bytes).body!, new StreamCommitGate(8))).text()).toBe(
			bytes,
		);
	});
});
