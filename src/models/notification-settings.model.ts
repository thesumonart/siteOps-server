import { DEFAULT_NOTIFICATION_PREFERENCES } from '../contracts/index.js';
import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Per-user, per-organization delivery preferences.
 *
 * Stored separately from the user so a person can be noisy about one client's
 * websites and quiet about another's.
 */
export interface NotificationSettingsAttributes {
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  websiteDown: boolean;
  websiteRecovered: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationSettingsDocument = HydratedDocument<NotificationSettingsAttributes>;

const notificationSettingsSchema = new Schema<NotificationSettingsAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    websiteDown: {
      type: Boolean,
      required: true,
      default: DEFAULT_NOTIFICATION_PREFERENCES.websiteDown,
    },
    websiteRecovered: {
      type: Boolean,
      required: true,
      default: DEFAULT_NOTIFICATION_PREFERENCES.websiteRecovered,
    },
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
