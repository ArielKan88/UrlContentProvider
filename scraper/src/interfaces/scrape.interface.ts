export interface ScrapeRequest {
  id: string;
  url: string;
  userAgent?: string;
  timeout?: number;
  retryCount?: number;
  priority?: number;
}

export interface ScrapeResult {
  id: string;
  url: string;
  success: boolean;
  content?: string;
  contentType?: string;
  httpStatus?: number;
  errorMessage?: string;
  finalUrl?: string;
  responseTime: number;
  contentLength: number;
  contentHash?: string;
  userAgent: string;
  redirectChain?: string[];
  scrapedAt: Date;
}

export interface ScrapeFailure {
  id: string;
  url: string;
  errorMessage: string;
  retryCount: number;
  maxRetries: number;
  canRetry: boolean;
  httpStatus?: number;
  failedAt: Date;
}

export interface ScrapeStarted {
  id: string;
  url: string;
  startedAt: Date;
  userAgent: string;
}

export enum QueueNames {
  SCRAPE_REQUESTS = 'scrape.requests',
  SCRAPE_STARTED = 'scrape.started',
  SCRAPE_RESULTS = 'scrape.results',
  SCRAPE_FAILURES = 'scrape.failures'
}

export enum HttpStatusCode {
  OK = 200,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  TIMEOUT = 408,
  TOO_MANY_REQUESTS = 429,
  INTERNAL_SERVER_ERROR = 500,
  BAD_GATEWAY = 502,
  SERVICE_UNAVAILABLE = 503,
  GATEWAY_TIMEOUT = 504
}
