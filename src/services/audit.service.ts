import type { AuditLogEntry, AuditLogRepository } from '../repositories/audit-log.repository.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('audit');

/**
 * Records who changed what inside an organization.
 *
 * Recording is best-effort by design: a failure to write the activity feed must
 * never roll back the action the user actually asked for. Failures are logged
 * so the gap is visible rather than silent.
 */
export class AuditService {
  constructor(private readonly repository: AuditLogRepository) {}

  async record(entry: AuditLogEntry): Promise<void> {
    try {
      await this.repository.record(entry);
    } catch (error) {
      logger.error(
        {
          err: error,
          action: entry.action,
          organizationId: entry.organizationId.toHexString(),
        },
        'audit.write_failed',
      );
    }
  }
}
