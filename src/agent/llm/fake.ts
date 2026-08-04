import type { LlmClient, LlmCompleteParams } from "./client.js";

/** Deterministic, queue-based fake for tests — never calls a real LLM. */
export class FakeLlmClient implements LlmClient {
  private readonly queue: string[] = [];
  readonly calls: LlmCompleteParams[] = [];

  enqueueResponse(response: string): void {
    this.queue.push(response);
  }

  enqueueJson(value: unknown): void {
    this.queue.push(JSON.stringify(value));
  }

  async complete(params: LlmCompleteParams): Promise<string> {
    this.calls.push(params);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error("FakeLlmClient: no more canned responses queued");
    }
    return next;
  }
}
