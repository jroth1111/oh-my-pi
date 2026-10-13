import type { Api, Model } from "../types";
export type {
	ResponseOwnersApi as GatewayResponseOwnership,
	StoredResponseOwner as GatewayResponseOwner,
} from "../auth/types";

/** Deployment configuration and standard OpenAI account/project headers own stored state. */
export function responseEndpointIdentity(model: Model<Api>, requestHeaders?: Record<string, string>): string {
	const modelHeaders = new Headers(model.headers);
	const headers = new Headers(requestHeaders);
	return Bun.SHA256.hash(
		JSON.stringify({
			baseUrl: model.baseUrl,
			modelHeaders: [...modelHeaders.entries()].sort(([a], [b]) => a.localeCompare(b)),
			project: headers.get("openai-project") ?? modelHeaders.get("openai-project"),
			organization: headers.get("openai-organization") ?? modelHeaders.get("openai-organization"),
		}),
		"hex",
	);
}
