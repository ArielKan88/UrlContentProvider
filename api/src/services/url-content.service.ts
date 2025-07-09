import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { 
  QueueNames, 
  ScrapeRequest, 
  ScrapeResult, 
  ScrapeFailure,
  ScrapeStarted,
  FetchStatus 
} from '../interfaces/scrape.interface';
import { UrlFetchRequestRepository } from '../repositories/url-fetch-request.repository';
import { UrlFetchRequest } from '../schemas/url-fetch-request.schema';
import { SubmitUrlsResponseDto, SkippedUrl } from '../dto/submit-urls.dto';
import { RabbitMQUtil } from '../utils/rabbitmq.util';
import { UrlNormalizer } from '../utils/url-normalizer.util';

@Injectable()
export class UrlContentService {
  private readonly logger = new Logger(UrlContentService.name);
  private readonly scrapeInterval: number;

  constructor(
    private readonly repository: UrlFetchRequestRepository,
    private readonly rabbitMQClient: RabbitMQUtil,
    private readonly configService: ConfigService
  ) {
    this.scrapeInterval = this.configService.get<number>('SCRAPE_INTERVAL_MINUTES', 60);
  }

  async submitUrls(urls: string[]): Promise<SubmitUrlsResponseDto> {
    const submitted: string[] = [];
    const skipped: SkippedUrl[] = [];
    const queued: string[] = [];

    for (const url of urls) {
      try {
        // Normalize URL for consistent storage
        const canonicalUrl = UrlNormalizer.getCanonicalUrl(url);
        
        const recentRequest = await this.repository.getRecentByUrl(url, this.scrapeInterval);
        
        if (recentRequest) {
          let reason: string;
          let nextAvailableAt: Date | undefined;
          
          if (recentRequest.status === FetchStatus.SUCCESS && recentRequest.fetchedAt) {
            // Check if this URL was directly scraped or reached via redirect
            if (recentRequest.url === canonicalUrl || UrlNormalizer.areEquivalent(recentRequest.url, url)) {
              reason = `Successfully scraped within ${this.scrapeInterval} minutes`;
            } else {
              reason = `Already scraped via redirect (${recentRequest.url} → redirects to this URL)`;
            }
            nextAvailableAt = new Date(
              recentRequest.fetchedAt.getTime() + this.scrapeInterval * 60 * 1000
            );
          } else if ([FetchStatus.PENDING, FetchStatus.PROCESSING].includes(recentRequest.status)) {
            reason = `Already queued for scraping (status: ${recentRequest.status})`;
          } else {
            reason = `Recent request exists with status: ${recentRequest.status}`;
          }
          
          skipped.push({
            url,
            reason,
            lastScrapedAt: recentRequest.fetchedAt || recentRequest.createdAt,
            nextAvailableAt
          });
          continue;
        }

        // Create new request with canonical URL
        const request = await this.repository.create({
          url: canonicalUrl,
          status: FetchStatus.PENDING,
          retryCount: 0
        });

        const scrapeRequest: ScrapeRequest = {
          id: (request as any)._id.toString(),
          url: canonicalUrl,
          retryCount: 0,
          priority: 1
        };

        await this.rabbitMQClient.publish(QueueNames.SCRAPE_REQUESTS, scrapeRequest);
        
        submitted.push(url);
        queued.push((request as any)._id.toString());
        
        this.logger.log(`Queued URL for scraping: ${canonicalUrl} (ID: ${scrapeRequest.id})`);
        
      } catch (error) {
        this.logger.error(`Error processing URL ${url}:`, error);
        skipped.push({
          url,
          reason: `Processing error: ${error.message}`
        });
      }
    }

    this.logger.log(`Submitted ${submitted.length} URLs, skipped ${skipped.length}`);
    
    return { submitted, skipped, queued };
  }

  async handleScrapeStarted(started: ScrapeStarted): Promise<void> {
    try {
      await this.repository.update(started.id, {
        status: FetchStatus.PROCESSING,
        userAgent: started.userAgent,
        // Clear any previous error messages when starting fresh
        errorMessage: undefined
      });
      this.logger.log(`Started processing ${started.url}`);
    } catch (error) {
      this.logger.error(`Error handling scrape started for ${started.url}:`, error);
    }
  }

  async handleScrapeResult(result: ScrapeResult): Promise<void> {
    try {
      const updateData: Partial<UrlFetchRequest> = {
        status: result.success ? FetchStatus.SUCCESS : FetchStatus.FAILED,
        fetchedAt: result.scrapedAt,
        lastScrapedAt: result.scrapedAt,
        finalUrl: result.finalUrl,
        responseTime: result.responseTime,
        contentLength: result.contentLength,
        contentHash: result.contentHash,
        userAgent: result.userAgent,
        redirectChain: result.redirectChain || []
      };

      if (result.success) {
        // SUCCESS: Set content and clear all error fields
        updateData.content = result.content;
        updateData.contentType = result.contentType;
        updateData.httpStatus = result.httpStatus;
        updateData.errorMessage = null; // Explicitly clear error message
      } else {
        // FAILURE: Set error and clear all content fields
        updateData.errorMessage = result.errorMessage;
        updateData.httpStatus = result.httpStatus;
        updateData.content = null; // Explicitly clear content
        updateData.contentType = null;
        updateData.contentHash = null;
      }

      await this.repository.update(result.id, updateData);
      this.logger.log(`Updated result for ${result.url}: ${result.success ? 'SUCCESS' : 'FAILED'} ${result.success ? '(cleared error message)' : '(cleared content)'}`);
    } catch (error) {
      this.logger.error(`Error handling scrape result for ${result.url}:`, error);
    }
  }

  async handleScrapeFailure(failure: ScrapeFailure): Promise<void> {
    try {
      const maxRetries = this.configService.get<number>('MAX_RETRIES', 3);
      
      this.logger.log(`Handling failure for ${failure.url}: ${failure.errorMessage} (retry ${failure.retryCount}/${maxRetries}, canRetry: ${failure.canRetry})`);
      
      if (failure.canRetry && failure.retryCount < maxRetries) {
        const request = await this.repository.update(failure.id, {
          retryCount: failure.retryCount + 1,
          status: FetchStatus.PENDING,
          // Keep the error message for debugging but clear other fields
          errorMessage: `Retry ${failure.retryCount + 1}/${maxRetries}: ${failure.errorMessage}`,
          // Clear previous success data
          content: undefined,
          contentType: undefined,
          contentHash: undefined,
          fetchedAt: undefined
        });

        if (request) {
          const scrapeRequest: ScrapeRequest = {
            id: (request as any)._id.toString(),
            url: failure.url,
            retryCount: failure.retryCount + 1,
            priority: 2
          };

          await this.rabbitMQClient.publish(QueueNames.SCRAPE_REQUESTS, scrapeRequest);
          this.logger.log(`🔄 Retrying ${failure.url} (attempt ${failure.retryCount + 1}/${maxRetries})`);
        }
      } else {
        const reason = failure.canRetry ? 
          `Maximum retries (${maxRetries}) exceeded` : 
          'Error is not retryable';
          
        await this.repository.update(failure.id, {
          status: FetchStatus.FAILED,
          errorMessage: `${reason}: ${failure.errorMessage}`,
          httpStatus: failure.httpStatus,
          // Clear any success data
          content: undefined,
          contentType: undefined,
          contentHash: undefined
        });
        this.logger.warn(`❌ Permanently failed: ${failure.url} after ${failure.retryCount} attempts (${reason})`);
      }
    } catch (error) {
      this.logger.error(`Error handling scrape failure for ${failure.url}:`, error);
    }
  }

  async getResult(id: string): Promise<UrlFetchRequest | null> {
    return this.repository.findById(id);
  }

  async getLatestByUrl(url: string): Promise<UrlFetchRequest | null> {
    return this.repository.findLatestByUrl(url);
  }

  async getAllResults(filter: any = {}, limit: number = 50, offset: number = 0): Promise<UrlFetchRequest[]> {
    return this.repository.findAll(filter, limit, offset);
  }

  async getUrlHistory(url: string): Promise<UrlFetchRequest[]> {
    return this.repository.getUrlHistory(url);
  }

  async startConsumers(): Promise<void> {
    this.logger.log('Starting message consumers...');

    try {
      await this.rabbitMQClient.consume(QueueNames.SCRAPE_STARTED, async (message: ScrapeStarted) => {
        await this.handleScrapeStarted(message);
      });

      await this.rabbitMQClient.consume(QueueNames.SCRAPE_RESULTS, async (message: ScrapeResult) => {
        await this.handleScrapeResult(message);
      });

      await this.rabbitMQClient.consume(QueueNames.SCRAPE_FAILURES, async (message: ScrapeFailure) => {
        await this.handleScrapeFailure(message);
      });

      this.logger.log('Message consumers started');
    } catch (error) {
      this.logger.error('Failed to start consumers:', error);
      throw error;
    }
  }

  /**
   * Cleanup stale pending requests (useful for maintenance)
   */
  async cleanupStaleRequests(): Promise<number> {
    const timeoutMinutes = this.configService.get<number>('STALE_REQUEST_TIMEOUT_MINUTES', 120);
    const staleRequests = await this.repository.findStalePendingRequests(timeoutMinutes);
    
    let cleaned = 0;
    for (const request of staleRequests) {
      await this.repository.update((request as any)._id.toString(), {
        status: FetchStatus.FAILED,
        errorMessage: 'Request timed out - no response from scraper'
      });
      cleaned++;
    }
    
    if (cleaned > 0) {
      this.logger.log(`Cleaned up ${cleaned} stale pending requests`);
    }
    
    return cleaned;
  }

  /**
   * Fix data inconsistencies in existing records
   */
  async fixDataInconsistencies(): Promise<number> {
    let fixed = 0;
    
    try {
      // Find SUCCESS records with error messages
      const successWithErrors = await this.repository.findAll({ 
        status: FetchStatus.SUCCESS,
        errorMessage: { $ne: null, $exists: true }
      }, 100, 0);
      
      for (const record of successWithErrors) {
        await this.repository.update((record as any)._id.toString(), {
          errorMessage: null
        });
        fixed++;
        this.logger.log(`Fixed SUCCESS record with error message: ${record.url}`);
      }
      
      // Find FAILED records with content
      const failedWithContent = await this.repository.findAll({ 
        status: FetchStatus.FAILED,
        content: { $ne: null, $exists: true }
      }, 100, 0);
      
      for (const record of failedWithContent) {
        await this.repository.update((record as any)._id.toString(), {
          content: null,
          contentType: null,
          contentHash: null
        });
        fixed++;
        this.logger.log(`Fixed FAILED record with content: ${record.url}`);
      }
      
      if (fixed > 0) {
        this.logger.log(`Fixed ${fixed} data inconsistencies`);
      }
      
    } catch (error) {
      this.logger.error('Error fixing data inconsistencies:', error);
    }
    
    return fixed;
  }
}