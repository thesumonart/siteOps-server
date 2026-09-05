import { Types } from 'mongoose';

import { IncidentModel } from '../../src/models/index.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from '../../tests/support/test-db.js';
import { applyIncidentTransition, type IncidentCheckContext } from './incident-processor.js';

beforeAll(async () => {
  await connectTestDatabase();
});

afterEach(async () => {
  await clearTestDatabase();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

function contextFor(overrides: Partial<IncidentCheckContext> = {}): IncidentCheckContext {
  return {
    organizationId: new Types.ObjectId(),
    websiteId: new Types.ObjectId(),
    checkedAt: new Date(),
    checkSucceeded: false,
    failedCheckCount: 3,
    statusCode: null,
    errorType: 'timeout',
    errorMessage: 'The request timed out.',
    ...overrides,
  };
}

describe('applyIncidentTransition — opening', () => {
  it('creates an open incident with the check context', async () => {
    const context = contextFor({ failedCheckCount: 3, statusCode: 503, errorType: 'http_error' });

    const result = await applyIncidentTransition('open', null, context);

    expect(result.newlyOpenedIncidentId).not.toBeNull();
    expect(result.openIncidentId).toEqual(result.newlyOpenedIncidentId);

    const stored = await IncidentModel.findById(result.newlyOpenedIncidentId).lean().exec();
    expect(stored?.status).toBe('open');
    expect(stored?.type).toBe('http_error');
    expect(stored?.failedCheckCount).toBe(3);
    expect(stored?.lastStatusCode).toBe(503);
    expect(stored?.resolvedAt).toBeNull();
  });

  it('maps checker error types onto the coarser incident type', async () => {
    const cases: [IncidentCheckContext['errorType'], string][] = [
      ['timeout', 'timeout'],
      ['http_error', 'http_error'],
      ['connection_refused', 'connection_error'],
      ['connection_reset', 'connection_error'],
      ['dns_failure', 'downtime'],
      ['blocked_target', 'downtime'],
      [null, 'downtime'],
    ];

    for (const [errorType, expectedType] of cases) {
      const context = contextFor({ errorType, websiteId: new Types.ObjectId() });
      const result = await applyIncidentTransition('open', null, context);
      const stored = await IncidentModel.findById(result.newlyOpenedIncidentId).lean().exec();
      expect(stored?.type, `errorType=${String(errorType)}`).toBe(expectedType);
    }
  });

  /**
   * This is the guarantee that actually matters: the unique partial index
   * (`incident_one_open_per_website`) — not application logic — is what makes
   * it impossible for two concurrent checks of the same website to open two
   * incidents. Racing two real inserts against the real database proves the
   * index does its job, which a mocked model never could.
   */
  it('never creates two open incidents for the same website, even under a real race', async () => {
    const websiteId = new Types.ObjectId();
    const organizationId = new Types.ObjectId();

    const [first, second] = await Promise.all([
      applyIncidentTransition('open', null, contextFor({ websiteId, organizationId })),
      applyIncidentTransition('open', null, contextFor({ websiteId, organizationId })),
    ]);

    // Both calls report the same open incident id — the loser of the race
    // read back the winner's document rather than creating its own.
    expect(first.openIncidentId?.toHexString()).toBe(second.openIncidentId?.toHexString());

    const openCount = await IncidentModel.countDocuments({ websiteId, status: 'open' }).exec();
    expect(openCount).toBe(1);
  });
});

describe('applyIncidentTransition — ongoing', () => {
  it('keeps the open incident current without touching startedAt', async () => {
    const websiteId = new Types.ObjectId();
    const organizationId = new Types.ObjectId();
    const opened = await applyIncidentTransition(
      'open',
      null,
      contextFor({ websiteId, organizationId, failedCheckCount: 3 }),
    );
    const incidentId = opened.newlyOpenedIncidentId;
    const before = await IncidentModel.findById(incidentId).lean().exec();

    const result = await applyIncidentTransition(
      'ongoing',
      incidentId,
      contextFor({
        websiteId,
        organizationId,
        statusCode: 500,
        errorType: 'http_error',
      }),
    );

    expect(result.openIncidentId?.toHexString()).toBe(incidentId?.toHexString());
    expect(result.newlyOpenedIncidentId).toBeNull();
    expect(result.newlyResolvedIncidentId).toBeNull();

    const after = await IncidentModel.findById(incidentId).lean().exec();
    expect(after?.failedCheckCount).toBe(4);
    expect(after?.lastStatusCode).toBe(500);
    expect(after?.startedAt).toEqual(before?.startedAt);
  });

  it('leaves the failure record untouched when the check succeeded', async () => {
    // A live run caught this: the first good response after an outage arrives
    // while the incident is still open, and it was overwriting the incident's
    // own record — a resolved downtime filed as "0 failed checks, HTTP 200".
    const websiteId = new Types.ObjectId();
    const organizationId = new Types.ObjectId();
    const opened = await applyIncidentTransition(
      'open',
      null,
      contextFor({
        websiteId,
        organizationId,
        failedCheckCount: 2,
        statusCode: 503,
        errorType: 'http_error',
      }),
    );
    const incidentId = opened.newlyOpenedIncidentId;

    await applyIncidentTransition(
      'ongoing',
      incidentId,
      contextFor({
        websiteId,
        organizationId,
        checkSucceeded: true,
        failedCheckCount: 0,
        statusCode: 200,
        errorType: null,
        errorMessage: null,
      }),
    );

    const after = await IncidentModel.findById(incidentId).lean().exec();
    expect(after?.failedCheckCount).toBe(2);
    expect(after?.lastStatusCode).toBe(503);
    expect(after?.lastErrorType).toBe('http_error');
  });

  it('counts every failed check in the incident, even across an intervening success', async () => {
    // The website's own consecutive counter resets on success, so assigning it
    // here would undercount. The incident counts what it has actually seen.
    const websiteId = new Types.ObjectId();
    const organizationId = new Types.ObjectId();
    const opened = await applyIncidentTransition(
      'open',
      null,
      contextFor({ websiteId, organizationId, failedCheckCount: 2 }),
    );
    const incidentId = opened.newlyOpenedIncidentId;

    await applyIncidentTransition('ongoing', incidentId, contextFor({ websiteId, organizationId }));
    await applyIncidentTransition(
      'ongoing',
      incidentId,
      contextFor({
        websiteId,
        organizationId,
        checkSucceeded: true,
        statusCode: 200,
        errorType: null,
      }),
    );
    await applyIncidentTransition('ongoing', incidentId, contextFor({ websiteId, organizationId }));

    const after = await IncidentModel.findById(incidentId).lean().exec();
    expect(after?.failedCheckCount).toBe(4);
  });
});

describe('applyIncidentTransition — resolving', () => {
  it('resolves an open incident and computes its duration', async () => {
    const websiteId = new Types.ObjectId();
    const organizationId = new Types.ObjectId();
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const opened = await applyIncidentTransition(
      'open',
      null,
      contextFor({ websiteId, organizationId, checkedAt: startedAt }),
    );

    const resolvedAt = new Date('2026-01-01T00:05:30.000Z');
    const result = await applyIncidentTransition(
      'resolve',
      opened.newlyOpenedIncidentId,
      contextFor({ websiteId, organizationId, checkedAt: resolvedAt }),
    );

    expect(result.newlyResolvedIncidentId?.toHexString()).toBe(
      opened.newlyOpenedIncidentId?.toHexString(),
    );
    expect(result.openIncidentId).toBeNull();

    const stored = await IncidentModel.findById(opened.newlyOpenedIncidentId).lean().exec();
    expect(stored?.status).toBe('resolved');
    expect(stored?.durationSeconds).toBe(330);
    expect(stored?.resolvedAt).toEqual(resolvedAt);
  });

  it('is idempotent: resolving an already-resolved incident does nothing further', async () => {
    const websiteId = new Types.ObjectId();
    const organizationId = new Types.ObjectId();
    const opened = await applyIncidentTransition(
      'open',
      null,
      contextFor({ websiteId, organizationId }),
    );

    const firstResolve = await applyIncidentTransition(
      'resolve',
      opened.newlyOpenedIncidentId,
      contextFor({ websiteId, organizationId }),
    );
    expect(firstResolve.newlyResolvedIncidentId).not.toBeNull();

    const beforeSecond = await IncidentModel.findById(opened.newlyOpenedIncidentId).lean().exec();

    const secondResolve = await applyIncidentTransition(
      'resolve',
      opened.newlyOpenedIncidentId,
      contextFor({ websiteId, organizationId, checkedAt: new Date(Date.now() + 60_000) }),
    );

    // The second call must not report itself as the resolver, and the stored
    // resolvedAt/durationSeconds must be untouched by the replay.
    expect(secondResolve.newlyResolvedIncidentId).toBeNull();
    const afterSecond = await IncidentModel.findById(opened.newlyOpenedIncidentId).lean().exec();
    expect(afterSecond?.resolvedAt).toEqual(beforeSecond?.resolvedAt);
    expect(afterSecond?.durationSeconds).toBe(beforeSecond?.durationSeconds);
  });
});

describe('applyIncidentTransition — none', () => {
  it('touches nothing in the database', async () => {
    const result = await applyIncidentTransition('none', null, contextFor());

    expect(result).toEqual({
      openIncidentId: null,
      newlyOpenedIncidentId: null,
      newlyResolvedIncidentId: null,
    });
    expect(await IncidentModel.countDocuments({}).exec()).toBe(0);
  });
});
