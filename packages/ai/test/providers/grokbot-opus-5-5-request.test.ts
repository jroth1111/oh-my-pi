// Focused coverage for Claude Opus 5.5 access THROUGH the grokbot provider:
// taxonomy class (anthropic ⇒ native thinking replay path) + sand request-param
// construction (serverModelName wire id; context/effort/fast ids from the live
// catalog's sand-parameter-ids; sane medium default; full low..max ladder).
// Ground truth: /workspace/grokbot-available-models-20261008.json (captured sand catalog).
import { test, expect } from "bun:test";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { resolveGrokbotRequestedModel } from "../../src/providers/grokbot/model-request";
import { isAnthropicSandModelId } from "../../src/providers/grokbot/anthropic-sand-wire";

const OPUS = "claude-opus-5-5";
const SAND_IDS = ["context", "effort", "fast"] as const; // catalog sand-parameter-ids
const DEFAULTS = { context: "300k", effort: "medium", fast: "false" } as const;

test("claude-opus-5-5 classifies as anthropic/opus (drives native thinking replay)", () => {
	const c = classifyModel("grokbot", OPUS, { lenient: true });
	expect(c.class).toBe("anthropic");
	expect(c.family).toBe("opus");
	expect(isAnthropicSandModelId(OPUS, "grokbot")).toBe(true);
});

test("sends serverModelName as wire model_id (strips grokbot/ and display name)", () => {
	const rm = resolveGrokbotRequestedModel("grokbot/claude-opus-5-5", { sandParameterIds: [...SAND_IDS] });
	expect(rm.modelId).toBe(OPUS);
});

test("maps effort/context/fast to parameters[] with catalog sand ids", () => {
	const rm = resolveGrokbotRequestedModel(OPUS, {
		effort: "high",
		context: "300k",
		fast: true,
		sandParameterIds: [...SAND_IDS],
		sandParameterDefaults: { ...DEFAULTS },
	});
	const byId = Object.fromEntries((rm.parameters ?? []).map(p => [p.id, p.value]));
	expect(Object.keys(byId).sort()).toEqual(["context", "effort", "fast"]);
	expect(byId.effort).toBe("high");
	expect(byId.context).toBe("300k");
	expect(byId.fast).toBe("true");
	// opus-5-5 does NOT expose a `thinking` sand param — must not be invented.
	expect(byId.thinking).toBeUndefined();
	// field 5 flag must never be set for a canonical id.
	expect((rm as { isVariantStringRepresentation?: boolean }).isVariantStringRepresentation).toBeUndefined();
});

test("default effort is the catalog default (medium) when unspecified", () => {
	const rm = resolveGrokbotRequestedModel(OPUS, {
		sandParameterIds: [...SAND_IDS],
		sandParameterDefaults: { ...DEFAULTS },
	});
	const effort = (rm.parameters ?? []).find(p => p.id === "effort")?.value;
	expect(effort).toBe("medium");
});

test("accepts the full low..max effort ladder", () => {
	for (const level of ["low", "medium", "high", "xhigh", "max"]) {
		const rm = resolveGrokbotRequestedModel(OPUS, { effort: level, sandParameterIds: [...SAND_IDS] });
		expect((rm.parameters ?? []).find(p => p.id === "effort")?.value).toBe(level);
	}
});

test("honors max mode on the requested model", () => {
	const rm = resolveGrokbotRequestedModel(OPUS, {
		context: "1m",
		sandParameterIds: [...SAND_IDS],
		sandMaxMode: true,
	});
	expect(rm.maxMode).toBe(true);
	expect((rm.parameters ?? []).find(p => p.id === "context")?.value).toBe("1m");
});
