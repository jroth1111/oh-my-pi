import { expect, it } from "bun:test";
import * as path from "node:path";

for (const native of [false, true]) {
	for (const phase of ["before-output", "after-output"] as const)
		it(`keeps an active quiet ${native ? "pi-native" : "chat"} stream alive past the transport idle limit (${phase})`, async () => {
			const child = Bun.spawn(
				["bun", path.join(import.meta.dir, "fixtures/gateway-active-stream.ts"), native ? "native" : "chat", phase],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const deadline = setTimeout(() => child.kill("SIGKILL"), 65_000);
			try {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
				const result = JSON.parse(stdout) as { status: number; output: string; calls: number; aborted: boolean };
				expect(result).toMatchObject({ status: 200, calls: 1, aborted: false });
				expect(result.output).toContain("opening");
				expect(result.output).toContain("completed");
			} finally {
				clearTimeout(deadline);
				child.kill("SIGTERM");
				await child.exited;
			}
		}, 75_000);
}
