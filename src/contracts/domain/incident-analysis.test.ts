import { describe, expect, it } from 'vitest';

import { INCIDENT_CATEGORIES } from './incident.js';
import {
  ANALYZABLE_INCIDENT_CATEGORIES,
  INCIDENT_ANALYSIS_STATUS_LABELS,
  INCIDENT_ANALYSIS_STATUSES,
  isAnalyzableIncidentCategory,
} from './incident-analysis.js';
import { PLAN_DEFINITIONS, UNRELEASED_PLAN_FEATURES } from './plan.js';

describe('incident analysis', () => {
  it('covers outages and slowdowns, and nothing the check history cannot explain', () => {
    expect(ANALYZABLE_INCIDENT_CATEGORIES).toEqual(['availability', 'anomaly']);
    for (const category of ANALYZABLE_INCIDENT_CATEGORIES) {
      expect(INCIDENT_CATEGORIES).toContain(category);
    }
    expect(isAnalyzableIncidentCategory('ssl')).toBe(false);
  });

  it('labels every status', () => {
    for (const status of INCIDENT_ANALYSIS_STATUSES) {
      expect(INCIDENT_ANALYSIS_STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
  });

  it('is released on the plans that grant it', () => {
    expect(UNRELEASED_PLAN_FEATURES).not.toContain('ai_insights');
    expect(PLAN_DEFINITIONS.agency.features).toContain('ai_insights');
    expect(PLAN_DEFINITIONS.starter.features).not.toContain('ai_insights');
  });
});
