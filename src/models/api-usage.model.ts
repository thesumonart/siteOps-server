import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * How many public API requests one organization made on one UTC day.
 *
 * The plan's `apiRequestsPerDay` is a billing limit, so it is counted here, in
 * the database, rather than in the in-process rate limiter: that one is per
 * process and forgets on restart, which is acceptable for smoothing bursts and
 * not for a number a plan is priced on. One document per organization per day,
 * incremented atomically, so concurrent requests on several API instances all
 * land on the same count.
 */
export interface ApiUsageAttributes {
  organizationId: Types.ObjectId;
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** Midnight UTC of `day`. The TTL is measured from here. */
  dayStart: Date;
  requests: number;
}

export type ApiUsageDocument = HydratedDocument<ApiUsageAttributes>;

/** Kept long enough to answer "how much did we use last month", then dropped. */
export const API_USAGE_RETENTION_SECONDS = 35 * 24 * 60 * 60;

const apiUsageSchema = new Schema<ApiUsageAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    dayStart: { type: Date, required: true },
    requests: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: false, collection: 'api_usage' },
);

/*
 * The counter's key, and the reason concurrent first requests of a day cannot
 * create two documents: the upsert's filter is exactly this index, so the
 * server serialises them onto one.
 */
apiUsageSchema.index(
  { organizationId: 1, day: 1 },
  { unique: true, name: 'api_usage_org_day_unique' },
);

apiUsageSchema.index(
  { dayStart: 1 },
  { name: 'api_usage_ttl', expireAfterSeconds: API_USAGE_RETENTION_SECONDS },
);

export const ApiUsageModel: Model<ApiUsageAttributes> =
  (mongoose.models.ApiUsage as Model<ApiUsageAttributes> | undefined) ??
  model<ApiUsageAttributes>('ApiUsage', apiUsageSchema);
