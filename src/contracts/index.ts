/**
 * The SiteOps API contract.
 *
 * SiteOps is two projects — this backend and the `siteOps-client` dashboard —
 * that meet only over HTTP. Everything in this directory describes what crosses
 * that boundary: the response envelope, the DTOs the API returns, the Zod
 * schemas both sides validate a request body with, and the domain vocabulary
 * (roles, plans, statuses) the two have to agree on to mean the same thing.
 *
 * **This directory is the source of truth.** `siteOps-client/src/contracts` is
 * a copy of it. Change it here first, then port the change there, and let the
 * tests that live alongside each module say whether the port was faithful.
 *
 * The copy is safe only because every module here is platform-neutral — no Node
 * built-ins, no database types, nothing but TypeScript and Zod. Anything that
 * cannot survive in a browser does not belong in this directory; put it in
 * `src/utils`, `src/email` or the layer that needs it.
 */

export * from './api/dto.js';
export * from './api/errors.js';
export * from './api/pagination.js';

export * from './domain/audit.js';
export * from './domain/check.js';
export * from './domain/incident.js';
export * from './domain/monitor.js';
export * from './domain/notification.js';
export * from './domain/permissions.js';
export * from './domain/plan.js';
export * from './domain/roles.js';
export * from './domain/website.js';

export * from './schemas/audit.js';
export * from './schemas/auth.js';
export * from './schemas/common.js';
export * from './schemas/monitor.js';
export * from './schemas/monitoring.js';
export * from './schemas/notification.js';
export * from './schemas/organization.js';
export * from './schemas/website.js';

export * from './url/ip.js';
export * from './url/normalize.js';

export * from './uptime.js';
