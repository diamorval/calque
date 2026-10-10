// The only access to models (rule 2): every provider SDK lives behind this file.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogle } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { dynamicTool, generateText, jsonSchema, stepCountIs, type LanguageModel, type ModelMessage } from "ai";

export type Message = ModelMessage;

/** Provider-specific settings (Azure OpenAI). */
export interface ModelOptions {
  /** Azure resource name, for `https://<resource>.openai.azure.com/openai` (or set the base URL) */
  resource?: string | undefined;
  /** Azure `api-version`: unset or `v1` is the v1 API, a dated one (`2024-10-21`) uses the deployment URLs */
  apiVersion?: string | undefined;
  /** Azure: an Entra ID token from the host's managed identity instead of an API key */
  managedIdentity?: boolean | undefined;
}

export interface ProviderInfo {
  label: string;
  /** an API key is required (Ollama and some gateways run without one) */
  key: boolean;
  /** a base URL is required; else it overrides the provider's default */
  baseURL: boolean;
  defaultBaseURL?: string;
  /** a model name suggested by the configuration form */
  example: string;
  /** what the form calls the model (Azure: the deployment) */
  modelLabel?: string;
  /** provider-specific fields of the form (`ModelConfig.options`) */
  options?: (keyof ModelOptions)[];
}

/** The provider catalog of the AI Models page. */
export const PROVIDERS = {
  anthropic: { label: "Anthropic", key: true, baseURL: false, defaultBaseURL: "https://api.anthropic.com/v1", example: "claude-sonnet-5-5" },
  openai: { label: "OpenAI", key: true, baseURL: false, defaultBaseURL: "https://api.openai.com/v1", example: "gpt-5" },
  azure: {
    label: "Azure OpenAI",
    key: true, // unless the managed identity signs in
    baseURL: false, // the resource name builds it
    defaultBaseURL: "https://<resource>.openai.azure.com/openai",
    example: "gpt-5-deployment",
    modelLabel: "Deployment",
    options: ["resource", "apiVersion", "managedIdentity"],
  },
  mistral: { label: "Mistral", key: true, baseURL: false, defaultBaseURL: "https://api.mistral.ai/v1", example: "mistral-large-latest" },
  gemini: { label: "Gemini", key: true, baseURL: false, defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta", example: "gemini-2.5-pro" },
  ollama: { label: "Ollama", key: false, baseURL: false, defaultBaseURL: "http://localhost:11434/v1", example: "qwen3" },
  "openai-compatible": { label: "OpenAI-compatible endpoint", key: false, baseURL: true, example: "default" },
} satisfies Record<string, ProviderInfo>;

export type ProviderId = keyof typeof PROVIDERS;

export interface ModelConfig {
  provider: ProviderId;
  /** the model name; Azure: the deployment name */
  model: string;
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  /** sent with every request, e.g. an APIM gateway's `Ocp-Apim-Subscription-Key` */
  headers?: Record<string, string> | undefined;
  options?: ModelOptions | undefined;
}

export class ModelConfigError extends Error {}

const COGNITIVE_SERVICES = "https://cognitiveservices.azure.com";

/** An Entra ID token for Azure OpenAI from the host's managed identity, cached until 5 minutes
before it expires: App Service and Container Apps (`IDENTITY_ENDPOINT`), else the instance
metadata endpoint (VMs, AKS nodes). `AZURE_CLIENT_ID` picks a user-assigned identity. */
export function managedIdentity(env = process.env): () => Promise<string> {
  let token: { value: string; until: number } | undefined;
  return async () => {
    if (token && Date.now() < token.until) return token.value;
    const app = env.IDENTITY_ENDPOINT;
    const q = new URLSearchParams({
      resource: COGNITIVE_SERVICES,
      "api-version": app ? "2019-08-01" : "2018-02-01",
      ...(env.AZURE_CLIENT_ID ? { client_id: env.AZURE_CLIENT_ID } : {}),
    });
    const res = await fetch(`${app ?? "http://169.254.169.254/metadata/identity/oauth2/token"}?${q}`, {
      headers: app ? { "X-IDENTITY-HEADER": env.IDENTITY_HEADER ?? "" } : { Metadata: "true" },
    });
    if (!res.ok) throw new ModelConfigError(`managed identity: no token (${res.status} ${await res.text()})`);
    const body = (await res.json()) as { access_token: string; expires_on?: string | number; expires_in?: string | number };
    const until = body.expires_on ? Number(body.expires_on) * 1000 : Date.now() + Number(body.expires_in ?? 300) * 1000;
    token = { value: body.access_token, until: until - 5 * 60_000 };
    return token.value;
  };
}

const hostIdentity = managedIdentity();

function languageModel(c: ModelConfig): LanguageModel {
  const info: ProviderInfo = PROVIDERS[c.provider];
  if (!info) throw new ModelConfigError(`unknown provider ${JSON.stringify(c.provider)}`);
  const o = c.options ?? {};
  const identity = c.provider === "azure" && o.managedIdentity === true;
  if (info.key && !c.apiKey && !identity) throw new ModelConfigError(`${info.label} needs an API key`);
  if (info.baseURL && !c.baseURL) throw new ModelConfigError(`${info.label} needs a base URL`);
  const s = {
    ...(c.apiKey && !identity ? { apiKey: c.apiKey } : {}),
    ...(c.baseURL ? { baseURL: c.baseURL } : {}),
    ...(c.headers && Object.keys(c.headers).length ? { headers: c.headers } : {}),
  };
  switch (c.provider) {
    case "anthropic":
      return createAnthropic(s)(c.model);
    case "openai":
      return createOpenAI(s)(c.model);
    case "azure":
      if (!c.baseURL && !o.resource) throw new ModelConfigError(`${info.label} needs a resource name or a base URL`);
      return createAzure({
        ...s,
        ...(identity ? { tokenProvider: hostIdentity } : {}),
        ...(o.resource && !c.baseURL ? { resourceName: o.resource } : {}),
        ...(o.apiVersion ? { apiVersion: o.apiVersion } : {}),
        // a dated api-version only exists on /openai/deployments/<deployment>/…
        useDeploymentBasedUrls: !!o.apiVersion && o.apiVersion !== "v1",
      }).chat(c.model); // chat completions: every Azure model and API version has it
    case "mistral":
      return createMistral(s)(c.model);
    case "gemini":
      return createGoogle(s)(c.model);
    case "ollama":
    case "openai-compatible":
      return createOpenAICompatible({ ...s, name: c.provider, baseURL: c.baseURL ?? info.defaultBaseURL ?? "" })(c.model);
  }
}

/** One tiny call: throws (bad key, unknown model, unreachable endpoint) unless the model answers. */
export async function testModel(c: ModelConfig): Promise<void> {
  await generateText({ model: languageModel(c), prompt: "Reply OK.", maxOutputTokens: 16, maxRetries: 0 });
}

export interface ToolDef {
  name: string;
  description?: string | undefined;
  /** JSON Schema of the arguments */
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export interface RunInput {
  model: ModelConfig;
  instructions: string;
  messages: Message[];
  tools: ToolDef[];
  maxSteps?: number;
  onStep?: (step: { text: string; toolCalls: { toolName: string; input: unknown }[] }) => void;
}

/** A tool-calling loop until the model answers in text (a question, or the end of the job). */
export async function runTools(i: RunInput): Promise<{ text: string; messages: Message[] }> {
  const r = await generateText({
    model: languageModel(i.model),
    instructions: i.instructions,
    messages: i.messages,
    tools: Object.fromEntries(
      i.tools.map((t) => [
        t.name,
        dynamicTool({
          ...(t.description ? { description: t.description } : {}),
          inputSchema: jsonSchema(t.inputSchema),
          execute: (args) => t.execute(args as Record<string, unknown>),
        }),
      ]),
    ),
    stopWhen: stepCountIs(i.maxSteps ?? 40),
    ...(i.onStep ? { onStepFinish: i.onStep } : {}),
  });
  return { text: r.text, messages: r.responseMessages };
}
