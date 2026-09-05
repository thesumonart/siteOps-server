import type { Types } from 'mongoose';

import { UserModel } from '../models/index.js';
import { toObjectId } from '../utils/object-id.js';

/**
 * Read-only access to the account records the authentication layer owns.
 *
 * Better Auth writes the `user` collection through its own adapter, including
 * password hashing and verification state. Nothing here writes to it: profile
 * changes, password changes and verification all go through Better Auth so that
 * hashing and session invalidation stay in one place. This repository exists so
 * the rest of the application can *read* a name and an address — to render a
 * members table, or to address an outage email.
 */

export interface UserProfile {
  readonly id: Types.ObjectId;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

interface UserProjection {
  readonly _id: Types.ObjectId;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

const PROFILE_FIELDS = { name: 1, email: 1, emailVerified: 1 } as const;

function toProfile(row: UserProjection): UserProfile {
  return {
    id: row._id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
  };
}

export class UserRepository {
  async findById(userId: string): Promise<UserProfile | null> {
    const objectId = toObjectId(userId);
    if (!objectId) return null;

    const row = await UserModel.findById(objectId)
      .select(PROFILE_FIELDS)
      .lean<UserProjection>()
      .exec();
    return row ? toProfile(row) : null;
  }

  /** One query for a whole page of members, never one per row. */
  async findManyByIds(userIds: readonly Types.ObjectId[]): Promise<readonly UserProfile[]> {
    if (userIds.length === 0) return [];

    const rows = await UserModel.find({ _id: { $in: userIds } })
      .select(PROFILE_FIELDS)
      .lean<UserProjection[]>()
      .exec();
    return rows.map(toProfile);
  }

  /** Addresses are lowercased by the auth layer before storage, so this matches exactly. */
  async findIdByEmail(email: string): Promise<Types.ObjectId | null> {
    const row = await UserModel.findOne({ email: email.trim().toLowerCase() })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>()
      .exec();
    return row?._id ?? null;
  }
}
