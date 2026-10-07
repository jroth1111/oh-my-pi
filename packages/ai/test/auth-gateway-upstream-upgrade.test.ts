import { expect, it } from "bun:test";
import { createAuthGatewayRouter } from "../src/auth-gateway/server";
import type { AuthStorage } from "../src/auth-storage";

it("shares fork route management with upstream's transport-independent router", async () => {
	const router = createAuthGatewayRouter({
		storage: {} as AuthStorage,
		resolveModel: () => undefined,
	});
	const request = (path: string, init?: RequestInit) =>
		router.route(new Request(`http://gateway${path}`, init), "fixture");
	try {
		const put = await request("/v1/routes/fork-route", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ root: { type: "target", model: "openai/upstream-model" } }),
		});
		expect(put.status).toBe(200);
		const list = await request("/v1/routes");
		const body = (await list.json()) as { data: Array<{ id: string }> };
		expect(body.data.map(route => route.id)).toEqual(["fork-route"]);
		expect((await request("/v1/routes/fork-route")).status).toBe(200);
		expect((await request("/v1/routes/fork-route", { method: "DELETE" })).status).toBe(204);
		expect((await request("/v1/routes/fork-route")).status).toBe(404);
	} finally {
		router.close();
	}
});
