import { spawn } from "node:child_process";
import { recordReportedSpend } from "../ledger/reported.js";

/**
 * Run an agent turn through the Claude Code CLI instead of the Messages API.
 *
 * Why this exists: the API harness needs an ANTHROPIC_API_KEY and bills API
 * credits. The CLI runs on the operator's existing Claude plan, needs no key,
 * and reports its own cost -- so the company can operate without anyone
 * provisioning API billing. It also brings WebSearch, which the scout needs.
 *
 * The tradeoff, stated plainly: this harness does NOT give the model
 * agentcorp's company tools. The CLI has its own toolset. So a turn here
 * cannot claim tickets or call `capture_idea` directly -- it produces
 * structured output which the caller then validates and persists through the
 * normal store functions. That keeps our guardrails authoritative: the model
 * proposes, our pure code judges.
 */

export class ClaudeCliNotFoundError extends Error {
  constructor() {
    super(
      "the `claude` CLI is not on PATH; the CLI harness needs it. Install " +
        "Claude Code, or set ANTHROPIC_API_KEY and use the API harness instead.",
    );
    this.name = "ClaudeCliNotFoundError";
  }
}

export class ClaudeCliFailedError extends Error {
  constructor(code: number | null, stderr: string) {
    super(
      `claude CLI exited with code ${code ?? "null"}: ` +
        (stderr.trim().slice(0, 500) || "(no stderr)"),
    );
    this.name = "ClaudeCliFailedError";
  }
}

interface CliModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly costUSD?: number;
}

interface CliResult {
  readonly result?: string;
  readonly is_error?: boolean;
  readonly total_cost_usd?: number;
  readonly num_turns?: number;
  readonly modelUsage?: Record<string, CliModelUsage>;
}

export interface CliTurnResult {
  readonly text: string;
  readonly costUsd: number;
  readonly turns: number;
  readonly models: readonly string[];
}

export interface CliTurnOptions {
  readonly role: string;
  readonly ticketId: number | null;
  readonly prompt: string;
  readonly cwd: string;
  /** Tools the CLI agent may use, e.g. ["WebSearch", "Write", "Read"]. */
  readonly allowedTools: readonly string[];
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Runs one turn and records its reported cost against the ticket.
 *
 * The prompt goes through an argv array rather than a shell string: these
 * prompts contain quotes, newlines and backticks, and shell-quoting them would
 * be a bug waiting to happen.
 */
export const runCliTurn = async (
  options: CliTurnOptions,
): Promise<CliTurnResult> => {
  const args = [
    "-p", options.prompt,
    "--output-format", "json",
    ...(options.allowedTools.length > 0
      ? ["--allowedTools", options.allowedTools.join(",")]
      : []),
  ];

  const { stdout, stderr, code } = await new Promise<{
    stdout: string; stderr: string; code: number | null;
  }>((resolve, reject) => {
    const child = spawn("claude", args, { cwd: options.cwd });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude CLI exceeded ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new ClaudeCliNotFoundError() : error);
    });
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
  });

  if (code !== 0) throw new ClaudeCliFailedError(code, stderr);

  let parsed: CliResult;
  try {
    parsed = JSON.parse(stdout) as CliResult;
  } catch {
    throw new Error(
      `could not parse claude CLI output as JSON (first 300 chars): ` +
        stdout.slice(0, 300),
    );
  }

  // Record spend even on an error turn: a failed turn still costs money, and
  // hiding that from the ledger is how burn rate becomes a surprise.
  const usage = parsed.modelUsage ?? {};
  const models = Object.keys(usage);
  const costUsd = parsed.total_cost_usd ?? 0;

  if (models.length === 0) {
    await recordReportedSpend({
      ticketId: options.ticketId, agentRole: options.role,
      model: "claude-code-cli", inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd,
    });
  } else {
    for (const model of models) {
      const u = usage[model]!;
      await recordReportedSpend({
        ticketId: options.ticketId,
        agentRole: options.role,
        model,
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cacheReadInputTokens ?? 0,
        cacheWriteTokens: u.cacheCreationInputTokens ?? 0,
        // Prefer the per-model figure; fall back to splitting the total.
        costUsd: u.costUSD ?? costUsd / models.length,
      });
    }
  }

  if (parsed.is_error === true) {
    throw new Error(`claude CLI reported an error turn: ${parsed.result ?? "(no detail)"}`);
  }

  return {
    text: parsed.result ?? "",
    costUsd,
    turns: parsed.num_turns ?? 1,
    models,
  };
};
