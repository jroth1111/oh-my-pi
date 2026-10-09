import { describe, expect, it } from "bun:test";
import { buildGrpcRequest, type CursorOptions } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { cursorModelParameters } from "@oh-my-pi/pi-catalog/compat/behavior";
import { type AgentRunRequest, AgentClientMessageSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

function cursorModel(id: string): Model<"cursor-agent"> {
	return buildModel({
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	});
}

async function capture(model: Model<"cursor-agent">, options?: CursorOptions | string): Promise<AgentRunRequest> {
	const opts = typeof options === "string" ? ({ wireModelId: options } satisfies CursorOptions) : options;
	const { requestBytes } = await buildGrpcRequest(
		model,
		{ messages: [{ role: "user", content: "pong", timestamp: 0 }] } satisfies Context,
		opts,
		{ conversationId: "wire-test", blobStore: new Map() },
	);
	const message = fromBinary(AgentClientMessageSchema, requestBytes).message;
	if (message.case !== "runRequest") throw new Error("Expected Cursor run request");
	return message.value;
}

describe("Cursor requestedModel wire shape", () => {
	it("splits a GPT reasoning-sibling slug into base id + reasoning parameter", async () => {
		const payload = await capture(cursorModel("gpt-5.4-mini-low"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.4-mini");
		expect(payload.requestedModel?.parameters).toEqual([expect.objectContaining({ id: "reasoning", value: "low" })]);
		// Cursor still validates the legacy model_details field independently.
		expect(payload.modelDetails?.modelId).toBe("gpt-5.4-mini-low");
	});

	it("handles multi-segment GPT bases and the xhigh tier", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-xhigh"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(payload.requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "xhigh" }),
		]);
	});

	it("maps the extra-high sibling to the xhigh reasoning parameter", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-extra-high"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(payload.requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "xhigh" }),
		]);
	});

	it("normalizes an off-tier sibling to the base id with no parameters", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-none"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(payload.requestedModel?.parameters).toEqual([]);
		// modelDetails keeps the account-usable sibling; the base goes out raw.
		expect(payload.modelDetails?.modelId).toBe("gpt-5.6-sol-none");
	});

	it("normalizes a fast-lane off-tier sibling preserving the lane", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-none-fast"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol-fast");
		expect(payload.requestedModel?.parameters).toEqual([]);
		expect(payload.modelDetails?.modelId).toBe("gpt-5.6-sol-none-fast");
	});

	it("leaves Cursor-native ids untouched with no parameters", async () => {
		const payload = await capture(cursorModel("cursor-composer-2.5"));
		expect(payload.requestedModel?.modelId).toBe("cursor-composer-2.5");
		expect(payload.requestedModel?.parameters).toEqual([]);
	});

	it("pins the Standard tier for bare composer-2.5 from the catalog rule (#9012)", async () => {
		const payload = await capture(cursorModel("composer-2.5"));
		expect(payload.requestedModel?.modelId).toBe("composer-2.5");
		expect(payload.requestedModel?.parameters).toEqual([expect.objectContaining({ id: "fast", value: "false" })]);
		expect(payload.requestedModel?.parameters.map(({ id, value }) => ({ id, value }))).toEqual(
			cursorModelParameters("composer-2.5").map(({ id, value }) => ({ id, value })),
		);
	});

	it("keeps explicit composer-2.5-fast on the Fast lane with no parameters", async () => {
		const payload = await capture(cursorModel("composer-2.5-fast"));
		expect(payload.requestedModel?.modelId).toBe("composer-2.5-fast");
		expect(payload.requestedModel?.parameters).toEqual([]);
	});

	it("does not translate non-OpenAI siblings (Claude effort schema is undecoded)", async () => {
		const payload = await capture(cursorModel("claude-fable-5-low"));
		expect(payload.requestedModel?.modelId).toBe("claude-fable-5-low");
		expect(payload.requestedModel?.parameters).toEqual([]);
	});

	it("uses authoritative rich-catalog routes after variant collapse", async () => {
		const model = cursorModel("cursor-rich-low");
		model.cursorModelRoutes = {
			"cursor-rich-low": {
				modelId: "cursor-rich",
				parameters: [
					{ id: "reasoning", value: "low" },
					{ id: "context", value: "long" },
				],
				maxMode: true,
			},
		};
		const payload = await capture(model);
		expect(payload.requestedModel?.modelId).toBe("cursor-rich");
		expect(payload.requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "low" }),
			expect.objectContaining({ id: "context", value: "long" }),
		]);
		expect(payload.requestedModel?.maxMode).toBe(true);
		expect(payload.modelDetails?.modelId).toBe("cursor-rich-low");
	});
});

describe("Cursor auto router wire id", () => {
	function rosterAutoModel(): Model<"cursor-agent"> {
		return buildModel({
			id: "auto",
			name: "auto",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
			requestModelId: "auto",
		});
	}

	it("echoes a roster-resolved requestModelId auto verbatim (what the CLI sends)", async () => {
		const payload = await capture(rosterAutoModel());
		expect(payload.requestedModel?.modelId).toBe("auto");
		expect(payload.requestedModel?.parameters).toEqual([]);
		expect(payload.modelDetails?.modelId).toBe("auto");
	});

	it("keeps the default contract for bare synthetic auto without roster proof", async () => {
		const payload = await capture(cursorModel("auto"));
		expect(payload.requestedModel?.modelId).toBe("default");
		expect(payload.requestedModel?.parameters).toEqual([]);
		expect(payload.modelDetails?.modelId).toBe("default");
	});

	it("honors an explicit caller wireModelId auto override", async () => {
		const payload = await capture(cursorModel("cursor-composer-2.5"), { wireModelId: "auto" });
		expect(payload.requestedModel?.modelId).toBe("auto");
		expect(payload.modelDetails?.modelId).toBe("auto");
	});
});
