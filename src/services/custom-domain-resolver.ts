import type { StatusPageRepository } from '../repositories/status-page.repository.js';
import type { PublicStatusCache } from './public-status-cache.js';

/** Names that always mean "this deployment", whatever the configuration says. */
const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * Decides whether a request's host is one of SiteOps's own names or a
 * customer's verified status page domain.
 *
 * Platform hosts are known without a query: the dashboard's and the API's own
 * origins, and every trusted origin. Anything else is looked up once and
 * remembered briefly. A host that is neither — a platform's internal health
 * check hostname, a load balancer's address — resolves to null and the request
 * carries on exactly as if this did not exist, which is what keeps a
 * deployment behind an unexpected hostname from breaking.
 */
export class CustomDomainResolver {
  private readonly platformHosts: ReadonlySet<string>;

  constructor(
    private readonly repository: StatusPageRepository,
    private readonly cache: PublicStatusCache,
    platformOrigins: readonly string[],
  ) {
    const hosts = new Set(LOCAL_HOSTS);
    for (const origin of platformOrigins) {
      try {
        hosts.add(new URL(origin).hostname.toLowerCase());
      } catch {
        // Origins are validated at startup; a malformed one names no host.
      }
    }
    this.platformHosts = hosts;
  }

  isPlatformHost(host: string): boolean {
    return this.platformHosts.has(host.toLowerCase());
  }

  /** The id of the page a verified custom domain serves, or null. */
  async resolve(host: string): Promise<string | null> {
    const normalized = host.toLowerCase().replace(/\.$/, '');

    const cached = this.cache.host(normalized);
    if (cached !== undefined) return cached;

    const pageId = await this.repository.findIdByVerifiedDomain(normalized);
    this.cache.rememberHost(normalized, pageId);
    return pageId;
  }
}
