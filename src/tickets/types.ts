export const TICKET_STATES = [
  "proposed", "approved", "in_progress", "review", "blocked", "done", "killed",
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export const TICKET_TYPES = [
  "research", "prd", "design", "build", "test", "deploy",
  "content", "outbound", "support", "finance", "incident", "decision",
] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export interface AcceptanceCriterion {
  /** Human-readable statement of what must be true. */
  readonly statement: string;
  /**
   * A shell command whose exit code decides the criterion, when one exists.
   * Criteria without a check must be verified by a reviewing role, which is why
   * `closeTicket` refuses to close a ticket with unverified criteria.
   */
  readonly check?: string;
  readonly verified: boolean;
}

export interface Ticket {
  readonly id: number;
  readonly parentId: number | null;
  readonly depth: number;
  readonly type: TicketType;
  readonly state: TicketState;
  readonly title: string;
  readonly body: string;
  readonly ownerRole: string;
  readonly createdBy: string;
  readonly acceptance: readonly AcceptanceCriterion[];
  readonly artifacts: readonly string[];
  readonly budgetUsd: number;
  readonly requiresHuman: boolean;
  readonly humanApproved: boolean;
  readonly claimedBy: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
}

export interface NewTicket {
  readonly type: TicketType;
  readonly title: string;
  readonly body: string;
  readonly ownerRole: string;
  readonly createdBy: string;
  readonly parentId?: number | null;
  readonly acceptance?: readonly AcceptanceCriterion[];
  readonly budgetUsd?: number;
  readonly requiresHuman?: boolean;
}
