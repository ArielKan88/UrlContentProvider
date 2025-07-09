import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { FetchStatus } from '../interfaces/scrape.interface';

export type UrlFetchRequestDocument = UrlFetchRequest & Document & { _id: any };

@Schema({ timestamps: true })
export class UrlFetchRequest {
  @Prop({ required: true, index: true })
  url: string;

  @Prop({ 
    required: true, 
    enum: Object.values(FetchStatus),
    default: FetchStatus.PENDING,
    index: true
  })
  status: FetchStatus;

  @Prop()
  content?: string;

  @Prop()
  contentType?: string;

  @Prop({ index: true })
  httpStatus?: number;

  @Prop()
  errorMessage?: string;

  @Prop()
  finalUrl?: string;

  @Prop()
  responseTime?: number;

  @Prop()
  contentLength?: number;

  @Prop()
  contentHash?: string;

  @Prop()
  userAgent?: string;

  @Prop({ type: [String], default: [] })
  redirectChain: string[];

  @Prop({ default: 0 })
  retryCount: number;

  @Prop({ index: true })
  fetchedAt?: Date;

  @Prop()
  lastScrapedAt?: Date;

  @Prop({ index: true })
  createdAt?: Date;

  @Prop()
  updatedAt?: Date;
}

export const UrlFetchRequestSchema = SchemaFactory.createForClass(UrlFetchRequest);

UrlFetchRequestSchema.index({ url: 1, status: 1 });
UrlFetchRequestSchema.index({ fetchedAt: -1 });
UrlFetchRequestSchema.index({ httpStatus: 1, status: 1 });
UrlFetchRequestSchema.index({ 'redirectChain': 1 }); // Index redirect chain for efficiency
