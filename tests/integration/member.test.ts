import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InvitationModel } from '../../src/models/index.js';
import { hashToken } from '../../src/utils/crypto.js';
import { onboard, signUpAndVerify, type SignedInAccount } from '../support/api.js';
import { databaseAvailable, disconnectTestDatabase } from '../support/test-db.js';

/**
 * Membership, roles and invitations.
 *
 * Authorization is checked against permissions rather than role names
 * everywhere in the API, so what these prove is that the permission table and
 * the rank rules together produce the behaviour a person would expect: nobody
 * mints an account more powerful than themselves, and an organization can never
 * be left with no owner.
 */

const available = await databaseAvailable();

/**
 * A fresh organization per test that adds people.
 *
 * The free plan caps membership at two, which is exactly the point of a plan
 * limit - but it means a shared organization would run out partway through this
 * file and every later test would fail on PLAN_LIMIT_REACHED instead of on what
 * it meant to assert.
 */
type Owner = SignedInAccount & { organizationId: string };

let owner: Owner;

beforeAll(async () => {
  if (!available) return;
  owner = await onboard('members');
});

afterAll(async () => {
  await disconnectTestDatabase();
});

/**
 * Issues an invitation and returns a token that will be accepted for it.
 *
 * The emailed token is deliberately unrecoverable - only its SHA-256 hash is
 * stored, so a leaked database yields no working links - which means a test
 * cannot read the real one. It writes a hash of its own token instead, so the
 * accept route still performs the genuine hash lookup, expiry check and address
 * comparison against a value it did not choose.
 */
async function invite(
  from: Owner,
  email: string,
  role: 'admin' | 'member',
): Promise<{ token: string; invitationId: string }> {
  const response = await from.agent
    .post(`/api/organizations/${from.organizationId}/members`)
    .send({ email, role })
    .expect(201);

  const invitationId = (response.body as { data: { id: string } }).data.id;
  const token = `test-token-${invitationId}`;

  await InvitationModel.updateOne(
    { _id: invitationId },
    { $set: { tokenHash: hashToken(token) } },
  ).exec();

  return { token, invitationId };
}

describe.skipIf(!available)('members and invitations', () => {
  it('lists the creator as the sole owner', async () => {
    const response = await owner.agent
      .get(`/api/organizations/${owner.organizationId}/members`)
      .expect(200);

    expect(response.body.data.members).toHaveLength(1);
    expect(response.body.data.members[0].role).toBe('owner');
    expect(response.body.data.invitations).toHaveLength(0);
  });

  it('creates a pending invitation and never stores the raw token', async () => {
    const host = await onboard('pending-invite');
    const email = `invitee-${String(Date.now())}@siteops.test`;

    const response = await host.agent
      .post(`/api/organizations/${host.organizationId}/members`)
      .send({ email, role: 'member' })
      .expect(201);

    expect(response.body.data.email).toBe(email);
    expect(response.body.data.role).toBe('member');
    // The response carries no token: the link goes to the address, not to
    // whoever issued the invitation.
    expect(response.body.data).not.toHaveProperty('token');

    const stored = await InvitationModel.findById(response.body.data.id).lean().exec();
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lets the invited address join, and refuses a forwarded link', async () => {
    const host = await onboard('invite-host');
    const invitee = await signUpAndVerify('invitee');
    const wrongPerson = await signUpAndVerify('forwarded');

    const { token } = await invite(host, invitee.account.email, 'member');

    // Someone else holding the same link cannot use it.
    const forwarded = await wrongPerson.agent.post('/api/invitations/accept').send({ token });
    expect(forwarded.status).toBe(403);

    const accepted = await invitee.agent
      .post('/api/invitations/accept')
      .send({ token })
      .expect(200);
    expect(accepted.body.data.organizationId).toBe(host.organizationId);

    const members = await host.agent
      .get(`/api/organizations/${host.organizationId}/members`)
      .expect(200);
    expect(members.body.data.members).toHaveLength(2);
  });

  it('refuses an unknown token', async () => {
    const invitee = await signUpAndVerify('bad-token');

    const response = await invitee.agent
      .post('/api/invitations/accept')
      .send({ token: 'not-a-real-token' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('INVALID_TOKEN');
  });

  it('stops a member from reading or changing what their role does not allow', async () => {
    const host = await onboard('member-permissions');
    const member = await signUpAndVerify('plain-member');
    const { token } = await invite(host, member.account.email, 'member');
    await member.agent.post('/api/invitations/accept').send({ token }).expect(200);

    const header = ['X-Organization-Id', host.organizationId] as const;

    // A member may read websites...
    await member.agent
      .get('/api/websites')
      .set(...header)
      .expect(200);

    // ...but not create, pause or delete them.
    const created = await member.agent
      .post('/api/websites')
      .set(...header)
      .send({ name: 'Nope', url: 'https://member-cannot-create.example.org' });
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('INSUFFICIENT_ROLE');

    // Nor invite anyone.
    const invited = await member.agent
      .post(`/api/organizations/${host.organizationId}/members`)
      .send({ email: 'someone@siteops.test', role: 'member' });
    expect(invited.status).toBe(403);

    // Nor change roles.
    const membersList = await host.agent
      .get(`/api/organizations/${host.organizationId}/members`)
      .expect(200);
    const targetId = (
      membersList.body as { data: { members: { id: string; role: string }[] } }
    ).data.members.find((entry) => entry.role === 'member')?.id;

    const roleChange = await member.agent
      .patch(`/api/organizations/${host.organizationId}/members/${targetId ?? ''}`)
      .send({ role: 'owner' });
    expect(roleChange.status).toBe(403);
  });

  it('refuses to invite at a role above the inviter', async () => {
    const host = await onboard('role-escalation');
    const admin = await signUpAndVerify('admin-invitee');
    const { token } = await invite(host, admin.account.email, 'admin');
    await admin.agent.post('/api/invitations/accept').send({ token }).expect(200);

    // `assignableRoleSchema` refuses `owner` outright — ownership is
    // transferred, never handed out through an invitation.
    const response = await admin.agent
      .post(`/api/organizations/${host.organizationId}/members`)
      .send({ email: 'escalation@siteops.test', role: 'owner' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses to remove or demote the last owner', async () => {
    const solo = await onboard('last-owner');

    const members = await solo.agent
      .get(`/api/organizations/${solo.organizationId}/members`)
      .expect(200);
    const ownerMemberId = (members.body as { data: { members: { id: string }[] } }).data.members[0]
      ?.id;

    const removed = await solo.agent.delete(
      `/api/organizations/${solo.organizationId}/members/${ownerMemberId ?? ''}`,
    );

    expect(removed.status).toBe(409);
    expect(removed.body.error.code).toBe('CANNOT_REMOVE_LAST_OWNER');
  });

  it('refuses to change your own role', async () => {
    const solo = await onboard('self-role');

    const members = await solo.agent
      .get(`/api/organizations/${solo.organizationId}/members`)
      .expect(200);
    const ownerMemberId = (members.body as { data: { members: { id: string }[] } }).data.members[0]
      ?.id;

    const response = await solo.agent
      .patch(`/api/organizations/${solo.organizationId}/members/${ownerMemberId ?? ''}`)
      .send({ role: 'member' });

    expect(response.status).toBe(403);
  });

  it('revokes a pending invitation', async () => {
    const host = await onboard('revoke-invite');
    const email = `revoked-${String(Date.now())}@siteops.test`;
    const created = await host.agent
      .post(`/api/organizations/${host.organizationId}/members`)
      .send({ email, role: 'member' })
      .expect(201);

    await host.agent
      .delete(
        `/api/organizations/${host.organizationId}/members/invitations/${created.body.data.id as string}`,
      )
      .expect(204);

    const members = await host.agent
      .get(`/api/organizations/${host.organizationId}/members`)
      .expect(200);
    expect(
      (members.body as { data: { invitations: { email: string }[] } }).data.invitations.some(
        (invitation) => invitation.email === email,
      ),
    ).toBe(false);
  });
});
