/**
 * Tools provided by the code harness rather than by this repo.
 *
 * Roles with `harness: "code"` (engineer, qa, sre) run inside a coding agent
 * that already supplies filesystem and shell access -- the Claude Agent SDK is
 * the intended adapter, and it is a separate product from the Messages API this
 * repo calls directly.
 *
 * Reading the repo is NOT here: it is read-only and sandboxed, so it is a
 * company tool in `runner/repo.ts` that api-harness roles (architect, growth)
 * can use directly. Only writing and running things needs the code harness.
 *
 * The names are declared here so that role definitions can be validated at
 * startup instead of silently losing a tool at request time. The adapter itself
 * is NOT implemented yet: `runTurn` rejects a code-harness role rather than
 * running it with a degraded toolset, because an engineer agent that cannot
 * read the repo would confidently produce nothing and bill for it.
 */
export const CODE_HARNESS_TOOL_NAMES = [
  "write_repo",
  "run_checks",
  "record_infra_cost",
] as const;

export type CodeHarnessToolName = (typeof CODE_HARNESS_TOOL_NAMES)[number];

export const isCodeHarnessTool = (name: string): name is CodeHarnessToolName =>
  (CODE_HARNESS_TOOL_NAMES as readonly string[]).includes(name);

export class CodeHarnessNotImplementedError extends Error {
  constructor(role: string) {
    super(
      `role "${role}" needs the code harness (filesystem and shell), which is ` +
        `not wired up in this version. Wire an adapter in src/runner/harness.ts ` +
        `-- the Claude Agent SDK is the intended one -- or run the api-harness ` +
        `roles only. Running it with a degraded toolset would bill for work it ` +
        `cannot do.`,
    );
    this.name = "CodeHarnessNotImplementedError";
  }
}
