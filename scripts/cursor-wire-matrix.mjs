#!/usr/bin/env bun
/**
 * Live Cursor AgentService wire matrix: text + tool-call round trip per model.
 *
 * Usage:
 *   bun scripts/cursor-wire-matrix.mjs [--models id[,id...]] [--mode text|tools|all]
 *
 * Credential: ~/.omp/auth/cursor.json (access token). Nothing is written to
 * the repo; cost is capped by tiny prompts and maxTokens per row.
 *
 * Harness discipline (mirrors the grokbot matrix):
 * - A row passes only on observed bytes: exact ping text, or a generated
 *   toolCall block whose command echoes the ping (echoLikeShellCommand).
 * - Tool calls are requested with cursorToolPassthrough so the matrix asserts
 *   generation, never fabricated execution.
 * - Any row failure exits nonzero. Success marker: CURSOR_WIRE_MATRIX_PASS.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { buildModel } from "../packages/catalog/src/build.ts";
import { fetchCursorUsableModels } from "../packages/catalog/src/discovery/cursor.ts";
import { streamCursor } from "../packages/ai/src/providers/cursor.ts";
import { echoLikeShellCommand } from "./grokbot-catalog-matrix/harness.ts";

const DEFAULT_MODELS = ["claude-4-sonnet", "gemini-3-flash", "composer-2.5"];
const TEXT_PING = "cursor-text-pong";
const TOOLS_PING = "cursor-tools-pong";
const ROW_TIMEOUT_MS = 150_000;

function parseArgs(argv) {
	const out = { models: DEFAULT_MODELS, mode: "all" };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--models" && argv[i + 1]) out.models = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
		else if (argv[i] === "--mode" && argv[i + 1]) out.mode = argv[++i];
	}
	if (!["text", "tools", "all"].includes(out.mode)) throw new Error(`unknown --mode ${out.mode}`);
	if (out.models.length === 0) throw new Error("no models selected");
	return out;
}

async function loadAccessToken() {
	const path = join(homedir(), ".omp", "auth", "cursor.json");
	const cred = await Bun.file(path)
		.json()
		.catch(() => null);
	const token = cred && typeof cred.access === "string" ? cred.access : "";
	if (!token) throw new Error(`missing Cursor access token at ${path}`);
	return token;
}

function commandOf(call) {
	const args = call.arguments;
	if (typeof args === "string") {
		try {
			const parsed = JSON.parse(args);
			if (parsed && typeof parsed.command === "string") return parsed.command;
		} catch {
			return "";
		}
	}
	if (args && typeof args === "object" && typeof args.command === "string") return args.command;
	return "";
}

async function runRow({ model, apiKey, kind, ping }) {
	const isTools = kind === "tools";
	const ctx = isTools
		? {
				messages: [
					{
						role: "user",
						content: `Call the bash tool once with command \`echo ${ping}\` and nothing else.`,
						timestamp: Date.now(),
					},
				],
				tools: [
					{
						name: "bash",
						description: "Run a shell command.",
						parameters: {
							type: "object",
							properties: { command: { type: "string" } },
							required: ["command"],
						},
					},
				],
			}
		: {
				messages: [{ role: "user", content: `Reply with exactly: ${ping}`, timestamp: Date.now() }],
			};
	const stream = streamCursor(model, ctx, {
		apiKey,
		sessionId: crypto.randomUUID(),
		maxTokens: isTools ? 512 : 64,
		...(isTools ? { cursorToolPassthrough: true } : {}),
		signal: AbortSignal.timeout(ROW_TIMEOUT_MS),
	});
	let text = "";
	let toolCalls = [];
	let error = "";
	for await (const event of stream) {
		if (event.type === "text_delta") text += event.delta;
		else if (event.type === "done") {
			for (const block of event.message.content ?? []) {
				if (block && block.type === "toolCall") toolCalls.push(block);
			}
			if (event.message.text) text = event.message.text;
		} else if (event.type === "error") {
			error = event.error?.errorMessage ?? "unknown stream error";
		}
	}
	await stream.result().catch(() => {});
	if (error) return { pass: false, detail: `stream-error: ${error.slice(0, 160)}` };
	if (isTools) {
		const call = toolCalls.find(c => c.name === "bash");
		if (!call) return { pass: false, detail: `no bash toolCall (got: ${toolCalls.map(c => c.name).join(",") || "none"})` };
		const command = commandOf(call);
		if (!echoLikeShellCommand(command, ping)) {
			return { pass: false, detail: `bash command does not echo ping: ${JSON.stringify(command).slice(0, 160)}` };
		}
		return { pass: true, detail: `bash(${JSON.stringify(command).slice(0, 80)})` };
	}
	if (!text.includes(ping)) return { pass: false, detail: `ping absent from ${text.length} text bytes` };
	return { pass: true, detail: `${text.length} text bytes` };
}

const { models: wantedIds, mode } = parseArgs(process.argv.slice(2));
const apiKey = await loadAccessToken();
const roster = await fetchCursorUsableModels({ apiKey });
if (!roster) throw new Error("GetUsableModels failed with the stored credential");
const byId = new Map(roster.map(spec => [spec.id, spec]));
const kinds = mode === "all" ? ["text", "tools"] : [mode];
let failed = 0;
for (const id of wantedIds) {
	const spec = byId.get(id);
	if (!spec) {
		console.log(`row ${id}: FAIL (absent from live roster of ${roster.length})`);
		failed++;
		continue;
	}
	const model = buildModel({ ...spec });
	for (const kind of kinds) {
		const ping = kind === "tools" ? TOOLS_PING : TEXT_PING;
		let result;
		try {
			result = await runRow({ model, apiKey, kind, ping });
		} catch (err) {
			result = { pass: false, detail: `threw: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}` };
		}
		console.log(`row ${id}/${kind}: ${result.pass ? "PASS" : "FAIL"} (${result.detail})`);
		if (!result.pass) failed++;
	}
}
if (failed > 0) {
	console.log(`CURSOR_WIRE_MATRIX_FAIL (${failed} rows)`);
	process.exit(1);
}
console.log("CURSOR_WIRE_MATRIX_PASS");
