export class UrlNormalizer {
  /**
   * Normalize URL for consistent storage and comparison
   * - Only lowercase the hostname (domain)
   * - Keep path, query, and fragment case-sensitive
   * - Remove www. prefix from hostname
   * - Ensure https:// protocol
   * - Remove trailing slash only for root paths
   */
  static normalize(url: string): string {
    try {
      let workingUrl = url.trim();
      
      // Add protocol if missing
      if (!workingUrl.match(/^https?:\/\//)) {
        workingUrl = `https://${workingUrl}`;
      }
      
      const urlObj = new URL(workingUrl);
      
      // Normalize only the hostname (lowercase + remove www)
      let hostname = urlObj.hostname.toLowerCase();
      if (hostname.startsWith('www.')) {
        hostname = hostname.substring(4);
      }
      
      // Reconstruct with normalized hostname but preserve case-sensitive parts
      let normalized = `${urlObj.protocol}//${hostname}`;
      
      // Add port if present
      if (urlObj.port) {
        normalized += `:${urlObj.port}`;
      }
      
      // Add path (case-sensitive)
      let pathname = urlObj.pathname;
      // Only remove trailing slash for root path
      if (pathname === '/') {
        pathname = '';
      } else if (pathname.endsWith('/') && pathname.length > 1) {
        // Remove trailing slash for non-root paths
        pathname = pathname.slice(0, -1);
      }
      normalized += pathname;
      
      // Add search/query (case-sensitive)
      if (urlObj.search) {
        normalized += urlObj.search;
      }
      
      // Add hash/fragment (case-sensitive)
      if (urlObj.hash) {
        normalized += urlObj.hash;
      }
      
      // Remove the protocol for storage (we'll add it back in getCanonicalUrl)
      return normalized.replace(/^https?:\/\//, '');
      
    } catch (error) {
      // If URL parsing fails, do minimal normalization
      console.warn(`URL normalization failed for: ${url}`, error);
      
      // Fallback: only remove protocol and www, keep everything else as-is
      let fallback = url.trim();
      fallback = fallback.replace(/^https?:\/\//, '');
      
      // Only lowercase and remove www from the hostname part
      const hostMatch = fallback.match(/^([^\/\?\#]+)(.*)/);
      if (hostMatch) {
        let hostname = hostMatch[1].toLowerCase();
        if (hostname.startsWith('www.')) {
          hostname = hostname.substring(4);
        }
        fallback = hostname + (hostMatch[2] || '');
      }
      
      return fallback;
    }
  }

  /**
   * Get the canonical URL for storage (with https:// prefix)
   */
  static getCanonicalUrl(url: string): string {
    const normalized = this.normalize(url);
    return `https://${normalized}`;
  }

  /**
   * Check if two URLs are equivalent after normalization
   */
  static areEquivalent(url1: string, url2: string): boolean {
    return this.normalize(url1) === this.normalize(url2);
  }

  /**
   * Extract hostname from URL for comparison
   */
  static getHostname(url: string): string {
    try {
      let workingUrl = url.trim();
      if (!workingUrl.match(/^https?:\/\//)) {
        workingUrl = `https://${workingUrl}`;
      }
      
      const urlObj = new URL(workingUrl);
      let hostname = urlObj.hostname.toLowerCase();
      
      // Remove www prefix
      if (hostname.startsWith('www.')) {
        hostname = hostname.substring(4);
      }
      
      return hostname;
    } catch (error) {
      // Fallback hostname extraction
      const match = url.replace(/^https?:\/\//, '').match(/^([^\/\?\#]+)/);
      if (match) {
        let hostname = match[1].toLowerCase();
        if (hostname.startsWith('www.')) {
          hostname = hostname.substring(4);
        }
        return hostname;
      }
      return url;
    }
  }
}