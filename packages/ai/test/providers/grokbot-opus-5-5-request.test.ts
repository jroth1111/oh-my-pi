import { expect, test } from "bun:test";
import { resolveGrokbotRequestedModel } from "../../src/providers/grokbot/model-request";
import { decodeInferenceStreamRequest, encodeInferenceStreamRequest } from "../../src/providers/grokbot/proto";

test("Opus 5.5's captured defaults become Sand wire parameters without an unadvertised thinking flag", () => {
	const requestedModel = resolveGrokbotRequestedModel("grokbot/claude-opus-5-5", {
		sandParameterIds: ["context", "effort", "fast"],
		sandParameterDefaults: { context: "300k", effort: "medium", fast: "false" },
	});
	const decoded = decodeInferenceStreamRequest(encodeInferenceStreamRequest({ requestedModel }));
	const wire = decoded.requestedModel as { modelId: string; parameters: Array<{ id: string; value: string }> };
	expect(wire.modelId).toBe("claude-opus-5-5");
	expect(Object.fromEntries(wire.parameters.map(p => [p.id, p.value]))).toEqual({
		context: "300k",
		effort: "medium",
		fast: "false",
	});
});
