import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { afterAll, describe, expect, test } from "bun:test";
import {
  ambientModelProviders,
  customProviderName,
  mergeAmbientModelProviders,
  prepareLocalGateway,
  scanAuthentication,
} from "../src/api.js";
import type { JsonObject } from "../src/config.js";
import { ConfigurationError } from "../src/errors.js";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.allSettled(
    temporaryDirectories.map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(
    await mkdtemp(join(tmpdir(), "codex-security-gateway-")),
  );
  temporaryDirectories.push(path);
  return path;
}

const AETHER_BLOCK: JsonObject = {
  name: "Aether Desktop",
  base_url: "http://127.0.0.1:8183/v1",
  wire_api: "responses",
  env_key: "AETHER_API_KEY",
};

describe("custom provider configuration", () => {
  test("recognizes custom providers but not the default OpenAI provider", () => {
    expect(customProviderName({})).toBeNull();
    expect(customProviderName({ model_provider: "" })).toBeNull();
    expect(customProviderName({ model_provider: "openai" })).toBeNull();
    expect(customProviderName({ model_provider: "aether" })).toBe("aether");
  });

  test("reports model_provider authentication ahead of OpenAI credentials", () => {
    const config: JsonObject = {
      model_provider: "aether",
      model_providers: { aether: AETHER_BLOCK },
    };
    expect(scanAuthentication({}, "auto", config)).toEqual({
      method: "model_provider",
      provider: "aether",
      source: "AETHER_API_KEY",
      verified: false,
    });
    // Even an explicit --auth api-key without a key must not throw when a
    // custom provider is configured: the provider supplies credentials.
    expect(scanAuthentication({}, "api-key", config)).toMatchObject({
      method: "model_provider",
      provider: "aether",
    });
    expect(
      scanAuthentication({ OPENAI_API_KEY: "synthetic" }, "auto", config),
    ).toMatchObject({ method: "model_provider" });
  });

  test("falls back to OpenAI authentication for the default provider", () => {
    expect(
      scanAuthentication({ OPENAI_API_KEY: "synthetic" }, "auto", {
        model_provider: "openai",
      }),
    ).toEqual({
      method: "api_key",
      source: "OPENAI_API_KEY",
      verified: false,
    });
    expect(scanAuthentication({}, "auto", {})).toEqual({
      method: "stored_credentials",
      verified: false,
    });
  });
});

describe("ambient model providers", () => {
  test("reads only the model_providers table from ambient config", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      join(home, "config.toml"),
      [
        'model = "gpt-5.6-sol"',
        "",
        "[model_providers.aether]",
        'name = "Aether Desktop"',
        'base_url = "http://127.0.0.1:8183/v1"',
        'wire_api = "responses"',
        'env_key = "AETHER_API_KEY"',
        "",
      ].join("\n"),
    );

    expect(await ambientModelProviders(home)).toEqual({
      aether: {
        name: "Aether Desktop",
        base_url: "http://127.0.0.1:8183/v1",
        wire_api: "responses",
        env_key: "AETHER_API_KEY",
      },
    });
  });

  test("tolerates missing and unparsable ambient configuration", async () => {
    const home = await temporaryDirectory();
    expect(await ambientModelProviders(home)).toBeNull();
    await writeFile(
      join(home, "config.toml"),
      "[model_providers.aether\nbroken",
    );
    expect(await ambientModelProviders(home)).toBeNull();
    await writeFile(join(home, "config.toml"), 'model = "gpt-5.6-sol"\n');
    expect(await ambientModelProviders(home)).toBeNull();
  });

  test("merges ambient definitions without overriding explicit ones", () => {
    const merged = mergeAmbientModelProviders(
      {
        model_provider: "aether",
        model_providers: {
          aether: { name: "explicit", base_url: "http://127.0.0.1:9/v1" },
        },
      },
      {
        aether: { name: "ambient", base_url: "http://127.0.0.1:8183/v1" },
        llama: { name: "llama", base_url: "http://127.0.0.1:8080/v1" },
      },
    );
    expect(merged["model_providers"]).toEqual({
      aether: { name: "explicit", base_url: "http://127.0.0.1:9/v1" },
      llama: { name: "llama", base_url: "http://127.0.0.1:8080/v1" },
    });
    expect(merged["model_provider"]).toBe("aether");
    // No ambient providers leaves the config untouched.
    const passthrough: JsonObject = { model: "m" };
    expect(mergeAmbientModelProviders(passthrough, null)).toBe(passthrough);
  });
});

describe("prepareLocalGateway", () => {
  test("leaves OpenAI scans untouched", async () => {
    const config: JsonObject = { model: "gpt-5.6-sol" };
    const result = await prepareLocalGateway(config, {});
    expect(result.gateway).toBeNull();
    expect(result.config).toBe(config);
  });

  test("rejects an undefined provider with actionable guidance", async () => {
    await expect(
      prepareLocalGateway({ model_provider: "aether" }, {}),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      prepareLocalGateway({ model_provider: "aether" }, {}),
    ).rejects.toThrow('The model provider "aether" is not defined');
  });

  test("rejects a provider whose API key variable is unset", async () => {
    await expect(
      prepareLocalGateway(
        {
          model_provider: "aether",
          model_providers: { aether: AETHER_BLOCK },
        },
        { AETHER_API_KEY: "   " },
      ),
    ).rejects.toThrow("AETHER_API_KEY");
  });

  test("rewrites the provider base URL to the local gateway", async () => {
    const result = await prepareLocalGateway(
      {
        model: "local-llama",
        model_provider: "aether",
        model_providers: { aether: AETHER_BLOCK },
      },
      { AETHER_API_KEY: "synthetic-aether-key" },
    );
    try {
      expect(result.gateway).not.toBeNull();
      const block = (result.config["model_providers"] as JsonObject)[
        "aether"
      ] as JsonObject;
      expect(block["base_url"]).toBe(result.gateway!.baseUrl);
      expect(block["wire_api"]).toBe("responses");
      expect(block["env_key"]).toBe("AETHER_API_KEY");
      expect(block["name"]).toBe("Aether Desktop");
      expect(result.config["model"]).toBe("local-llama");
    } finally {
      await result.gateway?.close();
    }
  });

  test("forwards Responses requests to the provider endpoint", async () => {
    const received: Array<{
      authorization: string | undefined;
      body: JsonObject;
    }> = [];
    const upstream: Server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          authorization: Array.isArray(request.headers.authorization)
            ? request.headers.authorization[0]
            : request.headers.authorization,
          body: JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as JsonObject,
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "local-llama",
            choices: [
              { index: 0, delta: { content: "secure" }, finish_reason: "stop" },
            ],
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (address === null || typeof address === "string") {
      throw new Error("upstream has no address");
    }
    const upstreamUrl = `http://127.0.0.1:${address.port}/v1`;

    const result = await prepareLocalGateway(
      {
        model: "local-llama",
        model_provider: "aether",
        model_providers: {
          aether: { ...AETHER_BLOCK, base_url: upstreamUrl },
        },
      },
      { AETHER_API_KEY: "synthetic-aether-key" },
    );
    try {
      const response = await fetch(`${result.gateway!.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "local-llama",
          input: "scan this",
          stream: true,
        }),
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain('"secure"');
      expect(text).toContain("event: response.completed");
      expect(received).toHaveLength(1);
      expect(received[0]!.authorization).toBe("Bearer synthetic-aether-key");
      expect(received[0]!.body["model"]).toBe("local-llama");
    } finally {
      await result.gateway?.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });
});
