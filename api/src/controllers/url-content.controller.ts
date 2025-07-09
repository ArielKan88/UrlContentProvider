import {
  Controller,
  Post,
  Get,
  Query,
  Param,
  Body,
  HttpStatus,
  HttpException,
  BadRequestException,
  NotFoundException
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiParam } from '@nestjs/swagger';
import { UrlContentService } from '../services/url-content.service';
import { SubmitUrlsDto, SubmitUrlsResponseDto } from '../dto/submit-urls.dto';
import { FetchStatus } from '../interfaces/scrape.interface';
import { UrlFetchRequest } from '../schemas/url-fetch-request.schema';

@ApiTags('URL Content')
@Controller('api/url-content')
export class UrlContentController {
  constructor(private readonly urlContentService: UrlContentService) {}

  @Post()
  @ApiOperation({ summary: 'Submit URLs for scraping' })
  @ApiResponse({ status: 200, description: 'URLs submitted successfully', type: SubmitUrlsResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid URL format or empty array' })
  async submitUrls(@Body() submitUrlsDto: SubmitUrlsDto): Promise<SubmitUrlsResponseDto> {
    if (!submitUrlsDto.urls || submitUrlsDto.urls.length === 0) {
      throw new BadRequestException('URLs array cannot be empty');
    }

    return this.urlContentService.submitUrls(submitUrlsDto.urls);
  }

  @Get()
  @ApiOperation({ summary: 'Get all results (debug)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Limit results (default: 50, max: 200)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Offset for pagination (default: 0)' })
  @ApiResponse({ status: 200, description: 'All results retrieved', type: [UrlFetchRequest] })
  async getAllResults(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ): Promise<UrlFetchRequest[]> {
    const parsedLimit = Math.min(parseInt(limit || '50'), 200);
    const parsedOffset = Math.max(parseInt(offset || '0'), 0);

    if (isNaN(parsedLimit) || isNaN(parsedOffset)) {
      throw new BadRequestException('Invalid limit or offset parameters');
    }

    return this.urlContentService.getAllResults({}, parsedLimit, parsedOffset);
  }

  @Get('by-url')
  @ApiOperation({ summary: 'Get scraping history for a specific URL' })
  @ApiQuery({ name: 'url', required: true, description: 'The URL to get scraping history for' })
  @ApiResponse({ status: 200, description: 'URL scraping history', type: 'ScrapingHistoryResponse' })
  async getUrlHistory(@Query('url') url: string): Promise<any> {
    if (!url) {
      throw new BadRequestException('URL parameter is required');
    }

    const history = await this.urlContentService.getUrlHistory(url);
    
    return {
      url,
      totalScrapes: history.length,
      scrapes: history.map(item => ({
        id: (item as any)._id.toString(),
        status: item.status,
        scrapedAt: item.fetchedAt || item.createdAt,
        httpStatus: item.httpStatus,
        contentLength: item.contentLength,
        errorMessage: item.errorMessage
      }))
    };
  }

  @Get('latest')
  @ApiOperation({ summary: 'Get latest successful result for URL' })
  @ApiQuery({ name: 'url', required: true, description: 'The URL to get latest result for' })
  @ApiResponse({ status: 200, description: 'Latest result found', type: UrlFetchRequest })
  @ApiResponse({ status: 404, description: 'No successful results found for URL' })
  async getLatestByUrl(@Query('url') url: string): Promise<UrlFetchRequest> {
    if (!url) {
      throw new BadRequestException('URL parameter is required');
    }

    const result = await this.urlContentService.getLatestByUrl(url);
    if (!result) {
      throw new NotFoundException(`No successful results found for URL: ${url}`);
    }

    return result;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get specific scrape result by ID' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId of the scrape result' })
  @ApiResponse({ status: 200, description: 'Scrape result found', type: UrlFetchRequest })
  @ApiResponse({ status: 404, description: 'Scrape result not found' })
  async getResult(@Param('id') id: string): Promise<UrlFetchRequest> {
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      throw new BadRequestException('Invalid ID format');
    }

    const result = await this.urlContentService.getResult(id);
    if (!result) {
      throw new NotFoundException(`Scrape result not found with ID: ${id}`);
    }

    return result;
  }

  @Post('fix-inconsistencies')
  @ApiOperation({ summary: 'Fix data inconsistencies (admin endpoint)' })
  @ApiResponse({ status: 200, description: 'Data inconsistencies fixed' })
  async fixDataInconsistencies(): Promise<{ fixed: number; message: string }> {
    const fixed = await this.urlContentService.fixDataInconsistencies();
    return {
      fixed,
      message: `Fixed ${fixed} data inconsistencies`
    };
  }
}
