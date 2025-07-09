import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer, { Browser, Page } from 'puppeteer';
import { createHash } from 'crypto';
// import UserAgent from 'user-agents';
import { 
  QueueNames,
  ScrapeRequest,
  ScrapeResult,
  ScrapeFailure,
  ScrapeStarted
} from '../interfaces/scrape.interface';
import { RabbitMQUtil } from '../utils/rabbitmq.util';
import { HttpErrorHandler } from '../utils/http-error-handler';

@Injectable()
export class ScraperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScraperService.name);
  private browser: Browser | null = null;
  private readonly concurrentScrapers: number;
  private readonly timeout: number;
  private readonly retryCount: number;

  constructor(
    private readonly rabbitMQClient: RabbitMQUtil,
    private readonly configService: ConfigService
  ) {
    this.concurrentScrapers = this.configService.get<number>('CONCURRENT_SCRAPERS', 3);
    this.timeout = this.configService.get<number>('PUPPETEER_TIMEOUT', 60000);
    this.retryCount = this.configService.get<number>('MAX_RETRIES', 3);
  }

  async onModuleInit(): Promise<void> {
    await this.initializeBrowser();
    await this.startConsumer();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
  }

  private async initializeBrowser(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ]
    });
    this.logger.log('Browser initialized');
  }

  async scrapeUrl(request: ScrapeRequest): Promise<ScrapeResult | ScrapeFailure> {
    const startTime = Date.now();
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
    let page: Page | null = null;

    try {
      // Send started notification
      const startedNotification: ScrapeStarted = {
        id: request.id,
        url: request.url,
        startedAt: new Date(),
        userAgent
      };
      await this.rabbitMQClient.publish(QueueNames.SCRAPE_STARTED, startedNotification);

      if (!this.browser) {
        throw new Error('Browser not initialized');
      }

      page = await this.browser.newPage();
      await page.setUserAgent(userAgent);
      
      await page.setViewport({ width: 1920, height: 1080 });
      
      const response = await page.goto(request.url, {
        waitUntil: 'networkidle2',
        timeout: this.timeout
      });

      if (!response) {
        throw new Error('No response received');
      }

      const httpStatus = response.status();
      const finalUrl = response.url();
      const redirectChain = response.request().redirectChain().map(req => req.url());

      if (httpStatus >= 400) {
        const errorHandler = HttpErrorHandler.handle(null, response);
        return this.createFailure(request, errorHandler.errorMessage, errorHandler.canRetry, httpStatus);
      }

      const content = await page.content();
      const contentType = response.headers()['content-type'] || 'text/html';
      const contentLength = Buffer.byteLength(content, 'utf8');
      const contentHash = createHash('sha256').update(content).digest('hex');
      const responseTime = Date.now() - startTime;

      return {
        id: request.id,
        url: request.url,
        success: true,
        content,
        contentType,
        httpStatus,
        finalUrl,
        responseTime,
        contentLength,
        contentHash,
        userAgent: userAgent,
        redirectChain,
        scrapedAt: new Date()
      };

    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorHandler = HttpErrorHandler.handle(error);
      
      this.logger.error(`Scraping failed for ${request.url}: ${errorHandler.errorMessage}`);
      
      return this.createFailure(
        request, 
        errorHandler.errorMessage, 
        errorHandler.canRetry,
        errorHandler.httpStatus,
        responseTime
      );
    } finally {
      if (page) {
        await page.close();
      }
    }
  }

  private createFailure(
    request: ScrapeRequest,
    errorMessage: string,
    canRetry: boolean,
    httpStatus?: number,
    responseTime?: number
  ): ScrapeFailure {
    const failure: ScrapeFailure = {
      id: request.id,
      url: request.url,
      errorMessage,
      retryCount: request.retryCount || 0,
      maxRetries: this.retryCount,
      canRetry: canRetry && (request.retryCount || 0) < this.retryCount,
      httpStatus,
      failedAt: new Date()
    };

    this.logger.log(`Creating failure for ${request.url}: canRetry=${canRetry}, retryCount=${request.retryCount || 0}, maxRetries=${this.retryCount}`);
    
    return failure;
  }

  private async startConsumer(): Promise<void> {
    this.logger.log('Starting scrape request consumer...');
    
    try {
      // Set up proper concurrency with prefetch
      await this.rabbitMQClient.consume(
        QueueNames.SCRAPE_REQUESTS, 
        async (request: ScrapeRequest) => {
          this.logger.log(`Processing scrape request for ${request.url} (ID: ${request.id})`);
          
          try {
            const result = await this.scrapeUrl(request);
            
            if ('success' in result && result.success) {
              await this.rabbitMQClient.publish(QueueNames.SCRAPE_RESULTS, result);
              this.logger.log(`Successfully scraped ${request.url}`);
            } else {
              await this.rabbitMQClient.publish(QueueNames.SCRAPE_FAILURES, result);
              this.logger.warn(`Failed to scrape ${request.url}: ${(result as ScrapeFailure).errorMessage}`);
            }
          } catch (processingError) {
            this.logger.error(`Error processing scrape request for ${request.url}:`, processingError);
            
            // Create a failure result for processing errors
            const failure = this.createFailure(
              request,
              `Processing error: ${processingError.message}`,
              true
            );
            
            await this.rabbitMQClient.publish(QueueNames.SCRAPE_FAILURES, failure);
          }
        }
      );
      
      this.logger.log(`Scrape request consumer started with concurrency: ${this.concurrentScrapers}`);
    } catch (error) {
      this.logger.error('Failed to start consumer:', error);
      throw error;
    }
  }
}