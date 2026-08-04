import { AuditRepo } from "../db/repositories/audit.repo.js";

export type AuditEntryType = "llm_output" | "human_decision" | "system_action";

export interface AuditEntry {
  claimId: string;
  entryType: AuditEntryType;
  payload: Record<string, unknown>;
}

/**
 * Every LLM-drafted output and every human-approval decision goes through this —
 * see CLAUDE.md §2.4. Only ever appended to; there is deliberately no update/delete
 * method on this interface or on AuditRepo.
 */
export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export class DbAuditLog implements AuditLog {
  constructor(private readonly repo: AuditRepo = new AuditRepo()) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.repo.append(entry);
  }
}
