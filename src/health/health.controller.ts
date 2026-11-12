import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MongoService } from '../database/mongo.service';
import { RabbitMQService } from '../messaging/rabbitmq.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly mongo: MongoService,
    private readonly rabbitMQ: RabbitMQService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness probe do Execution Service' })
  liveness() {
    return {
      status: 'ok',
      service: 'execution-service',
      database: this.mongo.isUsingMongo() ? 'mongodb' : 'in-memory',
      messaging: this.rabbitMQ.getStatus(),
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe verificando conexão com o MongoDB NoSQL' })
  async readiness() {
    try {
      await this.mongo.ping();
      return {
        status: 'ready',
        database: this.mongo.isUsingMongo() ? 'mongodb-connected' : 'in-memory',
        messaging: this.rabbitMQ.getStatus(),
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        error: String(e),
      });
    }
  }
}
