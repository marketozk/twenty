import { type QueryRunner } from 'typeorm';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditResourceKind } from 'src/engine/core-modules/crm-audit/crm-audit.types';

type Snapshot = { id: string; workspaceId: string } & Record<string, unknown>;
type Effect = {
  table: string;
  kind: CrmAuditResourceKind;
  action: 'delete' | 'update';
  before: Snapshot;
};

export class MembershipCleanupScopeError extends Error {}

const CASCADED_TABLES = [
  'applicationAuthorization',
  'navigationMenuItem',
  'twoFactorAuthenticationMethod',
  'userApplicationVariableValue',
  'userSession',
] as const;
const CLEARED_TABLES = ['view', 'workflow'] as const;
const DELETED_TABLES = ['userWorkspace', 'roleTarget', ...CASCADED_TABLES];
const SECRET_FIELDS = [
  'secret',
  'value',
  'tokenHash',
  'ipAddress',
  'userAgent',
];

// A new FK effect needs an explicit audit contract before it can be described.
const verifyForeignKeys = async (runner: QueryRunner) => {
  const keys: {
    parent: string;
    schema: string;
    child: string;
    deletion: string;
    update: string;
    columns: string[];
    parentColumns: string[];
  }[] = await runner.query(
    `SELECT p.relname AS parent, ns.nspname AS schema, c.relname AS child,
      fk.confdeltype AS deletion, fk.confupdtype AS update,
      ARRAY(SELECT a.attname::text FROM unnest(fk.conkey) WITH ORDINALITY k(n,i)
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.n ORDER BY k.i) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(fk.confkey) WITH ORDINALITY k(n,i)
        JOIN pg_attribute a ON a.attrelid=p.oid AND a.attnum=k.n ORDER BY k.i) AS "parentColumns"
    FROM pg_constraint fk JOIN pg_class p ON p.oid=fk.confrelid
    JOIN pg_namespace pn ON pn.oid=p.relnamespace
    JOIN pg_class c ON c.oid=fk.conrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE fk.contype='f' AND pn.nspname='core' AND p.relname=ANY($1::text[])`,
    [[...DELETED_TABLES, ...CLEARED_TABLES]],
  );
  const actual = keys.filter((key) =>
    DELETED_TABLES.includes(key.parent)
      ? ['c', 'n', 'd'].includes(key.deletion)
      : ['c', 'n', 'd'].includes(key.update) &&
        key.parentColumns.includes('createdByUserWorkspaceId'),
  );
  const signature = (key: (typeof keys)[number]) =>
    canonicalAuditJson([
      key.parent,
      key.schema,
      key.child,
      key.deletion,
      key.columns,
      key.parentColumns,
    ]);
  const expected = [
    ...CASCADED_TABLES.map((child) => [
      'userWorkspace',
      'core',
      child,
      'c',
      ['userWorkspaceId'],
      ['id'],
    ]),
    ...CLEARED_TABLES.map((child) => [
      'userWorkspace',
      'core',
      child,
      'n',
      ['createdByUserWorkspaceId'],
      ['id'],
    ]),
    [
      'navigationMenuItem',
      'core',
      'navigationMenuItem',
      'c',
      ['folderId'],
      ['id'],
    ],
  ]
    .map(canonicalAuditJson)
    .sort();
  if (
    canonicalAuditJson(actual.map(signature).sort()) !==
    canonicalAuditJson(expected)
  )
    throw new Error('Membership audit FK coverage unavailable');
};

export const captureMembershipCleanupAudit = async ({
  runner,
  context,
  workspaceId,
  userWorkspaceId,
  softDelete,
}: {
  runner: QueryRunner;
  context: CrmAuditTransactionContext;
  workspaceId: string;
  userWorkspaceId: string;
  softDelete: boolean;
}) => {
  // Table identifiers below come only from this fixed inventory, never from callers.
  const read = async (
    table: string,
    predicate: string,
    parameters: unknown[],
    lock = false,
  ): Promise<Snapshot[]> => {
    const rows: { snapshot: Snapshot }[] = await runner.query(
      `SELECT to_jsonb(r) - $1::text[] AS snapshot FROM core."${table}" r
       WHERE ${predicate} ORDER BY r.id${lock ? ' FOR UPDATE OF r' : ''}`,
      [SECRET_FIELDS, ...parameters],
    );
    return rows.map(({ snapshot }) => snapshot);
  };
  const [membership] = await read(
    'userWorkspace',
    'r.id=$2',
    [userWorkspaceId],
    true,
  );
  if (!membership || membership.workspaceId !== workspaceId)
    throw new MembershipCleanupScopeError(
      'Membership audit target unavailable',
    );
  const effects: Effect[] = [
    {
      table: 'userWorkspace',
      kind: 'userWorkspace',
      action: softDelete ? 'update' : 'delete',
      before: membership,
    },
  ];
  if (!softDelete) {
    for (const table of [
      'roleTarget',
      ...CASCADED_TABLES,
      ...CLEARED_TABLES,
    ] as const) {
      if (table === 'navigationMenuItem') continue;
      const cleared = table === 'workflow' || table === 'view';
      const rows = await read(
        table,
        `r."${cleared ? 'createdByUserWorkspaceId' : 'userWorkspaceId'}"=$2`,
        [userWorkspaceId],
        true,
      );
      for (const before of rows)
        effects.push({
          table,
          kind:
            table === 'workflow'
              ? 'coreWorkflow'
              : table === 'view'
                ? 'coreView'
                : table,
          action: cleared ? 'update' : 'delete',
          before,
        });
    }
    const locked = new Set<string>();
    let reachable: { id: string }[];
    do {
      reachable = await runner.query(
        `WITH RECURSIVE descendants(id) AS (
          SELECT id FROM core."navigationMenuItem" WHERE "userWorkspaceId"=$1
          UNION SELECT n.id FROM core."navigationMenuItem" n JOIN descendants d ON n."folderId"=d.id
        ) SELECT id FROM descendants ORDER BY id`,
        [userWorkspaceId],
      );
      const pending = reachable.filter(({ id }) => !locked.has(id));
      if (!pending.length) break;
      for (const row of await read(
        'navigationMenuItem',
        'r.id=ANY($2::uuid[])',
        [pending.map(({ id }) => id)],
        true,
      ))
        locked.add(row.id);
      // A row can move out while its lock is awaited. Only the final reachable set is deleted.
    } while (true);
    for (const before of await read(
      'navigationMenuItem',
      'r.id=ANY($2::uuid[])',
      [reachable.map(({ id }) => id)],
    ))
      effects.push({
        table: 'navigationMenuItem',
        kind: 'navigationMenuItem',
        action: 'delete',
        before,
      });
  }
  if (effects.some(({ before }) => before.workspaceId !== workspaceId))
    throw new MembershipCleanupScopeError(
      'Membership deletion has foreign dependencies',
    );

  let verifiedAfter: (Snapshot | null)[] | undefined;
  const verify = async (): Promise<(Snapshot | null)[]> => {
    const after: (Snapshot | null)[] = [];
    for (const effect of effects) {
      const [actual] = await read(effect.table, 'r.id=$2', [effect.before.id]);
      if (effect.action === 'delete') {
        if (actual)
          throw new Error('Membership cleanup retained a deleted dependency');
        after.push(null);
        continue;
      }
      if (!actual)
        throw new Error('Membership cleanup lost an updated dependency');
      const expected = { ...effect.before };
      if (effect.table === 'userWorkspace') {
        if (!actual.deletedAt)
          throw new Error('Membership cleanup did not revoke membership');
        expected.deletedAt = actual.deletedAt;
        if (Object.hasOwn(expected, 'updatedAt'))
          expected.updatedAt = actual.updatedAt;
      } else expected.createdByUserWorkspaceId = null;
      if (canonicalAuditJson(actual) !== canonicalAuditJson(expected))
        throw new Error(
          'Membership cleanup changed an unrelated persisted field',
        );
      after.push(actual);
    }
    if (
      verifiedAfter &&
      canonicalAuditJson(after) !== canonicalAuditJson(verifiedAfter)
    )
      throw new Error('Membership cleanup changed after verification');
    verifiedAfter ??= after;
    return after;
  };
  return {
    verify,
    verifyCoverage: async () => {
      if (!softDelete) await verifyForeignKeys(runner);
    },
    verifyDeletedRoleTargets: (ids: string[]) => {
      const expected = effects
        .filter(({ table }) => table === 'roleTarget')
        .map(({ before }) => before.id)
        .sort();
      if (canonicalAuditJson([...ids].sort()) !== canonicalAuditJson(expected))
        throw new Error('Membership cleanup deleted unexpected role targets');
    },
    append: async () => {
      const after = await verify();
      for (const [index, effect] of effects.entries()) {
        context.record({
          resourceKind: effect.kind,
          resourceId: effect.before.id,
          action: effect.action,
          before: effect.before,
          after: after[index],
          securityDescriptor: {
            resourceKind: effect.kind,
            resourceId: effect.before.id,
            ...(effect.kind === 'userSession'
              ? {
                  sessionOwner: {
                    userId: String(effect.before.userId),
                    userWorkspaceId,
                    access: 'currentWorkspaceAdministration' as const,
                  },
                }
              : { metadataAccess: 'currentWorkspaceAdministration' as const }),
          },
        });
      }
      await context.flush();
    },
  };
};
