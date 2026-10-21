/**
 * Claude Code tool parity for OpenCode 2.
 *
 * V2 names and shapes its tools differently from both V1 and Claude Code
 * (`shell`, `subagent`, `path` instead of `filePath`, ...), so the V1 name
 * tables do not apply. Each V2 tool with a faithful Claude Code counterpart is
 * replaced by Claude's wire-captured definition on the way out, and the model's
 * Claude-shaped tool calls are translated back into input V2's tool accepts.
 * Every other tool (`patch`, `execute`, MCP/custom) keeps its own definition.
 */

import {
  AGENT_TYPE_CLAUDE_TO_OPENCODE,
  AGENT_TYPE_OPENCODE_TO_CLAUDE,
  getClaudeTools,
} from "../claude-tools.js";
import type { ToolDefinition } from "../claude-tools.js";
import { translateSseStream } from "../stream.js";

type Json = Record<string, unknown>;

interface Mapping {
  v2: string;
  claude: string;
  /**
   * V2 input properties the inbound translation may emit; guards against schema
   * drift. `a[].b` is property `b` of the objects in array `a`.
   */
  produces: readonly string[];
  /** Claude tool input -> V2 tool input. Keys it does not know are dropped: V2 schemas are strict. */
  toV2(input: Json): Json;
  /** V2 tool input from history -> what Claude's schema would have carried. */
  toClaude(input: Json): Json;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copy `input`, renaming per `names`; keys absent from `names` are dropped. */
function rename(input: Json, names: Record<string, string>): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(input)) {
    const to = names[key];
    if (to !== undefined) out[to] = value;
  }
  return out;
}

function invert(names: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(names).map(([from, to]) => [to, from]));
}

/** A plain rename in both directions. */
function simple(v2: string, claude: string, names: Record<string, string>): Mapping {
  const back = invert(names);
  return {
    v2,
    claude,
    produces: Object.values(names),
    toV2: (input) => rename(input, names),
    toClaude: (input) => rename(input, back),
  };
}

// V2 only lets `explore` and `general` run as subagents ("Agent plan cannot run as a subagent"),
// so Claude's Plan and statusline-setup land on the closest runnable one.
const CLAUDE_AGENT_TO_V2: Record<string, string> = {
  ...AGENT_TYPE_CLAUDE_TO_OPENCODE,
  Plan: "explore",
  "statusline-setup": "general",
};

const FETCH_PROMPTS: Record<string, string> = {
  text: "Fetch this URL and return the content as plain text.",
  html: "Fetch this URL and return the raw HTML.",
  markdown: "Fetch this URL and return the content as markdown.",
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Questions may arrive as a JSON string; anything else non-array is left for V2 to reject. */
function questionList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

const MAPPINGS: readonly Mapping[] = [
  {
    v2: "subagent",
    claude: "Agent",
    produces: ["agent", "description", "prompt", "background"],
    toV2(input) {
      const out = rename(input, {
        description: "description",
        prompt: "prompt",
        run_in_background: "background",
      });
      const type = typeof input.subagent_type === "string" ? input.subagent_type : "general-purpose";
      // `model` is dropped: Claude's enum (sonnet/opus/haiku) is not a V2 "provider/model" id.
      return { agent: CLAUDE_AGENT_TO_V2[type] ?? type, ...out };
    },
    toClaude(input) {
      const out = rename(input, {
        description: "description",
        prompt: "prompt",
        background: "run_in_background",
      });
      const agent = typeof input.agent === "string" ? input.agent : undefined;
      if (agent === undefined) return out;
      return { ...out, subagent_type: AGENT_TYPE_OPENCODE_TO_CLAUDE[agent] ?? agent };
    },
  },
  {
    v2: "shell",
    claude: "Bash",
    produces: ["command", "timeout", "background"],
    toV2: (input) => rename(input, { command: "command", timeout: "timeout", run_in_background: "background" }),
    toClaude(input) {
      const out = rename(input, { command: "command", timeout: "timeout", background: "run_in_background" });
      // Claude's Bash has no working-directory field; fold it into the command so history still shows where it ran.
      if (typeof input.workdir === "string" && typeof out.command === "string") {
        out.command = `cd ${shellQuote(input.workdir)} && ${out.command}`;
      }
      return out;
    },
  },
  simple("read", "Read", { file_path: "path", offset: "offset", limit: "limit" }),
  simple("write", "Write", { file_path: "path", content: "content" }),
  simple("edit", "Edit", {
    file_path: "path",
    old_string: "oldString",
    new_string: "newString",
    replace_all: "replaceAll",
  }),
  simple("glob", "Glob", { pattern: "pattern", path: "path" }),
  {
    v2: "grep",
    claude: "Grep",
    produces: ["pattern", "path", "include", "caseSensitive", "limit"],
    toV2(input) {
      const out = rename(input, { pattern: "pattern", path: "path", glob: "include" });
      if (typeof input["-i"] === "boolean") out.caseSensitive = !input["-i"];
      // head_limit 0 means unlimited in Claude; V2 requires a positive limit.
      if (typeof input.head_limit === "number" && input.head_limit > 0) out.limit = input.head_limit;
      return out;
    },
    toClaude(input) {
      const out = rename(input, { pattern: "pattern", path: "path", include: "glob", limit: "head_limit" });
      if (input.caseSensitive === false) out["-i"] = true;
      if (input.literal === true && typeof out.pattern === "string") out.pattern = escapeRegex(out.pattern);
      return out;
    },
  },
  {
    v2: "webfetch",
    claude: "WebFetch",
    produces: ["url"],
    // Claude's `prompt` has no V2 field (V2 returns the page itself), so it is dropped.
    toV2: (input) => rename(input, { url: "url" }),
    toClaude(input) {
      const out = rename(input, { url: "url" });
      const format = typeof input.format === "string" ? input.format : "markdown";
      return { ...out, prompt: FETCH_PROMPTS[format] ?? FETCH_PROMPTS.markdown };
    },
  },
  {
    v2: "websearch",
    claude: "WebSearch",
    produces: ["query"],
    toV2: (input) => rename(input, { query: "query" }),
    toClaude: (input) => rename(input, { query: "query" }),
  },
  {
    v2: "skill",
    claude: "Skill",
    produces: ["id"],
    toV2: (input) => rename(input, { skill: "id" }),
    toClaude: (input) => rename(input, { id: "skill" }),
  },
  {
    v2: "question",
    claude: "AskUserQuestion",
    produces: [
      "questions",
      "questions[].question",
      "questions[].header",
      "questions[].options",
      "questions[].multiple",
      "questions[].options[].label",
      "questions[].options[].description",
    ],
    toV2(input) {
      const questions = questionList(input.questions);
      if (!Array.isArray(questions)) return rename(input, { questions: "questions" });
      return {
        questions: questions.map((item) => {
          if (!isRecord(item)) return item;
          const out = rename(item, { question: "question", header: "header", options: "options", multiSelect: "multiple" });
          if (Array.isArray(out.options)) {
            // Claude's `preview` is not in V2's option schema.
            out.options = out.options.map((opt) => (isRecord(opt) ? rename(opt, { label: "label", description: "description" }) : opt));
          }
          return out;
        }),
      };
    },
    toClaude(input) {
      const out = rename(input, { questions: "questions" });
      if (!Array.isArray(out.questions)) return out;
      out.questions = out.questions.map((item) => {
        if (!isRecord(item)) return item;
        const q = rename(item, { question: "question", header: "header", options: "options" });
        // Claude requires multiSelect on every question.
        q.multiSelect = item.multiple === true;
        return q;
      });
      return out;
    },
  },
];

const BY_V2 = new Map(MAPPINGS.map((m) => [m.v2, m]));

function toolName(tool: unknown): string | undefined {
  return isRecord(tool) && typeof tool.name === "string" ? tool.name : undefined;
}

/** `schemaFits` for one object schema; `paths` are relative to it. */
function objectFits(schema: unknown, paths: readonly string[]): boolean {
  if (!isRecord(schema) || !isRecord(schema.properties)) return false;
  const properties = schema.properties;
  const own = paths.filter((p) => !p.includes("[]."));
  const required = Array.isArray(schema.required) ? schema.required : [];
  return (
    required.every((key) => typeof key === "string" && own.includes(key)) &&
    own.every((key) => {
      if (!Object.hasOwn(properties, key)) return false;
      const nested = paths.filter((p) => p.startsWith(`${key}[].`)).map((p) => p.slice(key.length + 3));
      const property = properties[key];
      return nested.length === 0 || (isRecord(property) && objectFits(property.items, nested));
    })
  );
}

/**
 * True when V2's tool still looks the way the translator assumes, nested array
 * items included: every required V2 property is one the translation can
 * supply, and every property it emits exists. Otherwise the V2 tool is left
 * alone.
 */
function schemaFits(tool: unknown, mapping: Mapping): boolean {
  return objectFits(isRecord(tool) ? tool.input_schema : undefined, mapping.produces);
}

function translateInput(mapping: Mapping, direction: "toV2" | "toClaude", input: unknown): unknown {
  return isRecord(input) ? mapping[direction](input) : input;
}

/**
 * Swap V2's tools for Claude Code's wire definitions where a faithful
 * counterpart exists, translate the history, and report the Claude -> V2 name
 * map the response needs. A body this cannot handle safely comes back as-is
 * with an empty map.
 */
export function applyClaudeToolsForV2(body: string): { body: string; inboundToolNameMap: Record<string, string> } {
  const unchanged = { body, inboundToolNameMap: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return unchanged;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tools) || parsed.tools.length === 0) return unchanged;

  const claudeByName = new Map<string, ToolDefinition>(getClaudeTools().map((tool) => [tool.name, tool]));
  const active = new Map<string, Mapping>();
  const claudeSent = new Set<string>();
  const passthrough: unknown[] = [];
  for (const tool of parsed.tools) {
    const name = toolName(tool);
    const mapping = name === undefined ? undefined : BY_V2.get(name);
    if (mapping && schemaFits(tool, mapping) && claudeByName.has(mapping.claude)) {
      active.set(mapping.v2, mapping);
      claudeSent.add(mapping.claude);
    } else {
      passthrough.push(tool);
    }
  }
  if (active.size === 0) return unchanged;
  // A kept tool that already uses a Claude name would collide with the swapped definition.
  if (passthrough.some((tool) => claudeSent.has(toolName(tool) ?? ""))) return unchanged;

  const core = getClaudeTools().filter((tool) => claudeSent.has(tool.name));
  const rest = passthrough.sort((a, b) => (toolName(a) ?? "").localeCompare(toolName(b) ?? ""));
  parsed.tools = [...core, ...rest];

  if (Array.isArray(parsed.messages)) {
    for (const message of parsed.messages) {
      if (!isRecord(message) || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
        // Only tools swapped in this request: a kept V2 tool must stay V2-shaped in history too.
        const mapping = active.get(block.name);
        if (!mapping) continue;
        block.name = mapping.claude;
        block.input = translateInput(mapping, "toClaude", block.input);
      }
    }
  }

  if (isRecord(parsed.tool_choice) && typeof parsed.tool_choice.name === "string") {
    const mapping = active.get(parsed.tool_choice.name);
    if (mapping) parsed.tool_choice.name = mapping.claude;
  }

  const inboundToolNameMap: Record<string, string> = {};
  for (const mapping of active.values()) inboundToolNameMap[mapping.claude] = mapping.v2;
  return { body: JSON.stringify(parsed), inboundToolNameMap };
}

const BY_CLAUDE = new Map(MAPPINGS.map((m) => [m.claude, m]));

/** Streamed-argument translator for translateSseStream: input is the whole assembled JSON. */
function translateStreamedArgs(json: string, claudeName: string): string {
  const mapping = BY_CLAUDE.get(claudeName);
  if (!mapping) return json;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (!isRecord(parsed)) return json;
  return JSON.stringify(mapping.toV2(parsed));
}

/**
 * Rewrite Claude tool names and arguments in a streamed response back to V2's.
 * Errors and non-SSE bodies pass through untouched.
 */
export function wrapV2Response(response: Response, inboundToolNameMap: Record<string, string>): Response {
  if (!response.body || !response.ok || Object.keys(inboundToolNameMap).length === 0) return response;
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response;
  // Only translate calls to tools that were swapped in this request.
  const translateToolArgs = (json: string, claudeName: string): string =>
    claudeName in inboundToolNameMap ? translateStreamedArgs(json, claudeName) : json;
  return new Response(
    translateSseStream(response.body, {
      inboundToolNameMap,
      translateToolArgs,
      debug: (msg) => console.error(`[opencode-claude-bridge] stream: ${msg}`),
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}
