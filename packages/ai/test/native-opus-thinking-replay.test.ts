import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { toInferenceMessages } from "../src/providers/grokbot";
import { decodeInferenceStreamRequest, encodeInferenceStreamRequest } from "../src/providers/grokbot/proto";
import { transformMessages, withCredentialRedaction } from "../src/providers/transform-messages";
import type { Api, AssistantMessage, Model } from "../src/types";

function model(api: "grokbot-sand" | "cursor-agent", provider: string, id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://api2.cursor.sh",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 300_000,
		maxTokens: 4096,
	});
}

function turn(api: "grokbot-sand" | "cursor-agent", provider: string, text = "fixture reasoning"): AssistantMessage {
	return {
		role: "assistant",
		api,
		provider,
		model: "claude-opus-5-5-low",
		timestamp: 1,
		stopReason: "stop",
		content: [
			{ type: "thinking", thinking: text, thinkingSignature: "fixture-signature" },
			{ type: "redactedThinking", data: "fixture-encrypted-block" },
			{ type: "text", text: "done" },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		providerPayload: {
			type: "anthropicNativeContent",
			provider,
			model: "claude-opus-5-5-low",
			blocks: [{ type: "thinking", thinking: text, signature: "fixture-signature" }],
		},
	};
}

describe("native Opus thinking replay", () => {
	test("Grokbot native content survives in wire field 18 verbatim, not just reconstructed reasoning", () => {
		const source = turn("grokbot-sand", "grokbot");
		const nativeContent = '[ { "type": "thinking", "thinking": "fixture", "signature": "fixture-signature" } ]';
		if (source.providerPayload?.type !== "anthropicNativeContent") throw new Error("Expected native payload");
		source.providerPayload.nativeContent = nativeContent;
		source.content = [];
		const messages = toInferenceMessages(
			{ messages: [source] },
			model("grokbot-sand", "grokbot", "claude-opus-5-5-high") as Model<"grokbot-sand">,
		);
		const decoded = decodeInferenceStreamRequest(encodeInferenceStreamRequest({ messages }));
		expect(decoded.messages).toMatchObject([{ anthropicNativeContent: nativeContent }]);
	});

	for (const [provider, api] of [
		["grokbot", "grokbot-sand"],
		["cursor", "cursor-agent"],
	] as const) {
		test(`${provider} preserves signed and encrypted thinking across Opus effort variants`, () => {
			const source = turn(api, provider);
			const result = transformMessages([source], model(api, provider, "claude-opus-5-5-xhigh"));
			expect(result[0]?.content).toEqual(source.content);
		});
	}
	test("Grokbot replays retained payload after display thinking is stripped, without changing signature bytes", () => {
		const source = turn("grokbot-sand", "grokbot");
		source.content = [{ type: "text", text: "done" }];
		const messages = toInferenceMessages(
			{ messages: [source] },
			model("grokbot-sand", "grokbot", "claude-opus-5-5-high") as Model<"grokbot-sand">,
		);
		expect(messages[0]?.reasoningParts).toEqual([
			{ isRedacted: false, text: "fixture reasoning", signature: "fixture-signature" },
		]);
	});
	test("Grokbot does not restore a foreign lineage's signature from an opaque payload", () => {
		const messages = toInferenceMessages(
			{ messages: [turn("grokbot-sand", "grokbot")] },
			model("grokbot-sand", "grokbot", "grok-4.6") as Model<"grokbot-sand">,
		);
		expect(messages[0]?.reasoningParts).toBeUndefined();
		expect(JSON.stringify(messages)).not.toContain("fixture-signature");
	});
	test("opt-in credential redaction cannot be undone by native thinking payload replay", () => {
		const token = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd";
		const messages = withCredentialRedaction(true, () =>
			toInferenceMessages(
				{ messages: [turn("grokbot-sand", "grokbot", token)] },
				model("grokbot-sand", "grokbot", "claude-opus-5-5-high") as Model<"grokbot-sand">,
			),
		);
		expect(JSON.stringify(messages)).not.toContain(token);
		expect(JSON.stringify(messages)).toContain("[anthropic_token_redacted]");
	});
});
