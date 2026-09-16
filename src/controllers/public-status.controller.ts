import type { Request, Response } from 'express';

import type { PublicStatusPageQuery } from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import { validatedParams, validatedQuery } from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { PublicStatusService } from '../services/public-status.service.js';

/** Published status pages, for anyone. No session, no key, no organization context. */
export class PublicStatusController {
  constructor(
    private readonly publicStatus: PublicStatusService,
    private readonly maxAgeSeconds: number,
  ) {}

  bySlug = async (request: Request, response: Response): Promise<void> => {
    const { slug } = validatedParams<{ slug: string }>(request);
    const { days } = validatedQuery<PublicStatusPageQuery>(request);

    const page = await this.publicStatus.bySlug(slug, days);
    this.cacheable(response);
    ApiResponse.ok(response, page);
  };

  /**
   * The page the request's host serves. Only reachable meaningfully on a
   * verified custom domain; on any other host there is no page to name.
   */
  forHost = async (request: Request, response: Response): Promise<void> => {
    const pageId = request.customDomainStatusPageId;
    if (pageId === undefined) {
      throw ApiError.notFound('STATUS_PAGE_NOT_FOUND', 'Status page not found.');
    }
    const { days } = validatedQuery<PublicStatusPageQuery>(request);

    const page = await this.publicStatus.byCustomDomain(pageId, days);
    this.cacheable(response);
    ApiResponse.ok(response, page);
  };

  /**
   * The same page is served to every visitor, so shared caches may keep it for
   * as long as this process would. Errors are not marked cacheable: a 404 for a
   * page about to be published should not outlive the publish.
   */
  private cacheable(response: Response): void {
    if (this.maxAgeSeconds <= 0) return;
    response.setHeader('Cache-Control', `public, max-age=${String(this.maxAgeSeconds)}`);
  }
}
