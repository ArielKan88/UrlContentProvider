import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UrlFetchRequest, UrlFetchRequestDocument } from '../schemas/url-fetch-request.schema';
import { FetchStatus } from '../interfaces/scrape.interface';
import { UrlNormalizer } from '../utils/url-normalizer.util';

@Injectable()
export class UrlFetchRequestRepository {
  constructor(
    @InjectModel(UrlFetchRequest.name)
    private readonly model: Model<UrlFetchRequestDocument>
  ) {}

  async create(data: Partial<UrlFetchRequest>): Promise<UrlFetchRequestDocument> {
    const created = new this.model(data);
    return created.save();
  }

  async findById(id: string): Promise<UrlFetchRequest | null> {
    return this.model.findById(id).exec();
  }

  async findByUrl(url: string): Promise<UrlFetchRequest | null> {
    const normalizedUrl = UrlNormalizer.normalize(url);
    const canonicalUrl = UrlNormalizer.getCanonicalUrl(url);
    
    return this.model.findOne({ 
      $or: [
        { url },
        { url: canonicalUrl },
        { url: normalizedUrl },
        { url: `https://${normalizedUrl}` },
        { url: `http://${normalizedUrl}` }
      ]
    }).exec();
  }

  async findLatestByUrl(url: string): Promise<UrlFetchRequest | null> {
    const normalizedUrl = UrlNormalizer.normalize(url);
    const canonicalUrl = UrlNormalizer.getCanonicalUrl(url);
    
    return this.model
      .findOne({ 
        $or: [
          { url },
          { url: canonicalUrl },
          { url: normalizedUrl },
          { url: `https://${normalizedUrl}` },
          { url: `http://${normalizedUrl}` }
        ],
        status: FetchStatus.SUCCESS 
      })
      .sort({ fetchedAt: -1 })
      .exec();
  }

  async findAll(
    filter: any = {},
    limit: number = 50,
    offset: number = 0
  ): Promise<UrlFetchRequest[]> {
    return this.model
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(offset)
      .exec();
  }

  async update(
    id: string,
    data: Partial<UrlFetchRequest>
  ): Promise<UrlFetchRequest | null> {
    return this.model
      .findByIdAndUpdate(id, data, { new: true })
      .exec();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.model.findByIdAndDelete(id).exec();
    return !!result;
  }

  async getUrlHistory(url: string): Promise<UrlFetchRequest[]> {
    const normalizedUrl = UrlNormalizer.normalize(url);
    const canonicalUrl = UrlNormalizer.getCanonicalUrl(url);
    
    return this.model
      .find({ 
        $or: [
          { url },
          { url: canonicalUrl },
          { url: normalizedUrl },
          { url: `https://${normalizedUrl}` },
          { url: `http://${normalizedUrl}` }
        ]
      })
      .sort({ fetchedAt: -1 })
      .exec();
  }

  /**
   * Check for recent submissions OR successful fetches within the time window
   * Also checks if the URL appears in redirect chains of successful scrapes
   * This prevents duplicate submissions and respects the scrape interval
   */
  async getRecentByUrl(
    url: string,
    minutesAgo: number
  ): Promise<UrlFetchRequest | null> {
    const cutoffTime = new Date(Date.now() - minutesAgo * 60 * 1000);
    const normalizedUrl = UrlNormalizer.normalize(url);
    const canonicalUrl = UrlNormalizer.getCanonicalUrl(url);
    
    // Generate possible URL variations for matching
    const urlVariations = [
      url,
      canonicalUrl,
      normalizedUrl,
      `https://${normalizedUrl}`,
      `http://${normalizedUrl}`
    ];
    
    return this.model
      .findOne({
        $or: [
          // Direct URL matches
          {
            url: { $in: urlVariations },
            $or: [
              // Recent successful fetch
              { 
                fetchedAt: { $gte: cutoffTime },
                status: FetchStatus.SUCCESS
              },
              // Recent submission that's still pending or processing
              { 
                createdAt: { $gte: cutoffTime },
                status: { $in: [FetchStatus.PENDING, FetchStatus.PROCESSING] }
              }
            ]
          },
          // URL appears in redirect chain of recent successful scrapes
          {
            redirectChain: { $in: urlVariations },
            fetchedAt: { $gte: cutoffTime },
            status: FetchStatus.SUCCESS
          }
        ]
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Find pending requests that are older than the timeout period
   * Useful for cleanup and retry logic
   */
  async findStalePendingRequests(timeoutMinutes: number): Promise<UrlFetchRequest[]> {
    const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000);
    
    return this.model
      .find({
        status: FetchStatus.PENDING,
        createdAt: { $lt: cutoffTime }
      })
      .exec();
  }
}