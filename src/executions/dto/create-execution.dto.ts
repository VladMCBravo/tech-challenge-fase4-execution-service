import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateExecutionDto {
  @ApiProperty({ example: 'wo-123' })
  @IsString()
  workOrderId: string;

  @ApiProperty({ example: 'OS-17100000' })
  @IsString()
  workOrderCode: string;

  @ApiPropertyOptional({ example: 'customer-123' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ example: 'vehicle-123' })
  @IsOptional()
  @IsString()
  vehicleId?: string;

  @ApiPropertyOptional({ example: 1, description: 'Prioridade da fila (menor = mais urgente)' })
  @IsOptional()
  @IsNumber()
  priority?: number;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  services?: Array<{
    serviceId: string;
    description: string;
    quantity: number;
    estimatedTimeMinutes?: number | null;
  }>;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  parts?: Array<{
    inventoryItemId: string;
    plannedQuantity: number;
  }>;
}
