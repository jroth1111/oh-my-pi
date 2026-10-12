import { describe, expect, it } from "bun:test";
import { AnthropicApiError, ProviderHttpError } from "../src/error/classes";
import { Flag } from "../src/error/flags";
import { classifyGatewayError } from "../src/error/gateway";
import { ValidationError } from "../src/error/validation";

describe("gateway review classification contracts", () => {
	for (const [flag, status, disposition] of [
		[Flag.Abort, 499, "cancelled"],
		[Flag.ContextOverflow, 400, "context_overflow"],
		[Flag.ContentBlocked, 403, "policy_terminal"],
	] as const) {
		it(`preserves structural ${disposition} evidence in the returned HTTP status`, () => {
			expect(
				classifyGatewayError(Object.assign(new Error("opaque local classification"), { errorId: flag })),
			).toMatchObject({ status, disposition });
		});
	}
	it("uses structured model-not-found evidence without requiring matching message prose", () => {
		expect(
			classifyGatewayError(new ProviderHttpError("Resource missing", 404, { code: "model_not_found" })),
		).toMatchObject({ owner: "model", disposition: "model_unavailable" });
		expect(
			classifyGatewayError(new ProviderHttpError("Resource missing", 503, { code: "model_not_found" })),
		).toMatchObject({ owner: "provider", disposition: "provider_unavailable" });
	});
	for (const detail of [{ statusCode: 401 }, { response: { status: 401 } }, { cause: { status: 401 } }]) {
		it(`preserves wrapped authentication status: ${JSON.stringify(detail)}`, () => {
			expect(classifyGatewayError(Object.assign(new Error("bad key"), detail))).toMatchObject({
				status: 401,
				owner: "credential",
				disposition: "credential_transient",
			});
		});
	}
	it("maps structurally flagged credentials before synthesizing a provider outage", () => {
		expect(
			classifyGatewayError(Object.assign(new Error("No configured credential"), { errorId: Flag.AuthFailed })),
		).toMatchObject({ owner: "credential", disposition: "credential_transient" });
	});
	it("returns a client error for structural validation failure", () => {
		expect(classifyGatewayError(new ValidationError("Circular schema"))).toMatchObject({
			status: 400,
			type: "invalid_request_error",
			disposition: "request_terminal",
		});
	});
	it("keeps Cline product gates model-owned rather than rotating healthy accounts", () => {
		expect(
			classifyGatewayError(
				Object.assign(new Error("This model is only available via Cline product surfaces"), { status: 403 }),
			),
		).toMatchObject({ owner: "model", disposition: "model_unavailable" });
	});
	it("recognizes a quoted model name in provider rejection wording", () => {
		expect(
			classifyGatewayError(
				Object.assign(new Error("The model 'gpt-x' does not exist or you do not have access to it"), {
					status: 400,
				}),
			),
		).toMatchObject({ owner: "model", disposition: "model_unavailable" });
	});
	for (const [status, directive, disposition] of [
		[409, undefined, "provider_transient"],
		[400, "true", "provider_transient"],
		[409, "false", "request_terminal"],
	] as const) {
		it(`retains Anthropic retry intent for ${status} / ${directive ?? "default"}`, () => {
			const headers = new Headers();
			if (directive) headers.set("x-should-retry", directive);
			expect(
				classifyGatewayError(new AnthropicApiError(status, "Provider rejected the request", headers)),
			).toMatchObject({ status, disposition });
		});
	}
});
