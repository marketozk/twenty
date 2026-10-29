import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import {
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'twenty-shared/application-runtime';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
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
  calendarSaveSnapshotJson,
  type CalendarSaveTable,
  type CalendarSaveSnapshot,
} from 'src/engine/core-modules/crm-audit/calendar-save-proof';
import { getIssuedNativeCleanupMetadata } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';
import { assertNoReferentialUpdateEffects } from 'src/engine/twenty-orm/utils/assert-no-referential-update-effects';
import {
  computeTargetReconciliationOperations,
  type ExistingTarget,
  type TargetIdentity,
} from 'src/modules/match-participant/utils/compute-target-reconciliation-operations.util';
import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';

import chunk from 'lodash.chunk';
import { MessageChannelType } from 'twenty-shared/types';
import { isDefined, isNonEmptyArray } from 'twenty-shared/utils';
import { Any, DataSource, In, Repository } from 'typeorm';

import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { getWorkspaceRepositoryWithOptionalTransaction } from 'src/engine/twenty-orm/utils/get-workspace-repository-with-optional-transaction.util';
import { type CalendarEventParticipantWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-event-participant.workspace-entity';
import { ParticipantTargetReconciliationService } from 'src/modules/match-participant/participant-target-reconciliation.service';
import { addPersonEmailFiltersToQueryBuilder } from 'src/modules/match-participant/utils/add-person-email-filters-to-query-builder';
import { findPersonByPrimaryOrAdditionalEmail } from 'src/modules/match-participant/utils/find-person-by-primary-or-additional-email';
import { type MessageChannelMessageAssociationWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-channel-message-association.workspace-entity';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import { type PersonWorkspaceEntity } from 'src/modules/person/standard-objects/person.workspace-entity';
import { WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';
import { findOmniOwnedMessageIds } from 'src/modules/omnichannel/services/find-omni-owned-native-record-ids';

type ObjectMetadataName = 'messageParticipant' | 'calendarEventParticipant';

type GetParticipantRepositoryArgs = {
  objectMetadataName: ObjectMetadataName;
  transactionScope?: WorkspaceTransactionScope;
};

type MatchParticipantsForWorkspaceMembersArgs = {
  participantMatching: {
    workspaceMemberIds: string[];
  };
  objectMetadataName: ObjectMetadataName;
  workspaceId: string;
};

type MatchParticipantsForPeopleArgs = {
  participantMatching: {
    personEmails: string[];
  };
  objectMetadataName: ObjectMetadataName;
  workspaceId: string;
};

export type MatchParticipantsArgs<
  ParticipantWorkspaceEntity extends
    | Pick<
        CalendarEventParticipantWorkspaceEntity,
        'id' | 'handle' | 'workspaceMemberId' | 'personId' | 'calendarEventId'
      >
    | Pick<
        MessageParticipantWorkspaceEntity,
        'id' | 'handle' | 'workspaceMemberId' | 'personId' | 'messageId'
      >,
> = {
  participants: ParticipantWorkspaceEntity[];
  sourceRecordIds: string[];
  objectMetadataName: ObjectMetadataName;
  matchWith:
    | 'workspaceMemberOnly'
    | 'personOnly'
    | 'workspaceMemberAndPerson'
    | 'targetsOnly';
  transactionScope?: WorkspaceTransactionScope;
};

export type CalendarParticipantRematchSelector =
  | { kind: 'personOnly'; personEmails: readonly string[] }
  | { kind: 'workspaceMemberOnly'; workspaceMemberIds: readonly string[] };

type CalendarRematchSelection = {
  selector: CalendarParticipantRematchSelector;
  discovered: { id: string; calendarEventId: string }[];
};

const MATCHING_SOURCE_TABLES = [
  'person',
  'workspaceMember',
  'company',
  'opportunity',
] as const;
type CalendarMatchingSource = (typeof MATCHING_SOURCE_TABLES)[number];
type CalendarMatchingTable = CalendarSaveTable | CalendarMatchingSource;
type CalendarMatchingState = {
  scope: WorkspaceTransactionScope;
  audit: CrmAuditTransactionContext;
  shapes: Map<CalendarMatchingTable, NativeCrmAuditTableShape>;
  before: Map<CalendarSaveTable, CalendarSaveSnapshot[]>;
  expected: Map<CalendarSaveTable, CalendarSaveSnapshot[]>;
  rootIds: string[];
  participantIds: string[];
  handleBatches: string[][];
  personIds: string[];
  memberIds: string[];
  originalSourceIds: Map<CalendarMatchingSource, string[]>;
  sources: Map<CalendarMatchingSource, CalendarSaveSnapshot[]>;
};

@Injectable()
export class MatchParticipantService<
  ParticipantWorkspaceEntity extends
    | CalendarEventParticipantWorkspaceEntity
    | MessageParticipantWorkspaceEntity,
> {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly participantTargetReconciliationService: ParticipantTargetReconciliationService,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    @InjectDataSource()
    private readonly coreDataSource: DataSource,
  ) {}

  public async matchCalendarImportParticipantsWithAudit({
    workspaceId,
    participantIds,
    eventIds,
    operation,
  }: {
    workspaceId: string;
    participantIds: readonly string[];
    eventIds: readonly string[];
    operation: CrmAuditOperation;
  }): Promise<void> {
    if (
      !isUUID(workspaceId) ||
      !operation ||
      operation.workspaceId !== workspaceId ||
      !isUUID(operation.operationId) ||
      !Array.isArray(participantIds) ||
      !Array.isArray(eventIds) ||
      eventIds.length > 1000 ||
      [...participantIds, ...eventIds].some(
        (id) => typeof id !== 'string' || !isUUID(id),
      )
    )
      throw new Error(
        'Calendar matching requires scoped input and audit identity',
      );
    participantIds = [...new Set(participantIds.map((id) => id.toLowerCase()))];
    eventIds = [...new Set(eventIds.map((id) => id.toLowerCase()))];
    operation = {
      ...operation,
      operationId: randomUUID(),
      actor: { ...operation.actor },
      ...(operation.initiator ? { initiator: { ...operation.initiator } } : {}),
    };
    await this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        this.workspaceOrmManager.runInWorkspaceTransaction(
          async (scope) => {
            const state = await this.prepareCalendarMatching(
              scope,
              operation,
              [...eventIds],
              [...participantIds],
            );
            await this.runCalendarMatchingStage(state, {
              participantIds: [...participantIds],
              eventIds: [...eventIds],
              matchWith: 'both',
            });
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        ),
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }

  public async rematchCalendarParticipantsWithAudit({
    workspaceId,
    operation,
    selector,
    afterParticipantId,
  }: {
    workspaceId: string;
    operation: CrmAuditOperation;
    selector: CalendarParticipantRematchSelector;
    afterParticipantId?: string;
  }): Promise<{ nextCursor: string | null }> {
    if (
      !isUUID(workspaceId) ||
      !operation ||
      operation.workspaceId !== workspaceId ||
      !isUUID(operation.operationId) ||
      (afterParticipantId !== undefined && !isUUID(afterParticipantId)) ||
      !selector ||
      (selector.kind !== 'personOnly' &&
        selector.kind !== 'workspaceMemberOnly')
    )
      throw new Error(
        'Calendar rematch requires scoped input and audit identity',
      );
    if (selector.kind === 'personOnly') {
      if (
        !Array.isArray(selector.personEmails) ||
        selector.personEmails.some((email) => typeof email !== 'string')
      )
        throw new Error('Calendar rematch requires email selection');
      selector = {
        kind: 'personOnly',
        personEmails: [
          ...new Set(selector.personEmails.map((email) => email.toLowerCase())),
        ],
      };
    } else {
      if (
        !Array.isArray(selector.workspaceMemberIds) ||
        selector.workspaceMemberIds.some(
          (id) => typeof id !== 'string' || !isUUID(id),
        )
      )
        throw new Error('Calendar rematch requires member selection');
      selector = {
        kind: 'workspaceMemberOnly',
        workspaceMemberIds: [
          ...new Set(selector.workspaceMemberIds.map((id) => id.toLowerCase())),
        ],
      };
    }
    operation = {
      ...operation,
      operationId: randomUUID(),
      actor: { ...operation.actor },
      ...(operation.initiator ? { initiator: { ...operation.initiator } } : {}),
    };
    const capturedSelector = selector;
    const criteria =
      capturedSelector.kind === 'personOnly'
        ? capturedSelector.personEmails
        : capturedSelector.workspaceMemberIds;
    const cursor = afterParticipantId?.toLowerCase() ?? null;
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        this.workspaceOrmManager.runInWorkspaceTransaction(
          async (scope) => {
            const state = await this.prepareCalendarMatching(
              scope,
              operation,
              [],
              [],
            );
            const predicate =
              capturedSelector.kind === 'personOnly'
                ? 'LOWER("handle")=ANY($1::text[])'
                : '"workspaceMemberId"=ANY($1::uuid[])';
            const discoveredRows = await scope.executeRawQuery(
              `SELECT id,"calendarEventId" FROM ${calendarSaveTableSql(state.shapes.get('calendarEventParticipant')!)} WHERE "deletedAt" IS NULL AND ${predicate} AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 200`,
              [[...criteria], cursor],
            );
            const discovered = discoveredRows.map((row) => {
              if (
                typeof row.id !== 'string' ||
                !isUUID(row.id) ||
                typeof row.calendarEventId !== 'string' ||
                !isUUID(row.calendarEventId)
              )
                throw new Error(
                  'Calendar rematch requires participant parent identity',
                );
              return { id: row.id, calendarEventId: row.calendarEventId };
            });
            state.rootIds = [
              ...new Set(discovered.map((row) => row.calendarEventId)),
            ];
            state.participantIds = discovered.map((row) => row.id);
            await this.runCalendarMatchingStage(state, {
              participantIds: state.participantIds,
              eventIds: state.rootIds,
              matchWith: capturedSelector.kind,
              selection: { selector: capturedSelector, discovered },
            });
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

  private async runCalendarMatchingStage(
    state: CalendarMatchingState,
    {
      participantIds,
      eventIds,
      matchWith,
      selection,
    }: {
      participantIds: readonly string[];
      eventIds: readonly string[];
      matchWith: 'both' | 'personOnly' | 'workspaceMemberOnly';
      selection?: CalendarRematchSelection;
    },
  ): Promise<void> {
    for (const name of CALENDAR_SAVE_TABLES) {
      const rows = await this.readMatchingGraph(state, name, true);
      state.before.set(name, rows);
      state.expected.set(name, rows);
    }
    const requested = new Map(
      state.before.get('calendarEventParticipant')!.map((row) => [row.id, row]),
    );
    let participants = participantIds
      .map((id) => requested.get(id))
      .filter(
        (row): row is CalendarSaveSnapshot =>
          !!row &&
          row.deletedAt === 'null' &&
          eventIds.includes(JSON.parse(String(row.calendarEventId))),
      );
    if (selection) {
      const parents = new Map(
        selection.discovered.map((row) => [row.id, row.calendarEventId]),
      );
      participants = participants.filter((row) => {
        const parentId = JSON.parse(String(row.calendarEventId)) as string;
        if (parents.get(row.id) !== parentId) return false;
        if (selection.selector.kind === 'personOnly') {
          const handle = JSON.parse(String(row.handle)) as string | null;
          return (
            handle !== null &&
            selection.selector.personEmails.includes(handle.toLowerCase())
          );
        }
        const memberId = JSON.parse(String(row.workspaceMemberId)) as
          | string
          | null;
        return (
          memberId !== null &&
          selection.selector.workspaceMemberIds.includes(memberId)
        );
      });
      eventIds = [
        ...new Set(
          participants.map(
            (row) => JSON.parse(String(row.calendarEventId)) as string,
          ),
        ),
      ];
    }
    state.handleBatches = chunk(participants, 200).map((rows) => [
      ...new Set(
        rows
          .map((row) => JSON.parse(String(row.handle)) as string | null)
          .filter((handle): handle is string => handle !== null),
      ),
    ]);
    const candidates = await this.readMatchingCandidates(state);
    state.personIds = [
      ...new Set([
        ...candidates.flatMap((batch) =>
          batch.people.map((person) => person.id),
        ),
        ...state.before
          .get('calendarEventParticipant')!
          .flatMap((row) =>
            row.personId === 'null'
              ? []
              : [JSON.parse(String(row.personId)) as string],
          ),
      ]),
    ];
    state.memberIds = [
      ...new Set([
        ...candidates.flatMap((batch) =>
          batch.members.map((member) => member.id),
        ),
        ...state.before
          .get('calendarEventParticipant')!
          .flatMap((row) =>
            row.workspaceMemberId === 'null'
              ? []
              : [JSON.parse(String(row.workspaceMemberId)) as string],
          ),
      ]),
    ];
    state.sources = await this.readMatchingSources(state);
    for (const name of MATCHING_SOURCE_TABLES)
      state.originalSourceIds.set(
        name,
        state.sources.get(name)!.map((row) => row.id),
      );
    await this.verifyMatchingGraph(state);
    const updates: {
      criteria: string;
      partialEntity: Record<string, unknown>;
    }[] = [];
    for (const [index, batch] of chunk(participants, 200).entries()) {
      for (const participant of batch) {
        const handle =
          (JSON.parse(String(participant.handle)) as string | null) ?? '';
        const person = findPersonByPrimaryOrAdditionalEmail({
          people: candidates[index].people,
          email: handle,
        });
        const member = candidates[index].members.find(
          (candidate) => candidate.userEmail === handle,
        );
        const personId =
          matchWith === 'workspaceMemberOnly'
            ? (JSON.parse(String(participant.personId)) as string | null)
            : (person?.id ?? null);
        const workspaceMemberId =
          matchWith === 'personOnly'
            ? (JSON.parse(String(participant.workspaceMemberId)) as
                | string
                | null)
            : (member?.id ?? null);
        if (
          participant.personId !== JSON.stringify(personId) ||
          participant.workspaceMemberId !== JSON.stringify(workspaceMemberId)
        )
          updates.push({
            criteria: participant.id,
            partialEntity: {
              ...(matchWith !== 'workspaceMemberOnly' ? { personId } : {}),
              ...(matchWith !== 'personOnly' ? { workspaceMemberId } : {}),
            },
          });
      }
    }
    await this.updateMatchingRecords(
      state,
      'calendarEventParticipant',
      updates,
    );
    if (matchWith !== 'workspaceMemberOnly') {
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
        const parentId = JSON.parse(String(row.calendarEventId)) as string;
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
          targetOpportunityId: JSON.parse(String(row.targetOpportunityId)),
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
      await this.insertMatchingTargets(
        state,
        plan.targetsToCreate.map(({ parentId, ...target }) => ({
          id: randomUUID(),
          calendarEventId: parentId,
          ...target,
          isAutomaticallyAssigned: true,
          isManuallyAssigned: false,
        })),
      );
      await this.updateMatchingRecords(state, 'calendarEventTarget', [
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
        await this.deleteMatchingTargets(state, ids);
    }
    await this.finishMatchingAudit(state);
  }

  private async prepareCalendarMatching(
    scope: WorkspaceTransactionScope,
    operation: CrmAuditOperation,
    rootIds: string[],
    participantIds: string[],
  ): Promise<CalendarMatchingState> {
    const context = getIssuedNativeCleanupMetadata(scope);
    if (
      context.authType !== 'system' ||
      context.authWorkspaceId !== scope.workspaceId ||
      operation.workspaceId !== scope.workspaceId
    )
      throw new Error(
        'Calendar matching requires issued scoped system authority',
      );
    const shapes = new Map<CalendarMatchingTable, NativeCrmAuditTableShape>();
    for (const name of [...CALENDAR_SAVE_TABLES, ...MATCHING_SOURCE_TABLES]) {
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
        throw new Error('Calendar matching requires exact standard metadata');
      const { metadata, shape } = candidates[0];
      if (
        shape.objectMetadataId !== metadata.id ||
        shape.nameSingular !== name ||
        shape.tableName !== name
      )
        throw new Error('Calendar matching table metadata mismatch');
      shapes.set(name, shape);
    }
    if (
      new Set([...shapes.values()].map((shape) => shape.schemaName)).size !== 1
    )
      throw new Error('Calendar matching schema mismatch');
    await scope.executeRawQuery("SET LOCAL lock_timeout='8s'");
    const [workspace] = await scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
      [scope.workspaceId],
    );
    if (!workspace || workspace.deletedAt !== null)
      throw new Error('Calendar matching requires active workspace');
    // Freeze candidate absence as well as rows. No provider or queue work occurs under these locks.
    await scope.executeRawQuery(
      'LOCK TABLE ' +
        MATCHING_SOURCE_TABLES.map((name) =>
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
        throw new Error('Calendar matching requires event foreign keys');
    }
    return {
      scope,
      shapes,
      rootIds,
      participantIds,
      before: new Map(),
      expected: new Map(),
      handleBatches: [],
      personIds: [],
      memberIds: [],
      originalSourceIds: new Map(),
      sources: new Map(),
      audit: new CrmAuditTransactionContext(
        createCrmAuditWorkspaceExecutor(scope),
        operation,
      ),
    };
  }

  private async readMatchingCandidates(state: CalendarMatchingState) {
    const personRepository = state.scope.getRepository<PersonWorkspaceEntity>(
      'person',
      { shouldBypassPermissionChecks: true },
    );
    const memberRepository =
      state.scope.getRepository<WorkspaceMemberWorkspaceEntity>(
        'workspaceMember',
        { shouldBypassPermissionChecks: true },
      );
    const result: {
      people: PersonWorkspaceEntity[];
      members: WorkspaceMemberWorkspaceEntity[];
    }[] = [];
    for (const handles of state.handleBatches) {
      const people = handles.length
        ? await addPersonEmailFiltersToQueryBuilder({
            queryBuilder: personRepository.createQueryBuilder('person'),
            emails: handles,
          })
            .orderBy('person.createdAt', 'ASC')
            .getMany<PersonWorkspaceEntity>()
        : [];
      const members = handles.length
        ? await memberRepository.find({ where: { userEmail: Any(handles) } })
        : [];
      result.push({ people, members });
    }
    return result;
  }

  private async readMatchingRows(
    state: CalendarMatchingState,
    name: CalendarMatchingTable,
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
      throw new Error('Calendar matching source disappeared');
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async readMatchingSources(
    state: CalendarMatchingState,
  ): Promise<Map<CalendarMatchingSource, CalendarSaveSnapshot[]>> {
    const candidates = await this.readMatchingCandidates(state);
    const result = new Map<CalendarMatchingSource, CalendarSaveSnapshot[]>();
    const selectIds = async (
      name: CalendarMatchingSource,
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
    const personIds = [
      ...new Set([
        ...state.personIds,
        ...candidates.flatMap((batch) => batch.people.map((row) => row.id)),
      ]),
    ];
    result.set(
      'person',
      await this.readMatchingRows(
        state,
        'person',
        await selectIds('person', 'id=ANY($1::uuid[])', [personIds]),
      ),
    );
    const memberIds = [
      ...new Set([
        ...state.memberIds,
        ...candidates.flatMap((batch) => batch.members.map((row) => row.id)),
      ]),
    ];
    result.set(
      'workspaceMember',
      await this.readMatchingRows(
        state,
        'workspaceMember',
        await selectIds('workspaceMember', 'id=ANY($1::uuid[])', [memberIds]),
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
      await this.readMatchingRows(
        state,
        'company',
        await selectIds('company', 'id=ANY($1::uuid[])', [companyIds]),
      ),
    );
    result.set(
      'opportunity',
      await this.readMatchingRows(
        state,
        'opportunity',
        await selectIds('opportunity', '"pointOfContactId"=ANY($1::uuid[])', [
          personIds,
        ]),
      ),
    );
    return result;
  }

  private async readMatchingGraph(
    state: CalendarMatchingState,
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
    const ids = (
      await state.scope.executeRawQuery(
        'SELECT id FROM ' +
          calendarSaveTableSql(state.shapes.get(name)!) +
          ' WHERE ' +
          quoteCalendarSaveIdentifier(
            name === 'calendarEvent' ? 'id' : 'calendarEventId',
          ) +
          '=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id' +
          (lock ? ' FOR UPDATE' : ''),
        [state.rootIds, originalIds],
      )
    ).map((row) => String(row.id));
    return this.readMatchingRows(state, name, ids);
  }

  private async verifyMatchingGraph(state: CalendarMatchingState) {
    const [workspace] = await state.scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1',
      [state.scope.workspaceId],
    );
    if (!workspace || workspace.deletedAt !== null)
      throw new Error('Calendar matching workspace changed');
    const sources = await this.readMatchingSources(state);
    for (const name of MATCHING_SOURCE_TABLES)
      if (
        canonicalAuditJson(sources.get(name)) !==
        canonicalAuditJson(state.sources.get(name))
      )
        throw new Error('Calendar matching sources changed');
    for (const name of CALENDAR_SAVE_TABLES)
      if (
        canonicalAuditJson(await this.readMatchingGraph(state, name)) !==
        canonicalAuditJson(
          [...(state.expected.get(name) ?? [])].sort((a, b) =>
            a.id.localeCompare(b.id),
          ),
        )
      )
        throw new Error('Calendar matching graph effects mismatch');
  }

  private matchingColumns(
    shape: NativeCrmAuditTableShape,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const allowed =
      shape.nameSingular === 'calendarEventParticipant'
        ? ['personId', 'workspaceMemberId']
        : [
            'id',
            'calendarEventId',
            'targetPersonId',
            'targetCompanyId',
            'targetOpportunityId',
            'isAutomaticallyAssigned',
            'isManuallyAssigned',
          ];
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const column = shape.columnShapeByColumnName[key];
      if (
        !allowed.includes(key) ||
        !column ||
        column.compositeParentFieldName ||
        column.fieldMetadataType === 'FILES'
      )
        throw new Error('Calendar matching field outside plan');
      result[key] = value;
    }
    return result;
  }

  private async insertMatchingTargets(
    state: CalendarMatchingState,
    records: ({ id: string } & Record<string, unknown>)[],
  ) {
    const name = 'calendarEventTarget';
    const shape = state.shapes.get(name)!;
    for (const batch of chunk(records, 200)) {
      await this.verifyMatchingGraph(state);
      const expected = state.expected.get(name)!;
      const planned = new Map<string, CalendarSaveSnapshot>();
      for (const row of batch) {
        if (expected.some((previous) => previous.id === row.id))
          throw new Error('Calendar matching target identity conflict');
        planned.set(
          row.id,
          await this.castMatchingImage(
            state,
            shape,
            this.matchingColumns(shape, row),
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
      const rows = await this.readMatchingRows(state, name, ids);
      for (const row of rows) {
        if (canonicalAuditJson(row) !== canonicalAuditJson(planned.get(row.id)))
          throw new Error('Calendar matching inserted values mismatch');
        if (row.deletedAt !== 'null')
          throw new Error('Calendar matching inserted tombstone');
      }
      assertNativeCrmDeleteFilesEmpty(shape, rows);
      state.expected.set(name, [...expected, ...rows]);
      await this.verifyMatchingGraph(state);
    }
  }

  private async castMatchingImage(
    state: CalendarMatchingState,
    shape: NativeCrmAuditTableShape,
    columns: Record<string, unknown>,
    before?: CalendarSaveSnapshot,
  ): Promise<CalendarSaveSnapshot> {
    const definitions = await state.scope.executeRawQuery(
      `SELECT attribute.attname AS name,attribute.attgenerated<>'' AS generated,pg_get_expr(definition.adbin,definition.adrelid) AS expression FROM pg_attribute attribute JOIN pg_attrdef definition ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum WHERE attribute.attrelid=$1::regclass AND NOT attribute.attisdropped ORDER BY attribute.attnum`,
      [calendarSaveTableSql(shape)],
    );
    const expression = (column: Record<string, unknown>) => {
      if (
        typeof column.name !== 'string' ||
        typeof column.expression !== 'string'
      )
        throw new Error('Calendar matching invalid column definition');
      return `jsonb_build_object('${column.name.replaceAll("'", "''")}',(${column.expression}))`;
    };
    const generated = definitions
      .filter((column) => column.generated === true)
      .map(expression);
    const defaults = before
      ? []
      : definitions
          .filter(
            (column) =>
              column.generated === false &&
              typeof column.name === 'string' &&
              !Object.prototype.hasOwnProperty.call(columns, column.name),
          )
          .map(expression);
    const [result] = await state.scope.executeRawQuery(
      `WITH previous AS (SELECT COALESCE(jsonb_object_agg(key,value::jsonb),'{}'::jsonb) AS data FROM jsonb_each_text($1::jsonb)), image AS (SELECT (jsonb_populate_record(NULL::${calendarSaveTableSql(shape)}, previous.data ${defaults.map((sql) => '|| ' + sql).join(' ')} || $2::jsonb ${before && shape.columnShapeByColumnName.updatedAt ? "|| jsonb_build_object('updatedAt',CURRENT_TIMESTAMP)" : ''})).* FROM previous) SELECT image.id,(SELECT jsonb_object_agg(key,value::text) FROM jsonb_each(to_jsonb(image) ${generated.map((sql) => '|| ' + sql).join(' ')})) AS snapshot FROM image`,
      [
        before ? calendarSaveSnapshotJson(before) : '{}',
        JSON.stringify(columns),
      ],
    );
    if (
      !result ||
      typeof result.id !== 'string' ||
      !result.snapshot ||
      typeof result.snapshot !== 'object'
    )
      throw new Error('Calendar matching cannot compute expected image');
    return { ...(result.snapshot as Record<string, unknown>), id: result.id };
  }

  private async updateMatchingRecords(
    state: CalendarMatchingState,
    name: 'calendarEventParticipant' | 'calendarEventTarget',
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
          throw new Error('Calendar matching invalid update identity');
        ids.add(record.criteria);
        batch.push(record);
      }
      await this.verifyMatchingGraph(state);
      const expected = state.expected.get(name)!;
      const after = new Map<string, CalendarSaveSnapshot>();
      for (const record of batch) {
        const before = expected.find((row) => row.id === record.criteria);
        if (!before || before.deletedAt !== 'null')
          throw new Error('Calendar matching requires live update parent');
        const columns = this.matchingColumns(shape, record.partialEntity);
        const image = await this.castMatchingImage(
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
      await this.verifyMatchingGraph(state);
    }
  }

  private async deleteMatchingTargets(
    state: CalendarMatchingState,
    ids: string[],
  ) {
    if (!ids.length) return;
    await this.verifyMatchingGraph(state);
    const name = 'calendarEventTarget';
    const shape = state.shapes.get(name)!;
    const before = state.expected.get(name)!;
    const selected = before.filter((row) => ids.includes(row.id));
    if (
      new Set(ids).size !== ids.length ||
      selected.length !== ids.length ||
      selected.some((row) => row.deletedAt !== 'null')
    )
      throw new Error('Calendar matching invalid target deletion');
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
          'Calendar matching excludes unsupported target cascade effects',
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
    await this.verifyMatchingGraph(state);
  }

  private async finishMatchingAudit(state: CalendarMatchingState) {
    await this.verifyMatchingGraph(state);
    for (const name of [
      'calendarEventParticipant',
      'calendarEventTarget',
    ] as const) {
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
    await this.verifyMatchingGraph(state);
  }

  private getParticipantRepository({
    objectMetadataName,
    transactionScope,
  }: GetParticipantRepositoryArgs) {
    return getWorkspaceRepositoryWithOptionalTransaction<ParticipantWorkspaceEntity>(
      {
        objectMetadataName,
        transactionScope,
        workspaceOrmManager: this.workspaceOrmManager,
        rolePermissionConfig: { shouldBypassPermissionChecks: true },
      },
    );
  }

  public async matchParticipants({
    participants,
    sourceRecordIds,
    objectMetadataName,
    matchWith = 'workspaceMemberAndPerson',
    transactionScope,
  }: MatchParticipantsArgs<ParticipantWorkspaceEntity>) {
    if (objectMetadataName === 'messageParticipant') {
      const workspaceId = this.workspaceOrmManager.getWorkspaceId();
      if (transactionScope && transactionScope.workspaceId !== workspaceId) {
        throw new Error('OMNI_NATIVE_OWNERSHIP_WORKSPACE_MISMATCH');
      }
      const ownedMessageIds = await findOmniOwnedMessageIds(
        transactionScope ?? {
          executeRawQuery: (sql, parameters) =>
            this.coreDataSource.query(sql, parameters),
        },
        workspaceId,
        [...sourceRecordIds, ...this.getSourceRecordIds(participants)],
      );
      participants = participants.filter(
        (participant) =>
          !ownedMessageIds.has(
            this.getSourceRecordId(participant).toLowerCase(),
          ),
      );
      sourceRecordIds = sourceRecordIds.filter(
        (id) => !ownedMessageIds.has(id.toLowerCase()),
      );
      if (participants.length === 0 && sourceRecordIds.length === 0) return;
    }

    // Targets derive from personId only, so a workspaceMemberOnly rematch cannot change them
    const shouldReconcileTargets = matchWith !== 'workspaceMemberOnly';

    // Sources with non-email handles only reconcile targets: matching them as emails would null out the
    // caller-supplied personId
    if (matchWith === 'targetsOnly') {
      await this.participantTargetReconciliationService.reconcileParticipantTargets(
        {
          sourceRecordIds,
          objectMetadataName,
          transactionScope,
        },
      );

      return;
    }

    if (participants.length === 0) {
      if (shouldReconcileTargets) {
        await this.participantTargetReconciliationService.reconcileParticipantTargets(
          {
            sourceRecordIds,
            objectMetadataName,
            transactionScope,
          },
        );
      }

      return;
    }

    const personRepository =
      getWorkspaceRepositoryWithOptionalTransaction<PersonWorkspaceEntity>({
        objectMetadataName: 'person',
        transactionScope,
        workspaceOrmManager: this.workspaceOrmManager,
        rolePermissionConfig: { shouldBypassPermissionChecks: true },
      });

    const participantRepository = this.getParticipantRepository({
      objectMetadataName,
      transactionScope,
    });

    const workspaceMemberRepository =
      getWorkspaceRepositoryWithOptionalTransaction<WorkspaceMemberWorkspaceEntity>(
        {
          objectMetadataName: 'workspaceMember',
          transactionScope,
          workspaceOrmManager: this.workspaceOrmManager,
          rolePermissionConfig: { shouldBypassPermissionChecks: true },
        },
      );

    const chunkSize = 200;
    const chunkedParticipants = chunk(participants, chunkSize);

    for (const participants of chunkedParticipants) {
      const uniqueParticipantsHandles = [
        ...new Set(participants.map((participant) => participant.handle)),
      ].filter(isDefined);

      const queryBuilder = addPersonEmailFiltersToQueryBuilder({
        queryBuilder: personRepository.createQueryBuilder('person'),
        emails: uniqueParticipantsHandles,
      });

      const people = await queryBuilder
        .orderBy('person.createdAt', 'ASC')
        .getMany<PersonWorkspaceEntity>();

      const workspaceMembers = await workspaceMemberRepository.find({
        where: {
          userEmail: Any(uniqueParticipantsHandles),
        },
      });

      const partipantsToBeUpdated = participants
        .map((participant) => ({
          ...participant,
          handle: participant.handle ?? '',
        }))
        .map((participant) => {
          const person = findPersonByPrimaryOrAdditionalEmail({
            people,
            email: participant.handle,
          });

          const workspaceMember = workspaceMembers.find(
            (workspaceMember) =>
              workspaceMember.userEmail === participant.handle,
          );

          const shouldMatchWithPerson =
            matchWith === 'workspaceMemberAndPerson' ||
            matchWith === 'personOnly';

          const shouldMatchWithWorkspaceMember =
            matchWith === 'workspaceMemberAndPerson' ||
            matchWith === 'workspaceMemberOnly';

          const newParticipant = {
            ...participant,
            ...(shouldMatchWithPerson && {
              personId: isDefined(person) ? person.id : null,
            }),
            ...(shouldMatchWithWorkspaceMember && {
              workspaceMemberId: isDefined(workspaceMember)
                ? workspaceMember.id
                : null,
            }),
          };

          if (
            newParticipant.personId === participant.personId &&
            newParticipant.workspaceMemberId === participant.workspaceMemberId
          ) {
            return null;
          }

          return newParticipant;
        })
        .filter(isDefined);

      await participantRepository.updateMany(
        partipantsToBeUpdated.map((participant) => ({
          criteria: participant.id,
          partialEntity: {
            personId: participant.personId,
            workspaceMemberId: participant.workspaceMemberId,
          },
        })),
      );
    }

    if (shouldReconcileTargets) {
      await this.participantTargetReconciliationService.reconcileParticipantTargets(
        {
          sourceRecordIds,
          objectMetadataName,
          transactionScope,
        },
      );
    }
  }

  public async matchParticipantsForWorkspaceMembers({
    participantMatching,
    objectMetadataName,
    workspaceId,
  }: MatchParticipantsForWorkspaceMembersArgs) {
    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(async () => {
      await this.workspaceOrmManager.runInWorkspaceTransaction(
        async (transactionScope) => {
          const participantRepository = this.getParticipantRepository({
            objectMetadataName,
            transactionScope,
          });

          const participants = await participantRepository.find({
            where: {
              workspaceMemberId: In(participantMatching.workspaceMemberIds),
            },
          });

          const rematchedParticipants = participants.map((participant) => ({
            ...participant,
            workspaceMemberId: null,
          })) as ParticipantWorkspaceEntity[];

          await this.matchParticipants({
            matchWith: 'workspaceMemberOnly',
            participants: rematchedParticipants,
            sourceRecordIds: this.getSourceRecordIds(rematchedParticipants),
            objectMetadataName,
            transactionScope,
          });
        },
      );
    }, authContext);
  }

  public async matchParticipantsForPeople({
    participantMatching,
    objectMetadataName,
    workspaceId,
  }: MatchParticipantsForPeopleArgs) {
    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(async () => {
      await this.workspaceOrmManager.runInWorkspaceTransaction(
        async (transactionScope) => {
          const participantRepository = this.getParticipantRepository({
            objectMetadataName,
            transactionScope,
          });

          if (!isNonEmptyArray(participantMatching.personEmails)) {
            return;
          }

          // emails before and after the change pick candidates, so links made any other way are left alone
          const participantsWithEmailHandle = await participantRepository
            .createQueryBuilder('participant')
            .where('LOWER("participant"."handle") = ANY(:emails)', {
              emails: [
                ...new Set(
                  participantMatching.personEmails.map((email) =>
                    email.toLowerCase(),
                  ),
                ),
              ],
            })
            .getMany<ParticipantWorkspaceEntity>();

          const participantsToRematch =
            await this.withoutAppChannelParticipants({
              participants: participantsWithEmailHandle,
              objectMetadataName,
              workspaceId,
              transactionScope,
            });

          await this.matchParticipants({
            matchWith: 'personOnly',
            participants: participantsToRematch,
            sourceRecordIds: this.getSourceRecordIds(participantsToRematch),
            objectMetadataName,
            transactionScope,
          });
        },
      );
    }, authContext);
  }

  // apps link their own participants, even ones whose handle looks like an email
  private async withoutAppChannelParticipants({
    participants,
    objectMetadataName,
    workspaceId,
    transactionScope,
  }: {
    participants: ParticipantWorkspaceEntity[];
    objectMetadataName: ObjectMetadataName;
    workspaceId: string;
    transactionScope: WorkspaceTransactionScope;
  }): Promise<ParticipantWorkspaceEntity[]> {
    if (
      objectMetadataName !== 'messageParticipant' ||
      !isNonEmptyArray(participants)
    ) {
      return participants;
    }

    const appMessageChannels = await this.messageChannelRepository.find({
      where: { workspaceId, type: MessageChannelType.APP },
      select: { id: true },
    });

    if (!isNonEmptyArray(appMessageChannels)) {
      return participants;
    }

    const appChannelAssociations =
      await getWorkspaceRepositoryWithOptionalTransaction<MessageChannelMessageAssociationWorkspaceEntity>(
        {
          objectMetadataName: 'messageChannelMessageAssociation',
          transactionScope,
          workspaceOrmManager: this.workspaceOrmManager,
          rolePermissionConfig: { shouldBypassPermissionChecks: true },
        },
      ).find({
        where: {
          messageId: Any([...new Set(this.getSourceRecordIds(participants))]),
          messageChannelId: Any(
            appMessageChannels.map((messageChannel) => messageChannel.id),
          ),
        },
        select: { messageId: true },
      });

    const appChannelMessageIds = new Set(
      appChannelAssociations.map((association) => association.messageId),
    );

    return participants.filter(
      (participant) =>
        !appChannelMessageIds.has(this.getSourceRecordId(participant)),
    );
  }

  private getSourceRecordIds(
    participants: ParticipantWorkspaceEntity[],
  ): string[] {
    return participants.map((participant) =>
      this.getSourceRecordId(participant),
    );
  }

  private getSourceRecordId(participant: ParticipantWorkspaceEntity): string {
    return 'messageId' in participant
      ? participant.messageId
      : participant.calendarEventId;
  }
}
