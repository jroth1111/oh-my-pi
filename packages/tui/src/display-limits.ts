/**
 * Shared display truncation budgets for TUI and provider status surfaces.
 * Keep these in pi-tui so packages like pi-ai can reuse them without depending on coding-agent.
 *
 * Canonical definitions live in ./render/render-utils (upstream); this module
 * re-exports them for barrel consumers that import from "@oh-my-pi/pi-tui".
 */
export { PREVIEW_LIMITS, TRUNCATE_LENGTHS } from "./render/render-utils";
