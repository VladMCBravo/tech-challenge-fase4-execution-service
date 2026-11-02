import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  ExecutionStatus,
  ExecutionTaskDocument,
  MongoService,
} from '../database/mongo.service';
import { RabbitMQService } from '../messaging/rabbitmq.service';
import {
  OsExecutionRequestedPayload,
  PaymentApprovedPayload,
  SagaEventPattern,
} from '../messaging/saga-events.interface';
import { MetricsService } from '../observability/metrics.service';
import { CreateExecutionDto } from './dto/create-execution.dto';
import {
  FailExecutionDto,
  FinishExecutionDto,
  UpdateExecutionProgressDto,
} from './dto/update-execution.dto';

@Injectable()
export class ExecutionsService implements OnModuleInit {
  constructor(
    private readonly mongo: MongoService,
    private readonly metrics: MetricsService,
    @Optional() private readonly rabbitMQ?: RabbitMQService,
  ) {}

  onModuleInit() {
    if (!this.rabbitMQ) return;

    // 1. Escuta o evento do OS Service solicitando a execução da OS após aprovação do pagamento
    this.rabbitMQ.registerHandler(
      SagaEventPattern.OS_EXECUTION_REQUESTED,
      async (payload: OsExecutionRequestedPayload) => {
        await this.enqueueExecution({
          workOrderId: payload.workOrderId,
          workOrderCode: payload.workOrderCode,
          customerId: payload.customerId,
          vehicleId: payload.vehicleId,
          services: payload.services,
          parts: payload.parts,
        });
      },
    );

    // 2. Fallback: se receber diretamente payment.approved e a tarefa ainda não estiver na fila, enfileira
    this.rabbitMQ.registerHandler(
      SagaEventPattern.PAYMENT_APPROVED,
      async (payload: PaymentApprovedPayload) => {
        const existing = await this.mongo.findByWorkOrderId(
          payload.workOrderId,
        );
        if (!existing) {
          await this.enqueueExecution({
            workOrderId: payload.workOrderId,
            workOrderCode: `OS-${payload.workOrderId}`,
          });
        }
      },
    );
  }

  async enqueueExecution(
    dto: CreateExecutionDto,
  ): Promise<ExecutionTaskDocument> {
    const existing = await this.mongo.findByWorkOrderId(dto.workOrderId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const doc: ExecutionTaskDocument = {
      _id: `exec_${dto.workOrderId}_${Date.now()}`,
      workOrderId: dto.workOrderId,
      workOrderCode: dto.workOrderCode,
      customerId: dto.customerId,
      vehicleId: dto.vehicleId,
      status: ExecutionStatus.QUEUED,
      priority: dto.priority ?? 2,
      mechanicName: null,
      diagnosisNotes: null,
      repairNotes: null,
      failureReason: null,
      services: dto.services ?? [],
      parts: dto.parts ?? [],
      steps: [
        {
          stage: ExecutionStatus.QUEUED,
          description:
            'Ordem de Serviço recebida na fila de execução/produção (MongoDB NoSQL)',
          timestamp: now,
        },
      ],
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    };

    const created = await this.mongo.insertTask(doc);
    this.metrics.increment('oficina.execution.queued');
    return created;
  }

  /**
   * Retorna a fila de execução ordenada por criticidade de status:
   * IN_REPAIR > IN_DIAGNOSIS > QUEUED e mais antigas primeiro (FIFO dentro da prioridade).
   * Exclui tarefas já COMPLETED ou FAILED da fila ativa.
   */
  async listQueue(): Promise<ExecutionTaskDocument[]> {
    const all = await this.mongo.findAll();
    const active = all.filter(
      (task) =>
        task.status !== ExecutionStatus.COMPLETED &&
        task.status !== ExecutionStatus.FAILED,
    );

    const statusWeight: Record<string, number> = {
      [ExecutionStatus.IN_REPAIR]: 1,
      [ExecutionStatus.IN_DIAGNOSIS]: 2,
      [ExecutionStatus.QUEUED]: 3,
    };

    return active.sort((a, b) => {
      const wA = statusWeight[a.status] ?? 99;
      const wB = statusWeight[b.status] ?? 99;
      if (wA !== wB) return wA - wB;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime();
    });
  }

  async findAll(): Promise<ExecutionTaskDocument[]> {
    return this.mongo.findAll();
  }

  async findByWorkOrder(workOrderId: string): Promise<ExecutionTaskDocument> {
    const task = await this.mongo.findByWorkOrderId(workOrderId);
    if (!task) {
      throw new NotFoundException(
        'Execução não encontrada para esta Ordem de Serviço.',
      );
    }
    return task;
  }

  async updateProgress(
    workOrderId: string,
    dto: UpdateExecutionProgressDto,
  ): Promise<ExecutionTaskDocument> {
    const task = await this.findByWorkOrder(workOrderId);

    if (
      task.status === ExecutionStatus.COMPLETED ||
      task.status === ExecutionStatus.FAILED
    ) {
      throw new BadRequestException(
        'Não é possível atualizar o progresso de uma execução já finalizada ou falha.',
      );
    }

    const nextStatus =
      dto.stage === 'IN_DIAGNOSIS'
        ? ExecutionStatus.IN_DIAGNOSIS
        : ExecutionStatus.IN_REPAIR;

    const now = new Date().toISOString();
    const updatedSteps = [
      ...task.steps,
      {
        stage: nextStatus,
        description: dto.notes,
        mechanicName: dto.mechanicName ?? task.mechanicName ?? 'Mecânico',
        timestamp: now,
      },
    ];

    const updated = await this.mongo.updateByWorkOrderId(workOrderId, {
      status: nextStatus,
      mechanicName: dto.mechanicName ?? task.mechanicName,
      diagnosisNotes:
        nextStatus === ExecutionStatus.IN_DIAGNOSIS
          ? dto.notes
          : task.diagnosisNotes,
      repairNotes:
        nextStatus === ExecutionStatus.IN_REPAIR ? dto.notes : task.repairNotes,
      startedAt: task.startedAt ?? now,
      steps: updatedSteps,
    });

    this.metrics.workOrderStatusChanged(nextStatus);
    return updated!;
  }

  async finishExecution(
    workOrderId: string,
    dto?: FinishExecutionDto,
  ): Promise<ExecutionTaskDocument> {
    const task = await this.findByWorkOrder(workOrderId);

    if (
      task.status === ExecutionStatus.COMPLETED ||
      task.status === ExecutionStatus.FAILED
    ) {
      throw new BadRequestException(
        'Esta execução já foi concluída ou cancelada por falha.',
      );
    }

    const now = new Date().toISOString();
    const updatedSteps = [
      ...task.steps,
      {
        stage: ExecutionStatus.COMPLETED,
        description:
          dto?.notes ?? 'Execução e reparos concluídos com sucesso na oficina',
        mechanicName: dto?.mechanicName ?? task.mechanicName ?? 'Mecânico',
        timestamp: now,
      },
    ];

    const updated = await this.mongo.updateByWorkOrderId(workOrderId, {
      status: ExecutionStatus.COMPLETED,
      mechanicName: dto?.mechanicName ?? task.mechanicName,
      repairNotes: dto?.notes ?? task.repairNotes,
      startedAt: task.startedAt ?? now,
      finishedAt: now,
      steps: updatedSteps,
    });

    const startMs = new Date(task.startedAt ?? task.queuedAt).getTime();
    const durationSec = (new Date(now).getTime() - startMs) / 1000;
    this.metrics.workOrderStageDuration('execucao', durationSec);
    this.metrics.workOrderStatusChanged(ExecutionStatus.COMPLETED);

    // Comunica finalização ao OS Service via Saga Event
    await this.rabbitMQ?.publish(SagaEventPattern.EXECUTION_FINISHED, {
      event: SagaEventPattern.EXECUTION_FINISHED,
      workOrderId,
      executionId: updated!._id,
      notes: dto?.notes,
      finishedAt: now,
    });

    return updated!;
  }

  /**
   * Caso ocorra falha grave durante diagnóstico ou reparo, marca a execução como FAILED
   * e publica o evento execution.failed para acionar o Rollback/Compensação da Saga:
   * - Billing Service estorna o pagamento (REFUNDED)
   * - OS Service estorna o estoque (REVERSAL) e cancela a OS (CANCELLED)
   */
  async failExecution(
    workOrderId: string,
    dto: FailExecutionDto,
  ): Promise<ExecutionTaskDocument> {
    const task = await this.findByWorkOrder(workOrderId);

    if (task.status === ExecutionStatus.COMPLETED) {
      throw new BadRequestException(
        'Não é possível marcar falha em uma execução já concluída.',
      );
    }

    const now = new Date().toISOString();
    const updatedSteps = [
      ...task.steps,
      {
        stage: ExecutionStatus.FAILED,
        description: `FALHA: ${dto.reason}`,
        mechanicName: dto.mechanicName ?? task.mechanicName ?? 'Mecânico',
        timestamp: now,
      },
    ];

    const updated = await this.mongo.updateByWorkOrderId(workOrderId, {
      status: ExecutionStatus.FAILED,
      mechanicName: dto.mechanicName ?? task.mechanicName,
      failureReason: dto.reason,
      finishedAt: now,
      steps: updatedSteps,
    });

    this.metrics.integrationError('execution_failed');

    await this.rabbitMQ?.publish(SagaEventPattern.EXECUTION_FAILED, {
      event: SagaEventPattern.EXECUTION_FAILED,
      workOrderId,
      executionId: updated!._id,
      reason: dto.reason,
      failedAt: now,
    });

    return updated!;
  }
}
