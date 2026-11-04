import { describe, expect, test } from "vitest";
import {
  ALL_ROLES, getRole, mayFile, mayOwn, rolesInLoop,
  UnknownRoleError, UnknownToolError, validateRoles, vetoRoles,
} from "../src/roles/registry.js";
import { CODE_HARNESS_TOOL_NAMES, isCodeHarnessTool } from "../src/runner/code-tools.js";
import { SERVER_TOOL_NAMES } from "../src/runner/server-tools.js";
import { MODEL_PRICES } from "../src/ledger/pricing.js";
import { TOOL_NAMES } from "../src/runner/tools.js";
import { violatesAuthorship } from "../src/guardrails/authorship.js";

describe("role registry", () => {
  test("defines every role exactly once", () => {
    const names = ALL_ROLES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("covers all three loops", () => {
    expect(rolesInLoop("strategy").length).toBeGreaterThan(0);
    expect(rolesInLoop("build").length).toBeGreaterThan(0);
    expect(rolesInLoop("revenue").length).toBeGreaterThan(0);
  });

  test("gives every role a model the ledger can price", () => {
    for (const role of ALL_ROLES) {
      expect(MODEL_PRICES[role.model], `${role.name} -> ${role.model}`).toBeDefined();
    }
  });

  test("grants every role only tools some harness actually provides", () => {
    const known = new Set<string>([
      ...TOOL_NAMES,
      ...SERVER_TOOL_NAMES,
      ...CODE_HARNESS_TOOL_NAMES,
    ]);
    for (const role of ALL_ROLES) {
      for (const tool of role.tools) {
        expect(known, `${role.name} wants ${tool}`).toContain(tool);
      }
    }
  });

  test("validateRoles passes for the shipped definitions", () => {
    expect(() => validateRoles()).not.toThrow();
  });

  test("validateRoles rejects a typo instead of silently dropping the tool", () => {
    const typo = { ...getRole("scout"), tools: ["capture_idae"] };
    expect(() => validateRoles([typo])).toThrow(UnknownToolError);
    expect(() => validateRoles([typo])).toThrow(/without the means to do it/);
  });

  test("api-harness roles only use tools the api harness can serve", () => {
    for (const role of ALL_ROLES.filter((r) => r.harness === "api")) {
      for (const tool of role.tools) {
        expect(
          isCodeHarnessTool(tool),
          `${role.name} is an api role but wants code-harness tool ${tool}`,
        ).toBe(false);
      }
    }
  });

  test("gives every role a positive budget and at least one worker", () => {
    for (const role of ALL_ROLES) {
      expect(role.defaultBudgetUsd, role.name).toBeGreaterThan(0);
      expect(role.concurrency, role.name).toBeGreaterThanOrEqual(1);
    }
  });

  test("writes a substantial charter for every role", () => {
    for (const role of ALL_ROLES) {
      expect(role.charter.length, role.name).toBeGreaterThan(200);
    }
  });

  test("names exactly one veto holder", () => {
    expect(vetoRoles().map((r) => r.name)).toEqual(["compliance"]);
  });

  test("throws a helpful error for an unknown role", () => {
    expect(() => getRole("cto")).toThrow(UnknownRoleError);
    expect(() => getRole("cto")).toThrow(/known roles are/);
  });
});

describe("the scout -> analyst -> pm idea funnel", () => {
  test("scout can capture and score ideas", () => {
    const scout = getRole("scout");
    expect(scout.tools).toContain("capture_idea");
    expect(scout.tools).toContain("score_idea");
  });

  test("scout cannot file tickets at all, so breadth cannot flood the backlog", () => {
    expect(getRole("scout").mayFile).toHaveLength(0);
    expect(mayFile("scout", "prd")).toBe(false);
    expect(mayFile("scout", "build")).toBe(false);
  });

  test("scout cannot promote its own ideas past validation", () => {
    expect(getRole("scout").tools).not.toContain("promote_idea");
  });

  test("scout runs on the cheapest model, since it runs widest", () => {
    const scout = getRole("scout");
    expect(scout.model).toBe("claude-haiku-4-5");
    const scoutPrice = MODEL_PRICES[scout.model]!.inputPerMTok;
    for (const role of ALL_ROLES) {
      expect(MODEL_PRICES[role.model]!.inputPerMTok).toBeGreaterThanOrEqual(
        scoutPrice,
      );
    }
  });

  test("analyst, not scout, files the prd that reaches the build loop", () => {
    expect(mayFile("analyst", "prd")).toBe(true);
    expect(mayOwn("pm", "prd")).toBe(true);
  });
});

describe("the forecaster", () => {
  test("can record and read forecasts and its own calibration", () => {
    const forecaster = getRole("forecaster");
    expect(forecaster.tools).toContain("record_forecast");
    expect(forecaster.tools).toContain("read_calibration");
  });

  test("runs on a reasoning model, because the assumptions are the deliverable", () => {
    expect(getRole("forecaster").model).toBe("claude-opus-5");
  });

  test("cannot build, deploy, or publish -- it only estimates", () => {
    const forecaster = getRole("forecaster");
    expect(mayFile("forecaster", "build")).toBe(false);
    expect(mayFile("forecaster", "deploy")).toBe(false);
    expect(mayFile("forecaster", "content")).toBe(false);
  });
});

describe("separation of duties", () => {
  test("a role that files a type it also owns has a peer to file it to", () => {
    // Overlap is legitimate -- ceo files a decision to compliance, compliance
    // files one back to ceo -- because `assertAuthorship` already blocks
    // filing to yourself at runtime. What would be broken is a role permitted
    // to file a type that ONLY it owns: every such call would necessarily be a
    // self-assignment and always fail, so the permission is dead weight that
    // only misleads the agent holding it.
    const ownersOf = new Map<string, string[]>();
    for (const role of ALL_ROLES) {
      for (const type of role.owns) {
        ownersOf.set(type, [...(ownersOf.get(type) ?? []), role.name]);
      }
    }
    for (const role of ALL_ROLES) {
      for (const type of role.owns.filter((t) => role.mayFile.includes(t))) {
        const peers = (ownersOf.get(type) ?? []).filter((n) => n !== role.name);
        expect(
          peers,
          `${role.name} may file "${type}" but is its only owner`,
        ).not.toHaveLength(0);
      }
    }
  });

  test("self-assignment is blocked at runtime, whatever the permissions say", () => {
    // The real enforcement point. Permissions describe intent; this is the gate.
    for (const role of ALL_ROLES) {
      for (const type of role.mayFile) {
        expect(
          violatesAuthorship({
            type,
            title: "x",
            body: "",
            createdBy: role.name,
            ownerRole: role.name,
          }),
          role.name,
        ).toBe(true);
      }
    }
  });

  test("the role that writes code is not the role that gates the release", () => {
    expect(mayOwn("engineer", "build")).toBe(true);
    expect(mayOwn("engineer", "test")).toBe(false);
    expect(mayOwn("qa", "test")).toBe(true);
  });

  test("only finance may pause the company", () => {
    const withPause = ALL_ROLES.filter((r) => r.tools.includes("pause_company"));
    expect(withPause.map((r) => r.name)).toEqual(["finance"]);
  });

  test("engineers and qa run on a code harness; everyone else reasons over state", () => {
    expect(getRole("engineer").harness).toBe("code");
    expect(getRole("qa").harness).toBe("code");
    expect(getRole("ceo").harness).toBe("api");
    expect(getRole("scout").harness).toBe("api");
  });
});
