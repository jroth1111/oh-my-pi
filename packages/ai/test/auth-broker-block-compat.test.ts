import { expect, it } from "bun:test";
import { AuthBrokerClient } from "../src/auth-broker/client";

it("does not retry or mask a broker credential-block validation failure", async () => {
	const bodies: unknown[] = [];
	const fetchImpl: typeof fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return Response.json({ error: "invalid credential" }, { status: 400 });
		},
		{ preconnect: fetch.preconnect },
	);
	const client = new AuthBrokerClient({ url: "https://broker.example", token: "fixture", fetchImpl });
	const block = { providerKey: "fixture:oauth", blockScope: "chat", blockedUntilMs: 12345, retryAfter: true };
	const result = client.upsertCredentialBlock(1, block);
	await expect(result).rejects.toMatchObject({ status: 400 });
	expect(bodies).toEqual([{ providerKey: "fixture:oauth", blockScope: "chat", blockedUntilMs: 12345 }]);
});
