import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelConfigError, PROVIDERS, testModel, type ProviderInfo } from "./index.ts";

/** An Azure OpenAI endpoint (and a managed identity endpoint): records each request, answers "OK". */
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
const server = createServer((req, res) => {
  seen.push({ url: req.url ?? "", headers: req.headers });
  res.setHeader("content-type", "application/json");
  if (req.url?.startsWith("/msi")) return res.end(JSON.stringify({ access_token: "entra-token", expires_on: String(Math.floor(Date.now() / 1000) + 3600) }));
  req.resume();
  req.on("end", () =>
    res.end(
      JSON.stringify({
        id: "c1",
        object: "chat.completion",
        created: 0,
        model: "gpt",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    ),
  );
});
let base = "";
beforeAll(async () => {
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

describe("Azure OpenAI", () => {
  it("is in the catalog, with a deployment and its own fields; every provider shows its default endpoint", () => {
    expect(PROVIDERS.azure).toMatchObject({ label: "Azure OpenAI", modelLabel: "Deployment", options: ["resource", "apiVersion", "managedIdentity"] });
    for (const [id, p] of Object.entries(PROVIDERS) as [string, ProviderInfo][]) if (id !== "openai-compatible") expect(p.defaultBaseURL, id).toBeTruthy();
  });

  it("calls the deployment URL with the api-version, the api-key and the gateway's headers", async () => {
    seen.length = 0;
    await testModel({
      provider: "azure",
      model: "gpt-eu",
      apiKey: "k1",
      baseURL: `${base}/openai`,
      headers: { "Ocp-Apim-Subscription-Key": "apim-1" },
      options: { apiVersion: "2024-10-21" },
    });
    expect(seen[0]?.url).toBe("/openai/deployments/gpt-eu/chat/completions?api-version=2024-10-21");
    expect(seen[0]?.headers["api-key"]).toBe("k1");
    expect(seen[0]?.headers["ocp-apim-subscription-key"]).toBe("apim-1");
  });

  it("uses the v1 API by default", async () => {
    seen.length = 0;
    await testModel({ provider: "azure", model: "gpt-eu", apiKey: "k1", baseURL: `${base}/openai/v1` });
    expect(seen[0]?.url).toBe("/openai/v1/chat/completions");
  });

  it("signs in with the managed identity instead of a key", async () => {
    process.env.IDENTITY_ENDPOINT = `${base}/msi`;
    process.env.IDENTITY_HEADER = "secret-header";
    seen.length = 0;
    try {
      await testModel({ provider: "azure", model: "gpt-eu", baseURL: `${base}/openai`, options: { managedIdentity: true } });
      await testModel({ provider: "azure", model: "gpt-eu", baseURL: `${base}/openai`, options: { managedIdentity: true } });
    } finally {
      delete process.env.IDENTITY_ENDPOINT;
      delete process.env.IDENTITY_HEADER;
    }
    const msi = seen.filter((r) => r.url.startsWith("/msi"));
    expect(msi).toHaveLength(1); // cached
    expect(msi[0]?.url).toContain("resource=https%3A%2F%2Fcognitiveservices.azure.com");
    expect(msi[0]?.headers["x-identity-header"]).toBe("secret-header");
    const calls = seen.filter((r) => !r.url.startsWith("/msi"));
    expect(calls.map((r) => r.headers.authorization)).toEqual(["Bearer entra-token", "Bearer entra-token"]);
    expect(calls[0]?.headers["api-key"]).toBeUndefined();
  });

  it("needs a key (or the managed identity) and a resource (or a base URL)", async () => {
    await expect(testModel({ provider: "azure", model: "d", baseURL: `${base}/openai` })).rejects.toThrow(ModelConfigError);
    await expect(testModel({ provider: "azure", model: "d", apiKey: "k" })).rejects.toThrow(/resource name or a base URL/);
  });
});
