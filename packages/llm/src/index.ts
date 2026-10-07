// The only access to models (rule 2): every provider SDK lives behind this file.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { dynamicTool, generateText, jsonSchema, stepCountIs, type LanguageModel, type ModelMessage } from "ai";

export type Message = ModelMessage;

export interface ProviderInfo {
  label: string;
  /** an API key is required (Ollama and some gateways run without one) */
  key: boolean;
  /** a base URL is required; else it overrides the provider's default */
  baseURL: boolean;
  defaultBaseURL?: string;
  /** a model name suggested by the configuration form */
  example: string;
}

/** The provider catalog of the AI Models page. */
export const PROVIDERS = {
  anthropic: { label: "Anthropic", key: true, baseURL: false, example: "claude-sonnet-5-5" },
  openai: { label: "OpenAI", key: true, baseURL: false, example: "gpt-5" },
  mistral: { label: "Mistral", key: true, baseURL: false, example: "mistral-large-latest" },
  gemini: { label: "Gemini", key: true, baseURL: false, example: "gemini-2.5-pro" },
  ollama: { label: "Ollama", key: false, baseURL: false, defaultBaseURL: "http://localhost:11434/v1", example: "qwen3" },
  "openai-compatible": { label: "OpenAI-compatible endpoint", key: false, baseURL: true, example: "default" },
} satisfies Record<string, ProviderInfo>;

export type ProviderId = keyof typeof PROVIDERS;

export interface ModelConfig {
  provider: ProviderId;
  model: string;
  apiKey?: string | undefined;
  baseURL?: string | undefined;
}

export class ModelConfigError extends Error {}

function languageModel(c: ModelConfig): LanguageModel {
  const info: ProviderInfo = PROVIDERS[c.provider];
  if (!info) throw new ModelConfigError(`unknown provider ${JSON.stringify(c.provider)}`);
  if (info.key && !c.apiKey) throw new ModelConfigError(`${info.label} needs an API key`);
  if (info.baseURL && !c.baseURL) throw new ModelConfigError(`${info.label} needs a base URL`);
  const s = { ...(c.apiKey ? { apiKey: c.apiKey } : {}), ...(c.baseURL ? { baseURL: c.baseURL } : {}) };
  switch (c.provider) {
    case "anthropic":
      return createAnthropic(s)(c.model);
    case "openai":
      return createOpenAI(s)(c.model);
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
