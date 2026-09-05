import { createHmac } from 'node:crypto';
import type { Express } from 'express';
import request, { type Agent } from 'supertest';

import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';

/**
 * Drives the real Express application over HTTP, against a real database.
 *
 * Nothing is stubbed. What these tests exist to prove — that a forged
 * organization header reads as 404, that a private address is refused, that the
 * envelope the dashboard parses is the one that arrives — depends on the
 * middleware chain, the auth library and the database agreeing with each other.
 * A mocked service would test none of it.
 */

let app: Express | null = null;

/** Built once: `createApp` constructs a Better Auth instance and every service. */
export function getApp(): Express {
  app ??= createApp();
  return app;
}

export function client(): Agent {
  return request.agent(getApp());
}

export interface TestAccount {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

/** A fresh identity per test, so two runs can never collide on a unique index. */
export function newAccount(label: string): TestAccount {
  const unique = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: `Test ${label}`,
    email: `test-${label}-${unique}@siteops.test`,
    password: 'IntegrationTestPassw0rd!',
  };
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * Mints the email-verification token for an address.
 *
 * Better Auth does not store this token anywhere — it is a self-contained HS256
 * JWT over `{ email }`, signed with `AUTH_SECRET` — so there is nothing in the
 * database to read, and no mail provider in a test run to deliver the link.
 *
 * Signing it here with the same secret produces the *exact* token the email
 * would have carried, so the test follows the real link and the real
 * `/verify-email` route runs: signature check, expiry, the user update, the
 * redirect and the automatic sign-in that follows. Setting `emailVerified`
 * directly in the database would skip every one of those.
 *
 * This mirrors `signJWT` in `better-auth/crypto`, and the dashboard's own e2e
 * suite carries an identical copy — which makes this a compatibility test as
 * much as a convenience.
 */
export function verificationTokenFor(email: string, expiresInSeconds = 3600): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    email: email.toLowerCase(),
    iat: issuedAt,
    exp: issuedAt + expiresInSeconds,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', env.AUTH_SECRET).update(signingInput).digest('base64url');

  return `${signingInput}.${signature}`;
}

export interface SignedInAccount {
  readonly account: TestAccount;
  readonly agent: Agent;
  readonly userId: string;
}

/** Registers, verifies and signs in, through the product's own routes. */
export async function signUpAndVerify(label: string): Promise<SignedInAccount> {
  const account = newAccount(label);
  const agent = client();

  const signUp = await agent
    .post('/api/auth/sign-up/email')
    .send({ name: account.name, email: account.email, password: account.password })
    .expect(200);

  const userId = (signUp.body as { data: { user: { id: string } } }).data.user.id;

  await agent
    .get('/api/auth/verify-email')
    .query({
      token: verificationTokenFor(account.email),
      callbackURL: `${env.APP_URL}/verify-email/confirmed`,
    })
    .expect(302);

  await agent
    .post('/api/auth/sign-in/email')
    .send({ email: account.email, password: account.password })
    .expect(200);

  return { account, agent, userId };
}

/** Creates an organization and returns its id. */
export async function createOrganization(agent: Agent, name: string): Promise<string> {
  const response = await agent.post('/api/organizations').send({ name }).expect(201);
  return (response.body as { data: { organization: { id: string } } }).data.organization.id;
}

/** Registers, verifies, signs in and creates one organization. */
export async function onboard(
  label: string,
): Promise<SignedInAccount & { organizationId: string }> {
  const signedIn = await signUpAndVerify(label);
  const organizationId = await createOrganization(
    signedIn.agent,
    `Org ${label} ${signedIn.userId.slice(-6)}`,
  );
  return { ...signedIn, organizationId };
}
