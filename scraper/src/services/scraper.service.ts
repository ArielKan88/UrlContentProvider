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
    this.timeout = this.configService.get<number>('PUPPETEER_TIMEOUT', 15000); // Reduced from 60s to 15s
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
      
      // Performance optimizations
      await page.setUserAgent(userAgent);
      await page.setViewport({ width: 1920, height: 1080 });
      
      // Disable images and CSS for faster loading (optional)
      const disableImages = this.configService.get<boolean>('DISABLE_IMAGES', true);
      const disableCSS = this.configService.get<boolean>('DISABLE_CSS', false);
      
      if (disableImages || disableCSS) {
        await page.setRequestInterception(true);
        
        page.on('request', (req) => {
          const resourceType = req.resourceType();
          
          if (disableImages && ['image', 'stylesheet', 'font'].includes(resourceType)) {
            req.abort();
          } else if (disableCSS && resourceType === 'stylesheet') {
            req.abort();
          } else {
            req.continue();
          }
        });
      }
      
      // Try multiple wait strategies for better compatibility
      const waitStrategy = this.configService.get<string>('WAIT_STRATEGY', 'fast');
      let waitUntil: any;
      
      switch (waitStrategy) {
        case 'comprehensive':
          waitUntil = 'networkidle2'; // Slow but thorough
          break;
        case 'moderate':
          waitUntil = 'networkidle0'; // Faster than networkidle2
          break;
        case 'basic':
          waitUntil = 'load'; // Wait for load event
          break;
        case 'fast':
        default:
          waitUntil = 'domcontentloaded'; // Fastest - just wait for DOM
          break;
      }
      
      this.logger.log(`🚀 Starting scrape: ${request.url} (strategy: ${waitStrategy}, timeout: ${this.timeout}ms)`);
      const navigationStart = Date.now();
      
      const response = await page.goto(request.url, {
        waitUntil,
        timeout: this.timeout
      });
      
      const navigationTime = Date.now() - navigationStart;
      this.logger.log(`📄 Navigation completed for ${request.url} in ${navigationTime}ms`);

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

      // Additional wait for dynamic content if needed
      const waitForDynamic = this.configService.get<number>('DYNAMIC_WAIT_MS', 0);
      if (waitForDynamic > 0) {
        this.logger.log(`⏳ Waiting ${waitForDynamic}ms for dynamic content...`);
        await page.waitForTimeout(waitForDynamic);
      }

      const contentStart = Date.now();
      const content = await page.content();
      const contentTime = Date.now() - contentStart;
      
      const contentType = response.headers()['content-type'] || 'text/html';
      const contentLength = Buffer.byteLength(content, 'utf8');
      const contentHash = createHash('sha256').update(content).digest('hex');
      const totalResponseTime = Date.now() - startTime;

      this.logger.log(`✅ Scraped ${request.url}: ${contentLength} bytes in ${totalResponseTime}ms (nav: ${navigationTime}ms, content: ${contentTime}ms)`);

      return {
        id: request.id,
        url: request.url,
        success: true,
        content,
        contentType,
        httpStatus,
        finalUrl,
        responseTime: totalResponseTime,
        contentLength,
        contentHash,
        userAgent: userAgent,
        redirectChain,
        scrapedAt: new Date()
      };

    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorHandler = HttpErrorHandler.handle(error);
      
      this.logger.error(`❌ Scraping failed for ${request.url} after ${responseTime}ms: ${errorHandler.errorMessage}`);
      
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