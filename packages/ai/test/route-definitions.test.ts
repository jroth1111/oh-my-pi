import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadRouteDefinitionsFile, parseRouteDefinitions, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { clearCustomApis } from "../src/api-registry";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel, registerMockApi } from "../src/providers/mock";
import * as AIError from "@oh-my-pi/pi-ai/error";

afterEach(() => clearCustomApis());

async function withTempFile(name: string, contents: string, run: (filePath: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "route-defs-"));
	const filePath = path.join(dir, name);
	try {
		await Bun.write(filePath, contents);
		await run(filePath);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("parseRouteDefinitions", () => {
	for (const id of ["", " ", ".", ".."])
		it(`rejects unusable route id ${JSON.stringify(id)}`, () => {
			expect(() => parseRouteDefinitions([{ id, root: { type: "target", model: "fixture/model" } }])).toThrow(
				AIError.ValidationError,
			);
		});

	it("rejects duplicate route ids instead of silently overwriting earlier definitions at boot", () => {
		expect(() =>
			parseRouteDefinitions([
				{ id: "duplicate", root: { type: "target", model: "fixture/a" } },
				{ id: "duplicate", root: { type: "target", model: "fixture/b" } },
			]),
		).toThrow(AIError.ValidationError);
	});

	it("rejects a blank target before boot", () => {
		expect(() => parseRouteDefinitions([{ id: "blank-target", root: { type: "target", model: " " } }])).toThrow(
			AIError.ValidationError,
		);
	});

	it("rejects a structural cycle as a validation failure", () => {
		const children: unknown[] = [];
		const root = { type: "fallback", on: ["provider_unavailable"], children };
		children.push(root);
		expect(() => parseRouteDefinitions([{ id: "cyclic", root }])).toThrow(AIError.ValidationError);
	});
	for (const depth of [256, 257])
		it(`${depth <= 256 ? "accepts" : "rejects"} route depth ${depth} without a stack overflow`, () => {
			let root: unknown = { type: "target", model: "fixture/model" };
			for (let index = 0; index < depth; index++)
				root = { type: "fallback", on: ["provider_unavailable"], children: [root] };
			const input = [{ id: "depth-fixture", root }];
			if (depth <= 256) expect(parseRouteDefinitions(input)).toHaveLength(1);
			else expect(() => parseRouteDefinitions(input)).toThrow(AIError.ValidationError);
		});
	it("parses a top-level array of route definitions", () => {
		const parsed = parseRouteDefinitions([{ id: "primary", root: { type: "target", model: "openai:gpt-4o" } }]);
		expect(parsed).toEqual([{ id: "primary", root: { type: "target", model: "openai:gpt-4o" } }]);
	});

	it("accepts an empty routes object wrapper", () => {
		expect(parseRouteDefinitions({ routes: [] })).toEqual([]);
	});

	it("parses a fallback tree keyed on provider_unavailable", () => {
		const parsed = parseRouteDefinitions({
			routes: [
				{
					id: "failover",
					root: {
						type: "fallback",
						on: ["provider_unavailable"],
						children: [
							{ type: "target", model: "openai:gpt-4o" },
							{ type: "target", model: "anthropic:claude-sonnet-4" },
						],
					},
				},
			],
		});
		expect(parsed).toEqual([
			{
				id: "failover",
				root: {
					type: "fallback",
					on: ["provider_unavailable"],
					children: [
						{ type: "target", model: "openai:gpt-4o" },
						{ type: "target", model: "anthropic:claude-sonnet-4" },
					],
				},
			},
		]);
	});

	it("rejects a definition missing id (negative)", () => {
		expect(() => parseRouteDefinitions([{ root: { type: "target", model: "openai:gpt-4o" } }])).toThrow(
			AIError.ValidationError,
		);
		expect(() => parseRouteDefinitions([{ root: { type: "target", model: "openai:gpt-4o" } }])).toThrow(/id/i);
	});

	it("rejects an unknown node type (negative)", () => {
		expect(() => parseRouteDefinitions([{ id: "bad", root: { type: "weighted", model: "openai:gpt-4o" } }])).toThrow(
			AIError.ValidationError,
		);
		expect(() => parseRouteDefinitions([{ id: "bad", root: { type: "weighted", model: "openai:gpt-4o" } }])).toThrow(
			/type/i,
		);
	});

	it("rejects an unknown disposition string (negative)", () => {
		expect(() =>
			parseRouteDefinitions([
				{
					id: "bad",
					root: {
						type: "fallback",
						on: ["not_a_disposition"],
						children: [{ type: "target", model: "openai:gpt-4o" }],
					},
				},
			]),
		).toThrow(AIError.ValidationError);
		expect(() =>
			parseRouteDefinitions([
				{
					id: "bad",
					root: {
						type: "fallback",
						on: ["not_a_disposition"],
						children: [{ type: "target", model: "openai:gpt-4o" }],
					},
				},
			]),
		).toThrow(/disposition/i);
	});

	it("rejects a fallback with empty children (negative)", () => {
		expect(() =>
			parseRouteDefinitions([
				{
					id: "bad",
					root: { type: "fallback", on: ["provider_unavailable"], children: [] },
				},
			]),
		).toThrow(AIError.ValidationError);
		expect(() =>
			parseRouteDefinitions([
				{
					id: "bad",
					root: { type: "fallback", on: ["provider_unavailable"], children: [] },
				},
			]),
		).toThrow(/empty/i);
	});
});

describe("loadRouteDefinitionsFile", () => {
	it("loads JSON5 and actually dispatches the registered fallback", async () => {
		await withTempFile(
			"routes.json5",
			`{
			// Target names are aliases resolved by the owning catalog.
			routes: [{id: 'loaded', root: {type: 'fallback', on: ['provider_unavailable'], children: [
				{type: 'target', model: 'primary'}, {type: 'target', model: 'backup'},
			]}}],
		}`,
			async filePath => {
				registerMockApi();
				const storage = await AuthStorage.create(path.join(path.dirname(filePath), "auth.db"), {
					usageProviderResolver: () => undefined,
					rankingStrategyResolver: () => undefined,
				});
				storage.keys.setRuntime("fixture-loader", "loader-fixture-key");
				const primary = createMockModel({
					provider: "fixture-loader",
					id: "primary",
					handler: { content: [], stopReason: "error", errorMessage: "HTTP 503: service unavailable" },
				});
				const backup = createMockModel({
					provider: "fixture-loader",
					id: "backup",
					handler: (_context, options) => {
						expect(options?.apiKey).toBe("loader-fixture-key");
						return { content: ["loaded fallback worked"] };
					},
				});
				const gateway = startAuthGateway({
					bind: "127.0.0.1:0",
					bearerTokens: ["loader-fixture-client"],
					storage,
					resolveModel: id => (id === "primary" ? primary : id === "backup" ? backup : undefined),
					routes: await loadRouteDefinitionsFile(filePath),
				});
				try {
					const response = await fetch(`${gateway.url}/v1/chat/completions`, {
						method: "POST",
						headers: { Authorization: "Bearer loader-fixture-client", "Content-Type": "application/json" },
						body: JSON.stringify({
							model: "loaded",
							messages: [{ role: "user", content: "fixture" }],
							stream: true,
						}),
					});
					expect(response.status).toBe(200);
					expect(await response.text()).toContain("loaded fallback worked");
					expect(primary.calls).toHaveLength(1);
					expect(backup.calls).toHaveLength(1);
				} finally {
					await gateway.close();
					storage.close();
				}
			},
		);
	});
	it("reports JSON5 syntax failures from the actual file", async () => {
		await withTempFile("invalid.json5", "{routes: [", async filePath => {
			await expect(loadRouteDefinitionsFile(filePath)).rejects.toThrow(/Invalid JSON5/);
		});
	});
	it("loads JSON5 with comments", async () => {
		const contents = `{
			// virtual primary
			routes: [
				{ id: "main", root: { type: "target", model: "openai:gpt-4o" } },
			],
		}`;
		await withTempFile("routes.json5", contents, async filePath => {
			const parsed = await loadRouteDefinitionsFile(filePath);
			expect(parsed).toEqual([{ id: "main", root: { type: "target", model: "openai:gpt-4o" } }]);
		});
	});

	it("throws ValidationError including the path when the file is missing (negative)", async () => {
		const missing = path.join(os.tmpdir(), `missing-routes-${crypto.randomUUID()}.json5`);
		let thrown: unknown;
		try {
			await loadRouteDefinitionsFile(missing);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AIError.ValidationError);
		if (!(thrown instanceof AIError.ValidationError)) return;
		expect(thrown.message).toContain(missing);
	});
});
