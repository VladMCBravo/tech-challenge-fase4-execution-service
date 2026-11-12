import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { MongoClient } from 'mongodb';

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

    // Com MONGODB_URI definido o serviço exige o MongoDB real: tenta conectar
    // algumas vezes (o banco pode ainda estar subindo no Kubernetes) e, se não
    // conseguir, falha o boot para o Kubernetes reiniciar o pod — sem cair
    // silenciosamente para memória.
    const maxAttempts = Number(process.env.MONGODB_CONNECT_ATTEMPTS ?? 10);
    const retryDelayMs = Number(process.env.MONGODB_RETRY_MS ?? 3000);
    const dbName = process.env.MONGODB_DATABASE ?? 'execution_db';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.client = new MongoClient(mongoUri, {
          serverSelectionTimeoutMS: 5000,
        });
        await this.client.connect();
        this.db = this.client.db(dbName);
        await this.db
          .collection('execution_tasks')
          .createIndex({ workOrderId: 1 }, { unique: true });
        await this.db
          .collection('execution_tasks')
          .createIndex({ status: 1, priority: 1, queuedAt: 1 });
        this.logger.log(`Conectado ao banco NoSQL MongoDB (${dbName}).`);
        return;
      } catch (error) {
        this.db = null;
        await this.client?.close().catch(() => undefined);
        this.client = null;
        this.logger.warn(
          `Falha ao conectar ao MongoDB (tentativa ${attempt}/${maxAttempts}): ${String(error)}`,
        );
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }

    throw new Error(
      `Não foi possível conectar ao MongoDB após ${maxAttempts} tentativas.`,
    );
  }

  isUsingMongo(): boolean {
    return this.db !== null;
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
