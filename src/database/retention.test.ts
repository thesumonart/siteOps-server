import { describe, expect, it } from 'vitest';

import { AUDIT_LOG_RETENTION_SECONDS, AuditLogModel } from '../models/audit-log.model.js';
import { CHECK_RETENTION_SECONDS, WebsiteCheckModel } from '../models/check-result.model.js';

/**
 * Retention is a promise to customers about how long their data is kept, and
 * it is enforced by a TTL index rather than by any code that runs on a
 * schedule. That makes it exactly the kind of thing that can be silently
 * dropped — a renamed index or a changed field, and the collection grows
 * forever with nobody noticing until the cluster fills.
 *
 * Read from the compiled schemas rather than a live database, so this runs
 * everywhere and still fails if a definition is removed.
 */

interface DeclaredIndex {
  readonly fields: Record<string, unknown>;
  readonly options: { name?: string; expireAfterSeconds?: number };
}

function declaredIndexes(schema: {
  indexes: () => [Record<string, unknown>, DeclaredIndex['options']][];
}): DeclaredIndex[] {
  return schema.indexes().map(([fields, options]) => ({ fields, options }));
}

describe('retention', () => {
  it('expires website checks on the field they are ordered by, at the configured window', () => {
    const ttl = declaredIndexes(WebsiteCheckModel.schema).find(
      (index) => index.options.name === 'check_ttl',
    );

    expect(ttl).toBeDefined();
    expect(ttl?.options.expireAfterSeconds).toBe(CHECK_RETENTION_SECONDS);
    // Configurable through CHECK_RETENTION_DAYS, but never unbounded: an index
    // built with no expiry keeps every check forever.
    expect(CHECK_RETENTION_SECONDS).toBeGreaterThan(0);
    // MongoDB expires from a date field; pointed at the wrong one it silently
    // never deletes anything.
    expect(ttl?.fields).toHaveProperty('checkedAt');
  });

  it('keeps audit logs for a year', () => {
    const ttl = declaredIndexes(AuditLogModel.schema).find(
      (index) => index.options.name === 'audit_ttl',
    );

    expect(ttl).toBeDefined();
    expect(ttl?.options.expireAfterSeconds).toBe(AUDIT_LOG_RETENTION_SECONDS);
    expect(AUDIT_LOG_RETENTION_SECONDS).toBe(365 * 24 * 60 * 60);
    expect(ttl?.fields).toHaveProperty('createdAt');
  });

  it('keeps audit logs far longer than checks', () => {
    // The two are not interchangeable: checks are high-volume telemetry that
    // ages out, audit logs are the record of who changed what.
    expect(AUDIT_LOG_RETENTION_SECONDS).toBeGreaterThan(CHECK_RETENTION_SECONDS);
  });
});
