import type Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic-hosted server tools.
 *
 * These execute on Anthropic's infrastructure, so there is no handler here --
 * results arrive as content blocks in the same response. They are declared
 * separately from the company toolset because they need no permission handler
 * and because the correct tool `type` depends on the calling model.
 */

export const SERVER_TOOL_NAMES = ["web_search"] as const;
export type ServerToolName = (typeof SERVER_TOOL_NAMES)[number];

export const isServerTool = (name: string): name is ServerToolName =>
  (SERVER_TOOL_NAMES as readonly string[]).includes(name);

/**
 * Models that support the dynamic-filtering web search variant. Older models,
 * Haiku 4.5 among them, take the basic variant instead; sending the newer type
 * to a model that does not support it is a request error, not a soft downgrade.
 */
const DYNAMIC_FILTERING_MODELS = new Set([
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-fable-5-1",
]);

/** Cap on searches per turn, so a scout cannot spend its budget on research. */
const MAX_SEARCH_USES = 5;

export const serverToolFor = (
  name: ServerToolName,
  model: string,
): Anthropic.ToolUnion => {
  switch (name) {
    case "web_search":
      return {
        type: DYNAMIC_FILTERING_MODELS.has(model)
          ? "web_search_20260209"
          : "web_search_20250305",
        name: "web_search",
        max_uses: MAX_SEARCH_USES,
      } as Anthropic.ToolUnion;
  }
};
