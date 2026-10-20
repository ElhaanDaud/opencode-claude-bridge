import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KEEPALIVE_FRAME, translateSseStream } from "./stream.js";

const encoder = new TextEncoder();
const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const START = ev("content_block_start", {
  type: "content_block_start",
  index: 1,
  content_block: { type: "tool_use", id: "t1", name: "Write", input: {} },
});
const DELTA = ev("content_block_delta", {
  type: "content_block_delta",
  index: 1,
  delta: { type: "input_json_delta", partial_json: '{"file_path":"/x","content":"abc"}' },
});
const STOP = ev("content_block_stop", { type: "content_block_stop", index: 1 });

function harness(keepaliveMs: number) {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => { upstream = c; } });
  const logs: string[] = [];
  const stream = translateSseStream(
    body,
    {
      inboundToolNameMap: { Write: "write" },
      translateToolArgs: (json) => json.replace('"file_path"', '"filePath"'),
      debug: (msg) => logs.push(msg),
    },
    { keepaliveMs },
  );
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      received += decoder.decode(value, { stream: true });
    }
  })();
  return {
    send: (text: string) => upstream.enqueue(encoder.encode(text)),
    end: () => upstream.close(),
    cancel: () => reader.cancel("interrupted"),
    received: () => received,
    pump,
    logs,
  };
}

describe("translateSseStream keepalive", () => {
  it("sends keepalive comments while a tool_use block is buffered", async () => {
    const h = harness(20);
    h.send(START + DELTA);
    await delay(90);

    assert.ok(h.received().includes(KEEPALIVE_FRAME), "expected a keepalive during buffering");

    h.send(STOP);
    h.end();
    await h.pump;
    assert.ok(h.received().includes('"partial_json":"{\\"filePath\\":\\"/x\\",\\"content\\":\\"abc\\"}"'));
    assert.deepEqual(h.logs, []);
  });

  it("stays quiet when no tool input is buffered", async () => {
    const h = harness(20);
    h.send(START + DELTA + STOP);
    await delay(90);

    assert.equal(h.received().includes(KEEPALIVE_FRAME), false);
    h.end();
    await h.pump;
  });
});

describe("translateSseStream termination", () => {
  it("does not report a cancelled stream as abandoned", async () => {
    const h = harness(0);
    h.send(START + DELTA);
    await delay(10);
    await h.cancel();
    await delay(10);

    assert.deepEqual(h.logs, []);
  });

  it("still reports a tool block the upstream never closed", async () => {
    const h = harness(0);
    h.send(START + DELTA);
    h.end();
    await h.pump;

    assert.equal(h.logs.length, 1);
    assert.match(h.logs[0]!, /abandoned mid-stream: index=1 tool=Write/);
  });
});
