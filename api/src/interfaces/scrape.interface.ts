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

export enum FetchStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  ARCHIVED = 'ARCHIVED'
}

export enum QueueNames {
  SCRAPE_REQUESTS = 'scrape.requests',
  SCRAPE_STARTED = 'scrape.started',
  SCRAPE_RESULTS = 'scrape.results',
  SCRAPE_FAILURES = 'scrape.failures'
}
