import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';

/**
 * Read-only projection of the account records owned by the authentication layer.
 *
 * Better Auth writes the `user`, `session`, `account` and `verification`
 * collections through its own MongoDB adapter, including password hashing and
 * session lifecycle. This model exists so application code can *read* profile
 * fields (to render a members table, or address a notification) using the same
 * connection.
 *
 * Application code must never write to this collection. Profile changes,
 * password changes and email verification all go through Better Auth so that
 * hashing and session invalidation stay in one place.
 */
export interface UserAttributes {
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<UserAttributes>;

const userSchema = new Schema<UserAttributes>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    emailVerified: { type: Boolean, required: true, default: false },
    image: { type: String, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  {
    timestamps: false,
    collection: 'user',
    // The auth library owns this schema; ignore fields it adds that this
    // projection does not model rather than dropping them on a read.
    strict: false,
  },
);

export const UserModel: Model<UserAttributes> =
  (mongoose.models.User as Model<UserAttributes> | undefined) ??
  model<UserAttributes>('User', userSchema);
