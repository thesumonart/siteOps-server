import type { IncidentCategory } from './incident.js';

/**
 * Where an incident's AI analysis stands.
 *
 * - `pending`: queued, or being written now.
 * - `completed`: a summary exists.
 * - `failed`: the model could not produce one after every attempt.
 * - `skipped`: deliberately not written — the plan no longer includes it, or
 *   the month's allowance was used up. The reason says which.
 */
export const INCIDENT_ANALYSIS_STATUSES = ['pending', 'completed', 'failed', 'skipped'] as const;

export type IncidentAnalysisStatus = (typeof INCIDENT_ANALYSIS_STATUSES)[number];

export const INCIDENT_ANALYSIS_STATUS_LABELS: Record<IncidentAnalysisStatus, string> = {
  pending: 'Analysing',
  completed: 'Ready',
  failed: 'Failed',
  skipped: 'Not analysed',
};

/** Generous for five short Markdown sections, and a hard stop on a model that will not stop. */
export const MAX_ANALYSIS_SUMMARY_LENGTH = 12_000;

export const AI_PROVIDERS = ['anthropic', 'openai'] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * The incidents an analysis is written for: outages and response-time
 * anomalies.
 *
 * Both are described by the check history — status codes, errors, response
 * times around the incident — which is what an analysis is built from. An
 * expiring certificate or a changed page has nothing in that history to
 * explain, and a summary of one would be padding around the incident's own
 * one-line detail.
 */
export const ANALYZABLE_INCIDENT_CATEGORIES: readonly IncidentCategory[] = [
  'availability',
  'anomaly',
];

export function isAnalyzableIncidentCategory(category: IncidentCategory): boolean {
  return ANALYZABLE_INCIDENT_CATEGORIES.includes(category);
}
