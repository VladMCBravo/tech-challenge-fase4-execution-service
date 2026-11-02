import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

export interface ExecutionStepDocument {
  stage: string;
  description: string;
  mechanicName?: string;
  timestamp: string;
}

export enum ExecutionStatus {
  QUEUED = 'QUEUED',
  IN_DIAGNOSIS = 'IN_DIAGNOSIS',
  IN_REPAIR = 'IN_REPAIR',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export interface ExecutionTaskDocument {
  _id: string;
  workOrderId: string;
  workOrderCode: string;
  customerId?: string;
  vehicleId?: string;
  status: ExecutionStatus;
  priority: number;
  mechanicName?: string | null;
  diagnosisNotes?: string | null;
  repairNotes?: string | null;
  failureReason?: string | null;
  services: Array<{
    serviceId: string;
    description: string;
    quantity: number;
    estimatedTimeMinutes?: number | null;
  }>;
  parts: Array<{
    inventoryItemId: string;
    plannedQuantity: number;
  }>;
  steps: ExecutionStepDocument[];
  queuedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt: string;
}

@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MongoService.name);
  private client: any = null;
  private db: any = null;
  private readonly inMemoryStore = new Map<string, ExecutionTaskDocument>();

  async onModuleInit() {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri || process.env.NODE_ENV === 'test') {
      this.logger.log(
        'MongoDB NoSQL operando em modo documento in-memory (MONGODB_URI não definido ou ambiente de teste).',
      );
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MongoClient } = require('mongodb');
      this.client = new MongoClient(mongoUri);
      await this.client.connect();
      const dbName = process.env.MONGODB_DATABASE ?? 'execution_db';
      this.db = this.client.db(dbName);
      await this.db
        .collection('execution_tasks')
        .createIndex({ workOrderId: 1 }, { unique: true });
      await this.db
        .collection('execution_tasks')
        .createIndex({ status: 1, priority: 1, queuedAt: 1 });
      this.logger.log(`Conectado ao banco NoSQL MongoDB (${dbName}).`);
    } catch (error) {
      this.logger.warn(
        `Não foi possível conectar ao MongoDB (${String(error)}). Usando coleção NoSQL em memória.`,
      );
      this.db = null;
    }
  }

  async ping(): Promise<boolean> {
    if (this.db) {
      await this.db.command({ ping: 1 });
    }
    return true;
  }

  async insertTask(doc: ExecutionTaskDocument): Promise<ExecutionTaskDocument> {
    if (this.db) {
      await this.db.collection('execution_tasks').insertOne({ ...doc });
      return doc;
    }
    this.inMemoryStore.set(doc.workOrderId, { ...doc });
    return doc;
  }

  async findByWorkOrderId(
    workOrderId: string,
  ): Promise<ExecutionTaskDocument | null> {
    if (this.db) {
      return this.db
        .collection('execution_tasks')
        .findOne({ workOrderId }) as Promise<ExecutionTaskDocument | null>;
    }
    return this.inMemoryStore.get(workOrderId) ?? null;
  }

  async findById(id: string): Promise<ExecutionTaskDocument | null> {
    if (this.db) {
      return this.db
        .collection('execution_tasks')
        .findOne({ _id: id }) as Promise<ExecutionTaskDocument | null>;
    }
    for (const doc of this.inMemoryStore.values()) {
      if (doc._id === id) return doc;
    }
    return null;
  }

  async findAll(): Promise<ExecutionTaskDocument[]> {
    if (this.db) {
      return this.db
        .collection('execution_tasks')
        .find({})
        .toArray() as Promise<ExecutionTaskDocument[]>;
    }
    return Array.from(this.inMemoryStore.values());
  }

  async updateByWorkOrderId(
    workOrderId: string,
    patch: Partial<ExecutionTaskDocument>,
  ): Promise<ExecutionTaskDocument | null> {
    const existing = await this.findByWorkOrderId(workOrderId);
    if (!existing) return null;

    const updated: ExecutionTaskDocument = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    if (this.db) {
      await this.db
        .collection('execution_tasks')
        .updateOne({ workOrderId }, { $set: updated });
      return updated;
    }

    this.inMemoryStore.set(workOrderId, updated);
    return updated;
  }

  async clearAll(): Promise<void> {
    this.inMemoryStore.clear();
  }

  async onModuleDestroy() {
    try {
      await this.client?.close();
    } catch {
      // ignora erro ao fechar conexão
    }
  }
}
