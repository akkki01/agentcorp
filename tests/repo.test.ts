import { describe, expect, test } from "vitest";
import {
  listRepo, PathDeniedError, PathEscapesRepoError, readRepoFile, safeResolve,
} from "../src/runner/repo.js";

describe("repo sandbox", () => {
  test("resolves a path inside the repo", () => {
    // Asserted against the actual root rather than a hardcoded directory
    // name: the old version matched /agentcorp\/package\.json$/ and broke the
    // moment the suite ran from a git worktree, which is a property of the
    // checkout, not of the sandbox being tested.
    const resolved = safeResolve("package.json");
    expect(resolved.endsWith("/package.json")).toBe(true);
    expect(resolved.startsWith(process.cwd())).toBe(true);
  });

  test("blocks a relative traversal out of the repo", () => {
    expect(() => safeResolve("../../../etc/passwd")).toThrow(PathEscapesRepoError);
  });

  test("blocks an absolute path outside the repo", () => {
    expect(() => safeResolve("/etc/passwd")).toThrow(PathEscapesRepoError);
  });

  test("blocks a traversal that climbs back out after going in", () => {
    expect(() => safeResolve("src/../../../../etc/passwd")).toThrow(
      PathEscapesRepoError,
    );
  });

  test("blocks the git directory, which holds credentials and history", () => {
    expect(() => safeResolve(".git/config")).toThrow(PathDeniedError);
  });

  test("blocks node_modules, which is noise an agent should never pay to read", () => {
    expect(() => safeResolve("node_modules/typescript/package.json")).toThrow(
      PathDeniedError,
    );
  });

  test("blocks the env file even when reached via a nested path", () => {
    expect(() => safeResolve("src/../.env")).toThrow(PathDeniedError);
  });

  test("names the sandbox root in the error, so the agent can correct itself", () => {
    expect(() => safeResolve("/tmp/elsewhere")).toThrow(/sandboxed to/);
  });

  test("lists the repo root without leaking denied directories", async () => {
    const entries = await listRepo(".");
    const names = entries.map((e) => e.path);
    expect(names).toContain("package.json");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
  });

  test("reports file sizes so an agent can avoid reading a huge file", async () => {
    const entries = await listRepo("src/ideas");
    const file = entries.find((e) => e.path.endsWith("scoring.ts"));
    expect(file?.kind).toBe("file");
    expect(file?.bytes).toBeGreaterThan(0);
  });

  test("reads a real file's contents", async () => {
    const file = await readRepoFile("package.json");
    expect(file.content).toContain('"name": "agentcorp"');
    expect(file.truncated).toBe(false);
  });

  test("refuses to read a directory as a file", async () => {
    await expect(readRepoFile("src")).rejects.toThrow(/not a file/);
  });
});
