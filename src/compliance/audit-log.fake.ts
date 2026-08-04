import type { AuditLog, AuditEntry } from "./audit-log.js";

/** In-memory audit log for node/unit tests — never touches the database. */
export class FakeAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}
