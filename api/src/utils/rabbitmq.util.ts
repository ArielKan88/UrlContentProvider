import * as amqp from 'amqplib';
import { QueueNames } from '../interfaces/scrape.interface';

export class RabbitMQUtil {
  private connection: any = null;
  private channel: any = null;

  async connect(url: string): Promise<void> {
    try {
      this.connection = await amqp.connect(url);
      this.channel = await this.connection.createChannel();
      
      // Set prefetch to enable proper load balancing across multiple workers
      await this.channel.prefetch(1);
      
      await this.setupQueues();
      
      // Handle connection errors
      this.connection.on('error', (err: any) => {
        console.error('RabbitMQ connection error:', err);
      });
      
      this.connection.on('close', () => {
        console.log('RabbitMQ connection closed');
      });
      
    } catch (error) {
      console.error('Failed to connect to RabbitMQ:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close();
      }
      if (this.connection) {
        await this.connection.close();
      }
    } catch (error) {
      console.error('Error disconnecting from RabbitMQ:', error);
    }
  }

  async publish<T>(queue: QueueNames, message: T): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ not connected');
    }

    try {
      const buffer = Buffer.from(JSON.stringify(message));
      const result = await this.channel.sendToQueue(queue, buffer, { 
        persistent: true,
        timestamp: Date.now()
      });
      
      if (!result) {
        throw new Error('Failed to publish message to queue');
      }
    } catch (error) {
      console.error(`Failed to publish message to queue ${queue}:`, error);
      throw error;
    }
  }

  async consume<T>(
    queue: QueueNames,
    handler: (message: T) => Promise<void>
  ): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ not connected');
    }

    try {
      await this.channel.consume(queue, async (msg: any) => {
        if (msg) {
          try {
            const content = JSON.parse(msg.content.toString());
            await handler(content);
            this.channel!.ack(msg);
          } catch (error) {
            console.error(`Error processing message from queue ${queue}:`, error);
            // Reject the message and don't requeue it to avoid infinite loops
            this.channel!.nack(msg, false, false);
          }
        }
      }, {
        noAck: false // Enable manual acknowledgment for reliability
      });
    } catch (error) {
      console.error(`Failed to start consumer for queue ${queue}:`, error);
      throw error;
    }
  }

  private async setupQueues(): Promise<void> {
    if (!this.channel) return;

    const queues = [
      QueueNames.SCRAPE_REQUESTS,
      QueueNames.SCRAPE_STARTED,
      QueueNames.SCRAPE_RESULTS,
      QueueNames.SCRAPE_FAILURES
    ];

    try {
      for (const queue of queues) {
        await this.channel.assertQueue(queue, { 
          durable: true,
          arguments: {
            // Optional: Set message TTL to prevent old messages from accumulating
            'x-message-ttl': 3600000 // 1 hour
          }
        });
      }
    } catch (error) {
      console.error('Failed to setup queues:', error);
      throw error;
    }
  }

  async getQueueInfo(queue: QueueNames): Promise<any> {
    if (!this.channel) {
      throw new Error('RabbitMQ not connected');
    }
    
    try {
      return await this.channel.checkQueue(queue);
    } catch (error) {
      console.error(`Failed to get info for queue ${queue}:`, error);
      throw error;
    }
  }
}