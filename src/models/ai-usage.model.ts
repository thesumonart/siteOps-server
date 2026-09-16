import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * How many AI generations one organization used in one calendar month (UTC).
 *
 * The plan's `aiGenerationsPerMonth` is a limit on something that costs real
 * money per call, so it is counted durably and reserved atomically *before* a
 * provider is called — see `IncidentAnalysisRepository.reserveGeneration`.
 * Counting afterwards would let a batch of concurrent analyses each see room
 * under the limit and all spend it.
 */
export interface AiUsageAttributes {
  organizationId: Types.ObjectId;
  /** `YYYY-MM`, UTC. */
  month: string;
  /** Midnight UTC on the first of `month`. The TTL is measured from here. */
  monthStart: Date;
  generations: number;
}

export type AiUsageDocument = HydratedDocument<AiUsageAttributes>;

/** A little over a year, so "how much did we use this time last year" has an answer. */
export const AI_USAGE_RETENTION_SECONDS = 400 * 24 * 60 * 60;

const aiUsageSchema = new Schema<AiUsageAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    monthStart: { type: Date, required: true },
    generations: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: false, collection: 'ai_usage' },
);

/*
 * The counter's key. The reservation upserts on exactly this, so two first
 * generations of a month cannot create two documents — one of them fails on
 * this index and retries against the other's.
 */
aiUsageSchema.index(
  { organizationId: 1, month: 1 },
  { unique: true, name: 'ai_usage_org_month_unique' },
);

aiUsageSchema.index(
  { monthStart: 1 },
  { name: 'ai_usage_ttl', expireAfterSeconds: AI_USAGE_RETENTION_SECONDS },
);

export const AiUsageModel: Model<AiUsageAttributes> =
  (mongoose.models.AiUsage as Model<AiUsageAttributes> | undefined) ??
  model<AiUsageAttributes>('AiUsage', aiUsageSchema);
