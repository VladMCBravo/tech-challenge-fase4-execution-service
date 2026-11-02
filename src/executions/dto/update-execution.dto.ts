import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateExecutionProgressDto {
  @ApiPropertyOptional({ example: 'Carlos Mecânico' })
  @IsOptional()
  @IsString()
  mechanicName?: string;

  @ApiPropertyOptional({ example: 'DIAGNOSIS' })
  @IsOptional()
  @IsString()
  stage?: 'IN_DIAGNOSIS' | 'IN_REPAIR';

  @ApiProperty({ example: 'Iniciada substituição de pastilhas e troca de óleo' })
  @IsString()
  notes: string;
}

export class FinishExecutionDto {
  @ApiPropertyOptional({ example: 'Carlos Mecânico' })
  @IsOptional()
  @IsString()
  mechanicName?: string;

  @ApiPropertyOptional({ example: 'Todos os reparos concluídos e testados com sucesso' })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class FailExecutionDto {
  @ApiProperty({ example: 'Bloco do motor trincado irreparável - cancelando execução' })
  @IsString()
  reason: string;

  @ApiPropertyOptional({ example: 'Carlos Mecânico' })
  @IsOptional()
  @IsString()
  mechanicName?: string;
}
