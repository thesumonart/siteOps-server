import mongoose, {
  Schema,
  model,
  type HydratedDocument,
  type Model,
  type SchemaDefinition,
  type Types,
} from 'mongoose';

import { DEFAULT_NOTIFICATION_PREFERENCES, PREFERENCE_FIELDS } from '../contracts/index.js';
import type { NotificationPreferences } from '../contracts/index.js';

/**
 * Per-user, per-organization delivery preferences.
 *
 * Stored separately from the user so a person can be noisy about one client's
 * websites and quiet about another's.
 */
export type NotificationSettingsAttributes = NotificationPreferences & {
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type NotificationSettingsDocument = HydratedDocument<NotificationSettingsAttributes>;

/**
 * The boolean paths, generated from the contract's field list.
 *
 * Written out by hand originally, which was fine at two preferences and became
 * a place to forget one at ten. Generating them means a new preference is one
 * entry in `PREFERENCE_FIELDS` and the schema, the repository and the form all
 * pick it up — they cannot disagree about which fields exist.
 */
const preferencePaths = Object.fromEntries(
  PREFERENCE_FIELDS.map((field) => [
    field,
    { type: Boolean, required: true, default: DEFAULT_NOTIFICATION_PREFERENCES[field] },
  ]),
) as SchemaDefinition<NotificationPreferences>;

const notificationSettingsSchema = new Schema<NotificationSettingsAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    ...preferencePaths,
  },
  { timestamps: true, collection: 'notification_settings' },
);

notificationSettingsSchema.index(
  { organizationId: 1, userId: 1 },
  { unique: true, name: 'notification_settings_org_user_unique' },
);

export const NotificationSettingsModel: Model<NotificationSettingsAttributes> =
  (mongoose.models.NotificationSettings as Model<NotificationSettingsAttributes> | undefined) ??
  model<NotificationSettingsAttributes>('NotificationSettings', notificationSettingsSchema);
