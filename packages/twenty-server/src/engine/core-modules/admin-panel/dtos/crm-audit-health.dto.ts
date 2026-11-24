import {
  ArgsType,
  Field,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export enum CrmAuditHealthStatus {
  OK = 'OK',
  DEGRADED = 'DEGRADED',
  UNAVAILABLE = 'UNAVAILABLE',
}

registerEnumType(CrmAuditHealthStatus, {
  name: 'CrmAuditHealthStatus',
});

@ArgsType()
export class CrmAuditHealthInput {
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  bypassCache?: boolean | null;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400_000)
  recentWindowMs?: number | null;
}

@ObjectType('CrmAuditFailureCount')
export class CrmAuditFailureCountDTO {
  @Field(() => String)
  code: string;

  @Field(() => Int)
  count: number;
}

@ObjectType('CrmAuditUnavailableRecord')
export class CrmAuditUnavailableRecordDTO {
  @Field(() => String)
  code: string;

  @Field(() => String)
  occurredAt: string;

  @Field(() => String, { nullable: true })
  workspaceId?: string | null;

  @Field(() => String, { nullable: true })
  operationId?: string | null;

  @Field(() => String, { nullable: true })
  attemptId?: string | null;

  @Field(() => String, { nullable: true })
  resourceKind?: string | null;

  @Field(() => String, { nullable: true })
  action?: string | null;
}

@ObjectType('CrmAuditAlertSinkStatus')
export class CrmAuditAlertSinkStatusDTO {
  @Field(() => Boolean)
  sentryEnabled: boolean;

  @Field(() => Boolean)
  webhookConfigured: boolean;

  @Field(() => Int)
  webhookDeliveredCount: number;

  @Field(() => Int)
  webhookDeliveryFailureCount: number;

  @Field(() => Int)
  webhookDroppedCount: number;

  @Field(() => Int)
  webhookSuppressedCount: number;

  @Field(() => String, { nullable: true })
  lastWebhookDeliveredAt?: string | null;

  @Field(() => String, { nullable: true })
  lastWebhookFailureAt?: string | null;
}

@ObjectType('CrmAuditHealth')
export class CrmAuditHealthDTO {
  @Field(() => CrmAuditHealthStatus)
  status: CrmAuditHealthStatus;

  @Field(() => Boolean)
  databaseReachable: boolean;

  @Field(() => Boolean)
  appendOnlyPrivilegesVerified: boolean;

  @Field(() => String)
  checkedAt: string;

  @Field(() => Boolean)
  fromCache: boolean;

  @Field(() => Int)
  totalUnavailableCount: number;

  @Field(() => Int)
  recentUnavailableCount: number;

  @Field(() => Boolean)
  hasRecentAuditLoss: boolean;

  @Field(() => Int)
  recentWindowMs: number;

  @Field(() => String, { nullable: true })
  lastFailureCode?: string | null;

  @Field(() => String, { nullable: true })
  lastFailureAt?: string | null;

  @Field(() => [CrmAuditFailureCountDTO])
  countsByCode: CrmAuditFailureCountDTO[];

  @Field(() => [CrmAuditUnavailableRecordDTO])
  recentFailures: CrmAuditUnavailableRecordDTO[];

  @Field(() => CrmAuditAlertSinkStatusDTO)
  alertSink: CrmAuditAlertSinkStatusDTO;
}
