# Tech Challenge Fase 4 — Execution Service (`tech-challenge-fase4-execution-service`)

Microsserviço responsável pelo gerenciamento da **Fila de Execução e Produção da Oficina**, acompanhamento de etapas de diagnóstico e reparo em **banco de dados NoSQL (MongoDB)** e comunicação de conclusão ou falha crítica via **Saga Pattern Coreografado**.

- **Participante:** Vladmir Musa Costa Bravo (RM 374193)
- **Curso:** Pós-graduação em Arquitetura de Software — FIAP (SOAT)

---

## 1. Justificativa do Banco NoSQL (MongoDB — `execution_db`)

O `execution-service` utiliza **MongoDB (NoSQL orientado a documentos)** pela natureza semiestruturada e orientada a eventos do chão de oficina:
- Cada tarefa de execução (`execution_tasks`) armazena em um **único documento agregado** a lista de serviços, peças planejadas e um array dinâmico de etapas/apontamentos do mecânico (`steps: [{ stage, description, mechanicName, timestamp }]`).
- Leituras da fila priorizada (`IN_REPAIR > IN_DIAGNOSIS > QUEUED`) e gravações de progresso ocorrem com **baixa latência e sem necessidade de JOINs**.

---

## 2. Participação no Saga Pattern (Coreografado via RabbitMQ)

1. **Consumo de `os.execution.requested` / `payment.approved`:** Assim que o pagamento é confirmado e a OS entra em execução, o `execution-service` insere automaticamente o documento na coleção `execution_tasks` do MongoDB com status `QUEUED`.
2. **Evolução Interna (`IN_DIAGNOSIS` / `IN_REPAIR`):** O mecânico registra apontamentos na tarefa via `PATCH /api/executions/work-order/:workOrderId/progress`.
3. **Publicação de `execution.finished` (Fluxo Feliz):** Ao concluir os reparos (`PATCH /api/executions/work-order/:workOrderId/finish`), o serviço atualiza o documento no MongoDB para `COMPLETED` e publica `execution.finished`, permitindo que o `os-service` marque a OS como `FINISHED`.
4. **Publicação de `execution.failed` (Gatilho de Rollback Distribuído):** Caso ocorra falha técnica impeditiva (`PATCH /api/executions/work-order/:workOrderId/fail`), o documento é marcado como `FAILED` e o evento `execution.failed` é publicado no RabbitMQ:
   - O `billing-service` consome o evento e **estorna o pagamento no Mercado Pago (`REFUNDED`)**;
   - O `os-service` consome o evento, **devolve as peças reservadas ao estoque (`REVERSAL`)** e cancela a OS (`CANCELLED`).

---

## 3. Evidências de Testes e Cobertura (`> 80%`)

```text
PASS src/executions/executions.service.spec.ts
  ExecutionsService & MongoService (NoSQL)
    ✓ deve enfileirar uma OS na coleção NoSQL (MongoDB) via evento Saga os.execution.requested
    ✓ deve enfileirar via fallback de payment.approved se ainda não existir na fila
    ✓ deve ordenar a fila de execução por prioridade de status (IN_REPAIR > IN_DIAGNOSIS > QUEUED) e excluir COMPLETED/FAILED
    ✓ deve concluir a execução no MongoDB e publicar o evento Saga execution.finished
    ✓ deve registrar falha na execução e publicar o evento Saga execution.failed para acionar compensação/rollback
    ✓ deve validar erros ao buscar ou modificar execuções inexistentes ou já encerradas
    ✓ deve exercitar operações com driver de coleção MongoDB e canal RabbitMQ conectados

-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
-------------------|---------|----------|---------|---------|-------------------
All files          |   80.75 |    76.33 |      95 |    81.4 |                   
 database          |   80.32 |    80.76 |     100 |    80.7 | 68-86             
 executions        |   94.59 |    79.22 |     100 |    97.1 | 135-136           
 observability     |   85.71 |       75 |     100 |   84.21 | 25,33,42          
-------------------|---------|----------|---------|---------|-------------------
Test Suites: 1 passed, 1 total
Tests:       7 passed, 7 total
```

---

## 4. Principais Endpoints e Execução

- `GET /api/executions/queue` — Lista fila ativa ordenada por prioridade (`IN_REPAIR > IN_DIAGNOSIS > QUEUED` + FIFO)
- `GET /api/executions/work-order/:workOrderId` — Consulta documento NoSQL e histórico de apontamentos da OS
- `PATCH /api/executions/work-order/:workOrderId/progress` — Atualiza etapa/progresso do mecânico
- `PATCH /api/executions/work-order/:workOrderId/finish` — Finaliza reparo e publica `execution.finished`
- `PATCH /api/executions/work-order/:workOrderId/fail` — Registra falha crítica e publica `execution.failed` (Rollback Saga)
- **Swagger:** `http://localhost:3002/docs`

```bash
npm ci
npm run test:cov
npm run start:dev
```
