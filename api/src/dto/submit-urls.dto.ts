import { IsArray, IsUrl, ArrayNotEmpty, ArrayMaxSize } from 'class-validator';

export class SubmitUrlsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUrl({}, { each: true })
  urls: string[];
}

export class SubmitUrlsResponseDto {
  submitted: string[];
  skipped: SkippedUrl[];
  queued: string[];
}

export class SkippedUrl {
  url: string;
  reason: string;
  lastScrapedAt?: Date;
  nextAvailableAt?: Date;
}
