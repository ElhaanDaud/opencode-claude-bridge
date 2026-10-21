import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getClaudeTools } from "../claude-tools.js";
import { applyClaudeToolsForV2, wrapV2Response } from "./tools.js";

type Json = Record<string, any>;

// Property/required sets as captured from OpenCode 2.1.2.
const V2_SCHEMAS: Record<string, { props: string[]; required: string[] }> = {
  edit: { props: ["path", "oldString", "newString", "replaceAll"], required: ["path", "oldString", "newString"] },
  glob: { props: ["pattern", "path", "hidden", "limit"], required: ["pattern"] },
  grep: { props: ["pattern", "path", "include", "literal", "caseSensitive", "limit"], required: ["pattern"] },
  question: { props: ["questions"], required: ["questions"] },
  read: { props: ["path", "offset", "limit"], required: ["path"] },
  shell: { props: ["command", "workdir", "timeout", "background"], required: ["command"] },
  skill: { props: ["id"], required: ["id"] },
  subagent: {
    props: ["agent", "description", "prompt", "model", "sessionID", "background"],
    required: ["agent", "description", "prompt"],
  },
  webfetch: { props: ["url", "format", "timeout"], required: ["url"] },
  websearch: { props: ["query"], required: ["query"] },
  write: { props: ["path", "content"], required: ["path", "content"] },
  patch: { props: ["patchText"], required: ["patchText"] },
  execute: { props: ["code"], required: ["code"] },
  zeta_mcp: { props: ["x"], required: ["x"] },
  alpha_mcp: { props: ["y"], required: [] },
};

function v2Tool(name: string): Json {
  const { props, required } = V2_SCHEMAS[name]!;
  return {
    name,
    description: `v2 ${name}`,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])),
      required,
      additionalProperties: false,
    },
  };
}

function apply(names: string[], extra: Json = {}) {
  const result = applyClaudeToolsForV2(JSON.stringify({ model: "claude-sonnet-5-5", tools: names.map(v2Tool), ...extra }));
  return { ...result, parsed: JSON.parse(result.body) as Json };
}

const toolUse = (name: string, input: Json) => ({ type: "tool_use", id: "toolu_1", name, input });
const history = (block: Json) => ({ messages: [{ role: "assistant", content: [block] }] });
const historicInput = (name: string, input: Json, active: string[] = [name]): Json =>
  apply(active, history(toolUse(name, input))).parsed.messages[0].content[0];

describe("applyClaudeToolsForV2 tool definitions", () => {
  it("swaps each mapped V2 tool for Claude's wire definition", () => {
    const names = Object.keys(V2_SCHEMAS).filter((n) => !["patch", "execute", "zeta_mcp", "alpha_mcp"].includes(n));
    const { parsed, inboundToolNameMap } = apply(names);
    const claude = new Map(getClaudeTools().map((t) => [t.name, t]));
    assert.deepEqual(inboundToolNameMap, {
      Agent: "subagent",
      Bash: "shell",
      Read: "read",
      Write: "write",
      Edit: "edit",
      Glob: "glob",
      Grep: "grep",
      WebFetch: "webfetch",
      WebSearch: "websearch",
      Skill: "skill",
      AskUserQuestion: "question",
    });
    assert.equal(parsed.tools.length, 11);
    for (const tool of parsed.tools) assert.deepEqual(tool, claude.get(tool.name));
  });

  it("adds Claude-only stubs only for active V2 equivalents", () => {
    const { parsed } = apply(["read", "websearch"]);
    assert.deepEqual(parsed.tools.map((t: Json) => t.name), ["Read", "WebSearch"]);
  });

  it("keeps unmapped tools with their own schema, after Claude's tools, alphabetically", () => {
    const { parsed } = apply(["zeta_mcp", "write", "patch", "shell", "alpha_mcp", "execute"]);
    assert.deepEqual(parsed.tools.map((t: Json) => t.name), ["Bash", "Write", "alpha_mcp", "execute", "patch", "zeta_mcp"]);
    assert.deepEqual(parsed.tools.at(-1), v2Tool("zeta_mcp"));
  });

  it("keeps typed tools that have no input_schema", () => {
    const serverTool = { type: "web_search_20250305", name: "web_search" };
    const body = JSON.stringify({ tools: [serverTool, v2Tool("read")] });
    const parsed = JSON.parse(applyClaudeToolsForV2(body).body);
    assert.deepEqual(parsed.tools.map((t: Json) => t.name), ["Read", "web_search"]);
    assert.deepEqual(parsed.tools[1], serverTool);
  });

  it("leaves a V2 tool alone when its schema no longer fits the translation", () => {
    const drifted = v2Tool("read");
    drifted.input_schema.required = ["path", "mode"];
    const body = JSON.stringify({ tools: [drifted, v2Tool("write")] });
    const out = applyClaudeToolsForV2(body);
    const tools = JSON.parse(out.body).tools;
    assert.deepEqual(tools.map((t: Json) => t.name), ["Write", "read"]);
    assert.deepEqual(out.inboundToolNameMap, { Write: "write" });
  });

  it("returns the body untouched when nothing maps, on bad JSON, and on a name collision", () => {
    for (const body of ["not json", JSON.stringify({ tools: [] }), JSON.stringify({ messages: [] }), JSON.stringify({ tools: [v2Tool("patch")] })]) {
      assert.deepEqual(applyClaudeToolsForV2(body), { body, inboundToolNameMap: {} });
    }
    const collision = JSON.stringify({ tools: [v2Tool("read"), { ...v2Tool("patch"), name: "Read" }] });
    assert.deepEqual(applyClaudeToolsForV2(collision), { body: collision, inboundToolNameMap: {} });
  });
});

describe("applyClaudeToolsForV2 history", () => {
  it("renames shell to Bash and folds workdir into the command", () => {
    const block = historicInput("shell", { command: "ls -la", workdir: "/tmp/it's", timeout: 5000, background: true });
    assert.equal(block.name, "Bash");
    assert.deepEqual(block.input, { command: "cd '/tmp/it'\\''s' && ls -la", timeout: 5000, run_in_background: true });
  });

  it("renames read/write/edit paths and fields", () => {
    assert.deepEqual(historicInput("read", { path: "/a", offset: 2, limit: 3 }).input, { file_path: "/a", offset: 2, limit: 3 });
    assert.deepEqual(historicInput("write", { path: "/a", content: "x" }).input, { file_path: "/a", content: "x" });
    assert.deepEqual(
      historicInput("edit", { path: "/a", oldString: "o", newString: "n", replaceAll: true }).input,
      { file_path: "/a", old_string: "o", new_string: "n", replace_all: true },
    );
  });

  it("translates grep options", () => {
    assert.deepEqual(historicInput("grep", { pattern: "a.b", include: "*.ts", caseSensitive: false, limit: 7 }).input, {
      pattern: "a.b", glob: "*.ts", "-i": true, head_limit: 7,
    });
    assert.equal(historicInput("grep", { pattern: "a.b", literal: true }).input.pattern, "a\\.b");
  });

  it("maps subagent agent ids to Claude subagent types", () => {
    const block = historicInput("subagent", { agent: "explore", description: "d", prompt: "p", background: false, sessionID: "ses_1" });
    assert.equal(block.name, "Agent");
    assert.deepEqual(block.input, { description: "d", prompt: "p", run_in_background: false, subagent_type: "Explore" });
    assert.equal(historicInput("subagent", { agent: "general", description: "d", prompt: "p" }).input.subagent_type, "general-purpose");
    assert.equal(historicInput("subagent", { agent: "custom", description: "d", prompt: "p" }).input.subagent_type, "custom");
  });

  it("translates webfetch, skill, websearch and question", () => {
    assert.deepEqual(historicInput("webfetch", { url: "https://x", format: "text", timeout: 5 }).input, {
      url: "https://x", prompt: "Fetch this URL and return the content as plain text.",
    });
    assert.deepEqual(historicInput("skill", { id: "pdf" }).input, { skill: "pdf" });
    assert.deepEqual(historicInput("websearch", { query: "q" }).input, { query: "q" });
    const question = historicInput("question", {
      questions: [{ question: "Q?", header: "H", options: [{ label: "a", description: "A" }], multiple: true }, { question: "R?", header: "H", options: [] }],
    });
    assert.equal(question.name, "AskUserQuestion");
    assert.deepEqual(question.input.questions.map((q: Json) => q.multiSelect), [true, false]);
    assert.equal("multiple" in question.input.questions[0], false);
  });

  it("leaves history of kept tools and non-tool_use blocks untouched", () => {
    const patch = toolUse("patch", { patchText: "x" });
    const text = { type: "text", text: "shell" };
    const result = { type: "tool_result", tool_use_id: "toolu_1", content: "ok" };
    const { parsed } = apply(["patch", "read"], { messages: [{ role: "assistant", content: [patch, text] }, { role: "user", content: [result] }] });
    assert.deepEqual(parsed.messages[0].content, [patch, text]);
    assert.deepEqual(parsed.messages[1].content, [result]);
  });

  it("leaves history of a tool whose definition was not swapped", () => {
    const drifted = v2Tool("read");
    drifted.input_schema.required = ["path", "mode"];
    const block = toolUse("read", { path: "/a" });
    const out = JSON.parse(applyClaudeToolsForV2(JSON.stringify({ tools: [drifted, v2Tool("write")], ...history(block) })).body);
    assert.deepEqual(out.messages[0].content[0], block);
  });

  it("translates tool_choice.name only for swapped tools", () => {
    assert.deepEqual(apply(["shell"], { tool_choice: { type: "tool", name: "shell" } }).parsed.tool_choice, { type: "tool", name: "Bash" });
    assert.deepEqual(apply(["shell", "patch"], { tool_choice: { type: "tool", name: "patch" } }).parsed.tool_choice, { type: "tool", name: "patch" });
    assert.deepEqual(apply(["shell"], { tool_choice: { type: "auto" } }).parsed.tool_choice, { type: "auto" });
  });
});

const encoder = new TextEncoder();
const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function toolStream(name: string, fragments: string[]): string {
  return [
    ev("message_start", { type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name, input: {} } }),
    ...fragments.map((partial_json) =>
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } })),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_stop", { type: "message_stop" }),
  ].join("");
}

function sse(text: string, headers: Record<string, string> = { "content-type": "text/event-stream" }): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

/** Name and assembled input of the first tool_use block in an SSE body. */
async function firstToolUse(response: Response): Promise<{ name: string; input: Json }> {
  const text = await response.text();
  let name = "";
  let json = "";
  for (const frame of text.split("\n\n")) {
    const data = frame.split("\n").find((l) => l.startsWith("data: "));
    if (!data) continue;
    const obj = JSON.parse(data.slice(6));
    if (obj.type === "content_block_start") name = obj.content_block.name;
    if (obj.type === "content_block_delta" && obj.delta.type === "input_json_delta") json += obj.delta.partial_json;
  }
  return { name, input: JSON.parse(json) };
}

const MAP = apply(Object.keys(V2_SCHEMAS)).inboundToolNameMap;

describe("wrapV2Response", () => {
  const cases: Array<[string, Json, string, Json]> = [
    ["Bash", { command: "ls", timeout: 100, description: "d", run_in_background: true, dangerouslyDisableSandbox: false }, "shell", { command: "ls", timeout: 100, background: true }],
    ["Read", { file_path: "/a", offset: 1, limit: 2, pages: "1-2" }, "read", { path: "/a", offset: 1, limit: 2 }],
    ["Write", { file_path: "/a", content: "c" }, "write", { path: "/a", content: "c" }],
    ["Edit", { file_path: "/a", old_string: "o", new_string: "n", replace_all: true }, "edit", { path: "/a", oldString: "o", newString: "n", replaceAll: true }],
    ["Glob", { pattern: "*.ts", path: "/src" }, "glob", { pattern: "*.ts", path: "/src" }],
    ["Grep", { pattern: "p", glob: "*.ts", "-i": true, "-C": 2, output_mode: "content", head_limit: 10 }, "grep", { pattern: "p", include: "*.ts", caseSensitive: false, limit: 10 }],
    ["Grep", { pattern: "p", head_limit: 0 }, "grep", { pattern: "p" }],
    ["WebFetch", { url: "https://x", prompt: "summarise" }, "webfetch", { url: "https://x" }],
    ["WebSearch", { query: "qq", allowed_domains: ["a.com"] }, "websearch", { query: "qq" }],
    ["Skill", { skill: "pdf", args: "x" }, "skill", { id: "pdf" }],
    ["Agent", { description: "d", prompt: "p", subagent_type: "Explore", model: "haiku", run_in_background: true, isolation: "worktree" }, "subagent", { agent: "explore", description: "d", prompt: "p", background: true }],
    ["Agent", { description: "d", prompt: "p", subagent_type: "general-purpose" }, "subagent", { agent: "general", description: "d", prompt: "p" }],
    ["Agent", { description: "d", prompt: "p", subagent_type: "Plan" }, "subagent", { agent: "explore", description: "d", prompt: "p" }],
    ["Agent", { description: "d", prompt: "p", subagent_type: "statusline-setup" }, "subagent", { agent: "general", description: "d", prompt: "p" }],
    ["Agent", { description: "d", prompt: "p", subagent_type: "my-custom" }, "subagent", { agent: "my-custom", description: "d", prompt: "p" }],
    ["Agent", { description: "d", prompt: "p" }, "subagent", { agent: "general", description: "d", prompt: "p" }],
    [
      "AskUserQuestion",
      { questions: [{ question: "Q?", header: "H", multiSelect: true, options: [{ label: "a", description: "A", preview: "p" }] }], answers: {} },
      "question",
      { questions: [{ question: "Q?", header: "H", multiple: true, options: [{ label: "a", description: "A" }] }] },
    ],
  ];

  for (const [claude, input, v2, expected] of cases) {
    it(`translates ${claude} ${JSON.stringify(input).slice(0, 40)} to ${v2}`, async () => {
      const wrapped = wrapV2Response(sse(toolStream(claude, [JSON.stringify(input)])), MAP);
      assert.deepEqual(await firstToolUse(wrapped), { name: v2, input: expected });
    });
  }

  it("translates arguments split mid-key across fragments", async () => {
    const json = JSON.stringify({ file_path: "/tmp/a.txt", old_string: "x", new_string: "y" });
    const cut = json.indexOf("file_") + 5;
    const wrapped = wrapV2Response(sse(toolStream("Edit", [json.slice(0, cut), json.slice(cut, cut + 12), json.slice(cut + 12)])), MAP);
    assert.deepEqual(await firstToolUse(wrapped), { name: "edit", input: { path: "/tmp/a.txt", oldString: "x", newString: "y" } });
  });

  it("does not touch a value that merely contains a key name", async () => {
    const input = { file_path: "/a", content: 'file_path="x" old_string' };
    const wrapped = wrapV2Response(sse(toolStream("Write", [JSON.stringify(input)])), MAP);
    assert.deepEqual((await firstToolUse(wrapped)).input, { path: "/a", content: 'file_path="x" old_string' });
  });

  it("passes unmapped tool calls through", async () => {
    const wrapped = wrapV2Response(sse(toolStream("patch", ['{"patchText":"x"}'])), MAP);
    assert.deepEqual(await firstToolUse(wrapped), { name: "patch", input: { patchText: "x" } });
  });

  it("returns the same response for errors, non-SSE bodies and an empty map", async () => {
    const error = new Response("{}", { status: 429, headers: { "content-type": "text/event-stream" } });
    assert.equal(wrapV2Response(error, MAP), error);
    const json = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    assert.equal(wrapV2Response(json, MAP), json);
    const stream = sse("x");
    assert.equal(wrapV2Response(stream, {}), stream);
  });

  it("keeps status and headers on a wrapped response", () => {
    const wrapped = wrapV2Response(sse(toolStream("Read", ["{}"]), { "content-type": "text/event-stream", "x-test": "1" }), MAP);
    assert.equal(wrapped.status, 200);
    assert.equal(wrapped.headers.get("x-test"), "1");
  });
});
