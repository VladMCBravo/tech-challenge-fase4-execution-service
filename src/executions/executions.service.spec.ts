import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionStatus, MongoService } from '../database/mongo.service';
import { RabbitMQService } from '../messaging/rabbitmq.service';
import { SagaEventPattern } from '../messaging/saga-events.interface';
import { MetricsService } from '../observability/metrics.service';
import { ExecutionsService } from './executions.service';

describe('ExecutionsService & MongoService (NoSQL)', () => {
  let service: ExecutionsService;
  let mongo: MongoService;
  let rabbitMQ: RabbitMQService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutionsService,
        MongoService,
        RabbitMQService,
        MetricsService,
      ],
    }).compile();

    service = module.get<ExecutionsService>(ExecutionsService);
    mongo = module.get<MongoService>(MongoService);
    rabbitMQ = module.get<RabbitMQService>(RabbitMQService);

    await mongo.onModuleInit();
    await mongo.clearAll();
    await rabbitMQ.onModuleInit();
    service.onModuleInit();
  });

  it('deve enfileirar uma OS na coleção NoSQL (MongoDB) via evento Saga os.execution.requested', async () => {
    await rabbitMQ.dispatchEvent(SagaEventPattern.OS_EXECUTION_REQUESTED, {
      event: SagaEventPattern.OS_EXECUTION_REQUESTED,
      workOrderId: 'wo-100',
      workOrderCode: 'OS-100',
      customerId: 'c-1',
      vehicleId: 'v-1',
      services: [
        {
          serviceId: 's-1',
          description: 'Alinhamento e Balanceamento',
          quantity: 1,
          estimatedTimeMinutes: 60,
        },
      ],
      parts: [
        {
          inventoryItemId: 'p-1',
          plannedQuantity: 2,
        },
      ],
      timestamp: new Date().toISOString(),
    });

    const doc = await service.findByWorkOrder('wo-100');
    expect(doc.workOrderCode).toBe('OS-100');
    expect(doc.status).toBe(ExecutionStatus.QUEUED);
    expect(doc.services).toHaveLength(1);
    expect(doc.parts).toHaveLength(1);
    expect(doc.steps).toHaveLength(1);

    // Idempotência: chamar enqueueExecution novamente retorna o mesmo documento
    const duplicate = await service.enqueueExecution({
      workOrderId: 'wo-100',
      workOrderCode: 'OS-100',
    });
    expect(duplicate._id).toBe(doc._id);
  });

  it('deve enfileirar via fallback de payment.approved se ainda não existir na fila', async () => {
    await rabbitMQ.dispatchEvent(SagaEventPattern.PAYMENT_APPROVED, {
      event: SagaEventPattern.PAYMENT_APPROVED,
      workOrderId: 'wo-200',
      budgetId: 'b-200',
      totalAmount: 300,
      approvedAt: new Date().toISOString(),
    });

    const doc = await service.findByWorkOrder('wo-200');
    expect(doc.workOrderId).toBe('wo-200');
    expect(doc.status).toBe(ExecutionStatus.QUEUED);
  });

  it('deve ordenar a fila de execução por prioridade de status (IN_REPAIR > IN_DIAGNOSIS > QUEUED) e excluir COMPLETED/FAILED', async () => {
    await service.enqueueExecution({
      workOrderId: 'wo-queued',
      workOrderCode: 'OS-Q',
      priority: 2,
    });
    await service.enqueueExecution({
      workOrderId: 'wo-diag',
      workOrderCode: 'OS-D',
      priority: 2,
    });
    await service.enqueueExecution({
      workOrderId: 'wo-repair',
      workOrderCode: 'OS-R',
      priority: 2,
    });
    await service.enqueueExecution({
      workOrderId: 'wo-done',
      workOrderCode: 'OS-DONE',
      priority: 1,
    });

    await service.updateProgress('wo-diag', {
      stage: 'IN_DIAGNOSIS',
      mechanicName: 'Marcos',
      notes: 'Analisando motor',
    });

    await service.updateProgress('wo-repair', {
      stage: 'IN_REPAIR',
      mechanicName: 'Pedro',
      notes: 'Trocando correia dentada',
    });

    await service.finishExecution('wo-done', {
      mechanicName: 'Ana',
      notes: 'Finalizado',
    });

    const queue = await service.listQueue();
    expect(queue).toHaveLength(3);
    expect(queue[0].workOrderId).toBe('wo-repair');
    expect(queue[1].workOrderId).toBe('wo-diag');
    expect(queue[2].workOrderId).toBe('wo-queued');

    const all = await service.findAll();
    expect(all).toHaveLength(4);
  });

  it('deve concluir a execução no MongoDB e publicar o evento Saga execution.finished', async () => {
    await service.enqueueExecution({
      workOrderId: 'wo-finish',
      workOrderCode: 'OS-FIN',
    });

    await service.updateProgress('wo-finish', {
      stage: 'IN_REPAIR',
      mechanicName: 'Carlos',
      notes: 'Substituindo amortecedores',
    });

    const completed = await service.finishExecution('wo-finish', {
      mechanicName: 'Carlos',
      notes: 'Teste de rodagem aprovado',
    });

    expect(completed.status).toBe(ExecutionStatus.COMPLETED);
    expect(completed.finishedAt).toBeDefined();
    expect(completed.steps).toHaveLength(3);

    const events = rabbitMQ.getPublishedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].pattern).toBe(SagaEventPattern.EXECUTION_FINISHED);
    expect(events[0].payload.workOrderId).toBe('wo-finish');
  });

  it('deve registrar falha na execução e publicar o evento Saga execution.failed para acionar compensação/rollback', async () => {
    await service.enqueueExecution({
      workOrderId: 'wo-fail',
      workOrderCode: 'OS-FAIL',
    });

    const failed = await service.failExecution('wo-fail', {
      mechanicName: 'Roberto',
      reason: 'Chassi comprometido impossibilitando reparo seguro',
    });

    expect(failed.status).toBe(ExecutionStatus.FAILED);
    expect(failed.failureReason).toContain('Chassi comprometido');

    const events = rabbitMQ.getPublishedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].pattern).toBe(SagaEventPattern.EXECUTION_FAILED);
    expect(events[0].payload.workOrderId).toBe('wo-fail');
    expect(events[0].payload.reason).toContain('Chassi comprometido');
  });

  it('deve validar erros ao buscar ou modificar execuções inexistentes ou já encerradas', async () => {
    await expect(service.findByWorkOrder('inexistente')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const created = await service.enqueueExecution({
      workOrderId: 'wo-closed',
      workOrderCode: 'OS-CLOSED',
    });
    expect((await mongo.findById(created._id))?.workOrderId).toBe('wo-closed');
    expect(await mongo.findById('missing-id')).toBeNull();
    expect(await mongo.ping()).toBe(true);

    await service.finishExecution('wo-closed');

    await expect(
      service.updateProgress('wo-closed', { notes: 'Tentativa inválida' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(service.finishExecution('wo-closed')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    await expect(
      service.failExecution('wo-closed', { reason: 'Erro' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const metrics = new MetricsService();
    metrics.workOrderCreated();
    metrics.gauge('oficina.execution.active', 2);
    rabbitMQ.clearPublishedEvents();
    await rabbitMQ.onModuleDestroy();
    await mongo.onModuleDestroy();
  });

  it('deve exercitar operações com driver de coleção MongoDB e canal RabbitMQ conectados', async () => {
    const collectionMock = {
      insertOne: jest.fn().mockResolvedValue({ acknowledged: true }),
      findOne: jest.fn().mockResolvedValue({
        _id: 'exec-db-1',
        workOrderId: 'wo-db-1',
        workOrderCode: 'OS-DB-1',
        status: ExecutionStatus.QUEUED,
        priority: 1,
        services: [],
        parts: [],
        steps: [],
        queuedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };

    (mongo as any).db = {
      command: jest.fn().mockResolvedValue({ ok: 1 }),
      collection: jest.fn().mockReturnValue(collectionMock),
    };

    const channelMock = {
      publish: jest.fn().mockReturnValue(true),
      close: jest.fn().mockResolvedValue(undefined),
    };
    (rabbitMQ as any).channel = channelMock;

    await mongo.ping();
    await mongo.insertTask({
      _id: 'exec-db-1',
      workOrderId: 'wo-db-1',
      workOrderCode: 'OS-DB-1',
      status: ExecutionStatus.QUEUED,
      priority: 1,
      services: [],
      parts: [],
      steps: [],
      queuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await mongo.findByWorkOrderId('wo-db-1');
    await mongo.findById('exec-db-1');
    await mongo.findAll();
    await mongo.updateByWorkOrderId('wo-db-1', {
      status: ExecutionStatus.IN_REPAIR,
    });
    await rabbitMQ.publish(SagaEventPattern.EXECUTION_FINISHED, {
      workOrderId: 'wo-db-1',
    });

    expect(collectionMock.insertOne).toHaveBeenCalled();
    expect(collectionMock.updateOne).toHaveBeenCalled();
    expect(channelMock.publish).toHaveBeenCalled();
  });
});
