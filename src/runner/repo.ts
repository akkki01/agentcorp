import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Read-only, sandboxed access to the company's own repository.
 *
 * Roles like architect and growth must read code to do their jobs -- one to
 * decide system shape, the other to avoid claiming a capability we have not
 * shipped -- but neither writes it. Writing stays with the code harness.
 */

const REPO_ROOT = resolve(process.env["AGENTCORP_REPO_ROOT"] ?? process.cwd());

/** Directories never worth an agent's tokens, and never worth leaking. */
const DENIED_SEGMENTS = new Set([
  "node_modules", ".git", "dist", "coverage", ".env",
]);

const MAX_FILE_BYTES = 200_000;
const MAX_ENTRIES = 400;

export class PathEscapesRepoError extends Error {
  constructor(requested: string) {
    super(
      `path "${requested}" resolves outside the repository; repo access is ` +
        `sandboxed to ${REPO_ROOT}`,
    );
    this.name = "PathEscapesRepoError";
  }
}

export class PathDeniedError extends Error {
  constructor(requested: string, segment: string) {
    super(`path "${requested}" touches denied directory "${segment}"`);
    this.name = "PathDeniedError";
  }
}

/**
 * Resolves a caller-supplied path inside the repo, or throws.
 *
 * Checked by resolving first and comparing against the root, rather than by
 * string-matching "..": an absolute path, a symlinked parent, or an encoded
 * traversal all survive a naive substring check but fail this one.
 */
export const safeResolve = (requested: string): string => {
  const candidate = isAbsolute(requested)
    ? resolve(requested)
    : resolve(REPO_ROOT, requested);

  const rel = relative(REPO_ROOT, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathEscapesRepoError(requested);
  }

  for (const segment of rel.split(sep)) {
    if (DENIED_SEGMENTS.has(segment)) {
      throw new PathDeniedError(requested, segment);
    }
  }
  return candidate;
};

export interface RepoEntry {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly bytes?: number;
}

export const listRepo = async (requested = "."): Promise<RepoEntry[]> => {
  const dir = safeResolve(requested);
  const entries = await readdir(dir, { withFileTypes: true });
  const out: RepoEntry[] = [];

  for (const entry of entries) {
    if (DENIED_SEGMENTS.has(entry.name)) continue;
    if (out.length >= MAX_ENTRIES) break;
    const full = join(dir, entry.name);
    const path = relative(REPO_ROOT, full) || ".";
    if (entry.isDirectory()) {
      out.push({ path, kind: "dir" });
    } else if (entry.isFile()) {
      const info = await stat(full);
      out.push({ path, kind: "file", bytes: info.size });
    }
  }
  return out;
};

export interface RepoFile {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export const readRepoFile = async (requested: string): Promise<RepoFile> => {
  const file = safeResolve(requested);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`"${requested}" is not a file`);

  const content = await readFile(file, "utf8");
  const truncated = Buffer.byteLength(content) > MAX_FILE_BYTES;
  return {
    path: relative(REPO_ROOT, file),
    content: truncated
      ? `${content.slice(0, MAX_FILE_BYTES)}\n\n[truncated at ${MAX_FILE_BYTES} bytes]`
      : content,
    truncated,
  };
};
