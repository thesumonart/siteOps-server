import type { Types } from 'mongoose';

import {
  API_KEY_PREFIX,
  API_KEY_SCOPE_PERMISSIONS,
  hasEveryPermission,
  type ApiKeyDto,
  type ApiKeyStatus,
  type CreateApiKeyInput,
  type IssuedApiKeyDto,
} from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type { ApiKeyRecord, ApiKeyRepository } from '../repositories/api-key.repository.js';
import type {
  OrganizationRecord,
  OrganizationRepository,
} from '../repositories/organization.repository.js';
import type { OrganizationActor, OrganizationContext } from '../types/common.types.js';
import { generateToken, hashToken } from '../utils/crypto.js';
import { toObjectId } from '../utils/object-id.js';
import type { AuditService } from './audit.service.js';
import type { EntitlementService } from './entitlement.service.js';

/** `so_live_` and 43 base64url characters: 256 bits of randomness. */
const TOKEN_PATTERN = new RegExp(`^${API_KEY_PREFIX}[A-Za-z0-9_-]{43}$`);

/** How much of a key the list shows: the prefix and eight characters of the secret. */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuthenticatedApiKey {
  readonly key: ApiKeyRecord;
  readonly organization: OrganizationRecord;
}

/**
 * Issuing, rotating and revoking API keys, and recognising one on a request.
 *
 * The rules that matter:
 *
 *  - **A key is shown once.** It exists in plaintext only in the response that
 *    issued it. The database holds its SHA-256, so neither a leaked backup nor
 *    this API can hand it out again; losing it means rotating it.
 *  - **A key cannot outrank its issuer.** Each scope stands for dashboard
 *    permissions, and a person may only grant scopes whose permissions they
 *    hold. Otherwise a key would be how a lesser role acts with a greater one's
 *    reach.
 *  - **The plan gates issuing and use, not existence.** After a downgrade the
 *    keys are still listed and can be revoked; they simply stop authenticating.
 */
export class ApiKeyService {
  constructor(
    private readonly repository: ApiKeyRepository,
    private readonly organizations: OrganizationRepository,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
  ) {}

  async list(organization: OrganizationContext): Promise<readonly ApiKeyDto[]> {
    const now = new Date();
    const keys = await this.repository.list(organization.objectId);
    return keys.map((key) => toApiKeyDto(key, now));
  }

  async create(
    organization: OrganizationContext,
    input: CreateApiKeyInput,
    actor: OrganizationActor,
  ): Promise<IssuedApiKeyDto> {
    this.entitlements.assertFeature(organization, 'api_access');
    await this.entitlements.assertWithinLimit(organization, 'maxApiKeys');

    for (const scope of input.scopes) {
      if (!hasEveryPermission(actor.role, API_KEY_SCOPE_PERMISSIONS[scope])) {
        throw ApiError.forbidden(
          'INSUFFICIENT_ROLE',
          `Your role cannot issue a key with the "${scope}" scope.`,
        );
      }
    }

    const actorObjectId = toObjectId(actor.id);
    if (!actorObjectId) throw ApiError.unauthenticated();

    const now = new Date();
    const issued = issueToken();
    const key = await this.repository.create({
      organizationId: organization.objectId,
      name: input.name,
      prefix: issued.prefix,
      tokenHash: issued.tokenHash,
      scopes: input.scopes,
      createdByUserId: actorObjectId,
      createdByName: actor.name,
      expiresAt:
        input.expiresInDays == null ? null : new Date(now.getTime() + input.expiresInDays * DAY_MS),
    });

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'api_key.created',
      actorUserId: actorObjectId,
      actorName: actor.name,
      targetType: 'api_key',
      targetId: key._id,
      targetLabel: key.name,
    });

    return { apiKey: toApiKeyDto(key, now), token: issued.token };
  }

  /**
   * Replaces a key's secret and keeps everything else — name, scopes, expiry.
   *
   * The old secret stops working in the same write. That is the point: a key
   * is rotated because it may have leaked, and an overlap window would be a
   * window for whoever has it.
   */
  async rotate(
    organization: OrganizationContext,
    keyId: string,
    actor: OrganizationActor,
  ): Promise<IssuedApiKeyDto> {
    this.entitlements.assertFeature(organization, 'api_access');
    const existing = await this.requireKey(organization, keyId);

    const now = new Date();
    const issued = issueToken();
    const rotated = await this.repository.rotate(
      organization.objectId,
      existing._id,
      { tokenHash: issued.tokenHash, prefix: issued.prefix },
      now,
    );
    if (!rotated) {
      throw ApiError.conflict(
        'CONFLICT',
        'A revoked or expired key cannot be rotated. Create a new one instead.',
      );
    }

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'api_key.rotated',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'api_key',
      targetId: rotated._id,
      targetLabel: rotated.name,
    });

    return { apiKey: toApiKeyDto(rotated, now), token: issued.token };
  }

  /**
   * Revokes a key. Idempotent: revoking a key that is already revoked succeeds
   * and records nothing, because it is the outcome the caller asked for.
   */
  async revoke(
    organization: OrganizationContext,
    keyId: string,
    actor: OrganizationActor,
  ): Promise<void> {
    const existing = await this.requireKey(organization, keyId);

    const revoked = await this.repository.revoke(organization.objectId, existing._id, new Date());
    if (!revoked) return;

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'api_key.revoked',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'api_key',
      targetId: revoked._id,
      targetLabel: revoked.name,
    });
  }

  /**
   * The live key a presented token belongs to, and its organization, or null.
   *
   * The shape check comes first and costs nothing, so a request carrying
   * something that could never be a key never reaches the database. The lookup
   * is by hash on a unique index: there is no key-by-key comparison to time.
   */
  async authenticate(token: string, now: Date): Promise<AuthenticatedApiKey | null> {
    if (!TOKEN_PATTERN.test(token)) return null;

    const key = await this.repository.findActiveByTokenHash(hashToken(token), now);
    if (!key) return null;

    const organization = await this.organizations.findById(key.organizationId.toHexString());
    if (!organization) return null;

    return { key, organization };
  }

  /** Counts a request against the day's quota and notes the key was used. Returns today's total. */
  async recordUse(
    keyId: Types.ObjectId,
    organizationId: Types.ObjectId,
    now: Date,
  ): Promise<number> {
    const [requests] = await Promise.all([
      this.repository.recordRequest(organizationId, now),
      this.repository.touch(keyId, now),
    ]);
    return requests;
  }

  private async requireKey(
    organization: OrganizationContext,
    keyId: string,
  ): Promise<ApiKeyRecord> {
    const key = await this.repository.findById(organization.objectId, keyId);
    if (!key) throw ApiError.notFound('API_KEY_NOT_FOUND', 'API key not found.');
    return key;
  }
}

function issueToken(): { token: string; tokenHash: string; prefix: string } {
  const token = `${API_KEY_PREFIX}${generateToken()}`;
  return { token, tokenHash: hashToken(token), prefix: token.slice(0, DISPLAY_PREFIX_LENGTH) };
}

function statusOf(key: ApiKeyRecord, now: Date): ApiKeyStatus {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

export function toApiKeyDto(key: ApiKeyRecord, now: Date): ApiKeyDto {
  return {
    id: key._id.toHexString(),
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes,
    status: statusOf(key, now),
    createdByName: key.createdByName,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  };
}
