import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "../../src/api-registry";
import { startAuthGateway } from "../../src/auth-gateway";
import { AuthStorage } from "../../src/auth-storage";
import { createMockModel } from "../../src/providers/mock";
import type { AssistantMessage, Model, SimpleStreamOptions } from "../../src/types";
import { AssistantMessageEventStream } from "../../src/utils/event-stream";

const native = process.argv[2] === "native";
const beforeOutput = process.argv[3] === "before-output";
const api = "gateway-idle-fixture";
let calls = 0;
let signal: AbortSignal | undefined;
registerCustomApi(
	api,
	(model, _context, options?: SimpleStreamOptions) => {
		calls++;
		signal = options?.signal;
		const events = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: "" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		void (async () => {
			try {
				events.push({ type: "start", partial: message });
				events.push({ type: "text_start", contentIndex: 0, partial: message });
				if (beforeOutput) await Bun.sleep(5500);
				message.content = [{ type: "text", text: "opening" }];
				events.push({ type: "text_delta", contentIndex: 0, delta: "opening", partial: message });
				if (!beforeOutput) await Bun.sleep(5500);
				message.content = [{ type: "text", text: "opening completed" }];
				events.push({ type: "text_delta", contentIndex: 0, delta: " completed", partial: message });
				events.push({ type: "text_end", contentIndex: 0, content: "opening completed", partial: message });
				events.push({ type: "done", reason: "stop", message });
				events.end(message);
			} catch (error) {
				message.stopReason = "error";
				message.errorMessage = error instanceof Error ? error.message : String(error);
				events.push({ type: "error", reason: "error", error: message });
				events.end(message);
			}
		})();
		return events;
	},
	api,
);

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-active-idle-"));
const storage = await AuthStorage.create(path.join(directory, "auth.db"));
storage.keys.setRuntime("openrouter", "fixture-key");
const base = createMockModel({ provider: "openrouter", id: "quiet-model" });
const model: Model<typeof api> = { ...base.model, api };
const gateway = startAuthGateway({
	bind: "127.0.0.1:0",
	bearerTokens: ["client"],
	storage,
	idleTimeout: 1,
	resolveModel: id => (id === model.id ? model : undefined),
});
try {
	const body = native
		? { modelId: model.id, context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, stream: true }
		: { model: model.id, messages: [{ role: "user", content: "hi" }], stream: true };
	const response = await fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
		method: "POST",
		headers: { Authorization: "Bearer client", "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});
	const output = await response.text();
	process.stdout.write(
		`${JSON.stringify({ status: response.status, output, calls, aborted: signal?.aborted === true })}\n`,
	);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
} finally {
	await gateway.close();
	storage.close();
	unregisterCustomApis(api);
	await fs.rm(directory, { recursive: true, force: true });
}
