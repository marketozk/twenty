import { lockOrdinaryNativeSyncRun } from 'src/modules/omnichannel/services/lock-ordinary-native-sync-run';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import {
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'twenty-shared/application-runtime';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  assertNativeCrmDeleteFilesEmpty,
  captureNativeCrmAuditSnapshot,
  readNativeCrmAuditRows,
  type NativeCrmAuditTableShape,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import { getIssuedNativeCleanupMetadata } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';
import { assertNoReferentialUpdateEffects } from 'src/engine/twenty-orm/utils/assert-no-referential-update-effects';

const EVENT = 'calendarEvent';
const ASSOCIATION = 'calendarChannelEventAssociation';
const PARTICIPANT = 'calendarEventParticipant';
const TARGET = 'calendarEventTarget';
const RECORDING = 'callRecording';
const TABLES = [EVENT, ASSOCIATION, PARTICIPANT, TARGET, RECORDING] as const;
const DELETED_TABLES = [EVENT, ASSOCIATION, PARTICIPANT, TARGET] as const;
type Table = (typeof TABLES)[number];
type Snapshot = Awaited<ReturnType<typeof readNativeCrmAuditRows>>[number];
type NativeCalendarEventCleanupScope = Parameters<
  typeof createCrmAuditWorkspaceExecutor
>[0] & {
  getRepository: (
    name: string,
    permissions: { shouldBypassPermissionChecks: true },
  ) => {
    delete: (
      ids: string[],
      options: { columnsToReturn: string[] },
    ) => Promise<{ raw: unknown; affected?: number | null }>;
  };
};
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const table = (shape: NativeCrmAuditTableShape) =>
  quote(shape.schemaName) + '.' + quote(shape.tableName);
const eventId = (name: Table, row: Snapshot): string => {
  if (name === EVENT) return row.id;
  const value: unknown = JSON.parse(String(row.calendarEventId));
  if (typeof value !== 'string' || !isUUID(value))
    throw new Error('Native orphan calendar cleanup invalid event reference');
  return value;
};
export type NativeCalendarEventCleanupResult = {
  deletedEventIds: string[];
  deletedAssociationIds: string[];
  deletedParticipantIds: string[];
  deletedTargetIds: string[];
  updatedCallRecordingIds: string[];
};

type CalendarCleanupSession = {
  scope: NativeCalendarEventCleanupScope;
  audit: CrmAuditTransactionContext;
  shapes: Map<Table, NativeCrmAuditTableShape>;
  referencesByTable: Map<
    Table,
    Awaited<ReturnType<typeof getIncomingRecordForeignKeys>>
  >;
  workspace?: Record<string, unknown>;
  validators: (() => Promise<void>)[];
};
const captureCandidateIds = (candidateEventIds: readonly string[]) => {
  if (
    !Array.isArray(candidateEventIds) ||
    candidateEventIds.length > 500 ||
    candidateEventIds.some((id) => !isUUID(id))
  )
    throw new Error(
      'Native orphan calendar cleanup requires bounded scoped system authority',
    );
  return Object.freeze(
    [...new Set(candidateEventIds.map((id) => id.toLowerCase()))].sort(),
  );
};
const createCalendarCleanupSession = (
  scope: NativeCalendarEventCleanupScope,
  operation: CrmAuditOperation,
): CalendarCleanupSession => {
  const context = getIssuedNativeCleanupMetadata(scope);
  if (
    context.authType !== 'system' ||
    context.authWorkspaceId !== scope.workspaceId ||
    operation?.workspaceId !== scope.workspaceId
  )
    throw new Error(
      'Native orphan calendar cleanup requires bounded scoped system authority',
    );
  const capturedOperation = {
    ...operation,
    operationId: randomUUID(),
    actor: { ...operation.actor },
    ...(operation.initiator ? { initiator: { ...operation.initiator } } : {}),
  };
  const audit = new CrmAuditTransactionContext(
    createCrmAuditWorkspaceExecutor(scope),
    capturedOperation,
  );
  const shapes = new Map<Table, NativeCrmAuditTableShape>();
  for (const name of TABLES) {
    const candidates = context.objects.filter(
      ({ metadata }) =>
        metadata.nameSingular === name &&
        metadata.universalIdentifier ===
          STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS[name] &&
        metadata.applicationUniversalIdentifier ===
          TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER &&
        metadata.workspaceId === scope.workspaceId &&
        !metadata.isRemote,
    );
    if (candidates.length !== 1)
      throw new Error(
        'Native orphan calendar cleanup requires exact standard metadata',
      );
    const { metadata, shape } = candidates[0];
    if (
      shape.objectMetadataId !== metadata.id ||
      shape.nameSingular !== name ||
      shape.tableName !== name
    )
      throw new Error('Native orphan calendar cleanup table metadata mismatch');
    shapes.set(name, shape);
  }
  if (new Set([...shapes.values()].map((shape) => shape.schemaName)).size !== 1)
    throw new Error('Native orphan calendar cleanup schema mismatch');

  return { scope, audit, shapes, referencesByTable: new Map(), validators: [] };
};
const isExpectedCalendarReference = (
  shapes: Map<Table, NativeCrmAuditTableShape>,
  reference: Awaited<ReturnType<typeof getIncomingRecordForeignKeys>>[number],
  name: Exclude<Table, typeof EVENT>,
) =>
  reference.schemaName === shapes.get(name)!.schemaName &&
  reference.tableName === shapes.get(name)!.tableName &&
  canonicalAuditJson(reference.parentColumns) === '["id"]' &&
  canonicalAuditJson(reference.childColumns) === '["calendarEventId"]' &&
  reference.deleteAction === (name === RECORDING ? 'n' : 'c');

const prepareCalendarCleanupSession = async (
  session: CalendarCleanupSession,
) => {
  const { scope, shapes, referencesByTable } = session;
  await scope.executeRawQuery("SET LOCAL lock_timeout='8s'");
  const [workspace] = await scope.executeRawQuery(
    'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
    [scope.workspaceId],
  );
  if (!workspace || workspace.deletedAt !== null)
    throw new Error('Native orphan calendar cleanup requires active workspace');
  session.workspace = workspace;
  await scope.executeRawQuery(
    'LOCK TABLE ' +
      [...shapes.values()].map(table).sort().join(',') +
      ' IN ROW EXCLUSIVE MODE',
  );
  for (const name of TABLES) {
    const shape = shapes.get(name)!;
    referencesByTable.set(
      name,
      await getIncomingRecordForeignKeys(
        scope,
        shape.schemaName,
        shape.tableName,
      ),
    );
  }
  for (const name of [ASSOCIATION, PARTICIPANT, TARGET, RECORDING] as const)
    if (
      !referencesByTable
        .get(EVENT)!
        .some((reference) =>
          isExpectedCalendarReference(shapes, reference, name),
        )
    )
      throw new Error(
        'Native orphan calendar cleanup requires expected foreign keys',
      );

  session.validators.push(async () => {
    const [currentWorkspace] = await scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1',
      [scope.workspaceId],
    );
    if (
      currentWorkspace?.id !== workspace.id ||
      currentWorkspace.deletedAt !== null
    )
      throw new Error(
        'Native orphan calendar cleanup workspace changed before commit',
      );
  });
};
const deleteOrphanCalendarEventsStage = async (
  session: CalendarCleanupSession,
  candidateEventIds: readonly string[],
): Promise<NativeCalendarEventCleanupResult> => {
  const ids = captureCandidateIds(candidateEventIds);
  // Validate earlier postimages before a later page can recapture and mask an intervening mutation.
  for (const verify of session.validators) await verify();
  const { scope, audit, shapes, referencesByTable } = session;
  const workspace = session.workspace!;
  const sql = {
    execute: ({ text, values }: { text: string; values: unknown[] }) =>
      scope.executeRawQuery(text, values),
  };
  const before = new Map<Table, Snapshot[]>();
  const read = async (name: Table, lock = false): Promise<Snapshot[]> => {
    const shape = shapes.get(name)!;
    const parentColumn = name === EVENT ? 'id' : 'calendarEventId';
    const originalIds = before.get(name)?.map((row) => row.id) ?? [];
    const currentIds = (
      await scope.executeRawQuery(
        'SELECT id FROM ' +
          table(shape) +
          ' WHERE ' +
          quote(parentColumn) +
          '=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id' +
          (lock ? ' FOR UPDATE' : ''),
        [ids, originalIds],
      )
    ).map((row) => {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error(
          'Native orphan calendar cleanup invalid record identity',
        );
      return row.id;
    });
    // This read follows the row lock. A concurrent reparent-away is no longer a child and is not a claimed effect.
    const snapshots = await readNativeCrmAuditRows(sql, shape, currentIds);
    if (snapshots.length !== currentIds.length)
      throw new Error('Native orphan calendar cleanup graph changed');
    return snapshots;
  };
  for (const name of TABLES) before.set(name, await read(name, true));
  const blocked = new Set(
    before
      .get(ASSOCIATION)!
      .filter((row) => JSON.parse(String(row.deletedAt)) === null)
      .map((row) => eventId(ASSOCIATION, row)),
  );
  // Candidate API preserves legacy behavior: an explicitly supplied tombstoned Event can be deleted.
  const selectedIds = before
    .get(EVENT)!
    .filter((row) => !blocked.has(row.id))
    .map((row) => row.id);
  const selected = new Set(selectedIds);
  for (const name of DELETED_TABLES) {
    const shape = shapes.get(name)!;
    const records = before
      .get(name)!
      .filter((row) => selected.has(eventId(name, row)));
    assertNativeCrmDeleteFilesEmpty(shape, records);
    for (const reference of referencesByTable.get(name)!) {
      if (!['c', 'n', 'd'].includes(reference.deleteAction)) continue;
      if (
        name === EVENT &&
        ([ASSOCIATION, PARTICIPANT, TARGET, RECORDING] as const).some((child) =>
          isExpectedCalendarReference(shapes, reference, child),
        )
      )
        continue;
      const predicate = reference.childColumns
        .map(
          (column, index) =>
            'child.' +
            quote(column) +
            '=parent.' +
            quote(reference.parentColumns[index]),
        )
        .join(' AND ');
      if (
        (
          await scope.executeRawQuery(
            'SELECT 1 FROM ' +
              quote(reference.schemaName) +
              '.' +
              quote(reference.tableName) +
              ' child JOIN ' +
              table(shape) +
              ' parent ON ' +
              predicate +
              ' WHERE parent.id=ANY($1::uuid[]) LIMIT 1',
            [records.map((row) => row.id)],
          )
        ).length
      )
        throw new Error(
          'Native orphan calendar cleanup excludes unsupported cascade effects',
        );
    }
  }
  const recordingShape = shapes.get(RECORDING)!;
  const selectedRecordingIds = before
    .get(RECORDING)!
    .filter((row) => selected.has(eventId(RECORDING, row)))
    .map((row) => row.id);
  // FK SET NULL bypasses the ordinary repository UPDATE kernel; explicitly guard its downstream UPDATE effects.
  if (selectedRecordingIds.length)
    await assertNoReferentialUpdateEffects(
      sql,
      {
        kind: 'update',
        alias: 'audit_recording',
        tableShape: recordingShape,
        setClauses: [
          { columnName: 'calendarEventId', valueExpression: 'NULL' },
        ],
      },
      {},
      '"audit_recording"."id"=ANY($1::uuid[])',
      (text) => ({ text, values: [selectedRecordingIds] }),
    );
  const actualIds = new Set<string>();
  if (selectedIds.length) {
    const result = await scope
      .getRepository(EVENT, { shouldBypassPermissionChecks: true })
      .delete(selectedIds, { columnsToReturn: ['id'] });
    const returned: unknown = result.raw;
    if (
      !Array.isArray(returned) ||
      result.affected !== returned.length ||
      returned.some(
        (row) => !row || typeof row.id !== 'string' || !selected.has(row.id),
      ) ||
      new Set(returned.map((row) => row.id)).size !== returned.length
    )
      throw new Error(
        'Native orphan calendar cleanup returned unexpected records',
      );
    for (const row of returned) actualIds.add(row.id);
  }
  const deleted = new Map<(typeof DELETED_TABLES)[number], Snapshot[]>();
  for (const name of DELETED_TABLES)
    deleted.set(
      name,
      before.get(name)!.filter((row) => actualIds.has(eventId(name, row))),
    );
  const changedRecordingIds = new Set(
    before
      .get(RECORDING)!
      .filter((row) => actualIds.has(eventId(RECORDING, row)))
      .map((row) => row.id),
  );
  const expectedRecordings = before
    .get(RECORDING)!
    .map((row) =>
      changedRecordingIds.has(row.id)
        ? { ...row, calendarEventId: 'null' }
        : row,
    );
  const verify = async () => {
    const [currentWorkspace] = await scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1',
      [scope.workspaceId],
    );
    if (
      currentWorkspace?.id !== workspace.id ||
      currentWorkspace.deletedAt !== null
    )
      throw new Error(
        'Native orphan calendar cleanup workspace changed before commit',
      );
    for (const name of TABLES) {
      const expected =
        name === RECORDING
          ? expectedRecordings
          : before
              .get(name)!
              .filter((row) => !actualIds.has(eventId(name, row)));
      if (canonicalAuditJson(await read(name)) !== canonicalAuditJson(expected))
        throw new Error('Native orphan calendar cleanup effects mismatch');
    }
  };
  await verify();
  for (const name of DELETED_TABLES) {
    const shape = shapes.get(name)!;
    for (const row of deleted.get(name)!)
      audit.record({
        resourceKind: 'crmRecord',
        resourceId: row.id,
        action: 'delete',
        before: captureNativeCrmAuditSnapshot(shape, row),
        after: null,
        securityDescriptor: {
          resourceKind: 'crmRecord',
          resourceId: row.id,
          objectMetadataId: shape.objectMetadataId,
          deletedRecord: { access: 'currentWorkspaceAdministration' },
        },
      });
  }
  for (const row of before
    .get(RECORDING)!
    .filter((row) => changedRecordingIds.has(row.id)))
    audit.record({
      resourceKind: 'crmRecord',
      resourceId: row.id,
      action: 'update',
      before: captureNativeCrmAuditSnapshot(recordingShape, row),
      after: captureNativeCrmAuditSnapshot(recordingShape, {
        ...row,
        calendarEventId: 'null',
      }),
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: row.id,
        objectMetadataId: recordingShape.objectMetadataId,
      },
    });
  session.validators.push(verify);
  return {
    deletedEventIds: [...actualIds].sort(),
    deletedAssociationIds: deleted.get(ASSOCIATION)!.map((row) => row.id),
    deletedParticipantIds: deleted.get(PARTICIPANT)!.map((row) => row.id),
    deletedTargetIds: deleted.get(TARGET)!.map((row) => row.id),
    updatedCallRecordingIds: [...changedRecordingIds].sort(),
  };
};

const finalizeCalendarCleanupSession = async (
  session: CalendarCleanupSession,
) => {
  for (const verify of session.validators) await verify();
  await session.audit.flush();
  await session.scope.executeRawQuery('SET CONSTRAINTS ALL IMMEDIATE');
  for (const verify of session.validators) await verify();
};

// Terminal explicit-candidate owner; tombstoned candidate Events retain their established eligibility.
export const deleteOrphanNativeCalendarEventsWithAudit = async ({
  scope,
  operation,
  candidateEventIds,
}: {
  scope: NativeCalendarEventCleanupScope;
  operation: CrmAuditOperation;
  candidateEventIds: readonly string[];
}): Promise<NativeCalendarEventCleanupResult> => {
  const ids = captureCandidateIds(candidateEventIds);
  const session = createCalendarCleanupSession(scope, operation);
  await prepareCalendarCleanupSession(session);
  const result = await deleteOrphanCalendarEventsStage(session, ids);
  await finalizeCalendarCleanupSession(session);
  return result;
};

// Terminal one-pass sweep; all pages share the original transaction and one pending audit context.
export const cleanWorkspaceNativeCalendarEventsWithAudit = async ({
  scope,
  operation,
}: {
  scope: NativeCalendarEventCleanupScope;
  operation: CrmAuditOperation;
}): Promise<NativeCalendarEventCleanupResult> => {
  const session = createCalendarCleanupSession(scope, operation);
  await prepareCalendarCleanupSession(session);
  const effects = {
    deletedEventIds: new Set<string>(),
    deletedAssociationIds: new Set<string>(),
    deletedParticipantIds: new Set<string>(),
    deletedTargetIds: new Set<string>(),
    updatedCallRecordingIds: new Set<string>(),
  };
  const keys = Object.keys(
    effects,
  ) as (keyof NativeCalendarEventCleanupResult)[];
  let cursor: string | undefined;
  for (;;) {
    const rows = await scope.executeRawQuery(
      'SELECT id FROM ' +
        table(session.shapes.get(EVENT)!) +
        ' WHERE "deletedAt" IS NULL' +
        (cursor ? ' AND id>$1::uuid' : '') +
        ' ORDER BY id LIMIT 500 FOR UPDATE',
      cursor ? [cursor] : [],
    );
    if (!rows.length) break;
    const ids = rows.map((row) => {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error(
          'Native orphan calendar cleanup invalid record identity',
        );
      return row.id;
    });
    cursor = ids[ids.length - 1];
    const result = await deleteOrphanCalendarEventsStage(session, ids);
    for (const key of keys) for (const id of result[key]) effects[key].add(id);
  }
  await finalizeCalendarCleanupSession(session);
  return {
    deletedEventIds: [...effects.deletedEventIds].sort(),
    deletedAssociationIds: [...effects.deletedAssociationIds].sort(),
    deletedParticipantIds: [...effects.deletedParticipantIds].sort(),
    deletedTargetIds: [...effects.deletedTargetIds].sort(),
    updatedCallRecordingIds: [...effects.updatedCallRecordingIds].sort(),
  };
};

type SyncCalendarSourceProof = {
  candidateEventIds: string[];
  verifiedDeletedEventIds: Set<string>;
};

const lockCalendarSyncAuthority = async (
  session: CalendarCleanupSession,
  run: OrdinaryMetadataSyncRun,
): Promise<boolean> => {
  const { scope } = session;
  if (!(await lockOrdinaryNativeSyncRun(scope, run))) return false;
  // Capture only authority fields, never provider credentials or unrelated timestamps.
  const read = async () => {
    const accounts = await scope.executeRawQuery(
      'SELECT id,provider,"applicationId","connectionProviderId" FROM core."connectedAccount" WHERE "workspaceId"=$1 AND id=$2',
      [scope.workspaceId, run.connectedAccountId],
    );
    const channels = await scope.executeRawQuery(
      'SELECT id,"connectedAccountId","isSyncEnabled","syncStage",to_char("syncStageStartedAt" AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS "startedAt" FROM core."calendarChannel" WHERE "workspaceId"=$1 AND id=$2',
      [scope.workspaceId, run.channelId],
    );
    return { accounts, channels };
  };
  const before = await read();
  if (before.accounts.length !== 1 || before.channels.length !== 1)
    throw new Error('Native sync calendar cleanup authority changed');
  session.validators.push(async () => {
    if (
      !(await lockOrdinaryNativeSyncRun(scope, run)) ||
      canonicalAuditJson(await read()) !== canonicalAuditJson(before)
    )
      throw new Error('Native sync calendar cleanup authority changed');
  });
  return true;
};

const deleteSyncCalendarAssociationsStage = async (
  session: CalendarCleanupSession,
  channelId: string,
  externalIds: readonly string[],
): Promise<SyncCalendarSourceProof> => {
  const { scope, audit, shapes, referencesByTable } = session;
  const rootShape = shapes.get(ASSOCIATION)!;
  const sql = {
    execute: ({ text, values }: { text: string; values: unknown[] }) =>
      scope.executeRawQuery(text, values),
  };
  // Discover without child locks so all Event parents are locked before Associations.
  const discovered = new Map<string, string>();
  let cursor: string | undefined;
  for (;;) {
    const rows = await scope.executeRawQuery(
      'SELECT id,"calendarEventId" FROM ' +
        table(rootShape) +
        ' WHERE "calendarChannelId"=$1 AND "eventExternalId"=ANY($2::text[])' +
        (cursor ? ' AND id>$3::uuid' : '') +
        ' ORDER BY id LIMIT 500',
      cursor ? [channelId, externalIds, cursor] : [channelId, externalIds],
    );
    if (!rows.length) break;
    for (const row of rows) {
      if (
        typeof row.id !== 'string' ||
        !isUUID(row.id) ||
        typeof row.calendarEventId !== 'string' ||
        !isUUID(row.calendarEventId) ||
        discovered.has(row.id)
      )
        throw new Error('Native sync calendar cleanup invalid record identity');
      discovered.set(row.id, row.calendarEventId);
    }
    cursor = String(rows[rows.length - 1].id);
  }
  const rootIds = [...discovered.keys()];
  const parentIds = [...new Set(discovered.values())].sort();
  const before = new Map<Table, Snapshot[]>();
  const readGraph = async (name: Table, lock = false): Promise<Snapshot[]> => {
    const shape = shapes.get(name)!;
    const parentColumn = name === EVENT ? 'id' : 'calendarEventId';
    const originalIds = [
      ...new Set([
        ...(before.get(name)?.map((row) => row.id) ?? []),
        ...(name === ASSOCIATION ? rootIds : []),
      ]),
    ];
    const ids: string[] = [];
    let pageCursor: string | undefined;
    for (;;) {
      const rows = await scope.executeRawQuery(
        'SELECT id FROM ' +
          table(shape) +
          ' WHERE (' +
          quote(parentColumn) +
          '=ANY($1::uuid[]) OR id=ANY($2::uuid[]))' +
          (pageCursor ? ' AND id>$3::uuid' : '') +
          ' ORDER BY id LIMIT 500' +
          (lock ? ' FOR UPDATE' : ''),
        pageCursor
          ? [parentIds, originalIds, pageCursor]
          : [parentIds, originalIds],
      );
      if (!rows.length) break;
      for (const row of rows) {
        if (typeof row.id !== 'string' || !isUUID(row.id))
          throw new Error(
            'Native sync calendar cleanup invalid record identity',
          );
        ids.push(row.id);
      }
      pageCursor = String(rows[rows.length - 1].id);
    }
    const snapshots = await readNativeCrmAuditRows(sql, shape, ids);
    if (snapshots.length !== ids.length)
      throw new Error('Native sync calendar cleanup graph changed');
    return snapshots;
  };
  // Fix the full five-table source graph before Association effects. A DELETE trigger
  // must not rewrite a later orphan-stage before-image and thereby escape the audit.
  for (const name of TABLES) before.set(name, await readGraph(name, true));
  const rootMap = new Map(before.get(ASSOCIATION)!.map((row) => [row.id, row]));
  for (const [id, parentId] of discovered) {
    const row = rootMap.get(id);
    // A committed removal or selector reassignment before this locked baseline
    // is skipped, matching the previous provider cleanup contract. A different
    // Event parent is still rejected: that parent was not part of our lock proof.
    if (row && eventId(ASSOCIATION, row) !== parentId)
      throw new Error('Native sync calendar cleanup reference changed');
  }
  const capturedRoots = rootIds.flatMap((id) => {
    const row = rootMap.get(id);
    return row ? [row] : [];
  });
  const selected = capturedRoots.filter(
    (row) =>
      JSON.parse(String(row.deletedAt)) === null &&
      JSON.parse(String(row.calendarChannelId)) === channelId &&
      externalIds.includes(JSON.parse(String(row.eventExternalId))),
  );
  const selectedIds = selected.map((row) => row.id);
  const actualAssociationIds = new Set<string>();
  const verifiedDeletedEventIds = new Set<string>();
  const verify = async () => {
    for (const name of TABLES) {
      const expected = before.get(name)!.flatMap((row) => {
        const parentDeleted = verifiedDeletedEventIds.has(eventId(name, row));
        if (name === RECORDING)
          return [
            { ...row, ...(parentDeleted ? { calendarEventId: 'null' } : {}) },
          ];
        if (
          parentDeleted ||
          (name === ASSOCIATION && actualAssociationIds.has(row.id))
        )
          return [];
        return [row];
      });
      if (
        canonicalAuditJson(await readGraph(name)) !==
        canonicalAuditJson(expected)
      )
        throw new Error('Native sync calendar cleanup effects mismatch');
    }
    // Include the full requested selector and original IDs; source rows must not
    // move out, appear late, or be hidden by a later verified Event cascade.
    const currentIds = (
      await scope.executeRawQuery(
        'SELECT id FROM ' +
          table(rootShape) +
          ' WHERE ("calendarChannelId"=$1 AND "eventExternalId"=ANY($2::text[])) OR id=ANY($3::uuid[]) ORDER BY id',
        [channelId, externalIds, rootIds],
      )
    ).map((row) => {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error('Native sync calendar cleanup invalid record identity');
      return row.id;
    });
    const current = await readNativeCrmAuditRows(sql, rootShape, currentIds);
    const expected = capturedRoots.filter(
      (row) =>
        !actualAssociationIds.has(row.id) &&
        !verifiedDeletedEventIds.has(eventId(ASSOCIATION, row)),
    );
    if (
      current.length !== currentIds.length ||
      canonicalAuditJson(current) !== canonicalAuditJson(expected)
    )
      throw new Error('Native sync calendar cleanup effects mismatch');
  };
  session.validators.push(verify);
  // Validate discovery again under all source locks, before a deletion can mask stale selection.
  for (const validate of session.validators) await validate();
  assertNativeCrmDeleteFilesEmpty(rootShape, selected);
  for (const reference of referencesByTable.get(ASSOCIATION)!) {
    if (!['c', 'n', 'd'].includes(reference.deleteAction)) continue;
    const predicate = reference.childColumns
      .map(
        (column, index) =>
          'child.' +
          quote(column) +
          '=parent.' +
          quote(reference.parentColumns[index]),
      )
      .join(' AND ');
    if (
      (
        await scope.executeRawQuery(
          'SELECT 1 FROM ' +
            quote(reference.schemaName) +
            '.' +
            quote(reference.tableName) +
            ' child JOIN ' +
            table(rootShape) +
            ' parent ON ' +
            predicate +
            ' WHERE parent.id=ANY($1::uuid[]) LIMIT 1',
          [selectedIds],
        )
      ).length
    )
      throw new Error(
        'Native sync calendar cleanup excludes unsupported cascade effects',
      );
  }
  const repository = scope.getRepository(ASSOCIATION, {
    shouldBypassPermissionChecks: true,
  });
  for (let offset = 0; offset < selectedIds.length; offset += 500) {
    for (const validate of session.validators) await validate();
    const ids = selectedIds.slice(offset, offset + 500);
    const result = await repository.delete(ids, { columnsToReturn: ['id'] });
    const returned: unknown = result.raw;
    if (
      !Array.isArray(returned) ||
      result.affected !== returned.length ||
      returned.some(
        (row) => !row || typeof row.id !== 'string' || !ids.includes(row.id),
      ) ||
      new Set(returned.map((row) => row.id)).size !== returned.length
    )
      throw new Error(
        'Native sync calendar cleanup returned unexpected records',
      );
    for (const row of returned) actualAssociationIds.add(row.id);
    for (const validate of session.validators) await validate();
  }
  const deleted = selected.filter((row) => actualAssociationIds.has(row.id));
  for (const row of deleted)
    audit.record({
      resourceKind: 'crmRecord',
      resourceId: row.id,
      action: 'delete',
      before: captureNativeCrmAuditSnapshot(rootShape, row),
      after: null,
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: row.id,
        objectMetadataId: rootShape.objectMetadataId,
        deletedRecord: { access: 'currentWorkspaceAdministration' },
      },
    });
  return {
    candidateEventIds: [
      ...new Set(deleted.map((row) => eventId(ASSOCIATION, row))),
    ].sort(),
    verifiedDeletedEventIds,
  };
};

// The external-ID command is produced by the existing provider/import classification.
// This terminal owner revalidates lifecycle authority, not a new blocklist/private policy.
export const deleteOrdinarySyncCalendarAssociationsWithAudit = async ({
  scope,
  operation,
  expectedRun,
  eventExternalIds,
}: {
  scope: NativeCalendarEventCleanupScope;
  operation: CrmAuditOperation;
  expectedRun: OrdinaryMetadataSyncRun;
  eventExternalIds: readonly string[];
}): Promise<boolean> => {
  const run = Object.freeze({ ...expectedRun });
  if (
    run.kind !== 'calendar' ||
    run.workspaceId !== scope.workspaceId ||
    !Array.isArray(eventExternalIds) ||
    eventExternalIds.some((id) => typeof id !== 'string')
  )
    throw new Error('Native sync calendar cleanup invalid command');
  const externalIds = Object.freeze([...new Set(eventExternalIds)].sort());
  const session = createCalendarCleanupSession(scope, operation);
  await prepareCalendarCleanupSession(session);
  if (!(await lockCalendarSyncAuthority(session, run))) return false;
  const source = await deleteSyncCalendarAssociationsStage(
    session,
    run.channelId,
    externalIds,
  );
  for (
    let offset = 0;
    offset < source.candidateEventIds.length;
    offset += 500
  ) {
    // The orphan stage verifies every prior source before taking new snapshots.
    const result = await deleteOrphanCalendarEventsStage(
      session,
      source.candidateEventIds.slice(offset, offset + 500),
    );
    // Only verified actual Event RETURNING admits its known child CASCADE / SET NULL.
    for (const id of result.deletedEventIds)
      source.verifiedDeletedEventIds.add(id);
  }
  await finalizeCalendarCleanupSession(session);
  return true;
};
