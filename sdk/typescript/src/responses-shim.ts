import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { CodexSecurityError } from "./errors.js";

/**
 * Translation shim between the OpenAI Responses API (required by the Codex
 * CLI for custom model providers since `wire_api = "chat"` was removed) and
 * OpenAI-compatible Chat Completions servers such as Aether Desktop,
 * llama-server, ollama, or vLLM.
 *
 * The shim binds to 127.0.0.1 on an ephemeral port, accepts
 * `POST /v1/responses` with `stream: true`, forwards the turn to
 * `<upstream>/chat/completions`, and re-emits the chat SSE stream as
 * Responses SSE events ending in `response.completed`.
 */

export interface ResponsesShimOptions {
  /** Chat Completions base URL, e.g. `http://127.0.0.1:8183/v1`. */
  upstreamBaseUrl: string;
  /** Bearer token sent to the upstream server, when it requires one. */
  upstreamApiKey?: string;
  /** Loopback port to bind; 0 (default) selects an ephemeral port. */
  port?: number;
}

export interface ResponsesShimHandle {
  /** Responses-API base URL to configure as the provider `base_url`. */
  readonly baseUrl: string;
  readonly port: number;
  close(): Promise<void>;
}

interface ResponseItem {
  readonly [key: string]: unknown;
}

interface ResponsesRequestBody {
  readonly model?: unknown;
  readonly instructions?: unknown;
  readonly input?: unknown;
  readonly tools?: unknown;
  readonly tool_choice?: unknown;
  readonly max_output_tokens?: unknown;
  readonly stream?: unknown;
  readonly [key: string]: unknown;
}

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type SseWriter = (event: string, data: Record<string, unknown>) => void;

export async function startResponsesShim(
  options: ResponsesShimOptions,
): Promise<ResponsesShimHandle> {
  const upstreamBaseUrl = options.upstreamBaseUrl.replace(/\/+$/u, "");
  let upstreamOrigin: URL;
  try {
    upstreamOrigin = new URL(upstreamBaseUrl);
  } catch {
    throw new CodexSecurityError(
      `The model provider base URL is invalid: ${options.upstreamBaseUrl}`,
    );
  }
  if (
    upstreamOrigin.protocol !== "http:" &&
    upstreamOrigin.protocol !== "https:"
  ) {
    throw new CodexSecurityError(
      `The model provider base URL must use http or https: ${options.upstreamBaseUrl}`,
    );
  }
  const upstreamApiKey = options.upstreamApiKey;

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(
        JSON.stringify({
          error: {
            message: `Local model gateway failure: ${errorMessage(error)}`,
          },
        }),
      );
    });
  });

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = request.url ?? "/";
    if (request.method === "POST" && url.startsWith("/v1/responses")) {
      const body = await readJsonBody(request);
      await serveResponses(request, response, body);
      return;
    }
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      const upstream = await fetch(`${upstreamBaseUrl}/models`, {
        headers: upstreamHeaders(upstreamApiKey),
      });
      const payload = await upstream.text();
      response.writeHead(upstream.status, {
        "content-type": "application/json",
      });
      response.end(payload);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: `The local model gateway does not serve ${url}.` },
      }),
    );
  }

  async function serveResponses(
    request: IncomingMessage,
    response: ServerResponse,
    body: ResponsesRequestBody,
  ): Promise<void> {
    if (body.stream !== true) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message:
              "The local model gateway only supports streamed Responses API requests.",
          },
        }),
      );
      return;
    }
    const model = typeof body.model === "string" ? body.model : "unknown";
    const chatBody = buildChatBody(body);
    const abortController = new AbortController();
    const onClose = (): void => abortController.abort();
    request.once("close", onClose);
    let upstream: Response;
    try {
      upstream = await fetch(`${upstreamBaseUrl}/chat/completions`, {
        method: "POST",
        headers: upstreamHeaders(upstreamApiKey),
        body: JSON.stringify(chatBody),
        signal: abortController.signal,
      });
    } catch (error) {
      request.removeListener("close", onClose);
      if (abortController.signal.aborted) return;
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            type: "upstream_unreachable",
            message: `The model endpoint is unreachable: ${errorMessage(error)}`,
          },
        }),
      );
      return;
    }
    if (!upstream.ok || upstream.body === null) {
      const detail = (await upstream.text().catch(() => "")).slice(0, 2000);
      response.writeHead(upstream.status || 502, {
        "content-type": "application/json",
      });
      // Forward the upstream error body verbatim when it is JSON so callers
      // keep the server's error type and code; otherwise wrap the text.
      let parsed: unknown;
      try {
        parsed = JSON.parse(detail);
      } catch {
        parsed = undefined;
      }
      if (isRecord(parsed) && isRecord(parsed["error"])) {
        response.end(detail);
      } else {
        response.end(
          JSON.stringify({
            error: {
              message: `The model endpoint returned ${upstream.status}.`,
              detail,
            },
          }),
        );
      }
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const write: SseWriter = (event, data) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const responseId = `resp_${randomUUID()}`;
    const skeleton = responseSkeleton(responseId, model, "in_progress");
    write("response.created", { type: "response.created", response: skeleton });
    write("response.in_progress", {
      type: "response.in_progress",
      response: skeleton,
    });

    const turn = new TurnState(write, responseId, model);
    try {
      await streamChatIntoResponses(upstream, turn);
    } catch (error) {
      request.removeListener("close", onClose);
      if (abortController.signal.aborted) return;
      // The Codex CLI treats a truncated stream as a reconnectable failure.
      response.write(
        `event: error\ndata: ${JSON.stringify({
          type: "error",
          error: { message: errorMessage(error) },
        })}\n\n`,
      );
      response.end();
      return;
    }
    request.removeListener("close", onClose);
    const completed = turn.complete(body);
    write("response.completed", {
      type: "response.completed",
      response: completed,
    });
    response.end();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new CodexSecurityError(
      "The local model gateway could not bind a loopback port.",
    );
  }
  const port = address.port;
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Accumulates output items and emits their SSE events for one turn. */
class TurnState {
  readonly #write: SseWriter;
  readonly #responseId: string;
  readonly #model: string;
  readonly #finished: ResponseItem[] = [];
  #nextOutputIndex = 0;
  #message: { id: string; text: string; emitted: boolean } | null = null;
  readonly #functionCalls = new Map<
    number,
    { item: Record<string, unknown>; args: string; index: number }
  >();
  #usage: Record<string, unknown> | null = null;

  public constructor(write: SseWriter, responseId: string, model: string) {
    this.#write = write;
    this.#responseId = responseId;
    this.#model = model;
  }

  public appendText(delta: string): void {
    if (delta.length === 0) return;
    const message = this.#ensureMessage();
    message.text += delta;
    this.#write("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: this.#messageOutputIndex,
      content_index: 0,
      delta,
    });
  }

  public appendFunctionCall(
    chatIndex: number,
    id: string | undefined,
    name: string | undefined,
    argumentDelta: string | undefined,
  ): void {
    let entry = this.#functionCalls.get(chatIndex);
    if (entry === undefined) {
      const index = this.#nextOutputIndex++;
      const item: Record<string, unknown> = {
        type: "function_call",
        id: `fc_${randomUUID()}`,
        call_id: id ?? `call_${randomUUID()}`,
        name: name ?? "",
        arguments: "",
        status: "in_progress",
      };
      entry = { item, args: "", index };
      this.#functionCalls.set(chatIndex, entry);
      this.#write("response.output_item.added", {
        type: "response.output_item.added",
        output_index: index,
        item,
      });
    }
    if (id !== undefined && id !== "") entry.item["call_id"] = id;
    if (name !== undefined && name !== "") entry.item["name"] = name;
    if (argumentDelta !== undefined && argumentDelta !== "") {
      entry.args += argumentDelta;
      this.#write("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: entry.item["id"],
        output_index: entry.index,
        delta: argumentDelta,
      });
    }
  }

  public recordUsage(usage: Record<string, unknown>): void {
    this.#usage = usage;
  }

  public complete(body: ResponsesRequestBody): Record<string, unknown> {
    if (this.#message !== null && this.#message.emitted) {
      const message = this.#message;
      const part = { type: "output_text", annotations: [], text: message.text };
      const item = {
        type: "message",
        id: message.id,
        status: "completed",
        role: "assistant",
        content: [part],
      };
      this.#write("response.output_text.done", {
        type: "response.output_text.done",
        item_id: message.id,
        output_index: this.#messageOutputIndex,
        content_index: 0,
        text: message.text,
      });
      this.#write("response.content_part.done", {
        type: "response.content_part.done",
        item_id: message.id,
        output_index: this.#messageOutputIndex,
        content_index: 0,
        part,
      });
      this.#write("response.output_item.done", {
        type: "response.output_item.done",
        output_index: this.#messageOutputIndex,
        item,
      });
      this.#finished.push(item);
    }
    for (const entry of this.#functionCalls.values()) {
      const item: Record<string, unknown> = {
        ...entry.item,
        arguments: entry.args,
        status: "completed",
      };
      this.#write("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: item["id"],
        output_index: entry.index,
        arguments: entry.args,
      });
      this.#write("response.output_item.done", {
        type: "response.output_item.done",
        output_index: entry.index,
        item,
      });
      this.#finished.push(item);
    }
    const completed = responseSkeleton(
      this.#responseId,
      this.#model,
      "completed",
    );
    completed["output"] = this.#finished;
    completed["instructions"] =
      typeof body.instructions === "string" ? body.instructions : null;
    completed["usage"] = normalizeUsage(this.#usage);
    return completed;
  }

  #messageOutputIndex = 0;

  #ensureMessage(): { id: string; text: string; emitted: boolean } {
    if (this.#message !== null) return this.#message;
    const index = this.#nextOutputIndex++;
    const message = { id: `msg_${randomUUID()}`, text: "", emitted: true };
    this.#message = message;
    this.#messageOutputIndex = index;
    const item = {
      type: "message",
      id: message.id,
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    this.#write("response.output_item.added", {
      type: "response.output_item.added",
      output_index: index,
      item,
    });
    this.#write("response.content_part.added", {
      type: "response.content_part.added",
      item_id: message.id,
      output_index: index,
      content_index: 0,
      part: { type: "output_text", annotations: [], text: "" },
    });
    return message;
  }
}

async function streamChatIntoResponses(
  upstream: Response,
  turn: TurnState,
): Promise<void> {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (isRecord(chunk["usage"])) {
          turn.recordUsage(chunk["usage"] as Record<string, unknown>);
        }
        const choices = chunk["choices"];
        if (!Array.isArray(choices) || choices.length === 0) continue;
        const choice = choices[0];
        if (!isRecord(choice)) continue;
        const delta = isRecord(choice["delta"]) ? choice["delta"] : {};
        if (typeof delta["content"] === "string") {
          turn.appendText(delta["content"]);
        }
        if (Array.isArray(delta["tool_calls"])) {
          for (const raw of delta["tool_calls"]) {
            if (!isRecord(raw)) continue;
            const index =
              typeof raw["index"] === "number" ? (raw["index"] as number) : 0;
            const fn = isRecord(raw["function"]) ? raw["function"] : {};
            turn.appendFunctionCall(
              index,
              typeof raw["id"] === "string" ? (raw["id"] as string) : undefined,
              typeof fn["name"] === "string"
                ? (fn["name"] as string)
                : undefined,
              typeof fn["arguments"] === "string"
                ? (fn["arguments"] as string)
                : undefined,
            );
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function buildChatBody(body: ResponsesRequestBody): Record<string, unknown> {
  const chat: Record<string, unknown> = {
    model: typeof body.model === "string" ? body.model : "",
    messages: toChatMessages(body),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (typeof body.max_output_tokens === "number") {
    chat["max_tokens"] = body.max_output_tokens;
  }
  if (typeof body["temperature"] === "number") {
    chat["temperature"] = body["temperature"];
  }
  if (typeof body["top_p"] === "number") {
    chat["top_p"] = body["top_p"];
  }
  const tools = toChatTools(body);
  if (tools !== undefined) {
    chat["tools"] = tools;
    chat["tool_choice"] = toChatToolChoice(body.tool_choice);
  }
  return chat;
}

function toChatMessages(body: ResponsesRequestBody): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (typeof body.instructions === "string" && body.instructions !== "") {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;
  for (const raw of input) {
    if (!isRecord(raw)) continue;
    const type = raw["type"];
    if (type === undefined || type === "message") {
      const role = raw["role"];
      const chatRole =
        role === "developer" || role === "system"
          ? "system"
          : role === "assistant"
            ? "assistant"
            : "user";
      messages.push({
        role: chatRole,
        content: flattenContent(raw["content"]),
      });
    } else if (type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id:
              typeof raw["call_id"] === "string"
                ? (raw["call_id"] as string)
                : `call_${randomUUID()}`,
            type: "function",
            function: {
              name:
                typeof raw["name"] === "string" ? (raw["name"] as string) : "",
              arguments:
                typeof raw["arguments"] === "string"
                  ? (raw["arguments"] as string)
                  : "",
            },
          },
        ],
      });
    } else if (type === "function_call_output") {
      const output = raw["output"];
      messages.push({
        role: "tool",
        tool_call_id:
          typeof raw["call_id"] === "string" ? (raw["call_id"] as string) : "",
        content:
          typeof output === "string" ? output : JSON.stringify(output ?? ""),
      });
    }
    // Other item types (reasoning summaries etc.) carry no input for the
    // chat backend and are intentionally dropped.
  }
  return messages;
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      parts.push(raw);
    } else if (isRecord(raw) && typeof raw["text"] === "string") {
      parts.push(raw["text"] as string);
    }
  }
  return parts.join("");
}

function toChatTools(
  body: ResponsesRequestBody,
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(body.tools)) return undefined;
  const tools: Record<string, unknown>[] = [];
  for (const raw of body.tools) {
    if (!isRecord(raw) || raw["type"] !== "function") continue;
    tools.push({
      type: "function",
      function: {
        name: typeof raw["name"] === "string" ? raw["name"] : "",
        description:
          typeof raw["description"] === "string" ? raw["description"] : "",
        parameters: isRecord(raw["parameters"])
          ? raw["parameters"]
          : { type: "object", properties: {} },
        ...(raw["strict"] === true ? { strict: true } : {}),
      },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function toChatToolChoice(choice: unknown): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  if (isRecord(choice) && choice["type"] === "function") {
    return {
      type: "function",
      function: {
        name: typeof choice["name"] === "string" ? choice["name"] : "",
      },
    };
  }
  return "auto";
}

function normalizeUsage(
  usage: Record<string, unknown> | null,
): Record<string, unknown> {
  const input =
    usage !== null && typeof usage["prompt_tokens"] === "number"
      ? (usage["prompt_tokens"] as number)
      : 0;
  const output =
    usage !== null && typeof usage["completion_tokens"] === "number"
      ? (usage["completion_tokens"] as number)
      : 0;
  const total =
    usage !== null && typeof usage["total_tokens"] === "number"
      ? (usage["total_tokens"] as number)
      : input + output;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function responseSkeleton(
  id: string,
  model: string,
  status: "in_progress" | "completed",
): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    instructions: null,
    output: [],
    metadata: {},
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    truncation: "disabled",
    error: null,
    incomplete_details: null,
    usage: null,
  };
}

function upstreamHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiKey === undefined || apiKey === ""
      ? {}
      : { authorization: `Bearer ${apiKey}` }),
  };
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<ResponsesRequestBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024 * 1024) {
      throw new CodexSecurityError(
        "The local model gateway received an oversized request.",
      );
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as ResponsesRequestBody;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
