/**
 * Per-route validation bundles.
 *
 * Body and query schemas come straight from `src/contracts/schemas`, which the
 * dashboard imports too — so the browser form and the API enforce literally the
 * same rule and cannot drift. What lives here is the composition: which schema
 * applies to which part of which request, in one place per resource, so a route
 * declares `validate(websiteValidators.create)` instead of assembling three
 * schemas inline.
 *
 * Route parameters are the exception and are defined here rather than in the
 * contract, because a browser has nothing to validate about them.
 */

export * from './audit.validator.js';
export * from './common.validator.js';
export * from './incident.validator.js';
export * from './notification.validator.js';
export * from './organization.validator.js';
export * from './report.validator.js';
export * from './website.validator.js';
