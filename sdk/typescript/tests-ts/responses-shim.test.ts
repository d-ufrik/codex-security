import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "bun:test";
import type { JsonObject } from "../src/config.js";
import {
  startResponsesShim,
  type ResponsesShimHandle,
} from "../src/responses-shim.js";

interface RecordedRequest {
  authorization: string | undefined;
  body: JsonObject;
}

interface MockChatBackend {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

function chatChunk(
  delta: JsonObject,
  finishReason: string | null = null,
  usage?: JsonObject,
): string {
  const chunk: JsonObject = {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage !== undefined) {
    chunk["usage"] = usage;
  }
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function startMockChat(
  handler: (request: RecordedRequest, response: ServerResponse) => void,
): Promise<MockChatBackend> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const recorded: RecordedRequest = {
        authorization: Array.isArray(request.headers.authorization)
          ? request.headers.authorization[0]
          : request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject,
      };
      requests.push(recorded);
      handler(recorded, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock chat backend has no address");
  }
  const backend: MockChatBackend = {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      ),
  };
  cleanups.push(() => backend.close());
  return backend;
}

async function startShim(
  options: Parameters<typeof startResponsesShim>[0],
): Promise<ResponsesShimHandle> {
  const handle = await startResponsesShim(options);
  cleanups.push(() => handle.close());
  return handle;
}

async function postResponses(
  shim: ResponsesShimHandle,
  body: JsonObject,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${shim.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function parseSseEvents(
  text: string,
): Array<{ event: string; data: JsonObject | undefined }> {
  const events: Array<{ event: string; data: JsonObject | undefined }> = [];
  for (const block of text.split("\n\n")) {
    const trimmed = block.trim();
    if (trimmed === "") continue;
    let event = "message";
    let data = "";
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice("data:".length).trim();
      }
    }
    events.push({
      event,
      data: data === "" ? undefined : (JSON.parse(data) as JsonObject),
    });
  }
  return events;
}

function eventNames(events: Array<{ event: string }>): string[] {
  return events.map((entry) => entry.event);
}

describe("responses shim", () => {
  test("translates streamed chat text into Responses events", async () => {
    const backend = await startMockChat((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chatChunk({ role: "assistant" }));
      response.write(chatChunk({ content: "Hello " }));
      response.write(chatChunk({ content: "world" }));
      response.write(
        chatChunk({}, "stop", {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        }),
      );
      response.end("data: [DONE]\n\n");
    });
    const shim = await startShim({ upstreamBaseUrl: backend.url });

    const { status, text } = await postResponses(shim, {
      model: "mock-model",
      input: "hi",
      stream: true,
    });

    expect(status).toBe(200);
    const events = parseSseEvents(text);
    expect(eventNames(events)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const deltas = events
      .filter((entry) => entry.event === "response.output_text.delta")
      .map((entry) => entry.data?.["delta"]);
    expect(deltas).toEqual(["Hello ", "world"]);
    const completed = events.find(
      (entry) => entry.event === "response.completed",
    )?.data?.["response"] as JsonObject | undefined;
    expect(completed?.["status"]).toBe("completed");
    const output = completed?.["output"] as JsonObject[];
    expect(
      ((output[0]?.["content"] as JsonObject[])[0] as JsonObject)["text"],
    ).toBe("Hello world");
    expect(completed?.["usage"]).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      output_tokens_details: { reasoning_tokens: 0 },
    });

    expect(backend.requests).toHaveLength(1);
    const forwarded = backend.requests[0]!.body;
    expect(forwarded["model"]).toBe("mock-model");
    expect(forwarded["stream"]).toBe(true);
    expect(forwarded["stream_options"]).toEqual({ include_usage: true });
    expect(forwarded["messages"]).toEqual([{ role: "user", content: "hi" }]);
  });

  test("maps instructions and developer messages onto system messages", async () => {
    const backend = await startMockChat((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chatChunk({ content: "ok" }, "stop"));
      response.end("data: [DONE]\n\n");
    });
    const shim = await startShim({ upstreamBaseUrl: backend.url });

    await postResponses(shim, {
      model: "mock-model",
      instructions: "be careful",
      input: [
        { role: "developer", content: "policy note" },
        { role: "user", content: "review this" },
      ],
      stream: true,
    });

    expect(backend.requests[0]!.body["messages"]).toEqual([
      { role: "system", content: "be careful" },
      { role: "system", content: "policy note" },
      { role: "user", content: "review this" },
    ]);
  });

  test("round-trips function calls and outputs across turns", async () => {
    const backend = await startMockChat((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (backend.requests.length === 1) {
        response.write(chatChunk({ role: "assistant" }));
        response.write(
          chatChunk({
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "shell", arguments: "" },
              },
            ],
          }),
        );
        response.write(
          chatChunk({
            tool_calls: [{ index: 0, function: { arguments: "ls " } }],
          }),
        );
        response.write(
          chatChunk({
            tool_calls: [{ index: 0, function: { arguments: "-la" } }],
          }),
        );
        response.write(chatChunk({}, "tool_calls"));
        response.end("data: [DONE]\n\n");
        return;
      }
      response.write(chatChunk({ content: "done" }, "stop"));
      response.end("data: [DONE]\n\n");
      void request;
    });
    const shim = await startShim({ upstreamBaseUrl: backend.url });

    const first = await postResponses(shim, {
      model: "mock-model",
      input: "list files",
      tools: [
        {
          type: "function",
          name: "shell",
          description: "run a command",
          parameters: { type: "object", properties: {} },
        },
        { type: "web_search_preview" },
      ],
      tool_choice: "auto",
      stream: true,
    });

    const firstEvents = parseSseEvents(first.text);
    expect(eventNames(firstEvents)).toContain(
      "response.function_call_arguments.delta",
    );
    const argumentDeltas = firstEvents
      .filter(
        (entry) => entry.event === "response.function_call_arguments.delta",
      )
      .map((entry) => entry.data?.["delta"]);
    expect(argumentDeltas).toEqual(["ls ", "-la"]);
    const argumentsDone = firstEvents.find(
      (entry) => entry.event === "response.function_call_arguments.done",
    )?.data;
    expect(argumentsDone?.["arguments"]).toBe("ls -la");
    const completed = firstEvents.find(
      (entry) => entry.event === "response.completed",
    )?.data?.["response"] as JsonObject | undefined;
    const output = completed?.["output"] as JsonObject[];
    expect(output[0]).toMatchObject({
      type: "function_call",
      name: "shell",
      call_id: "call_1",
      arguments: "ls -la",
      status: "completed",
    });

    // Second turn: feed the function call and its output back in.
    await postResponses(shim, {
      model: "mock-model",
      input: [
        { role: "user", content: "list files" },
        {
          type: "function_call",
          name: "shell",
          call_id: "call_1",
          arguments: "ls -la",
          status: "completed",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "file listing",
        },
      ],
      stream: true,
    });

    expect(backend.requests).toHaveLength(2);
    const firstForwarded = backend.requests[0]!.body;
    expect(firstForwarded["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "shell",
          description: "run a command",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(firstForwarded["tool_choice"]).toBe("auto");
    expect(backend.requests[1]!.body["messages"]).toEqual([
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "shell", arguments: "ls -la" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file listing" },
    ]);
  });

  test("forwards the upstream API key and generation limits", async () => {
    const backend = await startMockChat((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chatChunk({ content: "ok" }, "stop"));
      response.end("data: [DONE]\n\n");
    });
    const shim = await startShim({
      upstreamBaseUrl: backend.url,
      upstreamApiKey: "synthetic-upstream-key",
    });

    await postResponses(shim, {
      model: "mock-model",
      input: "hi",
      max_output_tokens: 256,
      temperature: 0.2,
      stream: true,
    });

    expect(backend.requests[0]!.authorization).toBe(
      "Bearer synthetic-upstream-key",
    );
    expect(backend.requests[0]!.body["max_tokens"]).toBe(256);
    expect(backend.requests[0]!.body["temperature"]).toBe(0.2);
  });

  test("surfaces upstream HTTP errors unchanged", async () => {
    const backend = await startMockChat((_request, response) => {
      response.writeHead(501, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "unsupported", type: "unsupported" },
        }),
      );
    });
    const shim = await startShim({ upstreamBaseUrl: backend.url });

    const { status, text } = await postResponses(shim, {
      model: "mock-model",
      input: "hi",
      stream: true,
    });

    expect(status).toBe(501);
    expect(JSON.parse(text)).toEqual({
      error: { message: "unsupported", type: "unsupported" },
    });
  });

  test("reports an unreachable upstream as a bad gateway", async () => {
    const shim = await startShim({
      upstreamBaseUrl: "http://127.0.0.1:1/v1",
    });

    const { status, text } = await postResponses(shim, {
      model: "mock-model",
      input: "hi",
      stream: true,
    });

    expect(status).toBe(502);
    expect(JSON.parse(text).error.type).toBe("upstream_unreachable");
  });

  test("rejects non-streamed requests", async () => {
    const backend = await startMockChat((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: [DONE]\n\n");
    });
    const shim = await startShim({ upstreamBaseUrl: backend.url });

    const { status } = await postResponses(shim, {
      model: "mock-model",
      input: "hi",
      stream: false,
    });

    expect(status).toBe(400);
    expect(backend.requests).toHaveLength(0);
  });
});
