import { describe, expect, test } from "bun:test";
import { buildGrpcRequest } from "@oh-my-pi/pi-ai/providers/cursor";
import { resolveGrokbotRequestedModel } from "@oh-my-pi/pi-ai/providers/grokbot/model-request";
import { decodeInferenceStreamRequest, encodeInferenceStreamRequest } from "@oh-my-pi/pi-ai/providers/grokbot/proto";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AgentClientMessageSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { buildGrokbotStaticSeed } from "@oh-my-pi/pi-catalog/provider-models/grokbot";
import { normalizeGrokbotAvailableModels } from "@oh-my-pi/pi-catalog/discovery/grokbot";
import { parseModelPattern } from "../src/config/model-resolver";

describe("native Opus 5.5 effort selectors", () => {
	const available = [...getBundledModels("cursor"), ...buildGrokbotStaticSeed().map(spec => buildModel(spec))];
	for (const effort of [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]) {
		test(`Grokbot advertised packed -${effort} reaches the wire without duplicate parameters`, () => {
			const id = `claude-opus-5-5-${effort}`;
			const specs = normalizeGrokbotAvailableModels(
				[
					{
						name: "claude-opus-5-5",
						supportsThinking: true,
						parameterDefinitions: [{ id: "effort" }, { id: "fast" }],
						variants: [
							{
								legacySlug: id,
								parameterValues: [
									{ id: "effort", value: effort },
									{ id: "fast", value: "false" },
								],
							},
						],
					},
				],
				undefined,
				new Set([id]),
			);
			const models = specs.map(spec => buildModel(spec));
			const selected = parseModelPattern(`grokbot/${id}`, models).model!;
			const requestedModel = resolveGrokbotRequestedModel(selected.id, {
				canonicalModelId: selected.requestModelId,
				sandParameterIds: selected.sandParameterIds,
				sandParameterDefaults: selected.sandParameterDefaults,
			});
			const decoded = decodeInferenceStreamRequest(encodeInferenceStreamRequest({ requestedModel }));
			expect(decoded.requestedModel).toMatchObject({ modelId: id, parameters: [] });
		});

		test(`Grokbot -${effort} selects canonical Opus with the corresponding Sand parameter`, () => {
			const selected = parseModelPattern(`grokbot/claude-opus-5-5-${effort}`, available);
			expect(selected.model?.provider).toBe("grokbot");
			expect(selected.model?.api).toBe("grokbot-sand");
			expect(selected.thinkingLevel).toBe(effort);
			expect(selected.explicitThinkingLevel).toBe(true);
			const model = selected.model!;
			const requested = resolveGrokbotRequestedModel(model.id, {
				effort: selected.thinkingLevel,
				canonicalModelId: model.requestModelId,
				sandParameterIds: model.sandParameterIds,
				sandParameterDefaults: model.sandParameterDefaults,
			});
			expect(requested.modelId).toBe("claude-opus-5-5");
			expect(requested.parameters).toContainEqual({ id: "effort", value: effort });
			const decoded = decodeInferenceStreamRequest(encodeInferenceStreamRequest({ requestedModel: requested }));
			expect(decoded.requestedModel).toMatchObject({
				modelId: "claude-opus-5-5",
				parameters: [{ id: "effort", value: effort }],
			});
		});
		test(`Cursor -${effort} preserves explicit intent and serializes the corresponding wire id`, async () => {
			const selected = parseModelPattern(`cursor/claude-opus-5-5-${effort}`, available);
			expect(selected.model?.provider).toBe("cursor");
			expect(selected.thinkingLevel).toBe(effort);
			expect(selected.explicitThinkingLevel).toBe(true);
			const model = getBundledModel<"cursor-agent">("cursor", selected.model!.id);
			const { requestBytes } = await buildGrpcRequest(
				model,
				{ messages: [{ role: "user", content: "fixture request", timestamp: 0 }] },
				{ wireModelId: model.thinking?.effortRouting?.[effort] },
				{ conversationId: `fixture-${effort}`, blobStore: new Map() },
			);
			const decoded = fromBinary(AgentClientMessageSchema, requestBytes);
			if (decoded.message.case !== "runRequest") throw new Error("Expected a Cursor run request");
			expect(decoded.message.value.modelDetails?.modelId).toBe(`claude-opus-5-5-${effort}`);
			expect(decoded.message.value.requestedModel?.modelId).toBe(`claude-opus-5-5-${effort}`);
		});
	}
});
