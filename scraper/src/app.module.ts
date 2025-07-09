import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RabbitMQUtil } from './utils/rabbitmq.util';
import { ScraperService } from './services/scraper.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env']
    })
  ],
  providers: [
    ScraperService,
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
export class AppModule {}
