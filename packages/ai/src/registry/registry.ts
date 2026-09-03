import type { KnownProvider } from "@oh-my-pi/pi-catalog";
import { authProviders } from "@oh-my-pi/pi-catalog/compat/auth";
import type { AuthProviderId, LoginProviderId } from "@oh-my-pi/pi-catalog/compat/auth-ids";
import { amazonBedrockTransport } from "./amazon-bedrock";
import { bedrockMantleTransport } from "./bedrock-mantle";
import { buildProviderDefinition, type ProviderTransport } from "./build";
import { cloudflareAiGatewayTransport } from "./cloudflare-ai-gateway";
import { aiandProvider } from "./aiand";
import { aimlApiProvider } from "./aimlapi";
import { alibabaCodingPlanProvider } from "./alibaba-coding-plan";
import { alibabaTokenPlanProvider } from "./alibaba-token-plan";
import { amazonBedrockProvider } from "./amazon-bedrock";
import { anthropicProvider } from "./anthropic";
import { azureProvider } from "./azure";
import { basetenProvider } from "./baseten";
import { bedrockMantleProvider } from "./bedrock-mantle";
import { cerebrasProvider } from "./cerebras";
import { clinePassProvider } from "./cline-pass";
import { cloudflareAiGatewayProvider } from "./cloudflare-ai-gateway";
import { coreWeaveProvider } from "./coreweave";
import { cursorProvider } from "./cursor";
import { deepinfraProvider } from "./deepinfra";
import { deepseekProvider } from "./deepseek";
import { devinProvider } from "./devin";
import { exaProvider } from "./exa";
import { firepassProvider } from "./firepass";
import { fireworksProvider } from "./fireworks";
import { githubCopilotProvider } from "./github-copilot";
import { gitlabDuoProvider } from "./gitlab-duo";
import { gitLabDuoWorkflowProvider } from "./gitlab-duo-workflow";
import { gmiCloudProvider } from "./gmi-cloud";
import { googleProvider } from "./google";
import { googleAntigravityProvider } from "./google-antigravity";
import { googleGeminiCliProvider } from "./google-gemini-cli";
import { googleVertexProvider } from "./google-vertex";
import { grokbotProvider } from "./grokbot";
import { groqProvider } from "./groq";
import { huggingfaceProvider } from "./huggingface";
import { kagiProvider } from "./kagi";
import { kiloProvider } from "./kilo";
import { kimiCodeProvider } from "./kimi-code";
import { litellmProvider } from "./litellm";
import { llamaCppProvider } from "./llama-cpp";
import { lmStudioProvider } from "./lm-studio";
import { metaProvider } from "./meta";
import { minimaxProvider } from "./minimax";
import { minimaxCodeProvider } from "./minimax-code";
import { minimaxCodeCnProvider } from "./minimax-code-cn";
import { mistralProvider } from "./mistral";
import { moonshotProvider } from "./moonshot";
import { nanogptProvider } from "./nanogpt";
import { novitaProvider } from "./novita";
import { nvidiaProvider } from "./nvidia";
import { ollamaProvider } from "./ollama";
import { ollamaCloudProvider } from "./ollama-cloud";
import { openaiProvider } from "./openai";
import { openaiCodexProvider } from "./openai-codex";
import { openaiCodexDeviceProvider } from "./openai-codex-device";
import { opencodeGoProvider } from "./opencode-go";
import { opencodeZenProvider } from "./opencode-zen";
import { openrouterProvider } from "./openrouter";
import { parallelProvider } from "./parallel";
import { perplexityProvider } from "./perplexity";
import { qianfanProvider } from "./qianfan";
import { qwenPortalProvider } from "./qwen-portal";
import { sakanaProvider } from "./sakana";
import { siliconflowProvider } from "./siliconflow";
import { siliconflowCnProvider } from "./siliconflow-cn";
import { syntheticProvider } from "./synthetic";
import { tavilyProvider } from "./tavily";
import { togetherProvider } from "./together";
import type { ProviderDefinition } from "./types";

/**
 * TypeScript-side request/model shaping for providers whose transport needs
 * code beside the KDL auth policy. Keyed by provider id; every other provider
 * is fully described by `rules/auth/<id>.kdl`.
 */
const TRANSPORTS: Record<string, ProviderTransport> = {
	"amazon-bedrock": amazonBedrockTransport,
	"bedrock-mantle": bedrockMantleTransport,
	"cloudflare-ai-gateway": cloudflareAiGatewayTransport,
};
const ALL = [
	azureProvider,
	openaiCodexProvider,
	anthropicProvider,
	zaiProvider,
	zaiCodingPlanProvider,
	kimiCodeProvider,
	openrouterProvider,
	githubCopilotProvider,
	cursorProvider,
	devinProvider,
	googleAntigravityProvider,
	googleGeminiCliProvider,
	openaiCodexDeviceProvider,
	xaiProvider,
	xaiOauthProvider,
	gitlabDuoProvider,
	gitLabDuoWorkflowProvider,
	alibabaCodingPlanProvider,
	alibabaTokenPlanProvider,
	aiandProvider,
	aimlApiProvider,
	zhipuCodingPlanProvider,
	umansProvider,
	qwenPortalProvider,
	sakanaProvider,
	minimaxCodeProvider,
	minimaxCodeCnProvider,
	xiaomiProvider,
	xiaomiTokenPlanSgpProvider,
	xiaomiTokenPlanAmsProvider,
	xiaomiTokenPlanCnProvider,
	firepassProvider,
	clinePassProvider,
	deepseekProvider,
	metaProvider,
	moonshotProvider,
	cerebrasProvider,
	basetenProvider,
	fireworksProvider,
	togetherProvider,
	nvidiaProvider,
	novitaProvider,
	deepinfraProvider,
	huggingfaceProvider,
	perplexityProvider,
	qianfanProvider,
	veniceProvider,
	siliconflowProvider,
	siliconflowCnProvider,
	syntheticProvider,
	nanogptProvider,
	waferServerlessProvider,
	coreWeaveProvider,
	vercelAiGatewayProvider,
	cloudflareAiGatewayProvider,
	litellmProvider,
	kiloProvider,
	zenmuxProvider,
	opencodeZenProvider,
	opencodeGoProvider,
	yoloAutoProvider,
	tavilyProvider,
	kagiProvider,
	exaProvider,
	parallelProvider,
	ollamaProvider,
	ollamaCloudProvider,
	lmStudioProvider,
	llamaCppProvider,
	vllmProvider,
	openaiProvider,
	googleProvider,
	googleVertexProvider,
	grokbotProvider,
	groqProvider,
	mistralProvider,
	minimaxProvider,
	amazonBedrockProvider,
	bedrockMantleProvider,
	gmiCloudProvider,
];

/**
 * The single per-provider list, derived from the compiled auth stratum
 * (`@oh-my-pi/pi-catalog` `rules/auth/*.kdl`) in `/login` display order.
 * Adding a provider = one new `auth/<id>.kdl` (plus a `TRANSPORTS` entry when
 * it shapes requests in code). Every legacy structure (`OAuthProvider` union,
 * env map, login list, refresh/login dispatch, CLI callback maps) derives
 * from this registry.
 */
export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = authProviders().map(policy =>
	buildProviderDefinition(policy, TRANSPORTS[policy.id]),
);

const BY_ID: Record<string, ProviderDefinition> = Object.fromEntries(PROVIDER_REGISTRY.map(p => [p.id, p]));

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
	return BY_ID[id];
}

/** Compile-time completeness: every catalog chat-model provider must have an auth policy. */
type _MissingCatalogProviders = Exclude<KnownProvider, AuthProviderId>;
type _CheckRegistryComplete = _MissingCatalogProviders extends never
	? true
	: ["auth rules are missing catalog providers", _MissingCatalogProviders];
true satisfies _CheckRegistryComplete;

/** Loginable providers (those whose auth policy declares a `login` flow). */
export type OAuthProviderUnion = LoginProviderId;
