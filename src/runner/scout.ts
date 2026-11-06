import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { captureIdea, scoreIdea } from "../ideas/store.js";
import { assertScores, RUBRIC, RUBRIC_KEYS, type IdeaScores } from "../ideas/scoring.js";
import { getRole } from "../roles/registry.js";
import { runCliTurn } from "./cli-harness.js";

/**
 * Run a scout sweep through the Claude Code CLI harness.
 *
 * The division of labour is deliberate: the model searches and proposes scores,
 * but OUR code judges. `assertScores` rejects malformed scoring and `judge`
 * (inside `scoreIdea`) decides shortlisting. A model that inflates its own
 * scores to look productive cannot promote an idea past the rubric, which is
 * the property that makes the funnel worth having.
 */

export interface SweepResult {
  readonly captured: number;
  readonly fresh: number;
  readonly shortlisted: number;
  readonly rejected: number;
  readonly costUsd: number;
  readonly rows: readonly string[];
  readonly skipped: readonly string[];
}

interface ProposedIdea {
  title?: string;
  hypothesis?: string;
  niche?: string;
  sourceKind?: string;
  sourceRef?: string;
  evidence?: string[];
  scores?: Partial<IdeaScores>;
}

const rubricBlock = (): string =>
  RUBRIC_KEYS.map(
    (k) => `  - ${k} (weight ${RUBRIC[k].weight}): ${RUBRIC[k].question}`,
  ).join("\n");

const buildPrompt = (brief: string, outPath: string): string => {
  const charter = getRole("scout").charter;
  return `You are the "scout" role in an agent-operated company. This is your charter:

${charter}

# This sweep's brief

${brief}

# Scoring rubric -- score every idea 0-5 on each dimension

${rubricBlock()}

Any dimension scored 0 or 1 is a VETO: the idea is rejected regardless of its
total. Score harshly. You are measured on how many of your shortlisted ideas
survive validation, not on how many you file.

# Method

1. Use WebSearch to find real candidates. Search for people already paying too
   much, and for people maintaining manual workarounds -- that second one is
   the strongest signal available to you.
2. For EVERY candidate, also search for who already sells it. An idea with a
   credible incumbent -- especially a free one -- should score low on the
   dimensions that reflect that. Four ideas in a previous sweep were killed by
   exactly this check, so do it before you file, not after.
3. Every idea needs a real sourceRef: a URL you actually visited. An idea you
   reasoned your way to with no source must be scored 0-2 on demandEvidenced,
   because that is the honest score.

# Output

Write a JSON array to exactly this path: ${outPath}

Each element:
{
  "title": "specific, not a category",
  "hypothesis": "who pays, for what, and why now",
  "niche": "short slug",
  "sourceKind": "forum | review | competitor | pricing | usage | news",
  "sourceRef": "a URL you actually visited",
  "evidence": ["quoted facts, including who the incumbents are and their prices"],
  "scores": { ${RUBRIC_KEYS.map((k) => `"${k}": 0`).join(", ")} }
}

Write ONLY the JSON array to that file. Then reply with one line: how many you
captured. Do not write an essay.`;
};

export const runScoutSweep = async (
  brief: string,
  options: { readonly ticketId?: number | null; readonly cwd?: string } = {},
): Promise<SweepResult> => {
  const outPath = join(tmpdir(), `agentcorp-scout-${randomUUID()}.json`);
  const role = getRole("scout");

  const turn = await runCliTurn({
    role: role.name,
    ticketId: options.ticketId ?? null,
    prompt: buildPrompt(brief, outPath),
    cwd: options.cwd ?? process.cwd(),
    allowedTools: ["WebSearch", "WebFetch", "Write", "Read"],
  });

  let proposed: ProposedIdea[];
  try {
    proposed = JSON.parse(await readFile(outPath, "utf8")) as ProposedIdea[];
  } catch (error) {
    throw new Error(
      `scout did not produce readable JSON at ${outPath} ` +
        `(${(error as Error).message}). Its reply was: ${turn.text.slice(0, 300)}`,
    );
  } finally {
    await rm(outPath, { force: true });
  }

  if (!Array.isArray(proposed)) throw new Error("scout output was not a JSON array");

  const rows: string[] = [];
  const skipped: string[] = [];
  let captured = 0, fresh = 0, shortlisted = 0, rejected = 0;

  for (const p of proposed) {
    // Validate before touching the database. A malformed proposal is the
    // scout's bug, not a reason to abort the whole sweep.
    if (
      typeof p.title !== "string" || p.title.trim().length < 3 ||
      typeof p.hypothesis !== "string" || typeof p.niche !== "string" ||
      typeof p.sourceKind !== "string" || typeof p.sourceRef !== "string" ||
      p.sourceRef.trim() === ""
    ) {
      skipped.push(`malformed or unsourced: ${String(p.title ?? "(untitled)").slice(0, 70)}`);
      continue;
    }

    let scores: IdeaScores;
    try {
      scores = assertScores(p.scores ?? {});
    } catch (error) {
      skipped.push(`${p.title.slice(0, 50)} -- ${(error as Error).message}`);
      continue;
    }

    const { idea, isNew } = await captureIdea({
      title: p.title, hypothesis: p.hypothesis, niche: p.niche,
      sourceKind: p.sourceKind, sourceRef: p.sourceRef,
      evidence: Array.isArray(p.evidence) ? p.evidence : [],
      foundBy: role.name,
    });
    captured += 1;
    if (isNew) fresh += 1;

    const { verdict } = await scoreIdea(idea.id, scores);
    if (verdict.vetoedBy.length > 0) rejected += 1;
    else if (verdict.shortlisted) shortlisted += 1;

    const state = verdict.vetoedBy.length > 0
      ? `VETOED(${verdict.vetoedBy.join(",")})`
      : verdict.shortlisted ? "shortlisted" : "below bar";
    rows.push(
      `#${String(idea.id).padEnd(4)} ${String(verdict.total).padStart(5)}  ` +
      `${state.padEnd(26)} ${p.title}`,
    );
  }

  return { captured, fresh, shortlisted, rejected, costUsd: turn.costUsd, rows, skipped };
};
