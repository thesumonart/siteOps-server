import type { Types } from 'mongoose';

import { planHasFeature, type Plan } from '../contracts/index.js';
import type { IncidentAnalysisRepository } from '../repositories/incident-analysis.repository.js';

export interface IncidentAnalysisSchedulerOptions {
  /** False when this deployment has no model: then nothing is ever queued. */
  readonly enabled: boolean;
  readonly delaySeconds: number;
  readonly minDurationSeconds: number;
}

/**
 * Decides whether a just-resolved incident gets an analysis, and queues it.
 *
 * Called from both places an incident resolves — the monitoring job on
 * recovery, and a person closing one by hand — so the rule is written once:
 * a model is configured, the plan includes AI insights, and the incident is
 * an outage or slowdown that lasted long enough to be worth explaining. The
 * first two are checked here; the rest are conditions of the queuing write
 * itself, which is what makes calling this twice harmless.
 */
export class IncidentAnalysisScheduler {
  constructor(
    private readonly repository: IncidentAnalysisRepository,
    private readonly options: IncidentAnalysisSchedulerOptions,
  ) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** True when this call queued an analysis. */
  async afterResolution(
    incidentId: Types.ObjectId,
    plan: Plan | null,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (!this.options.enabled) return false;
    if (plan === null || !planHasFeature(plan, 'ai_insights')) return false;

    return this.repository.enqueueAutomatic(incidentId, {
      now,
      // After a short wait, so the checks that confirm the recovery exist by the
      // time the model is shown what happened.
      readyAt: new Date(now.getTime() + this.options.delaySeconds * 1000),
      minDurationSeconds: this.options.minDurationSeconds,
    });
  }
}
