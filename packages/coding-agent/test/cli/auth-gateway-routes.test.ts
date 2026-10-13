import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SnapshotResponse } from "@oh-my-pi/pi-ai/auth-broker";

const entry = path.resolve(import.meta.dir, "../../src/cli.ts");
function launch(
	directory: string,
	routeFile: string | undefined,
	brokerUrl?: string,
	action = "serve",
	adminToken?: string,
) {
	return Bun.spawn(
		[
			process.execPath,
			entry,
			"auth-gateway",
			action,
			...(routeFile === undefined ? [] : ["--routes", routeFile]),
			"--no-auth",
			"--bind=127.0.0.1:0",
		],
		{
			cwd: directory,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// Do not inherit provider keys, profiles, dotenv files or user configuration.
			env: {
				PATH: process.env.PATH ?? "",
				TERM: "dumb",
				NO_COLOR: "1",
				PI_CONFIG_DIR: directory,
				PI_CODING_AGENT_DIR: path.join(directory, "agent"),
				...(brokerUrl ? { OMP_AUTH_BROKER_URL: brokerUrl, OMP_AUTH_BROKER_TOKEN: "fixture-broker-token" } : {}),
				...(adminToken ? { OMP_AUTH_GATEWAY_ADMIN_TOKEN: adminToken } : {}),
			},
		},
	);
}

for (const mode of ["blank", "missing", "syntax", "wrong-action"] as const)
	it(`rejects ${mode} --routes before broker or token setup in the real CLI`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-cli-invalid-routes-"));
		const routeFile = mode === "blank" ? " " : path.join(directory, "routes.json5");
		if (mode === "syntax") await Bun.write(routeFile, "{routes: [");
		const child = launch(directory, routeFile, undefined, mode === "wrong-action" ? "stdio" : "serve");
		const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code).not.toBe(0);
			const output = stdout + stderr;
			expect(output).toContain(
				mode === "wrong-action"
					? "only supported by"
					: mode === "blank"
						? "requires a file path"
						: mode === "missing"
							? "Route definitions file not found"
							: "Invalid JSON5",
			);
			expect(output).not.toContain("requires OMP_AUTH_BROKER_URL");
			expect(
				await fs.stat(path.join(directory, "auth-gateway.token")).then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(
				await fs.stat(path.join(directory, "auth-gateway")).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			clearTimeout(deadline);
			child.kill("SIGTERM");
			await child.exited;
			await fs.rm(directory, { recursive: true });
		}
	}, 20_000);

for (const mode of ["flag", "config", "override"] as const)
	it(`loads an exact JSON5 path via ${mode} into the broker-backed HTTP router`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-cli-routes-"));
		// Leading/trailing filename spaces are significant, not whitespace to strip from the flag value.
		const routeFile = path.join(directory, " routes.json5 ");
		await Bun.write(
			routeFile,
			`{routes: [{id: 'loaded-cli-route', root: {type: 'target', model: 'fixture/absent-target'}}],}`,
		);
		if (mode !== "flag")
			await Bun.write(
				path.join(directory, "agent", "config.yml"),
				`auth:\n  gateway:\n    routesFile: ${JSON.stringify(mode === "config" ? routeFile : path.join(directory, "wrong-route-file.json5"))}\n`,
			);
		const brokerRequests: string[] = [];
		const broker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				brokerRequests.push(new URL(request.url).pathname);
				if (request.headers.get("authorization") !== "Bearer fixture-broker-token")
					return new Response("unauthorized fixture", { status: 401 });
				if (new URL(request.url).pathname !== "/v1/snapshot")
					return new Response("fixture endpoint not found", { status: 404 });
				const snapshot: SnapshotResponse = {
					generation: 1,
					generatedAt: Date.now(),
					serverNowMs: Date.now(),
					credentials: [],
					refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
				};
				return Response.json(snapshot);
			},
		});
		const child = launch(
			directory,
			mode === "config" ? undefined : routeFile,
			broker.url.href,
			"serve",
			"cli-management-fixture-admin",
		);
		const ready = Promise.withResolvers<string>();
		const stderr = new Response(child.stderr).text();
		const stdout = (async () => {
			const reader = child.stdout.getReader();
			const decoder = new TextDecoder();
			let output = "";
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) return output;
					output += decoder.decode(next.value, { stream: true });
					const match = /auth-gateway listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
					if (match?.[1]) ready.resolve(match[1]);
				}
			} finally {
				reader.releaseLock();
			}
		})();
		void child.exited.then(async code =>
			ready.reject(new Error(`CLI exited before readiness (${code}): ${await stderr}`)),
		);
		const deadline = setTimeout(() => {
			child.kill("SIGKILL");
			ready.reject(new Error("CLI fixture readiness timed out"));
		}, 15_000);
		try {
			const url = await ready.promise;
			const response = await fetch(`${url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "loaded-cli-route",
					messages: [{ role: "user", content: "fixture" }],
					stream: false,
				}),
				signal: AbortSignal.timeout(5000),
			});
			expect(response.status).toBe(404);
			// Empty broker credentials deliberately prevent all vendor discovery/inference. This distinguishes a loaded virtual target from an unregistered alias.
			expect(await response.text()).toContain("Unknown model: fixture/absent-target");
			expect(brokerRequests).toContain("/v1/snapshot");
			const models = await fetch(`${url}/v1/models`);
			expect(models.status).toBe(200);
			expect(await models.json()).toMatchObject({ data: [] });
			const withoutAdmin = await fetch(`${url}/v1/routes/loaded-cli-route`, {
				method: "PUT",
				body: "{root:{type:'target',model:'fixture/changed-target'}}",
			});
			expect(withoutAdmin.status).toBe(403);
			await withoutAdmin.text();
			const changed = await fetch(`${url}/v1/routes/loaded-cli-route`, {
				method: "PUT",
				headers: { Authorization: "Bearer cli-management-fixture-admin" },
				body: "{root:{type:'target',model:'fixture/changed-target'}}",
			});
			expect(changed.status).toBe(200);
			expect(await changed.json()).toMatchObject({ id: "loaded-cli-route", targets: ["fixture/changed-target"] });
		} finally {
			child.kill("SIGTERM");
			await child.exited;
			clearTimeout(deadline);
			await Promise.all([stdout, stderr]);
			broker.stop(true);
			await fs.rm(directory, { recursive: true });
		}
	}, 20_000);

for (const mode of ["blank", "missing"] as const)
	it(`rejects ${mode} configured routes before broker and private-state setup`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-cli-config-routes-"));
		await Bun.write(
			path.join(directory, "agent", "config.yml"),
			`auth:\n  gateway:\n    routesFile: ${JSON.stringify(mode === "blank" ? " " : path.join(directory, "missing.json5"))}\n`,
		);
		const child = launch(directory, undefined);
		const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code).not.toBe(0);
			expect(stdout + stderr).toContain(
				mode === "blank" ? "requires a file path" : "Route definitions file not found",
			);
			expect(stdout + stderr).not.toContain("requires OMP_AUTH_BROKER_URL");
			expect((await fs.readdir(directory)).sort()).toEqual(["agent"]);
		} finally {
			clearTimeout(deadline);
			child.kill("SIGTERM");
			await child.exited;
			await fs.rm(directory, { recursive: true });
		}
	}, 20_000);
