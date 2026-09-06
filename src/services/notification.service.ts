import type {
  NotificationSettingsDto,
  UpdateNotificationPreferencesInput,
} from '../contracts/index.js';
import { DEFAULT_NOTIFICATION_PREFERENCES, PREFERENCE_FIELDS } from '../contracts/index.js';
import type { PreferenceField } from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type { NotificationRepository } from '../repositories/notification.repository.js';
import type { OrganizationContext } from '../types/common.types.js';
import { toObjectId } from '../utils/object-id.js';

/**
 * Per-user, per-organization alert preferences.
 *
 * Scoped to both because someone who works across several client organizations
 * may want outage alerts for one and not another.
 *
 * A user with no stored row is notified. The absence of a preference means
 * "never asked", and defaulting that to silence would mean an outage nobody
 * hears about — the failure this product exists to prevent. The worker applies
 * the same default when it resolves recipients.
 */
export class NotificationService {
  constructor(private readonly repository: NotificationRepository) {}

  async get(organization: OrganizationContext, userId: string): Promise<NotificationSettingsDto> {
    const userObjectId = toObjectId(userId);
    if (!userObjectId) throw ApiError.unauthenticated();

    const stored = await this.repository.findPreferences(organization.objectId, userObjectId);
    return { preferences: stored ?? DEFAULT_NOTIFICATION_PREFERENCES };
  }

  async update(
    organization: OrganizationContext,
    userId: string,
    input: UpdateNotificationPreferencesInput,
  ): Promise<NotificationSettingsDto> {
    const userObjectId = toObjectId(userId);
    if (!userObjectId) throw ApiError.unauthenticated();

    const changes: Partial<Record<PreferenceField, boolean>> = {};
    for (const field of PREFERENCE_FIELDS) {
      const value = input[field];
      if (value !== undefined) changes[field] = value;
    }

    // An empty patch must not create a row of defaults: that would silently
    // convert "never asked" into an explicit answer the person did not give.
    if (Object.keys(changes).length === 0) {
      return this.get(organization, userId);
    }

    const preferences = await this.repository.upsertPreferences(
      organization.objectId,
      userObjectId,
      changes,
    );
    return { preferences };
  }
}
