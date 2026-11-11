import { randomUUID } from 'node:crypto';
import { type QueryRunner } from 'typeorm';

import {
  captureCrmAuditOperation,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { projectEmailingDomain } from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import { UNSUBSCRIBE_HOSTNAME_PREFIX } from 'src/engine/core-modules/emailing-domain/constants/unsubscribe-hostname-prefix.constant';
import { EmailingDomainStatus } from 'src/engine/core-modules/emailing-domain/drivers/types/emailing-domain-status.type';
import { EmailingDomainTenantStatus } from 'src/engine/core-modules/emailing-domain/drivers/types/emailing-domain-tenant-status.type';
import { UnsubscribeHostnameStatus } from 'src/engine/core-modules/emailing-domain/drivers/types/unsubscribe-hostname-status.type';

const tableName = 'emailingDomain';

const DEV_EMAILING_DOMAIN = 'dev.twenty.local';

export const getSeededEmailGroupDomains = (workspaceId: string) => {
  const prefix = workspaceId.slice(0, 8);

  return {
    verified: `${prefix}.${DEV_EMAILING_DOMAIN}`,
    pending: `${prefix}.pending.${DEV_EMAILING_DOMAIN}`,
  };
};

type SeedEmailingDomainsArgs = {
  queryRunner: QueryRunner;
  schemaName: string;
  workspaceId: string;
};

export const seedEmailingDomains = async ({
  queryRunner,
  schemaName,
  workspaceId,
}: SeedEmailingDomainsArgs) => {
  const { verified, pending } = getSeededEmailGroupDomains(workspaceId);

  const existingRows: Array<{ id: string }> = await queryRunner.query(
    `SELECT id FROM ${schemaName}."${tableName}" WHERE "workspaceId"=$1`,
    [workspaceId],
  );
  const existingIds = new Set(
    existingRows.map((row) => String(row.id).toLowerCase()),
  );

  await queryRunner.manager
    .createQueryBuilder()
    .insert()
    .into(`${schemaName}.${tableName}`, [
      'workspaceId',
      'domain',
      'status',
      'verificationRecords',
      'verifiedAt',
      'tenantStatus',
      'unsubscribeHostname',
      'unsubscribeHostnameStatus',
    ])
    .orIgnore()
    .values([
      {
        workspaceId,
        domain: verified,
        status: EmailingDomainStatus.VERIFIED,
        verificationRecords: [],
        verifiedAt: new Date(),
        tenantStatus: EmailingDomainTenantStatus.ACTIVE,
        unsubscribeHostname: `${UNSUBSCRIBE_HOSTNAME_PREFIX}.${verified}`,
        unsubscribeHostnameStatus: UnsubscribeHostnameStatus.ACTIVE,
      },
      {
        workspaceId,
        domain: pending,
        status: EmailingDomainStatus.PENDING,
        verificationRecords: [
          {
            type: 'TXT',
            key: `_amazonses.${pending}`,
            value: 'seed-verification-token',
          },
          {
            type: 'CNAME',
            key: `seed1._domainkey.${pending}`,
            value: 'seed1.dkim.amazonses.com',
          },
        ],
        verifiedAt: null,
        tenantStatus: EmailingDomainTenantStatus.ACTIVE,
        unsubscribeHostname: null,
        unsubscribeHostnameStatus: null,
      },
    ])
    .execute();

  const [auditReg] = await queryRunner.query(
    `SELECT to_regclass('crm_audit."crmAuditEntry"') IS NOT NULL AS "hasAudit"`,
  );
  if (auditReg?.hasAudit === true) {
    const afterEntries: Array<{ row: Record<string, unknown> }> =
      await queryRunner.query(
        `SELECT to_jsonb(ed) AS row FROM ${schemaName}."${tableName}" ed WHERE ed."workspaceId"=$1 ORDER BY ed.id ASC`,
        [workspaceId],
      );
    const createdRows = afterEntries
      .map((entry) => entry.row)
      .filter((row) => !existingIds.has(String(row.id).toLowerCase()));
    if (createdRows.length > 0) {
      const operation = captureCrmAuditOperation({
        workspaceId,
        operationId: randomUUID(),
        actor: {
          kind: 'system',
          id: 'dev-seeder:seed-emailing-domains',
        },
        correlationId: randomUUID(),
      });
      const audit = new CrmAuditTransactionContext(queryRunner, operation);
      for (const row of createdRows) {
        const resourceId = String(row.id).toLowerCase();
        audit.record({
          resourceKind: 'emailingDomain',
          resourceId,
          action: 'create',
          before: null,
          after: projectEmailingDomain(row),
          securityDescriptor: {
            resourceKind: 'emailingDomain',
            resourceId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      }
      await audit.flush();
    }
  }
};
