import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateExecutionDto } from './dto/create-execution.dto';
import {
  FailExecutionDto,
  FinishExecutionDto,
  UpdateExecutionProgressDto,
} from './dto/update-execution.dto';
import { ExecutionsService } from './executions.service';

@ApiTags('Executions & Production Queue (MongoDB NoSQL)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('executions')
export class ExecutionsController {
  constructor(private readonly executionsService: ExecutionsService) {}

  @Post()
  @ApiOperation({
    summary: 'Enfileira uma Ordem de Serviço na fila de execução (MongoDB NoSQL)',
  })
  enqueue(@Body() dto: CreateExecutionDto) {
    return this.executionsService.enqueueExecution(dto);
  }

  @Get('queue')
  @ApiOperation({
    summary:
      'Lista a fila ativa de execução ordenada por prioridade (IN_REPAIR > IN_DIAGNOSIS > QUEUED e FIFO)',
  })
  listQueue() {
    return this.executionsService.listQueue();
  }

  @Get()
  @ApiOperation({
    summary: 'Lista histórico completo de execuções no banco NoSQL MongoDB',
  })
  findAll() {
    return this.executionsService.findAll();
  }

  @Get('work-order/:workOrderId')
  @ApiOperation({
    summary: 'Consulta o documento de execução e logs de etapas pelo ID da OS',
  })
  findByWorkOrder(@Param('workOrderId') workOrderId: string) {
    return this.executionsService.findByWorkOrder(workOrderId);
  }

  @Patch('work-order/:workOrderId/progress')
  @ApiOperation({
    summary:
      'Atualiza o status e adiciona etapa de diagnóstico ou reparo na execução da OS',
  })
  updateProgress(
    @Param('workOrderId') workOrderId: string,
    @Body() dto: UpdateExecutionProgressDto,
  ) {
    return this.executionsService.updateProgress(workOrderId, dto);
  }

  @Patch('work-order/:workOrderId/finish')
  @ApiOperation({
    summary:
      'Conclui a execução da OS no MongoDB e publica evento Saga execution.finished para o OS Service',
  })
  finish(
    @Param('workOrderId') workOrderId: string,
    @Body() dto?: FinishExecutionDto,
  ) {
    return this.executionsService.finishExecution(workOrderId, dto);
  }

  @Patch('work-order/:workOrderId/fail')
  @ApiOperation({
    summary:
      'Registra falha na execução e publica evento Saga execution.failed (aciona Rollback no Billing e OS Service)',
  })
  fail(
    @Param('workOrderId') workOrderId: string,
    @Body() dto: FailExecutionDto,
  ) {
    return this.executionsService.failExecution(workOrderId, dto);
  }
}
