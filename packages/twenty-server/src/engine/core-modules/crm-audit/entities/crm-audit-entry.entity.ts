import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'crmAuditEntry', schema: 'crm_audit' })
@Unique('UQ_crmAuditEntry_workspace_event', ['workspaceId', 'eventKey'])
@Index('IDX_crmAuditEntry_workspace_operation', ['workspaceId', 'operationId'])
@Check('CHK_crmAuditEntry_hash', `"payloadHash" ~ '^[a-f0-9]{64}$'`)
@Check('CHK_crmAuditEntry_version', '"schemaVersion" > 0')
@Check(
  'CHK_crmAuditEntry_outcome',
  `("outcome" = 'success' AND "attemptId" IS NULL) OR ("outcome" IN ('denied', 'failed') AND "attemptId" IS NOT NULL)`,
)
export class CrmAuditEntryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Historical tenant identity survives workspace deletion.
  @Column({ type: 'uuid', nullable: false })
  workspaceId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column({ type: 'text', nullable: false })
  eventKey: string;

  @Column({ type: 'uuid', nullable: false })
  operationId: string;

  @Column({ type: 'uuid', nullable: true })
  attemptId: string | null;

  @Column({ type: 'jsonb', nullable: false })
  actor: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: false })
  initiator: Record<string, unknown>;

  @Column({ type: 'text', nullable: false })
  action: string;

  @Column({ type: 'text', nullable: false })
  resourceKind: string;

  @Column({ type: 'text', nullable: false })
  resourceId: string;

  @Column({ type: 'text', nullable: false })
  outcome: string;

  @Column({ type: 'text', nullable: true })
  reasonCode: string | null;

  @Column({ type: 'jsonb', nullable: false })
  redactedDiff: Record<string, unknown>;

  @Column({ type: 'text', nullable: false })
  payloadHash: string;

  @Column({ type: 'jsonb', nullable: false })
  securityDescriptor: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  correlationId: string | null;

  @Column({ type: 'text', nullable: true })
  causationId: string | null;

  @Column({ type: 'integer', nullable: false, default: 1 })
  schemaVersion: number;
}
