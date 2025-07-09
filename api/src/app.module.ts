import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { RabbitMQUtil } from './utils/rabbitmq.util';
import { UrlContentController } from './controllers/url-content.controller';
import { UrlContentService } from './services/url-content.service';
import { UrlFetchRequestRepository } from './repositories/url-fetch-request.repository';
import { UrlFetchRequest, UrlFetchRequestSchema } from './schemas/url-fetch-request.schema';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env']
    }),
    MongooseModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URL', 'mongodb://localhost:27017/url-content-provider')
      }),
      inject: [ConfigService]
    }),
    MongooseModule.forFeature([
      { name: UrlFetchRequest.name, schema: UrlFetchRequestSchema }
    ])
  ],
  controllers: [UrlContentController],
  providers: [
    UrlContentService,
    UrlFetchRequestRepository,
    {
      provide: RabbitMQUtil,
      useFactory: async (configService: ConfigService) => {
        const client = new RabbitMQUtil();
        const rabbitmqUrl = configService.get<string>('RABBITMQ_URL', 'amqp://localhost:5672');
        await client.connect(rabbitmqUrl);
        return client;
      },
      inject: [ConfigService]
    }
  ]
})
export class AppModule implements OnModuleInit {
  constructor(
    private readonly urlContentService: UrlContentService
  ) {}

  async onModuleInit(): Promise<void> {
    await this.urlContentService.startConsumers();
  }
}
