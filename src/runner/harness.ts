import Anthropic from "@anthropic-ai/sdk";
import { recordSpend } from "../ledger/ledger.js";
import type { RoleDefinition } from "../roles/types.js";
import { CodeHarnessNotImplementedError } from "./code-tools.js";
import { isServerTool, serverToolFor } from "./server-tools.js";
import { callTool, toolsForRole, type ToolContext } from "./tools.js";

/**
 * Executes one agent turn against the Messages API.
 *
 * This is the manual tool-use loop rather than the SDK tool runner, because the
 * company needs to price and record every single model call into the ledger
 * between iterations and block the moment a budget is exhausted. Owning the
 * loop is what makes that enforceable.
 */

let client: Anthropic | undefined;

/**
 * The SDK resolves credentials itself: ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN,
 * then an OAuth profile from `ant auth login`. Constructing with no arguments
 * is deliberate -- an unset API key does not mean there are no credentials.
 */
const getClient = (): Anthropic => {
  client ??= new Anthropic();
  return client;
};

/** Models that still take a fixed thinking budget rather than adaptive thinking. */
const FIXED_BUDGET_MODELS = new Set(["claude-haiku-4-5"]);
const HAIKU_THINKING_BUDGET = 4096;
const MAX_TOKENS = 32_000;

const thinkingFor = (
  model: string,
): Anthropic.ThinkingConfigParam | undefined =>
  FIXED_BUDGET_MODELS.has(model)
    ? { type: "enabled", budget_tokens: HAIKU_THINKING_BUDGET }
    : { type: "adaptive" };

export interface TurnResult {
  readonly text: string;
  readonly costUsd: number;
  readonly iterations: number;
  readonly toolCalls: number;
  /** Set when safety classifiers declined the request. */
  readonly refusal?: Anthropic.RefusalStopDetails;
  readonly hitIterationCap: boolean;
}

export interface TurnOptions {
  readonly role: RoleDefinition;
  readonly systemPrompt: string;
  readonly turnPrompt: string;
  readonly ctx: ToolContext;
  /** Stop and return once this much has been spent on this turn. */
  readonly remainingBudgetUsd: number;
  readonly maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 12;

const textOf = (message: Anthropic.Message): string =>
  message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

export const runTurn = async (options: TurnOptions): Promise<TurnResult> => {
  const { role, ctx } = options;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Refuse rather than silently degrade: an engineer without repo access would
  // produce confident nothing and bill for it.
  if (role.harness === "code") throw new CodeHarnessNotImplementedError(role.name);

  const tools: Anthropic.ToolUnion[] = [
    ...toolsForRole(role.name),
    ...role.tools
      .filter(isServerTool)
      .map((name) => serverToolFor(name, role.model)),
  ];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: options.turnPrompt },
  ];

  let costUsd = 0;
  let toolCalls = 0;
  let iterations = 0;
  let lastText = "";

  while (iterations < maxIterations) {
    iterations += 1;

    // Streaming because max_tokens is large; a non-streaming request of this
    // size risks an HTTP timeout rather than a useful answer.
    const stream = getClient().messages.stream({
      model: role.model,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: options.systemPrompt,
          // The charter and rules are identical across every turn of this role,
          // so caching the prefix turns the standing cost of the role's
          // instructions into a cache read.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
      tools,
      output_config: { effort: role.effort },
      ...(thinkingFor(role.model) !== undefined
        ? { thinking: thinkingFor(role.model)! }
        : {}),
    });

    const message = await stream.finalMessage();

    costUsd += await recordSpend({
      ticketId: ctx.ticketId,
      agentRole: role.name,
      model: role.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    });

    // Check stop_reason before reading content: a refusal returns HTTP 200 with
    // no usable answer, and treating it as a normal empty response would look
    // like the agent simply had nothing to say.
    if (message.stop_reason === "refusal") {
      return {
        text: textOf(message),
        costUsd,
        iterations,
        toolCalls,
        ...(message.stop_details !== null
          ? { refusal: message.stop_details }
          : {
              refusal: {
                type: "refusal" as const,
                category: null,
                explanation: null,
              },
            }),
        hitIterationCap: false,
      };
    }

    lastText = textOf(message) || lastText;
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason !== "tool_use") {
      return { text: lastText, costUsd, iterations, toolCalls, hitIterationCap: false };
    }

    const toolUses = message.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    // All results go back in ONE user message. Splitting them across messages
    // silently teaches the model to stop issuing parallel calls.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      toolCalls += 1;
      try {
        const output = await callTool(
          use.name,
          (use.input ?? {}) as Record<string, unknown>,
          ctx,
        );
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(output ?? { ok: true }),
        });
      } catch (error) {
        // Errors are returned to the model, not thrown: a guardrail rejection
        // is information the agent should act on, and dropping the result block
        // would break the conversation shape.
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: (error as Error).message,
        });
      }
    }
    messages.push({ role: "user", content: results });

    if (costUsd >= options.remainingBudgetUsd) {
      return {
        text:
          lastText ||
          "turn stopped: ticket budget exhausted mid-turn",
        costUsd,
        iterations,
        toolCalls,
        hitIterationCap: false,
      };
    }
  }

  return { text: lastText, costUsd, iterations, toolCalls, hitIterationCap: true };
};
