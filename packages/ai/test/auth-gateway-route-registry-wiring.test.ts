import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "../src/api-registry";
import { RouteRegistry, startAuthGateway } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel, registerMockApi } from "../src/providers/mock";

afterEach(() => clearCustomApis());

for (const native of [false, true])
	for (const virtual of [false, true]) {
		it(`dispatches the registry-selected target for ${native ? "pi-native" : "chat"} ${virtual ? "virtual routes" : "aliases"} without a second catalog lookup`, async () => {
			registerMockApi();
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-compiled-target-"));
			const storage = await AuthStorage.create(path.join(directory, "auth.db"));
			storage.keys.setRuntime("openrouter", "fixture-key");
			const target = createMockModel({ provider: "openrouter", id: "mock/compiled-target" });
			target.push({ content: ["selected registry target"] });
			const alias = "aliases/with/slashes";
			const registry = new RouteRegistry(id => (id === alias ? target : undefined));
			if (virtual)
				registry.register({
					id: "virtual/entry",
					root: {
						type: "fallback",
						on: ["credential_quota"],
						children: [
							{ type: "target", model: alias },
							{ type: "target", model: "unknown/fallback" },
						],
					},
				});
			const requested = virtual ? "virtual/entry" : alias;
			const gateway = startAuthGateway({
				bind: "127.0.0.1:0",
				storage,
				bearerTokens: ["registry-fixture-client"],
				routeRegistry: registry,
				resolveModel: () => undefined,
			});
			try {
				const response = await fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
					method: "POST",
					headers: { Authorization: "Bearer registry-fixture-client", "Content-Type": "application/json" },
					body: JSON.stringify(
						native
							? {
									modelId: requested,
									context: { messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
									stream: false,
								}
							: { model: requested, messages: [{ role: "user", content: "fixture" }], stream: false },
					),
				});
				expect(response.status).toBe(200);
				expect(await response.text()).toContain("selected registry target");
				expect(target.calls).toHaveLength(1);
			} finally {
				await gateway.close();
				storage.close();
				await fs.rm(directory, { recursive: true });
			}
		});
	}

it("canonicalizes a slash-containing alias without publishing private model headers", () => {
	const model = createMockModel({ provider: "openrouter", id: "mock/real-target" });
	const registry = new RouteRegistry(id =>
		id === "alias/path" ? { ...model, headers: { Authorization: "private-fixture-key" } } : undefined,
	);
	const route = registry.resolve("alias/path");
	expect(route?.targets[0]).toBe("openrouter/mock/real-target");
	expect(JSON.stringify(route)).not.toContain("private-fixture-key");
	expect(registry.resolve("missing")).toBeUndefined();
});
