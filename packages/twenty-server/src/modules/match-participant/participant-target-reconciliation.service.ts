import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import {
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'twenty-shared/application-runtime';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  CrmAuditTransactionContext,
  captureCrmAuditOperation,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  captureNativeCrmAuditSnapshot,
  readNativeCrmAuditRows,
  assertNativeCrmDeleteFilesEmpty,
  type NativeCrmAuditTableShape,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import {
  CALENDAR_SAVE_TABLES,
  calendarSaveTableSql,
  quoteCalendarSaveIdentifier,
  calendarSaveActualIds,
  type CalendarSaveTable,
  type CalendarSaveSnapshot,
} from 'src/engine/core-modules/crm-audit/calendar-save-proof';
import { getIssuedNativeCleanupMetadata } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';
import { assertNoReferentialUpdateEffects } from 'src/engine/twenty-orm/utils/assert-no-referential-update-effects';
import {
  readCalendarProofGraph,
  castCalendarProofImage,
} from 'src/engine/core-modules/crm-audit/calendar-target-proof';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import chunk from 'lodash.chunk';
import { QUERY_MAX_RECORDS } from 'twenty-shared/constants';
import { isDefined } from 'twenty-shared/utils';
import { DataSource, In, MoreThan, type ObjectLiteral } from 'typeorm';

import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { getWorkspaceRepositoryWithOptionalTransaction } from 'src/engine/twenty-orm/utils/get-workspace-repository-with-optional-transaction.util';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type CalendarEventParticipantWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-event-participant.workspace-entity';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import { type MessageWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message.workspace-entity';
import {
  computeTargetReconciliationOperations,
  type ExistingTarget,
  type TargetIdentity,
} from 'src/modules/match-participant/utils/compute-target-reconciliation-operations.util';
import { type OpportunityWorkspaceEntity } from 'src/modules/opportunity/standard-objects/opportunity.workspace-entity';
import { type PersonWorkspaceEntity } from 'src/modules/person/standard-objects/person.workspace-entity';
import { findOmniOwnedMessageThreadIds } from 'src/modules/omnichannel/services/find-omni-owned-native-record-ids';

type TargetParentFieldName = 'calendarEventId' | 'messageThreadId';

type TargetWorkspaceEntity = Omit<ExistingTarget, 'parentId' | 'deletedAt'> & {
  calendarEventId?: string | null;
  messageThreadId?: string | null;
  deletedAt: string | null;
};

const CALENDAR_TARGET_SOURCE_TABLES = [
  'person',
  'company',
  'opportunity',
] as const;
type CalendarTargetSource = (typeof CALENDAR_TARGET_SOURCE_TABLES)[number];
type CalendarTargetTable = CalendarSaveTable | CalendarTargetSource;
type CalendarTargetState = {
  scope: WorkspaceTransactionScope;
  audit: CrmAuditTransactionContext;
  shapes: Map<CalendarTargetTable, NativeCrmAuditTableShape>;
  rootIds: string[];
  participantIds: string[];
  personIds: string[];
  before: Map<CalendarSaveTable, CalendarSaveSnapshot[]>;
  expected: Map<CalendarSaveTable, CalendarSaveSnapshot[]>;
  sources: Map<CalendarTargetSource, CalendarSaveSnapshot[]>;
  originalSourceIds: Map<CalendarTargetSource, string[]>;
};

@Injectable()
export class ParticipantTargetReconciliationService {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectDataSource()
    private readonly coreDataSource: DataSource,
  ) {}

  public async reconcileTargetsForPeople({
    personIds,
    workspaceId,
    operation,
  }: {
    personIds: string[];
    workspaceId: string;
    operation: CrmAuditOperation;
  }): Promise<void> {
    operation = captureCrmAuditOperation(operation);
    if (
      !isUUID(workspaceId) ||
      operation.workspaceId !== workspaceId.toLowerCase() ||
      !Array.isArray(personIds) ||
      personIds.some((id) => typeof id !== 'string' || !isUUID(id))
    )
      throw new Error('Calendar targets require scoped person selection');
    workspaceId = workspaceId.toLowerCase();
    personIds = [...new Set(personIds.map((id) => id.toLowerCase()))];
    await this.workspaceOrmManager.executeInWorkspaceContext(async () => {
      for (const objectMetadataName of ['messageParticipant'] as const) {
        for (const personIdChunk of chunk(
          [...new Set(personIds)],
          QUERY_MAX_RECORDS,
        )) {
          let lastParticipantId: string | undefined;
          let hasMoreParticipants = true;

          while (hasMoreParticipants) {
            await this.workspaceOrmManager.runInWorkspaceTransaction(
              async (transactionScope) => {
                const participantRepository = await this.getRepository<
                  | MessageParticipantWorkspaceEntity
                  | CalendarEventParticipantWorkspaceEntity
                >(objectMetadataName, transactionScope);
                const participants = await participantRepository.find({
                  where: {
                    personId: In(personIdChunk),
                    ...(isDefined(lastParticipantId)
                      ? { id: MoreThan(lastParticipantId) }
                      : {}),
                  },
                  order: { id: 'ASC' },
                  take: QUERY_MAX_RECORDS,
                });

                await this.reconcileParticipantTargets({
                  objectMetadataName,
                  sourceRecordIds: participants.map((participant) =>
                    'messageId' in participant
                      ? participant.messageId
                      : participant.calendarEventId,
                  ),
                  transactionScope,
                });

                lastParticipantId = participants[participants.length - 1]?.id;
                hasMoreParticipants = participants.length === QUERY_MAX_RECORDS;
              },
            );
          }
        }
      }
    }, buildSystemAuthContext(workspaceId));
    for (const personIdChunk of chunk(personIds, QUERY_MAX_RECORDS)) {
      let afterParticipantId: string | undefined;
      do {
        const { nextCursor } = await this.reconcileCalendarTargetsForPeoplePage(
          {
            workspaceId,
            personIds: personIdChunk,
            operation,
            afterParticipantId,
          },
        );
        afterParticipantId = nextCursor ?? undefined;
      } while (afterParticipantId !== undefined);
    }
  }

  private async reconcileCalendarTargetsForPeoplePage({
    workspaceId,
    personIds,
    operation,
    afterParticipantId,
  }: {
    workspaceId: string;
    personIds: readonly string[];
    operation: CrmAuditOperation;
    afterParticipantId?: string;
  }): Promise<{ nextCursor: string | null }> {
    operation = captureCrmAuditOperation({
      ...operation,
      operationId: randomUUID(),
    });
    const selectedPersonIds = [...personIds];
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        this.workspaceOrmManager.runInWorkspaceTransaction(
          async (scope) => {
            const state = await this.prepareCalendarTargets(
              scope,
              operation,
              [],
              [],
            );
            const discoveredRows = await scope.executeRawQuery(
              `SELECT id,"calendarEventId","personId" FROM ${calendarSaveTableSql(state.shapes.get('calendarEventParticipant')!)} WHERE "deletedAt" IS NULL AND "personId"=ANY($1::uuid[]) AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 200`,
              [selectedPersonIds, afterParticipantId ?? null],
            );
            const discovered = discoveredRows.map((row) => {
              if (
                typeof row.id !== 'string' ||
                !isUUID(row.id) ||
                typeof row.calendarEventId !== 'string' ||
                !isUUID(row.calendarEventId) ||
                typeof row.personId !== 'string' ||
                !isUUID(row.personId)
              )
                throw new Error(
                  'Calendar targets require participant parent identity',
                );
              return {
                id: row.id,
                calendarEventId: row.calendarEventId,
                personId: row.personId,
              };
            });
            state.rootIds = [
              ...new Set(discovered.map((row) => row.calendarEventId)),
            ];
            state.participantIds = discovered.map((row) => row.id);
            for (const name of CALENDAR_SAVE_TABLES) {
              const rows = await this.readCalendarTargetGraph(
                state,
                name,
                true,
              );
              state.before.set(name, rows);
              state.expected.set(name, rows);
            }
            const byId = new Map(
              state.before
                .get('calendarEventParticipant')!
                .map((row) => [row.id, row]),
            );
            const eventIds = [
              ...new Set(
                discovered
                  .filter((hint) => {
                    const current = byId.get(hint.id);
                    return (
                      current &&
                      current.deletedAt === 'null' &&
                      current.calendarEventId ===
                        JSON.stringify(hint.calendarEventId) &&
                      current.personId === JSON.stringify(hint.personId) &&
                      selectedPersonIds.includes(hint.personId)
                    );
                  })
                  .map((row) => row.calendarEventId),
              ),
            ];
            state.personIds = [
              ...new Set(
                state.before
                  .get('calendarEventParticipant')!
                  .flatMap((row) =>
                    row.personId === 'null'
                      ? []
                      : [JSON.parse(String(row.personId)) as string],
                  ),
              ),
            ];
            state.sources = await this.readCalendarTargetSources(state);
            for (const name of CALENDAR_TARGET_SOURCE_TABLES)
              state.originalSourceIds.set(
                name,
                state.sources.get(name)!.map((row) => row.id),
              );
            await this.verifyCalendarTargetGraph(state);
            // Plan from actual RETURNING effects, including unrequested live participants.
            const personById = new Map(
              state.sources
                .get('person')!
                .filter((row) => row.deletedAt === 'null')
                .map((row) => [row.id, row]),
            );
            const opportunities = state.sources
              .get('opportunity')!
              .filter((row) => row.deletedAt === 'null');
            const desiredTargets: TargetIdentity[] = [];
            for (const row of state.expected.get('calendarEventParticipant')!) {
              if (row.deletedAt !== 'null' || row.personId === 'null') continue;
              const parentId = JSON.parse(
                String(row.calendarEventId),
              ) as string;
              if (!eventIds.includes(parentId)) continue;
              const personId = JSON.parse(String(row.personId)) as string;
              const person = personById.get(personId);
              if (!person) continue;
              desiredTargets.push({
                parentId,
                targetPersonId: personId,
                targetCompanyId: null,
                targetOpportunityId: null,
              });
              if (person.companyId !== 'null')
                desiredTargets.push({
                  parentId,
                  targetPersonId: null,
                  targetCompanyId: JSON.parse(String(person.companyId)),
                  targetOpportunityId: null,
                });
              for (const opportunity of opportunities)
                if (opportunity.pointOfContactId === JSON.stringify(personId))
                  desiredTargets.push({
                    parentId,
                    targetPersonId: null,
                    targetCompanyId: null,
                    targetOpportunityId: opportunity.id,
                  });
            }
            const existingTargets: ExistingTarget[] = state.expected
              .get('calendarEventTarget')!
              .filter((row) =>
                eventIds.includes(JSON.parse(String(row.calendarEventId))),
              )
              .map((row) => ({
                id: row.id,
                parentId: JSON.parse(String(row.calendarEventId)),
                targetPersonId: JSON.parse(String(row.targetPersonId)),
                targetCompanyId: JSON.parse(String(row.targetCompanyId)),
                targetOpportunityId: JSON.parse(
                  String(row.targetOpportunityId),
                ),
                deletedAt: JSON.parse(String(row.deletedAt)),
                isAutomaticallyAssigned: JSON.parse(
                  String(row.isAutomaticallyAssigned),
                ),
                isManuallyAssigned: JSON.parse(String(row.isManuallyAssigned)),
              }));
            const plan = computeTargetReconciliationOperations({
              desiredTargets,
              existingTargets,
            });
            await this.insertCalendarTargets(
              state,
              plan.targetsToCreate.map(({ parentId, ...target }) => ({
                id: randomUUID(),
                calendarEventId: parentId,
                ...target,
                isAutomaticallyAssigned: true,
                isManuallyAssigned: false,
              })),
            );
            await this.updateCalendarTargets(state, 'calendarEventTarget', [
              ...plan.targetsToMarkAutomatic.map((id) => ({
                criteria: id,
                partialEntity: { isAutomaticallyAssigned: true },
              })),
              ...plan.targetsToMarkNotAutomatic.map((id) => ({
                criteria: id,
                partialEntity: { isAutomaticallyAssigned: false },
              })),
            ]);
            for (const ids of chunk(plan.targetIdsToDelete, 200))
              await this.deleteCalendarTargets(state, ids);
            await this.finishCalendarTargetAudit(state);
            return {
              nextCursor:
                discovered.length === 200
                  ? discovered[discovered.length - 1].id
                  : null,
            };
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        ),
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }

  private async prepareCalendarTargets(
    scope: WorkspaceTransactionScope,
    operation: CrmAuditOperation,
    rootIds: string[],
    participantIds: string[],
  ): Promise<CalendarTargetState> {
    const context = getIssuedNativeCleanupMetadata(scope);
    if (
      context.authType !== 'system' ||
      context.authWorkspaceId !== scope.workspaceId ||
      operation.workspaceId !== scope.workspaceId
    )
      throw new Error(
        'Calendar targets requires issued scoped system authority',
      );
    const shapes = new Map<CalendarTargetTable, NativeCrmAuditTableShape>();
    for (const name of [
      ...CALENDAR_SAVE_TABLES,
      ...CALENDAR_TARGET_SOURCE_TABLES,
    ]) {
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
        throw new Error('Calendar targets requires exact standard metadata');
      const { metadata, shape } = candidates[0];
      if (
        shape.objectMetadataId !== metadata.id ||
        shape.nameSingular !== name ||
        shape.tableName !== name
      )
        throw new Error('Calendar targets table metadata mismatch');
      shapes.set(name, shape);
    }
    if (
      new Set([...shapes.values()].map((shape) => shape.schemaName)).size !== 1
    )
      throw new Error('Calendar targets schema mismatch');
    await scope.executeRawQuery("SET LOCAL lock_timeout='8s'");
    const [workspace] = await scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
      [scope.workspaceId],
    );
    if (!workspace || workspace.deletedAt !== null)
      throw new Error('Calendar targets requires active workspace');
    // Freeze candidate absence as well as rows. No provider or queue work occurs under these locks.
    await scope.executeRawQuery(
      'LOCK TABLE ' +
        CALENDAR_TARGET_SOURCE_TABLES.map((name) =>
          calendarSaveTableSql(shapes.get(name)!),
        )
          .sort()
          .join(',') +
        ' IN SHARE MODE',
    );
    await scope.executeRawQuery(
      'LOCK TABLE ' +
        CALENDAR_SAVE_TABLES.map((name) =>
          calendarSaveTableSql(shapes.get(name)!),
        )
          .sort()
          .join(',') +
        ' IN ROW EXCLUSIVE MODE',
    );
    const references = await getIncomingRecordForeignKeys(
      scope,
      shapes.get('calendarEvent')!.schemaName,
      'calendarEvent',
    );
    for (const name of CALENDAR_SAVE_TABLES.filter(
      (name) => name !== 'calendarEvent',
    )) {
      const shape = shapes.get(name)!;
      if (
        !references.some(
          (reference) =>
            reference.schemaName === shape.schemaName &&
            reference.tableName === shape.tableName &&
            canonicalAuditJson(reference.childColumns) ===
              '["calendarEventId"]' &&
            canonicalAuditJson(reference.parentColumns) === '["id"]',
        )
      )
        throw new Error('Calendar targets requires event foreign keys');
    }
    return {
      scope,
      shapes,
      rootIds,
      participantIds,
      before: new Map(),
      expected: new Map(),
      personIds: [],
      originalSourceIds: new Map(),
      sources: new Map(),
      audit: new CrmAuditTransactionContext(
        createCrmAuditWorkspaceExecutor(scope),
        operation,
      ),
    };
  }
  private async readCalendarTargetRows(
    state: CalendarTargetState,
    name: CalendarTargetTable,
    ids: string[],
  ) {
    const rows = await readNativeCrmAuditRows(
      {
        execute: ({ text, values }) =>
          state.scope.executeRawQuery(text, values),
      },
      state.shapes.get(name)!,
      [...new Set(ids)],
    );
    if (rows.length !== new Set(ids).size)
      throw new Error('Calendar targets source disappeared');
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  private async readCalendarTargetSources(
    state: CalendarTargetState,
  ): Promise<Map<CalendarTargetSource, CalendarSaveSnapshot[]>> {
    const result = new Map<CalendarTargetSource, CalendarSaveSnapshot[]>();
    const selectIds = async (
      name: CalendarTargetSource,
      predicate: string,
      values: unknown[],
    ) =>
      (
        await state.scope.executeRawQuery(
          'SELECT id FROM ' +
            calendarSaveTableSql(state.shapes.get(name)!) +
            ' WHERE (' +
            predicate +
            ') OR id=ANY($' +
            (values.length + 1) +
            '::uuid[]) ORDER BY id',
          [...values, state.originalSourceIds.get(name) ?? []],
        )
      ).map((row) => String(row.id));
    const personIds = state.personIds;
    result.set(
      'person',
      await this.readCalendarTargetRows(
        state,
        'person',
        await selectIds('person', 'id=ANY($1::uuid[])', [personIds]),
      ),
    );
    const companyIds = result
      .get('person')!
      .flatMap((row) =>
        row.companyId === 'null'
          ? []
          : [JSON.parse(String(row.companyId)) as string],
      );
    result.set(
      'company',
      await this.readCalendarTargetRows(
        state,
        'company',
        await selectIds('company', 'id=ANY($1::uuid[])', [companyIds]),
      ),
    );
    result.set(
      'opportunity',
      await this.readCalendarTargetRows(
        state,
        'opportunity',
        await selectIds('opportunity', '"pointOfContactId"=ANY($1::uuid[])', [
          personIds,
        ]),
      ),
    );
    return result;
  }
  private async readCalendarTargetGraph(
    state: CalendarTargetState,
    name: CalendarSaveTable,
    lock = false,
  ): Promise<CalendarSaveSnapshot[]> {
    const originalIds = [
      ...new Set([
        ...(state.before.get(name) ?? []).map((row) => row.id),
        ...(state.expected.get(name) ?? []).map((row) => row.id),
        ...(name === 'calendarEventParticipant' ? state.participantIds : []),
      ]),
    ];
    return readCalendarProofGraph({
      scope: state.scope,
      shape: state.shapes.get(name)!,
      name,
      rootIds: state.rootIds,
      originalIds,
      lock,
    });
  }
  private async verifyCalendarTargetGraph(state: CalendarTargetState) {
    const [workspace] = await state.scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1',
      [state.scope.workspaceId],
    );
    if (!workspace || workspace.deletedAt !== null)
      throw new Error('Calendar targets workspace changed');
    const sources = await this.readCalendarTargetSources(state);
    for (const name of CALENDAR_TARGET_SOURCE_TABLES)
      if (
        canonicalAuditJson(sources.get(name)) !==
        canonicalAuditJson(state.sources.get(name))
      )
        throw new Error('Calendar targets sources changed');
    for (const name of CALENDAR_SAVE_TABLES)
      if (
        canonicalAuditJson(await this.readCalendarTargetGraph(state, name)) !==
        canonicalAuditJson(
          [...(state.expected.get(name) ?? [])].sort((a, b) =>
            a.id.localeCompare(b.id),
          ),
        )
      )
        throw new Error('Calendar targets graph effects mismatch');
  }
  private calendarTargetColumns(
    shape: NativeCrmAuditTableShape,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const allowed = [
      'id',
      'calendarEventId',
      'targetPersonId',
      'targetCompanyId',
      'targetOpportunityId',
      'isAutomaticallyAssigned',
      'isManuallyAssigned',
    ];
    if (shape.nameSingular !== 'calendarEventTarget')
      throw new Error('Calendar targets exclude participant writes');
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const column = shape.columnShapeByColumnName[key];
      if (
        !allowed.includes(key) ||
        !column ||
        column.compositeParentFieldName ||
        column.fieldMetadataType === 'FILES'
      )
        throw new Error('Calendar targets field outside plan');
      result[key] = value;
    }
    return result;
  }
  private async insertCalendarTargets(
    state: CalendarTargetState,
    records: ({ id: string } & Record<string, unknown>)[],
  ) {
    const name = 'calendarEventTarget';
    const shape = state.shapes.get(name)!;
    for (const batch of chunk(records, 200)) {
      await this.verifyCalendarTargetGraph(state);
      const expected = state.expected.get(name)!;
      const planned = new Map<string, CalendarSaveSnapshot>();
      for (const row of batch) {
        if (expected.some((previous) => previous.id === row.id))
          throw new Error('Calendar targets target identity conflict');
        planned.set(
          row.id,
          await this.castCalendarTargetImage(
            state,
            shape,
            this.calendarTargetColumns(shape, row),
          ),
        );
      }
      const result = await state.scope
        .getRepository(name, { shouldBypassPermissionChecks: true })
        .insert(batch, { onConflictDoNothing: true });
      const ids = calendarSaveActualIds(
        result,
        batch.map((row) => row.id),
      );
      const rows = await this.readCalendarTargetRows(state, name, ids);
      for (const row of rows) {
        if (canonicalAuditJson(row) !== canonicalAuditJson(planned.get(row.id)))
          throw new Error('Calendar targets inserted values mismatch');
        if (row.deletedAt !== 'null')
          throw new Error('Calendar targets inserted tombstone');
      }
      assertNativeCrmDeleteFilesEmpty(shape, rows);
      state.expected.set(name, [...expected, ...rows]);
      await this.verifyCalendarTargetGraph(state);
    }
  }
  private async castCalendarTargetImage(
    state: CalendarTargetState,
    shape: NativeCrmAuditTableShape,
    columns: Record<string, unknown>,
    before?: CalendarSaveSnapshot,
  ): Promise<CalendarSaveSnapshot> {
    return castCalendarProofImage(state.scope, shape, columns, before);
  }
  private async updateCalendarTargets(
    state: CalendarTargetState,
    name: 'calendarEventTarget',
    records: { criteria: string; partialEntity: Record<string, unknown> }[],
  ) {
    const shape = state.shapes.get(name)!;
    // Ordered batches retain the existing behavior when two provider events share one record.
    for (let offset = 0; offset < records.length; ) {
      const batch: typeof records = [];
      const ids = new Set<string>();
      while (
        offset < records.length &&
        batch.length < 100 &&
        !ids.has(records[offset].criteria)
      ) {
        const record = records[offset++];
        if (!isUUID(record.criteria))
          throw new Error('Calendar targets invalid update identity');
        ids.add(record.criteria);
        batch.push(record);
      }
      await this.verifyCalendarTargetGraph(state);
      const expected = state.expected.get(name)!;
      const after = new Map<string, CalendarSaveSnapshot>();
      for (const record of batch) {
        const before = expected.find((row) => row.id === record.criteria);
        if (!before || before.deletedAt !== 'null')
          throw new Error('Calendar targets requires live update parent');
        const columns = this.calendarTargetColumns(shape, record.partialEntity);
        const image = await this.castCalendarTargetImage(
          state,
          shape,
          { ...columns, id: record.criteria },
          before,
        );
        after.set(record.criteria, image);
        const changedColumns = Object.keys(image).filter(
          (column) => column !== 'id' && image[column] !== before[column],
        );
        const patch =
          '{' +
          changedColumns
            .map(
              (column) => JSON.stringify(column) + ':' + String(image[column]),
            )
            .join(',') +
          '}';
        await assertNoReferentialUpdateEffects(
          {
            execute: ({ text, values }) =>
              state.scope.executeRawQuery(text, values),
          },
          {
            kind: 'update',
            alias: 'calendar_matching_parent',
            tableShape: shape,
            setClauses: changedColumns.map((columnName) => ({
              columnName,
              valueExpression: `(jsonb_populate_record(NULL::${calendarSaveTableSql(shape)},$2::jsonb)).${quoteCalendarSaveIdentifier(columnName)}`,
            })),
          },
          {},
          '"calendar_matching_parent".id=$1::uuid AND $2::jsonb IS NOT NULL',
          (text) => ({
            text,
            values: [record.criteria, patch],
          }),
        );
      }
      const result = await state.scope
        .getRepository(name, { shouldBypassPermissionChecks: true })
        .updateMany(batch);
      const actual = new Set(calendarSaveActualIds(result, [...ids]));
      state.expected.set(
        name,
        expected.map((row) => (actual.has(row.id) ? after.get(row.id)! : row)),
      );
      await this.verifyCalendarTargetGraph(state);
    }
  }
  private async deleteCalendarTargets(
    state: CalendarTargetState,
    ids: string[],
  ) {
    if (!ids.length) return;
    await this.verifyCalendarTargetGraph(state);
    const name = 'calendarEventTarget';
    const shape = state.shapes.get(name)!;
    const before = state.expected.get(name)!;
    const selected = before.filter((row) => ids.includes(row.id));
    if (
      new Set(ids).size !== ids.length ||
      selected.length !== ids.length ||
      selected.some((row) => row.deletedAt !== 'null')
    )
      throw new Error('Calendar targets invalid target deletion');
    assertNativeCrmDeleteFilesEmpty(shape, selected);
    for (const reference of await getIncomingRecordForeignKeys(
      state.scope,
      shape.schemaName,
      shape.tableName,
    )) {
      if (!['c', 'n', 'd'].includes(reference.deleteAction)) continue;
      const join = reference.childColumns
        .map(
          (column, index) =>
            'child.' +
            quoteCalendarSaveIdentifier(column) +
            '=parent.' +
            quoteCalendarSaveIdentifier(reference.parentColumns[index]),
        )
        .join(' AND ');
      if (
        (
          await state.scope.executeRawQuery(
            'SELECT 1 FROM ' +
              quoteCalendarSaveIdentifier(reference.schemaName) +
              '.' +
              quoteCalendarSaveIdentifier(reference.tableName) +
              ' child JOIN ' +
              calendarSaveTableSql(shape) +
              ' parent ON ' +
              join +
              ' WHERE parent.id=ANY($1::uuid[]) LIMIT 1',
            [ids],
          )
        ).length
      )
        throw new Error(
          'Calendar targets excludes unsupported target cascade effects',
        );
    }
    const result = await state.scope
      .getRepository(name, { shouldBypassPermissionChecks: true })
      .delete(ids, { columnsToReturn: ['id'] });
    const actual = new Set(calendarSaveActualIds(result, ids));
    state.expected.set(
      name,
      before.filter((row) => !actual.has(row.id)),
    );
    await this.verifyCalendarTargetGraph(state);
  }
  private async finishCalendarTargetAudit(state: CalendarTargetState) {
    await this.verifyCalendarTargetGraph(state);
    for (const name of ['calendarEventTarget'] as const) {
      const shape = state.shapes.get(name)!;
      const before = new Map(
        state.before.get(name)!.map((row) => [row.id, row]),
      );
      const after = new Map(
        state.expected.get(name)!.map((row) => [row.id, row]),
      );
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const previous = before.get(id),
          current = after.get(id);
        if (
          canonicalAuditJson(previous ?? null) ===
          canonicalAuditJson(current ?? null)
        )
          continue;
        state.audit.record({
          resourceKind: 'crmRecord',
          resourceId: id,
          action: previous ? (current ? 'update' : 'delete') : 'create',
          before: previous
            ? captureNativeCrmAuditSnapshot(shape, previous)
            : null,
          after: current ? captureNativeCrmAuditSnapshot(shape, current) : null,
          implicitUpdatedAtFieldId:
            previous && current
              ? shape.columnShapeByColumnName.updatedAt?.fieldMetadataId
              : undefined,
          securityDescriptor: {
            resourceKind: 'crmRecord',
            resourceId: id,
            objectMetadataId: shape.objectMetadataId,
            ...(!current
              ? {
                  deletedRecord: {
                    access: 'currentWorkspaceAdministration' as const,
                  },
                }
              : {}),
          },
        });
      }
    }
    await state.audit.flush();
    await state.scope.executeRawQuery('SET CONSTRAINTS ALL IMMEDIATE');
    await this.verifyCalendarTargetGraph(state);
  }

  public async reconcileParticipantTargets({
    sourceRecordIds,
    objectMetadataName,
    transactionScope,
  }: {
    sourceRecordIds: string[];
    objectMetadataName: 'messageParticipant' | 'calendarEventParticipant';
    transactionScope?: WorkspaceTransactionScope;
  }): Promise<void> {
    if (objectMetadataName === 'messageParticipant') {
      await this.reconcileMessageThreadTargetsFromMessageIds({
        messageIds: sourceRecordIds,
        transactionScope,
      });

      return;
    }

    await this.reconcileCalendarEventTargets({
      calendarEventIds: sourceRecordIds,
      transactionScope,
    });
  }

  public async reconcileCalendarEventTargets({
    calendarEventIds,
    transactionScope,
  }: {
    calendarEventIds: string[];
    transactionScope?: WorkspaceTransactionScope;
  }): Promise<void> {
    for (const calendarEventIdChunk of chunk(
      [...new Set(calendarEventIds)],
      QUERY_MAX_RECORDS,
    )) {
      const participantRepository =
        await this.getRepository<CalendarEventParticipantWorkspaceEntity>(
          'calendarEventParticipant',
          transactionScope,
        );

      const participants = await participantRepository.find({
        where: { calendarEventId: In(calendarEventIdChunk) },
        select: { calendarEventId: true, personId: true },
      });

      await this.reconcileTargets({
        parentIds: calendarEventIdChunk,
        parentFieldName: 'calendarEventId',
        participantPersonIdsByParentId: this.groupParticipantPersonIds({
          participants,
          getParentId: (participant) => participant.calendarEventId,
        }),
        targetObjectName: 'calendarEventTarget',
        transactionScope,
      });
    }
  }

  public async reconcileMessageThreadTargetsFromMessageIds({
    messageIds,
    transactionScope,
  }: {
    messageIds: string[];
    transactionScope?: WorkspaceTransactionScope;
  }): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const messageRepository = await this.getRepository<MessageWorkspaceEntity>(
      'message',
      transactionScope,
    );
    const changedMessages: Pick<
      MessageWorkspaceEntity,
      'id' | 'messageThreadId'
    >[] = [];

    for (const messageIdChunk of chunk(
      [...new Set(messageIds)],
      QUERY_MAX_RECORDS,
    )) {
      changedMessages.push(
        ...(await messageRepository.find({
          where: { id: In(messageIdChunk) },
          select: { id: true, messageThreadId: true },
        })),
      );
    }
    const messageThreadIds = [
      ...new Set(
        changedMessages
          .map(({ messageThreadId }) => messageThreadId)
          .filter(isDefined),
      ),
    ];

    await this.reconcileMessageThreadTargets({
      messageThreadIds,
      transactionScope,
    });
  }

  public async reconcileMessageThreadTargets({
    messageThreadIds,
    transactionScope,
  }: {
    messageThreadIds: string[];
    transactionScope?: WorkspaceTransactionScope;
  }): Promise<void> {
    if (messageThreadIds.length === 0) return;
    const workspaceId = getWorkspaceContext().authContext.workspace.id;
    if (transactionScope && transactionScope.workspaceId !== workspaceId) {
      throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
    }
    const ownedThreadIds = await findOmniOwnedMessageThreadIds(
      transactionScope ?? {
        executeRawQuery: (sql, parameters) =>
          this.coreDataSource.query(sql, parameters),
      },
      workspaceId,
      messageThreadIds,
    );
    messageThreadIds = messageThreadIds.filter(
      (id) => !ownedThreadIds.has(id.toLowerCase()),
    );
    if (messageThreadIds.length === 0) return;

    const messageRepository = await this.getRepository<MessageWorkspaceEntity>(
      'message',
      transactionScope,
    );

    for (const messageThreadIdChunk of chunk(
      [...new Set(messageThreadIds)],
      QUERY_MAX_RECORDS,
    )) {
      const threadMessages = await messageRepository.find({
        where: { messageThreadId: In(messageThreadIdChunk) },
        select: { id: true, messageThreadId: true },
      });
      const messageThreadIdByMessageId = new Map<string, string>();

      for (const { id, messageThreadId } of threadMessages) {
        if (isDefined(messageThreadId)) {
          messageThreadIdByMessageId.set(id, messageThreadId);
        }
      }

      const participantRepository =
        await this.getRepository<MessageParticipantWorkspaceEntity>(
          'messageParticipant',
          transactionScope,
        );
      const messageIds = [...messageThreadIdByMessageId.keys()];
      const participants: Pick<
        MessageParticipantWorkspaceEntity,
        'messageId' | 'personId'
      >[] = [];

      for (const messageIdChunk of chunk(messageIds, QUERY_MAX_RECORDS)) {
        participants.push(
          ...(await participantRepository.find({
            where: { messageId: In(messageIdChunk) },
            select: { messageId: true, personId: true },
          })),
        );
      }

      await this.reconcileTargets({
        parentIds: messageThreadIdChunk,
        parentFieldName: 'messageThreadId',
        participantPersonIdsByParentId: this.groupParticipantPersonIds({
          participants,
          getParentId: (participant) =>
            messageThreadIdByMessageId.get(participant.messageId),
        }),
        targetObjectName: 'messageThreadTarget',
        transactionScope,
      });
    }
  }

  private async reconcileTargets({
    parentIds,
    parentFieldName,
    participantPersonIdsByParentId,
    targetObjectName,
    transactionScope,
  }: {
    parentIds: string[];
    parentFieldName: TargetParentFieldName;
    participantPersonIdsByParentId: Map<string, Set<string>>;
    targetObjectName: 'calendarEventTarget' | 'messageThreadTarget';
    transactionScope?: WorkspaceTransactionScope;
  }): Promise<void> {
    if (parentIds.length === 0) {
      return;
    }

    // Target junction objects exist only after the upgrade metadata sync; no-op until then so imports keep
    // succeeding, and the following backfill covers the gap
    if (
      !isDefined(getWorkspaceContext().objectIdByNameSingular[targetObjectName])
    ) {
      return;
    }

    const desiredTargets = await this.buildDesiredTargets({
      parentIds,
      participantPersonIdsByParentId,
      transactionScope,
    });
    const targetRepository = await this.getRepository<TargetWorkspaceEntity>(
      targetObjectName,
      transactionScope,
    );
    const existingTargetRows = await targetRepository.find({
      where: { [parentFieldName]: In(parentIds) },
      withDeleted: true,
    });
    const existingTargets = existingTargetRows
      .map((target): ExistingTarget | null => {
        const parentId = target[parentFieldName];

        if (!isDefined(parentId)) {
          return null;
        }

        return {
          ...target,
          parentId,
        };
      })
      .filter(isDefined);
    const operations = computeTargetReconciliationOperations({
      desiredTargets,
      existingTargets,
    });

    // Targets per parent are unbounded, so re-chunk under the ORM's per-call record cap
    for (const targetsToCreateChunk of chunk(
      operations.targetsToCreate,
      QUERY_MAX_RECORDS,
    )) {
      await targetRepository.insert(
        targetsToCreateChunk.map(({ parentId, ...target }) => ({
          ...target,
          [parentFieldName]: parentId,
          isAutomaticallyAssigned: true,
          isManuallyAssigned: false,
        })),
        { onConflictDoNothing: true },
      );
    }

    for (const targetIdsToMarkAutomaticChunk of chunk(
      operations.targetsToMarkAutomatic,
      QUERY_MAX_RECORDS,
    )) {
      await targetRepository.updateMany(
        targetIdsToMarkAutomaticChunk.map((id) => ({
          criteria: id,
          partialEntity: { isAutomaticallyAssigned: true },
        })),
      );
    }

    for (const targetIdsToMarkNotAutomaticChunk of chunk(
      operations.targetsToMarkNotAutomatic,
      QUERY_MAX_RECORDS,
    )) {
      await targetRepository.updateMany(
        targetIdsToMarkNotAutomaticChunk.map((id) => ({
          criteria: id,
          partialEntity: { isAutomaticallyAssigned: false },
        })),
      );
    }

    for (const targetIdsToDeleteChunk of chunk(
      operations.targetIdsToDelete,
      QUERY_MAX_RECORDS,
    )) {
      await targetRepository.delete({
        id: In(targetIdsToDeleteChunk),
      });
    }
  }

  private async buildDesiredTargets({
    parentIds,
    participantPersonIdsByParentId,
    transactionScope,
  }: {
    parentIds: string[];
    participantPersonIdsByParentId: Map<string, Set<string>>;
    transactionScope?: WorkspaceTransactionScope;
  }): Promise<TargetIdentity[]> {
    const personIds = [
      ...new Set(
        [...participantPersonIdsByParentId.values()].flatMap((ids) => [...ids]),
      ),
    ];

    if (personIds.length === 0) {
      return [];
    }

    const personRepository = await this.getRepository<PersonWorkspaceEntity>(
      'person',
      transactionScope,
    );
    const people = await personRepository.find({
      where: { id: In(personIds) },
      select: { id: true, companyId: true },
    });
    // find() excludes soft-deleted people, matching the backfill which joins live people only
    const livePersonIds = new Set(people.map(({ id }) => id));
    const companyIdByPersonId = new Map(
      people.map(({ id, companyId }) => [id, companyId]),
    );

    const opportunityRepository =
      await this.getRepository<OpportunityWorkspaceEntity>(
        'opportunity',
        transactionScope,
      );
    const opportunities = await opportunityRepository.find({
      where: { pointOfContactId: In(personIds) },
      select: { id: true, pointOfContactId: true },
    });
    const opportunityIdsByPersonId = new Map<string, string[]>();

    for (const opportunity of opportunities) {
      if (!isDefined(opportunity.pointOfContactId)) {
        continue;
      }

      const opportunityIds =
        opportunityIdsByPersonId.get(opportunity.pointOfContactId) ?? [];

      opportunityIds.push(opportunity.id);
      opportunityIdsByPersonId.set(
        opportunity.pointOfContactId,
        opportunityIds,
      );
    }

    return parentIds.flatMap((parentId) =>
      [...(participantPersonIdsByParentId.get(parentId) ?? [])].flatMap(
        (personId): TargetIdentity[] => {
          if (!livePersonIds.has(personId)) {
            return [];
          }

          const companyId = companyIdByPersonId.get(personId);
          const opportunityIds = opportunityIdsByPersonId.get(personId) ?? [];

          return [
            {
              parentId,
              targetPersonId: personId,
              targetCompanyId: null,
              targetOpportunityId: null,
            },
            ...(isDefined(companyId)
              ? [
                  {
                    parentId,
                    targetPersonId: null,
                    targetCompanyId: companyId,
                    targetOpportunityId: null,
                  },
                ]
              : []),
            ...opportunityIds.map((opportunityId) => ({
              parentId,
              targetPersonId: null,
              targetCompanyId: null,
              targetOpportunityId: opportunityId,
            })),
          ];
        },
      ),
    );
  }

  private groupParticipantPersonIds<
    Participant extends { personId: string | null },
  >({
    participants,
    getParentId,
  }: {
    participants: Participant[];
    getParentId: (participant: Participant) => string | undefined;
  }): Map<string, Set<string>> {
    const personIdsByParentId = new Map<string, Set<string>>();

    for (const participant of participants) {
      const parentId = getParentId(participant);
      const personId = participant.personId;

      if (!isDefined(parentId) || !isDefined(personId)) {
        continue;
      }

      const personIds = personIdsByParentId.get(parentId) ?? new Set<string>();

      personIds.add(personId);
      personIdsByParentId.set(parentId, personIds);
    }

    return personIdsByParentId;
  }

  private async getRepository<T extends ObjectLiteral>(
    objectMetadataName: string,
    transactionScope?: WorkspaceTransactionScope,
  ): Promise<WorkspaceRepository<T>> {
    return getWorkspaceRepositoryWithOptionalTransaction<T>({
      objectMetadataName,
      transactionScope,
      workspaceOrmManager: this.workspaceOrmManager,
      rolePermissionConfig: { shouldBypassPermissionChecks: true },
    });
  }
}
