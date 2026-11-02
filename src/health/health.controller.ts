import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MongoService } from '../database/mongo.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly mongo: MongoService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness probe do Execution Service' })
  liveness() {
    return {
      status: 'ok',
      service: 'execution-service',
      database: 'mongodb-nosql',
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
        database: 'mongodb-connected',
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
