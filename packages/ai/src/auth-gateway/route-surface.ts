import { gatewaySurfaceAllowsApi } from "@oh-my-pi/pi-catalog/compat/behavior";

export type GatewaySurface = "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini-v1beta" | "pi-native";
export interface RouteSurfaceEligibility {
	surface: GatewaySurface;
	modelApi: string;
}

/** Native API capability, not permission to reject stateless cross-format translation. */
export function surfaceAllowsApi(surface: GatewaySurface, api: string): boolean {
	return gatewaySurfaceAllowsApi(surface, api);
}
