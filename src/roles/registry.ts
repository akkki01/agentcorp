import { BUILD_ROLES } from "./build.js";
import { REVENUE_ROLES } from "./revenue.js";
import { STRATEGY_ROLES } from "./strategy.js";
import { isCodeHarnessTool } from "../runner/code-tools.js";
import { isServerTool } from "../runner/server-tools.js";
import { TOOL_NAMES } from "../runner/tools.js";
import type { Loop, RoleDefinition } from "./types.js";

export const ALL_ROLES: readonly RoleDefinition[] = [
  ...STRATEGY_ROLES,
  ...BUILD_ROLES,
  ...REVENUE_ROLES,
];

const BY_NAME = new Map(ALL_ROLES.map((role) => [role.name, role]));

export class UnknownRoleError extends Error {
  constructor(name: string) {
    super(
      `unknown role "${name}"; known roles are ${[...BY_NAME.keys()].join(", ")}`,
    );
    this.name = "UnknownRoleError";
  }
}

export const getRole = (name: string): RoleDefinition => {
  const role = BY_NAME.get(name);
  if (role === undefined) throw new UnknownRoleError(name);
  return role;
};

export const rolesInLoop = (loop: Loop): readonly RoleDefinition[] =>
  ALL_ROLES.filter((role) => role.loop === loop);

export const vetoRoles = (): readonly RoleDefinition[] =>
  ALL_ROLES.filter((role) => role.hasVeto === true);

/**
 * Whether `role` is permitted to file a ticket of `type` against someone else.
 * Checked at tool-call time so a role cannot widen its own remit by asking.
 */
export const mayFile = (roleName: string, type: string): boolean =>
  getRole(roleName).mayFile.includes(type as never);

export const mayOwn = (roleName: string, type: string): boolean =>
  getRole(roleName).owns.includes(type as never);

export { type RoleDefinition, type Loop, type Harness } from "./types.js";

export class UnknownToolError extends Error {
  constructor(role: string, tool: string) {
    super(
      `role "${role}" declares unknown tool "${tool}"; it is not a company ` +
        `tool, a server tool, or a code-harness tool. Declaring a tool that ` +
        `does not exist silently removes it from the role's schema at request ` +
        `time, so the agent is told to do a job without the means to do it.`,
    );
    this.name = "UnknownToolError";
  }
}

const isKnownTool = (name: string): boolean =>
  TOOL_NAMES.includes(name) || isServerTool(name) || isCodeHarnessTool(name);

/**
 * Validates every role definition. Called at module load so a typo in a tool
 * name fails at startup rather than halfway through a billed turn.
 */
export const validateRoles = (
  roles: readonly RoleDefinition[] = ALL_ROLES,
): void => {
  for (const role of roles) {
    for (const tool of role.tools) {
      if (!isKnownTool(tool)) throw new UnknownToolError(role.name, tool);
    }
  }
};

validateRoles();
