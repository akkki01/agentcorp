export { assertAuthorship, violatesAuthorship, SelfAssignmentError } from "./authorship.js";
export { assertDepth, exceedsDepth, DepthExceededError } from "./depth.js";
export { assertBudget, isExhausted, budgetPressure, BudgetExhaustedError } from "./budget.js";
export {
  readControls, setPaused, haltReason,
  recordRoleFailure, recordRoleSuccess, isRoleTripped,
  type ControlState, type HaltReason,
} from "./controls.js";
