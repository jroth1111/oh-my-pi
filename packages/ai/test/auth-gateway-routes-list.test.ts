import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAuthGatewayRouter, RouteRegistry, startAuthGateway } from "../src/auth-gateway";
import type { RouteDefinition } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel } from "../src/providers/mock";

async function withListing(
	definitions: readonly RouteDefinition[],
	run: (url: string, registry: RouteRegistry, changeAlias: () => void, storage: AuthStorage) => Promise<void>,
	management: { allowManagement?: boolean; adminBearerTokens?: string[] } = {},
): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-route-list-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
		usageProviderResolver: () => undefined,
	});
	const first = {
		...createMockModel({ provider: "fixture", id: "first" }),
		headers: { Authorization: "private-model-fixture-bearer" },
	};
	const second = createMockModel({ provider: "fixture", id: "second" });
	let alias = first;
	const registry = new RouteRegistry(id => (id === "alias" ? alias : id === "second" ? second : undefined));
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["listing-fixture-client"],
		storage,
		resolveModel: () => undefined,
		routeRegistry: registry,
		routes: definitions,
		listModels: () => [first, second],
		...management,
	});
	try {
		await run(
			gateway.url,
			registry,
			() => {
				alias = { ...first, id: "changed", name: "Changed fixture" };
			},
			storage,
		);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
}

const definitions: readonly RouteDefinition[] = [
	{
		id: "virtual-a",
		root: {
			type: "fallback",
			on: ["provider_unavailable"],
			children: [
				{ type: "target", model: "alias" },
				{ type: "target", model: "second" },
			],
		},
	},
	{ id: "virtual-b", root: { type: "target", model: "second" } },
];
const auth = { Authorization: "Bearer listing-fixture-client" };

it("lists canonical virtual routes without private model state", async () => {
	await withListing(definitions, async url => {
		const response = await fetch(`${url}/v1/routes`, { headers: auth });
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("private-model-fixture-bearer");
		expect(text).not.toContain("Authorization");
		expect(JSON.parse(text)).toEqual({
			object: "list",
			generation: 3,
			data: [
				{
					id: "virtual-a",
					generation: 2,
					targets: ["fixture/first", "fixture/second"],
					fallbacks: { provider_unavailable: ["fixture/second"] },
				},
				{ id: "virtual-b", generation: 3, targets: ["fixture/second"], fallbacks: {} },
			],
		});
	});
});

it("requires an authorized bearer for route listing", async () => {
	await withListing(definitions, async url => {
		for (const headers of [undefined, { Authorization: "Bearer wrong-fixture-client" }]) {
			const response = await fetch(`${url}/v1/routes`, { headers });
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "unauthorized" });
		}
	});
});

it("does not expose route writes or count concrete catalog models as virtual routes", async () => {
	await withListing([], async url => {
		const response = await fetch(`${url}/v1/routes`, { headers: auth });
		expect(await response.json()).toEqual({ object: "list", generation: 1, data: [] });
		for (const method of ["POST", "PUT", "DELETE"]) {
			const rejected = await fetch(`${url}/v1/routes`, { method, headers: auth });
			expect(rejected.status).toBe(404);
			await rejected.text();
		}
	});
});

it("lists the same current catalog snapshot that dispatch will resolve", async () => {
	await withListing(definitions, async (url, registry, changeAlias) => {
		changeAlias();
		const response = await fetch(`${url}/v1/routes`, { headers: auth });
		const body = (await response.json()) as { generation: number; data: Array<{ id: string; targets: string[] }> };
		expect(body.generation).toBe(3);
		const resolved = registry.resolve("virtual-a");
		if (!resolved) throw new Error("Expected a registered fixture route");
		expect(body.data[0]?.targets).toEqual([...resolved.targets]);
		expect(body.data[0]?.targets).toEqual(["fixture/changed", "fixture/second"]);
	});
});

it("gets a virtual route by its exact encoded ID without leaking model headers", async () => {
	const id = "virtual/雪 % +";
	await withListing([{ id, root: { type: "target", model: "alias" } }], async (url, _registry, changeAlias) => {
		changeAlias();
		const response = await fetch(`${url}/v1/routes/${encodeURIComponent(id)}`, { headers: auth });
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("private-model-fixture-bearer");
		expect(JSON.parse(text)).toEqual({ id, generation: 2, targets: ["fixture/changed"], fallbacks: {} });
	});
});

it("does not wrap missing or concrete IDs into virtual route lookup", async () => {
	await withListing(definitions, async url => {
		for (const id of ["no-such-route", "alias", "fixture/first"]) {
			const response = await fetch(`${url}/v1/routes/${encodeURIComponent(id)}`, { headers: auth });
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: `Unknown route: ${id}` });
		}
	});
});

it("requires a bearer and rejects malformed route-ID encoding", async () => {
	await withListing(definitions, async url => {
		const unauthorized = await fetch(`${url}/v1/routes/virtual-a`);
		expect(unauthorized.status).toBe(401);
		await unauthorized.text();
		const invalid = await fetch(`${url}/v1/routes/%GG`, { headers: auth });
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({ error: "invalid route id encoding" });
	});
});

it("keeps individual lookup and collection listing consistent", async () => {
	await withListing(definitions, async url => {
		const response = await fetch(`${url}/v1/routes/virtual-a`, { headers: auth });
		expect(response.status).toBe(200);
		const row = await response.json();
		const collection = await fetch(`${url}/v1/routes/`, { headers: auth });
		expect(collection.status).toBe(200);
		expect(await collection.json()).toMatchObject({ object: "list", data: expect.arrayContaining([row]) });
	});
});

it("keeps route mutation disabled by default, including for an admin bearer", async () => {
	await withListing(
		definitions,
		async (url, registry) => {
			const generation = registry.generation;
			for (const method of ["PUT", "DELETE"]) {
				const response = await fetch(`${url}/v1/routes/virtual-a`, {
					method,
					headers: { Authorization: "Bearer management-fixture-admin" },
					body: method === "PUT" ? "{root:{type:'target',model:'second'}}" : undefined,
				});
				expect(response.status).toBe(404);
				await response.text();
			}
			expect(registry.generation).toBe(generation);
		},
		{ adminBearerTokens: ["management-fixture-admin"] },
	);
});

it("requires separate admin authorization even when management is enabled", async () => {
	await withListing(
		definitions,
		async (url, registry) => {
			const generation = registry.generation;
			for (const method of ["PUT", "DELETE"]) {
				const response = await fetch(`${url}/v1/routes/virtual-a`, {
					method,
					headers: auth,
					body: method === "PUT" ? "{root:{type:'target',model:'second'}}" : undefined,
				});
				expect(response.status).toBe(403);
				await response.text();
			}
			expect(registry.generation).toBe(generation);
		},
		{ allowManagement: true, adminBearerTokens: ["management-fixture-admin"] },
	);
});

it("admin can read and update routes but its token does not authorize inference", async () => {
	await withListing(
		definitions,
		async (url, registry) => {
			const admin = { Authorization: "Bearer management-fixture-admin" };
			const read = await fetch(`${url}/v1/routes`, { headers: admin });
			expect(read.status).toBe(200);
			await read.text();
			const denied = await fetch(`${url}/v1/chat/completions`, {
				method: "POST",
				headers: { ...admin, "Content-Type": "application/json" },
				body: JSON.stringify({ model: "alias", messages: [{ role: "user", content: "fixture" }] }),
			});
			expect(denied.status).toBe(401);
			await denied.text();
			const changed = await fetch(`${url}/v1/routes/virtual-a`, {
				method: "PUT",
				headers: admin,
				body: "{/*JSON5*/root:{type:'target',model:'second'},}",
			});
			expect(changed.status).toBe(200);
			expect(await changed.json()).toEqual({
				id: "virtual-a",
				generation: 4,
				targets: ["fixture/second"],
				fallbacks: {},
			});
			const readback = await fetch(`${url}/v1/routes/virtual-a`, { headers: auth });
			expect(await readback.json()).toEqual({
				id: "virtual-a",
				generation: registry.generation,
				targets: ["fixture/second"],
				fallbacks: {},
			});
		},
		{ allowManagement: true, adminBearerTokens: ["management-fixture-admin"] },
	);
});

it("validates route replacement atomically and allows PUT preflight", async () => {
	await withListing(
		definitions,
		async (url, registry) => {
			const admin = { Authorization: "Bearer management-fixture-admin" };
			for (const body of [
				"{",
				"{id:'different',root:{type:'target',model:'second'}}",
				"{root:{type:'unknown'}}",
				"{root:{type:'fallback',on:['provider_unavailable'],children:[{type:'target',model:'second'},{type:'target',model:'second'}]}}",
			]) {
				const before = JSON.stringify(registry.list());
				const generation = registry.generation;
				const rejected = await fetch(`${url}/v1/routes/virtual-a`, { method: "PUT", headers: admin, body });
				expect(rejected.status).toBe(400);
				await rejected.text();
				expect(registry.generation).toBe(generation);
				expect(JSON.stringify(registry.list())).toBe(before);
			}
			const options = await fetch(`${url}/v1/routes/virtual-a`, {
				method: "OPTIONS",
				headers: { Origin: "http://fixture-client", "Access-Control-Request-Method": "PUT" },
			});
			expect(options.status).toBe(204);
			expect(options.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
		},
		{ allowManagement: true, adminBearerTokens: ["management-fixture-admin"] },
	);
});

it("an empty admin capability cannot authorize a direct router mutation", async () => {
	await withListing(definitions, async (_url, registry, _changeAlias, storage) => {
		const router = createAuthGatewayRouter({
			storage,
			routeRegistry: registry,
			resolveModel: () => undefined,
			allowManagement: true,
			adminBearerTokens: [],
		});
		try {
			const generation = registry.generation;
			for (const method of ["PUT", "DELETE"]) {
				const response = await router.route(
					new Request("http://fixture/v1/routes/virtual-a", {
						method,
						body: method === "PUT" ? "{root:{type:'target',model:'second'}}" : undefined,
					}),
					"fixture",
				);
				expect(response.status).toBe(403);
				await response.text();
			}
			expect(registry.generation).toBe(generation);
		} finally {
			router.close();
		}
	});
});

it("rejects misplaced admin bearer material before a route write", async () => {
	await withListing(
		definitions,
		async (url, registry) => {
			const generation = registry.generation;
			for (const method of ["PUT", "DELETE"]) {
				const response = await fetch(`${url}/v1/routes/virtual-a?token=management-fixture-admin`, {
					method,
					headers: { Authorization: "Bearer management-fixture-admin" },
					body: method === "PUT" ? "{root:{type:'target',model:'second'}}" : undefined,
				});
				expect(response.status).toBe(400);
				await response.text();
			}
			expect(registry.generation).toBe(generation);
		},
		{ allowManagement: true, adminBearerTokens: ["management-fixture-admin"] },
	);
});

it("deletes only the named virtual route and stops future dispatch while retaining in-flight snapshots", async () => {
	const id = "virtual/雪 % +?#";
	await withListing(
		[{ id, root: { type: "target", model: "alias" } }, definitions[1]],
		async (url, registry) => {
			const captured = registry.resolve(id);
			if (!captured) throw new Error("Expected a captured route");
			const response = await fetch(`${url}/v1/routes/${encodeURIComponent(id)}`, {
				method: "DELETE",
				headers: { Authorization: "Bearer management-fixture-admin" },
			});
			expect(response.status).toBe(204);
			expect(await response.text()).toBe("");
			const gone = await fetch(`${url}/v1/routes/${encodeURIComponent(id)}`, { headers: auth });
			expect(gone.status).toBe(404);
			expect(await gone.json()).toEqual({ error: `Unknown route: ${id}` });
			const collection = await fetch(`${url}/v1/routes`, { headers: auth });
			expect(await collection.json()).toEqual({
				object: "list",
				generation: 4,
				data: [{ id: "virtual-b", generation: 3, targets: ["fixture/second"], fallbacks: {} }],
			});
			const inference = await fetch(`${url}/v1/chat/completions`, {
				method: "POST",
				headers: { ...auth, "Content-Type": "application/json" },
				body: JSON.stringify({ model: id, messages: [{ role: "user", content: "fixture" }] }),
			});
			expect(inference.status).toBe(404);
			await inference.text();
			expect(registry.resolve(id)).toBeUndefined();
			expect(registry.getModel(captured)?.id).toBe("first");
		},
		{ allowManagement: true, adminBearerTokens: ["management-fixture-admin"] },
	);
});

it("rejects unknown and concrete deletions without changing routes or generation", async () => {
	await withListing(
		definitions,
		async (url, registry) => {
			const before = JSON.stringify(registry.list());
			for (const id of ["no-such-route", "alias", "fixture/first"]) {
				const response = await fetch(`${url}/v1/routes/${encodeURIComponent(id)}`, {
					method: "DELETE",
					headers: { Authorization: "Bearer management-fixture-admin" },
				});
				expect(response.status).toBe(404);
				expect(await response.json()).toEqual({ error: `Unknown route: ${id}` });
			}
			expect(registry.generation).toBe(3);
			expect(JSON.stringify(registry.list())).toBe(before);
		},
		{ allowManagement: true, adminBearerTokens: ["management-fixture-admin"] },
	);
});

it("rejects empty or malformed DELETE IDs and allows browser preflight", async () => {
	await withListing(
		definitions,
		async (url, registry) => {
			const admin = { Authorization: "Bearer management-fixture-admin" };
			const empty = await fetch(`${url}/v1/routes/`, { method: "DELETE", headers: admin });
			expect(empty.status).toBe(404);
			expect(await empty.json()).toEqual({ error: "Missing route id" });
			const invalid = await fetch(`${url}/v1/routes/%GG`, { method: "DELETE", headers: admin });
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toEqual({ error: "invalid route id encoding" });
			const unauthenticated = await fetch(`${url}/v1/routes/virtual-a`, { method: "DELETE" });
			expect(unauthenticated.status).toBe(401);
			await unauthenticated.text();
			const options = await fetch(`${url}/v1/routes/virtual-a`, {
				method: "OPTIONS",
				headers: { Origin: "http://fixture-client", "Access-Control-Request-Method": "DELETE" },
			});
			expect(options.status).toBe(204);
			expect(options.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
			expect(registry.generation).toBe(3);
		},
		{ allowManagement: true, adminBearerTokens: ["management-fixture-admin"] },
	);
});
