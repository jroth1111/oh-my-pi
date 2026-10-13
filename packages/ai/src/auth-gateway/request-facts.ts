import { isRecord } from "@oh-my-pi/pi-utils";
import type { Context } from "../types";
import type { RouteRequestFacts } from "./route-graph";

/** Includes provider-native history images as well as canonical visible blocks. */
export function routeRequestFacts(context: Context): RouteRequestFacts {
	return {
		vision: context.messages.some(message => {
			if (Array.isArray(message.content) && message.content.some(block => block.type === "image")) return true;
			const payload = "providerPayload" in message ? message.providerPayload : undefined;
			return (
				payload?.type === "openaiResponsesHistory" &&
				payload.items.some(
					item =>
						isRecord(item) &&
						Array.isArray(item.content) &&
						item.content.some(part => isRecord(part) && part.type === "input_image"),
				)
			);
		}),
	};
}
