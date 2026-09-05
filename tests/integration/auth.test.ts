import { afterAll, describe, expect, it } from 'vitest';

import { env } from '../../src/config/env.js';
import { UserModel } from '../../src/models/index.js';
import { client, newAccount, signUpAndVerify, verificationTokenFor } from '../support/api.js';
import { databaseAvailable, disconnectTestDatabase } from '../support/test-db.js';

/**
 * Registration through to a working session, and the boundaries around it.
 *
 * These run against the real Better Auth handler rather than a stub, because
 * everything worth asserting here is a property of the integration: that the
 * envelope adapter rewrites its errors into SiteOps codes, that the cookie is
 * named what the dashboard's routing middleware looks for, and that an
 * unverified account cannot reach organization data.
 */

/*
 * Resolved before any suite is declared, so the whole file can be skipped as a
 * unit rather than each test deciding for itself. `pnpm test` has to be
 * runnable on a machine with nothing started; CI and `pnpm docker:up` both
 * provide a database, so these still run where it counts.
 */
const available = await databaseAvailable();

afterAll(async () => {
  await disconnectTestDatabase();
});

describe.skipIf(!available)('authentication', () => {
  it('registers an account and answers in the SiteOps envelope', async () => {
    const account = newAccount('register');
    const response = await client()
      .post('/api/auth/sign-up/email')
      .send({ name: account.name, email: account.email, password: account.password })
      .expect(200);

    expect(response.body).toMatchObject({ success: true });
    expect(response.body.data.user.email).toBe(account.email);
    // Nobody is admitted before confirming the address.
    expect(response.body.data.user.emailVerified).toBe(false);
  });

  it('does not let a second sign-up take over an existing account', async () => {
    const { account } = await signUpAndVerify('takeover');
    const attackerPassword = 'AttackerChosenPassw0rd!';

    /*
     * Signing up again with a registered address answers 200 with a synthetic
     * user id and creates nothing. That is deliberate on Better Auth's part and
     * stronger than a 409 would be: a distinguishable response here is an
     * oracle for "does this person have a SiteOps account", which is exactly
     * what a credential-stuffing list is built from.
     *
     * What has to hold is the part underneath the response.
     */
    const second = await client()
      .post('/api/auth/sign-up/email')
      .send({ name: 'Attacker', email: account.email, password: attackerPassword })
      .expect(200);

    expect(second.body.success).toBe(true);

    // Exactly one account, and it is still the original one.
    expect(await UserModel.countDocuments({ email: account.email }).exec()).toBe(1);

    // The password was not replaced...
    await client()
      .post('/api/auth/sign-in/email')
      .send({ email: account.email, password: attackerPassword })
      .expect(401);

    // ...and the real one still works.
    await client()
      .post('/api/auth/sign-in/email')
      .send({ email: account.email, password: account.password })
      .expect(200);
  });

  it('refuses sign-in until the address is confirmed', async () => {
    const account = newAccount('unverified');
    const agent = client();

    await agent
      .post('/api/auth/sign-up/email')
      .send({ name: account.name, email: account.email, password: account.password })
      .expect(200);

    const response = await agent
      .post('/api/auth/sign-in/email')
      .send({ email: account.email, password: account.password });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('verifies through the emailed link and redirects to the dashboard', async () => {
    const account = newAccount('verify');
    const agent = client();

    await agent
      .post('/api/auth/sign-up/email')
      .send({ name: account.name, email: account.email, password: account.password })
      .expect(200);

    const response = await agent
      .get('/api/auth/verify-email')
      .query({
        token: verificationTokenFor(account.email),
        callbackURL: `${env.APP_URL}/verify-email/confirmed`,
      })
      .expect(302);

    // A real 302 with a Location header, not a wrapped JSON body: the person
    // clicked a link in a mail client and has to land on a page.
    expect(response.headers.location).toBe(`${env.APP_URL}/verify-email/confirmed`);
  });

  it('issues the session cookie the dashboard middleware looks for', async () => {
    const { agent, account } = await signUpAndVerify('cookie');

    const response = await agent
      .post('/api/auth/sign-in/email')
      .send({ email: account.email, password: account.password })
      .expect(200);

    const cookies = response.headers['set-cookie'] as unknown as string[] | undefined;
    expect(cookies).toBeDefined();
    const session = cookies?.find((cookie) => cookie.startsWith('siteops.session_token='));

    /*
     * The name is a contract, not an implementation detail:
     * `siteOps-client/src/middleware.ts` matches
     * `/^(?:__Secure-)?siteops\.session_token$/` to decide whether to redirect a
     * visitor to sign-in. Renaming it signs everyone out of the dashboard.
     */
    expect(session).toBeDefined();
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const { account } = await signUpAndVerify('wrong-password');

    const wrongPassword = await client()
      .post('/api/auth/sign-in/email')
      .send({ email: account.email, password: 'NotTheRightPassword1!' });

    const unknownAccount = await client()
      .post('/api/auth/sign-in/email')
      .send({ email: 'nobody-at-all@siteops.test', password: 'NotTheRightPassword1!' });

    // Identical code and identical wording. Anything else is an oracle for
    // enumerating registered addresses.
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknownAccount.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.body.error.message).toBe(unknownAccount.body.error.message);
  });

  it('reports a signed-out visitor as a null user rather than an error', async () => {
    const response = await client().get('/api/session').expect(200);

    // The browser has to tell "signed out" apart from "request failed"; a 401
    // here would make every first paint look like an outage.
    expect(response.body).toEqual({ success: true, data: { user: null } });
  });

  it('describes the signed-in user with their memberships and permissions', async () => {
    const { agent, account } = await signUpAndVerify('session');
    await agent.post('/api/organizations').send({ name: 'Session Org' }).expect(201);

    const response = await agent.get('/api/session').expect(200);

    expect(response.body.data.user.email).toBe(account.email);
    expect(response.body.data.user.emailVerified).toBe(true);
    expect(response.body.data.memberships).toHaveLength(1);
    expect(response.body.data.memberships[0].role).toBe('owner');
    // Permissions are resolved server-side so the UI can hide what it may not
    // do; the API re-checks every one of them on the request itself.
    expect(response.body.data.memberships[0].permissions).toContain('website:create');
  });

  it('refuses a protected route without a session', async () => {
    const response = await client().get('/api/websites').expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('locks the dashboard again after signing out', async () => {
    const { agent, organizationId } = await (async () => {
      const signedIn = await signUpAndVerify('sign-out');
      const org = await signedIn.agent
        .post('/api/organizations')
        .send({ name: 'Sign Out Org' })
        .expect(201);
      return {
        agent: signedIn.agent,
        organizationId: (org.body as { data: { organization: { id: string } } }).data.organization
          .id,
      };
    })();

    await agent.get('/api/websites').set('X-Organization-Id', organizationId).expect(200);

    await agent.post('/api/auth/sign-out').send({});

    await agent.get('/api/websites').set('X-Organization-Id', organizationId).expect(401);
  });
});
