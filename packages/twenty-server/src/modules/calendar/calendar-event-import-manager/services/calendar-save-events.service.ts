import { lockOrdinaryNativeSyncRun } from 'src/modules/omnichannel/services/lock-ordinary-native-sync-run';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';
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
import { captureCurrentCrmAuditIdentity } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import {
  membershipCleanupOperation,
  copyMembershipCleanupIdentity,
  type MembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { isTransactionUnsafeToRetry } from 'src/engine/twenty-orm/error-handling/is-transaction-outcome-unknown';
import {
  captureNativeCrmAuditWriteData,
  captureNativeCrmAuditSnapshot,
  readNativeCrmAuditRows,
  assertNativeCrmDeleteFilesEmpty,
  type NativeCrmAuditTableShape,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import {
  CALENDAR_SAVE_TABLES,
  calendarSaveTableSql,
  quoteCalendarSaveIdentifier,
  calendarSaveColumns,
  calendarSaveActualIds,
  calendarSaveSnapshotJson,
  type CalendarSaveTable,
  type CalendarSaveSnapshot,
} from 'src/engine/core-modules/crm-audit/calendar-save-proof';
import { getIssuedNativeCleanupMetadata } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';
import { assertNoReferentialUpdateEffects } from 'src/engine/twenty-orm/utils/assert-no-referential-update-effects';
import { Injectable } from '@nestjs/common';

import { isNonEmptyString } from '@sniptt/guards';
import { ConnectedAccountProvider, FeatureFlagKey } from 'twenty-shared/types';
import { assertUnreachable } from 'twenty-shared/utils';
import { Any, Not } from 'typeorm';

import { FeatureFlagService } from 'src/engine/core-modules/feature-flag/services/feature-flag.service';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { type ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { type CalendarEventSharingChannel } from 'src/modules/calendar/calendar-event-import-manager/types/calendar-event-sharing-channel.type';
import { buildCalendarEventSaveOperations } from 'src/modules/calendar/calendar-event-import-manager/utils/build-calendar-event-save-operations.util';
import { getCalendarChannelHandles } from 'src/modules/calendar/calendar-event-import-manager/utils/get-calendar-channel-handles.util';
import { resolveCalendarEventSharing } from 'src/modules/calendar/calendar-event-import-manager/utils/resolve-calendar-event-sharing.util';
import { CalendarEventParticipantService } from 'src/modules/calendar/calendar-event-participant-manager/services/calendar-event-participant.service';
import { buildCalendarEventParticipantSaveOperations } from 'src/modules/calendar/calendar-event-participant-manager/utils/build-calendar-event-participant-save-operations.util';
import { type CalendarChannelEventAssociationWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-channel-event-association.workspace-entity';
import { type CalendarEventWorkspaceEntity } from 'src/modules/calendar/common/standard-objects/calendar-event.workspace-entity';
import { type FetchedCalendarEvent } from 'src/modules/calendar/common/types/fetched-calendar-event.type';

type CalendarSaveScope = Parameters<
  Parameters<WorkspaceOrmManager['runInWorkspaceTransaction']>[0]
>[0];
type CalendarSaveAuditState = {
  scope: CalendarSaveScope;
  audit: CrmAuditTransactionContext;
  shapes: Map<CalendarSaveTable, NativeCrmAuditTableShape>;
  before: Map<CalendarSaveTable, CalendarSaveSnapshot[]>;
  expected: Map<CalendarSaveTable, CalendarSaveSnapshot[]>;
  rootIds: string[];
  sourceIds: string[];
  accountIds: string[];
  sourceProof?: Record<string, unknown>[];
  expectedRun?: OrdinaryMetadataSyncRun;
};

@Injectable()
export class CalendarSaveEventsService {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly calendarEventParticipantService: CalendarEventParticipantService,
    private readonly featureFlagService: FeatureFlagService,
    @InjectWorkspaceScopedRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: WorkspaceScopedRepository<CalendarChannelEntity>,
  ) {}

  public async captureCalendarSaveAuditOperation(
    workspaceId: string,
    trustedIdentity?: MembershipCleanupIdentity,
  ): Promise<CrmAuditOperation> {
    const trusted = copyMembershipCleanupIdentity(trustedIdentity, workspaceId);
    if (trusted && trusted.actor.kind === 'system')
      throw new Error(
        'Calendar creation requires authenticated audit identity',
      );
    const ambient = await captureCurrentCrmAuditIdentity(
      workspaceId,
      async (membershipId) => {
        const member = await this.calendarChannelRepository
          .createQueryBuilder()
          .select('member."userId"', 'userId')
          .from('core.userWorkspace', 'member')
          .where('member.id = :id', { id: membershipId })
          .getRawOne<{ userId: string }>();
        return member?.userId;
      },
    );
    if (
      ambient &&
      trusted &&
      (ambient.actor.kind !== trusted.actor.kind ||
        ambient.actor.id !== trusted.actor.id ||
        (trusted.initiator &&
          (ambient.initiator?.kind !== trusted.initiator.kind ||
            ambient.initiator?.id !== trusted.initiator.id)))
    )
      throw new Error('Calendar creation audit identity mismatch');
    const identity = ambient ?? trusted;
    if (identity?.actor.kind === 'system')
      throw new Error(
        'Calendar creation requires authenticated audit identity',
      );
    const operation = membershipCleanupOperation(workspaceId, identity);
    if (!operation)
      throw new Error(
        'Calendar creation requires authenticated audit identity',
      );
    return operation;
  }

  public async saveCalendarEventsAndEnqueueContactCreationJob(
    fetchedCalendarEvents: FetchedCalendarEvent[],
    calendarChannel: CalendarChannelEntity,
    connectedAccount: ConnectedAccountEntity,
    workspaceId: string,
    auditOperation: CrmAuditOperation,
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<{ calendarEventIds: string[]; applied: boolean }> {
    if (!auditOperation || auditOperation.workspaceId !== workspaceId)
      throw new Error('Calendar save requires scoped audit identity');
    auditOperation = {
      ...auditOperation,
      operationId: randomUUID(),
      actor: { ...auditOperation.actor },
      ...(auditOperation.initiator
        ? { initiator: { ...auditOperation.initiator } }
        : {}),
    };
    fetchedCalendarEvents = captureNativeCrmAuditWriteData({
      events: fetchedCalendarEvents,
    }).events as FetchedCalendarEvent[];
    if (
      new Set(fetchedCalendarEvents.map(({ id }) => id)).size !==
      fetchedCalendarEvents.length
    )
      throw new Error('Calendar save requires distinct provider event IDs');
    expectedRun = expectedRun && { ...expectedRun };
    calendarChannel = { ...calendarChannel };
    connectedAccount = {
      ...connectedAccount,
      handleAliases: connectedAccount.handleAliases && [
        ...connectedAccount.handleAliases,
      ],
    };
    if (
      expectedRun &&
      (expectedRun.kind !== 'calendar' ||
        expectedRun.workspaceId !== workspaceId ||
        expectedRun.channelId !== calendarChannel.id ||
        expectedRun.connectedAccountId !== connectedAccount.id ||
        calendarChannel.connectedAccountId !== connectedAccount.id)
    )
      throw new Error('CALENDAR_NATIVE_SYNC_SCOPE_MISMATCH');
    const authContext = buildSystemAuthContext(workspaceId);

    const isCalendarEventSharingEnabled =
      await this.featureFlagService.isFeatureEnabled(
        FeatureFlagKey.IS_CALENDAR_EVENT_SHARED_ACROSS_CHANNELS_ENABLED,
        workspaceId,
      );

    let channelHandles = getCalendarChannelHandles({
      calendarChannel,
      connectedAccount,
    });

    const saved = await this.workspaceOrmManager.executeInWorkspaceContext(
      async () =>
        this.workspaceOrmManager.runInWorkspaceTransaction(
          async (transactionScope) => {
            const auditState = await this.prepareSaveAudit(
              transactionScope,
              auditOperation,
            );
            const calendarChannelEventAssociationRepository =
              transactionScope.getRepository<CalendarChannelEventAssociationWorkspaceEntity>(
                'calendarChannelEventAssociation',
                { shouldBypassPermissionChecks: true },
              );

            const calendarEventRepository =
              transactionScope.getRepository<CalendarEventWorkspaceEntity>(
                'calendarEvent',
                { shouldBypassPermissionChecks: true },
              );

            const existingAssociations =
              await calendarChannelEventAssociationRepository.find({
                where: {
                  eventExternalId: Any(
                    fetchedCalendarEvents.map((event) => event.id),
                  ),
                  calendarChannelId: calendarChannel.id,
                },
              });

            const existingEventExternalIds = new Set(
              existingAssociations
                .map(({ eventExternalId }) => eventExternalId)
                .filter(isNonEmptyString),
            );

            // Not gated by the flag: events shared before it was turned off keep their roles
            const otherAssociationsOfExistingEvents =
              existingAssociations.length > 0
                ? await calendarChannelEventAssociationRepository.find({
                    where: {
                      calendarEventId: Any(
                        existingAssociations.map(
                          ({ calendarEventId }) => calendarEventId,
                        ),
                      ),
                      calendarChannelId: Not(calendarChannel.id),
                    },
                  })
                : [];

            const linkCandidateAssociations = isCalendarEventSharingEnabled
              ? await this.findLinkCandidateAssociations({
                  calendarChannelEventAssociationRepository,
                  provider: connectedAccount.provider,
                  calendarChannelId: calendarChannel.id,
                  fetchedCalendarEvents: fetchedCalendarEvents.filter(
                    ({ id }) => !existingEventExternalIds.has(id),
                  ),
                })
              : [];

            const otherAssociations = [
              ...otherAssociationsOfExistingEvents,
              ...linkCandidateAssociations,
            ];

            if (
              !(await this.lockSaveSources(
                auditState,
                [
                  calendarChannel.id,
                  ...otherAssociations.map(
                    ({ calendarChannelId }) => calendarChannelId,
                  ),
                ],
                expectedRun,
              ))
            )
              return null;
            const selectedSource = auditState.sourceProof!.find(
              (row) => row.id === calendarChannel.id,
            );
            if (
              !selectedSource ||
              selectedSource.connectedAccountId !== connectedAccount.id ||
              selectedSource.provider !== connectedAccount.provider ||
              calendarChannel.connectedAccountId !== connectedAccount.id
            ) {
              if (expectedRun) return null;
              throw new Error('Calendar save source scope changed');
            }
            auditState.expectedRun = expectedRun;
            calendarChannel = {
              ...calendarChannel,
              handle: selectedSource.handle as string,
              isContactAutoCreationEnabled:
                selectedSource.isContactAutoCreationEnabled as boolean,
              contactAutoCreationPolicy:
                selectedSource.contactAutoCreationPolicy as CalendarChannelEntity['contactAutoCreationPolicy'],
              excludePrivateEvents:
                selectedSource.excludePrivateEvents as boolean,
            };
            connectedAccount = {
              ...connectedAccount,
              handleAliases:
                selectedSource.handleAliases as ConnectedAccountEntity['handleAliases'],
            };
            channelHandles = getCalendarChannelHandles({
              calendarChannel,
              connectedAccount,
            });

            const otherCalendarChannels: CalendarEventSharingChannel[] =
              otherAssociations.length > 0
                ? ((await transactionScope.executeRawQuery(
                    `SELECT channel.id,channel.handle,channel."syncStatus",channel."isSyncEnabled",jsonb_build_object('handleAliases',account."handleAliases") AS "connectedAccount" FROM core."calendarChannel" channel JOIN core."connectedAccount" account ON account.id=channel."connectedAccountId" AND account."workspaceId"=channel."workspaceId" WHERE channel."workspaceId"=$1 AND channel.id=ANY($2::uuid[]) AND account.provider=$3`,
                    [
                      workspaceId,
                      [
                        ...new Set(
                          otherAssociations.map(
                            ({ calendarChannelId }) => calendarChannelId,
                          ),
                        ),
                      ],
                      connectedAccount.provider,
                    ],
                  )) as unknown as CalendarEventSharingChannel[])
                : [];

            const otherCalendarChannelIds = new Set(
              otherCalendarChannels.map(({ id }) => id),
            );

            const sharedAssociations = otherAssociations.filter(
              ({ calendarChannelId }) =>
                otherCalendarChannelIds.has(calendarChannelId),
            );

            const candidateCalendarEventIds = [
              ...new Set(
                [...existingAssociations, ...sharedAssociations].map(
                  ({ calendarEventId }) => calendarEventId,
                ),
              ),
            ];

            auditState.rootIds = [...candidateCalendarEventIds].sort();
            for (const name of CALENDAR_SAVE_TABLES) {
              const rows = await this.readSaveGraph(auditState, name, true);
              auditState.before.set(name, rows);
              auditState.expected.set(name, rows);
            }
            // Discovery preceded row locks. Revalidate every planner relationship after the locks.
            const discoveredAssociations = [
              ...existingAssociations,
              ...sharedAssociations,
            ];
            for (const association of discoveredAssociations) {
              const row = auditState.before
                .get('calendarChannelEventAssociation')!
                .find(({ id }) => id === association.id);
              if (
                !row ||
                row.deletedAt !== 'null' ||
                row.calendarEventId !==
                  JSON.stringify(association.calendarEventId) ||
                row.calendarChannelId !==
                  JSON.stringify(association.calendarChannelId) ||
                row.eventExternalId !==
                  JSON.stringify(association.eventExternalId) ||
                row.recurringEventExternalId !==
                  JSON.stringify(association.recurringEventExternalId)
              )
                throw new Error(
                  'Calendar save association changed during discovery',
                );
            }
            const discoveredIds = new Set(
              discoveredAssociations.map(({ id }) => id),
            );
            for (const row of auditState.before.get(
              'calendarChannelEventAssociation',
            )!) {
              if (row.deletedAt !== 'null') continue;
              const channelId = JSON.parse(String(row.calendarChannelId));
              if (
                !auditState.sourceIds.includes(channelId) ||
                (!discoveredIds.has(row.id) && channelId !== calendarChannel.id)
              )
                throw new Error(
                  'Calendar save sharing sources changed during discovery',
                );
            }

            const candidateCalendarEvents =
              candidateCalendarEventIds.length > 0
                ? await calendarEventRepository.find({
                    where: { id: Any(candidateCalendarEventIds) },
                  })
                : [];

            const {
              calendarEventIdToLinkByEventExternalId,
              otherChannelIdsByCalendarEventId,
            } = resolveCalendarEventSharing({
              provider: connectedAccount.provider,
              fetchedCalendarEvents,
              existingEventExternalIds,
              sharedAssociations,
              iCalUidByCalendarEventId: new Map(
                candidateCalendarEvents.map(({ id, iCalUid }) => [id, iCalUid]),
              ),
              isCalendarEventSharingEnabled,
            });

            const storedCalendarEventIds = [
              ...existingAssociations.map(
                (association) => association.calendarEventId,
              ),
              ...calendarEventIdToLinkByEventExternalId.values(),
            ];

            const {
              saveOperations,
              channelRoleByCalendarEventId,
              participantsOfNewEvents,
              participantsOfExistingEvents,
              participantsOfLinkedEvents,
            } = buildCalendarEventSaveOperations({
              fetchedCalendarEvents,
              existingAssociations,
              existingCalendarEvents: candidateCalendarEvents,
              calendarChannelId: calendarChannel.id,
              channelHandles,
              calendarEventIdToLinkByEventExternalId,
              otherChannelIdsByCalendarEventId,
              otherCalendarChannels,
            });

            const existingParticipants =
              await this.calendarEventParticipantService.findCalendarEventParticipantsByCalendarEventIds(
                { calendarEventIds: storedCalendarEventIds, transactionScope },
              );

            const participantOperations =
              buildCalendarEventParticipantSaveOperations({
                fetchedParticipants: [
                  ...participantsOfNewEvents,
                  ...participantsOfExistingEvents,
                  ...participantsOfLinkedEvents,
                ],
                existingParticipants,
                channelRoleByCalendarEventId,
                channelHandles,
              });

            const newEvents = saveOperations.calendarEventsToInsert.map(
              (record) => {
                if (typeof record.id !== 'string' || !isUUID(record.id))
                  throw new Error(
                    'Calendar save missing planned event identity',
                  );
                return { ...record, id: record.id };
              },
            );
            const participantKeys =
              participantOperations.participantsToInsert.map((row) =>
                JSON.stringify([row.calendarEventId, row.handle]),
              );
            if (new Set(participantKeys).size !== participantKeys.length)
              throw new Error(
                'Calendar save ambiguous duplicate participant identity',
              );
            auditState.rootIds = [
              ...new Set([
                ...auditState.rootIds,
                ...newEvents.map(({ id }) => id),
              ]),
            ].sort();
            await this.verifySaveGraph(auditState);
            const insertedEventIds = await this.insertSaveRecords(
              auditState,
              'calendarEvent',
              newEvents,
            );
            if (insertedEventIds.length !== newEvents.length)
              throw new Error(
                'Calendar save skipped event required by dependent plan',
              );
            await this.updateSaveRecords(
              auditState,
              'calendarEvent',
              saveOperations.calendarEventsToUpdate,
            );
            const insertedAssociations =
              saveOperations.associationsToInsert.map((row) => ({
                ...row,
                id: randomUUID(),
              }));
            const associationIds = await this.insertSaveRecords(
              auditState,
              'calendarChannelEventAssociation',
              insertedAssociations,
            );
            await this.updateSaveRecords(
              auditState,
              'calendarChannelEventAssociation',
              saveOperations.associationsToUpdate,
            );
            await this.deleteSaveParticipants(
              auditState,
              participantOperations.participantIdsToDelete,
            );
            await this.updateSaveRecords(
              auditState,
              'calendarEventParticipant',
              participantOperations.participantsToUpdate,
            );
            const savedParticipantIds = await this.insertSaveRecords(
              auditState,
              'calendarEventParticipant',
              participantOperations.participantsToInsert,
            );
            const calendarEventIds = [
              ...new Set([
                ...existingAssociations.map(
                  ({ calendarEventId }) => calendarEventId,
                ),
                ...insertedAssociations
                  .filter(({ id }) => associationIds.includes(id))
                  .map(({ calendarEventId }) => calendarEventId),
              ]),
            ];
            await this.finishSaveAudit(auditState);
            return {
              savedParticipantIds,
              participantsOfLinkedEvents: participantsOfLinkedEvents.filter(
                (row) => calendarEventIds.includes(row.calendarEventId),
              ),
              calendarEventIds,
            };
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        ),
      authContext,
      { lite: true },
    );

    if (!saved) return { calendarEventIds: [], applied: false };
    const {
      savedParticipantIds,
      participantsOfLinkedEvents,
      calendarEventIds,
    } = saved;

    try {
      await this.calendarEventParticipantService.matchParticipantsAndEnqueueContactCreationJob(
        {
          savedParticipantIds,
          participantsOfLinkedEvents,
          calendarEventIds,
          calendarChannel,
          connectedAccount,
          workspaceId,
        },
      );
    } catch (error) {
      if (isTransactionUnsafeToRetry(error)) throw error;
      throw new CoreAuditPostCommitError(error);
    }

    return { calendarEventIds, applied: true };
  }

  private async prepareSaveAudit(
    scope: CalendarSaveScope,
    operation: CrmAuditOperation,
  ): Promise<CalendarSaveAuditState> {
    const context = getIssuedNativeCleanupMetadata(scope);
    if (
      context.authType !== 'system' ||
      context.authWorkspaceId !== scope.workspaceId ||
      operation.workspaceId !== scope.workspaceId
    )
      throw new Error('Calendar save requires issued scoped system authority');
    const shapes = new Map<CalendarSaveTable, NativeCrmAuditTableShape>();
    for (const name of CALENDAR_SAVE_TABLES) {
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
        throw new Error('Calendar save requires exact standard metadata');
      const { metadata, shape } = candidates[0];
      if (
        shape.objectMetadataId !== metadata.id ||
        shape.nameSingular !== name ||
        shape.tableName !== name
      )
        throw new Error('Calendar save table metadata mismatch');
      shapes.set(name, shape);
    }
    if (
      new Set([...shapes.values()].map((shape) => shape.schemaName)).size !== 1
    )
      throw new Error('Calendar save schema mismatch');
    await scope.executeRawQuery("SET LOCAL lock_timeout='8s'");
    const [workspace] = await scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
      [scope.workspaceId],
    );
    if (!workspace || workspace.deletedAt !== null)
      throw new Error('Calendar save requires active workspace');
    await scope.executeRawQuery(
      'LOCK TABLE ' +
        [...shapes.values()].map(calendarSaveTableSql).sort().join(',') +
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
        throw new Error('Calendar save requires event foreign keys');
    }
    return {
      scope,
      shapes,
      before: new Map(),
      expected: new Map(),
      rootIds: [],
      sourceIds: [],
      accountIds: [],
      audit: new CrmAuditTransactionContext(
        createCrmAuditWorkspaceExecutor(scope),
        operation,
      ),
    };
  }

  private async readSaveSources(
    state: CalendarSaveAuditState,
  ): Promise<Record<string, unknown>[]> {
    return state.scope.executeRawQuery(
      `SELECT channel.id,channel."workspaceId",channel."connectedAccountId",channel.handle,channel."isSyncEnabled",channel."syncStatus",channel."syncStage",channel."syncStageStartedAt"::text,channel."isContactAutoCreationEnabled",channel."contactAutoCreationPolicy",channel."excludePrivateEvents",account.provider,account."handleAliases",account."applicationId",account."connectionProviderId",account."archivedAt"::text FROM core."calendarChannel" channel JOIN core."connectedAccount" account ON account.id=channel."connectedAccountId" AND account."workspaceId"=channel."workspaceId" WHERE channel."workspaceId"=$1 AND channel.id=ANY($2::uuid[]) ORDER BY channel.id`,
      [state.scope.workspaceId, state.sourceIds],
    );
  }

  private async lockSaveSources(
    state: CalendarSaveAuditState,
    ids: string[],
    expectedRun?: OrdinaryMetadataSyncRun,
  ): Promise<boolean> {
    if (ids.some((id) => !isUUID(id)))
      throw new Error('Calendar save invalid source identity');
    state.sourceIds = [...new Set(ids)].sort();
    const discovery = await this.readSaveSources(state);
    state.accountIds = [
      ...new Set(discovery.map((row) => String(row.connectedAccountId))),
    ].sort();
    await state.scope.executeRawQuery(
      'SELECT id FROM core."connectedAccount" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
      [state.scope.workspaceId, state.accountIds],
    );
    await state.scope.executeRawQuery(
      'SELECT id FROM core."calendarChannel" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
      [state.scope.workspaceId, state.sourceIds],
    );
    const current = await this.readSaveSources(state);
    if (
      expectedRun &&
      !(await lockOrdinaryNativeSyncRun(state.scope, expectedRun))
    )
      return false;
    if (
      current.some(
        (row) => !state.accountIds.includes(String(row.connectedAccountId)),
      )
    )
      throw new Error('Calendar save source relationship changed');
    state.sourceProof = current;
    return true;
  }

  private async readSaveGraph(
    state: CalendarSaveAuditState,
    name: CalendarSaveTable,
    lock = false,
  ): Promise<CalendarSaveSnapshot[]> {
    const shape = state.shapes.get(name)!;
    const originalIds = [
      ...new Set(
        [
          ...(state.before.get(name) ?? []),
          ...(state.expected.get(name) ?? []),
        ].map((row) => row.id),
      ),
    ];
    const ids = (
      await state.scope.executeRawQuery(
        'SELECT id FROM ' +
          calendarSaveTableSql(shape) +
          ' WHERE ' +
          quoteCalendarSaveIdentifier(
            name === 'calendarEvent' ? 'id' : 'calendarEventId',
          ) +
          '=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id' +
          (lock ? ' FOR UPDATE' : ''),
        [state.rootIds, originalIds],
      )
    ).map((row) => {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error('Calendar save invalid graph identity');
      return row.id;
    });
    const rows = await readNativeCrmAuditRows(
      {
        execute: ({ text, values }) =>
          state.scope.executeRawQuery(text, values),
      },
      shape,
      ids,
    );
    if (rows.length !== ids.length)
      throw new Error('Calendar save graph changed');
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async verifySaveGraph(state: CalendarSaveAuditState) {
    if (
      state.expectedRun &&
      !(await lockOrdinaryNativeSyncRun(state.scope, state.expectedRun))
    )
      throw new Error('Calendar save run ownership changed before commit');
    const [workspace] = await state.scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1',
      [state.scope.workspaceId],
    );
    if (
      !workspace ||
      workspace.deletedAt !== null ||
      canonicalAuditJson(await this.readSaveSources(state)) !==
        canonicalAuditJson(state.sourceProof)
    )
      throw new Error('Calendar save authority changed before commit');
    for (const name of CALENDAR_SAVE_TABLES) {
      const expected = [...(state.expected.get(name) ?? [])].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      if (
        canonicalAuditJson(await this.readSaveGraph(state, name)) !==
        canonicalAuditJson(expected)
      )
        throw new Error('Calendar save graph effects mismatch');
    }
  }

  private async castSaveImage(
    state: CalendarSaveAuditState,
    shape: NativeCrmAuditTableShape,
    columns: Record<string, unknown>,
    before?: CalendarSaveSnapshot,
  ): Promise<CalendarSaveSnapshot> {
    const generated = await state.scope.executeRawQuery(
      `SELECT attribute.attname AS name,pg_get_expr(definition.adbin,definition.adrelid) AS expression FROM pg_attribute attribute JOIN pg_attrdef definition ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum WHERE attribute.attrelid=$1::regclass AND attribute.attgenerated<>'' AND NOT attribute.attisdropped ORDER BY attribute.attnum`,
      [calendarSaveTableSql(shape)],
    );
    const generatedSql = generated.map((column) => {
      if (
        typeof column.name !== 'string' ||
        typeof column.expression !== 'string'
      )
        throw new Error('Calendar save invalid generated column metadata');
      return `jsonb_build_object('${column.name.replaceAll("'", "''")}',(${column.expression}))`;
    });
    // Reconstruct JSON in PostgreSQL, without decoding NUMERIC/JSON/timestamps in JS.
    const [result] = await state.scope.executeRawQuery(
      `WITH previous AS (SELECT COALESCE(jsonb_object_agg(key,value::jsonb),'{}'::jsonb) AS data FROM jsonb_each_text($1::jsonb)), image AS (SELECT (jsonb_populate_record(NULL::${calendarSaveTableSql(shape)}, previous.data || $2::jsonb ${before && shape.columnShapeByColumnName.updatedAt ? "|| jsonb_build_object('updatedAt',CURRENT_TIMESTAMP)" : ''})).* FROM previous) SELECT image.id,(SELECT jsonb_object_agg(key,value::text) FROM jsonb_each(to_jsonb(image) ${generatedSql.map((sql) => '|| ' + sql).join(' ')})) AS snapshot FROM image`,
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
      throw new Error('Calendar save cannot compute expected image');
    return { ...(result.snapshot as Record<string, unknown>), id: result.id };
  }

  private async insertSaveRecords(
    state: CalendarSaveAuditState,
    name:
      | 'calendarEvent'
      | 'calendarChannelEventAssociation'
      | 'calendarEventParticipant',
    records: { id: string }[],
  ): Promise<string[]> {
    const shape = state.shapes.get(name)!;
    const actualIds: string[] = [];
    if (
      new Set(records.map((row) => row.id)).size !== records.length ||
      records.some((row) => !isUUID(row.id))
    )
      throw new Error('Calendar save invalid planned insert identity');
    for (let offset = 0; offset < records.length; offset += 100) {
      const batch = records.slice(offset, offset + 100);
      await this.verifySaveGraph(state);
      const expected = state.expected.get(name)!;
      if (
        batch.some((row) => expected.some((existing) => existing.id === row.id))
      )
        throw new Error('Calendar save insert identity already exists');
      const declared = new Map<
        string,
        { columns: Record<string, unknown>; image: CalendarSaveSnapshot }
      >();
      for (const row of batch) {
        const columns = calendarSaveColumns(shape, row);
        declared.set(row.id, {
          columns,
          image: await this.castSaveImage(state, shape, columns),
        });
      }
      const result = await state.scope
        .getRepository(name, { shouldBypassPermissionChecks: true })
        .insert(batch);
      const ids = calendarSaveActualIds(
        result,
        batch.map((row) => row.id),
      );
      const rows = await readNativeCrmAuditRows(
        {
          execute: ({ text, values }) =>
            state.scope.executeRawQuery(text, values),
        },
        shape,
        ids,
      );
      if (rows.length !== ids.length)
        throw new Error('Calendar save inserted row disappeared');
      for (const row of rows) {
        const planned = declared.get(row.id)!;
        for (const column of Object.keys(planned.columns)) {
          if (row[column] !== planned.image[column])
            throw new Error('Calendar save inserted values mismatch');
        }
      }
      assertNativeCrmDeleteFilesEmpty(shape, rows);
      state.expected.set(name, [...expected, ...rows]);
      actualIds.push(...ids);
      await this.verifySaveGraph(state);
    }
    return actualIds;
  }

  private async updateSaveRecords(
    state: CalendarSaveAuditState,
    name:
      | 'calendarEvent'
      | 'calendarChannelEventAssociation'
      | 'calendarEventParticipant',
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
          throw new Error('Calendar save invalid update identity');
        ids.add(record.criteria);
        batch.push(record);
      }
      await this.verifySaveGraph(state);
      const expected = state.expected.get(name)!;
      const after = new Map<string, CalendarSaveSnapshot>();
      for (const record of batch) {
        const before = expected.find((row) => row.id === record.criteria);
        if (!before || before.deletedAt !== 'null')
          throw new Error('Calendar save requires live update parent');
        const columns = calendarSaveColumns(shape, record.partialEntity);
        const image = await this.castSaveImage(
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
            alias: 'calendar_save_parent',
            tableShape: shape,
            setClauses: changedColumns.map((columnName) => ({
              columnName,
              valueExpression: `(jsonb_populate_record(NULL::${calendarSaveTableSql(shape)},$2::jsonb)).${quoteCalendarSaveIdentifier(columnName)}`,
            })),
          },
          {},
          '"calendar_save_parent".id=$1::uuid AND $2::jsonb IS NOT NULL',
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
      await this.verifySaveGraph(state);
    }
  }

  private async deleteSaveParticipants(
    state: CalendarSaveAuditState,
    ids: string[],
  ) {
    if (!ids.length) return;
    await this.verifySaveGraph(state);
    const name = 'calendarEventParticipant';
    const shape = state.shapes.get(name)!;
    const before = state.expected.get(name)!;
    const selected = before.filter((row) => ids.includes(row.id));
    if (
      new Set(ids).size !== ids.length ||
      selected.length !== ids.length ||
      selected.some((row) => row.deletedAt !== 'null')
    )
      throw new Error('Calendar save invalid participant deletion');
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
          'Calendar save excludes unsupported participant cascade effects',
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
    await this.verifySaveGraph(state);
  }

  private async finishSaveAudit(state: CalendarSaveAuditState) {
    await this.verifySaveGraph(state);
    for (const name of [
      'calendarEvent',
      'calendarChannelEventAssociation',
      'calendarEventParticipant',
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
    await this.verifySaveGraph(state);
  }

  private async findLinkCandidateAssociations({
    calendarChannelEventAssociationRepository,
    provider,
    calendarChannelId,
    fetchedCalendarEvents,
  }: {
    calendarChannelEventAssociationRepository: WorkspaceRepository<CalendarChannelEventAssociationWorkspaceEntity>;
    provider: ConnectedAccountProvider;
    calendarChannelId: string;
    fetchedCalendarEvents: FetchedCalendarEvent[];
  }): Promise<CalendarChannelEventAssociationWorkspaceEntity[]> {
    if (fetchedCalendarEvents.length === 0) {
      return [];
    }

    switch (provider) {
      case ConnectedAccountProvider.GOOGLE:
        return calendarChannelEventAssociationRepository.find({
          where: {
            eventExternalId: Any(fetchedCalendarEvents.map(({ id }) => id)),
            calendarChannelId: Not(calendarChannelId),
          },
        });
      case ConnectedAccountProvider.MICROSOFT: {
        const iCalUids = fetchedCalendarEvents
          .map(({ iCalUid }) => iCalUid)
          .filter(isNonEmptyString);

        return iCalUids.length > 0
          ? calendarChannelEventAssociationRepository.find({
              where: {
                calendarEvent: { iCalUid: Any(iCalUids) },
                calendarChannelId: Not(calendarChannelId),
              },
            })
          : [];
      }
      case ConnectedAccountProvider.IMAP_SMTP_CALDAV:
      case ConnectedAccountProvider.OIDC:
      case ConnectedAccountProvider.SAML:
      case ConnectedAccountProvider.EMAIL_GROUP:
      case ConnectedAccountProvider.APP:
        return [];
      default:
        return assertUnreachable(provider);
    }
  }
}
