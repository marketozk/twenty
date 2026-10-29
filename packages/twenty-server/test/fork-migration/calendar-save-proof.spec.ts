import { randomUUID } from 'node:crypto';
import {
  calendarSaveActualIds,
  calendarSaveColumns,
  calendarSaveSnapshotJson,
  calendarSaveTableSql,
} from 'src/engine/core-modules/crm-audit/calendar-save-proof';
import { type NativeCrmAuditTableShape } from 'src/engine/core-modules/crm-audit/native-crm-audit-record';

const shape = (
  nameSingular = 'calendarEvent',
  columns: Record<string, Record<string, unknown>> = {
    id: {},
    title: {},
    startsAt: {},
    conferenceLinkPrimaryLinkLabel: {
      compositeParentFieldName: 'conferenceLink',
    },
    conferenceLinkPrimaryLinkUrl: {
      compositeParentFieldName: 'conferenceLink',
    },
    conferenceLinkSecondaryLinks: {
      compositeParentFieldName: 'conferenceLink',
    },
  },
) =>
  ({
    nameSingular,
    schemaName: 'workspace_quoted"schema',
    tableName: nameSingular,
    columnShapeByColumnName: columns,
  }) as unknown as NativeCrmAuditTableShape;

it('reports only actual returned IDs, including an empty skipped INSERT result', () => {
  const first = randomUUID(),
    skipped = randomUUID();
  expect(
    calendarSaveActualIds({ raw: [{ id: first }], affected: 1 }, [
      first,
      skipped,
    ]),
  ).toEqual([first]);
  expect(calendarSaveActualIds({ raw: [] }, [first, skipped])).toEqual([]);
  expect(calendarSaveActualIds({ raw: [], affected: null }, [first])).toEqual(
    [],
  );
});

it.each([
  'missing',
  'foreign',
  'duplicate',
  'invalid-id',
  'null-row',
  'wrong-count',
] as const)(
  'refuses %s RETURNING evidence instead of accepting planned identities',
  (kind) => {
    const id = randomUUID();
    const result =
      kind === 'missing'
        ? { raw: undefined }
        : kind === 'foreign'
          ? { raw: [{ id: randomUUID() }] }
          : kind === 'duplicate'
            ? { raw: [{ id }, { id }] }
            : kind === 'invalid-id'
              ? { raw: [{ id: 'not-a-uuid' }] }
              : kind === 'null-row'
                ? { raw: [null] }
                : { raw: [{ id }], affected: 0 };
    expect(() => calendarSaveActualIds(result, [id])).toThrow();
  },
);

it('projects only declared calendar columns and preserves absent composite properties', () => {
  const secondaryLinks = [{ label: 'Room', url: 'https://example.test/room' }];
  expect(
    calendarSaveColumns(shape(), {
      title: 'Meeting',
      startsAt: undefined,
      conferenceLink: {
        primaryLinkUrl: null,
        primaryLinkLabel: undefined,
        secondaryLinks,
      },
    }),
  ).toEqual({
    title: 'Meeting',
    conferenceLinkPrimaryLinkUrl: null,
    conferenceLinkSecondaryLinks: secondaryLinks,
  });
});

it.each(['personId', 'workspaceMemberId', 'deletedAt'])(
  'refuses participant planner assignment to retained field %s',
  (field) => {
    const metadata = shape('calendarEventParticipant', {
      [field]: {},
      handle: {},
    });
    expect(() =>
      calendarSaveColumns(metadata, { [field]: randomUUID() }),
    ).toThrow('field outside plan');
  },
);

it.each(['calendarEventTarget', 'callRecording'])(
  'does not grant writes to dependent snapshot object %s',
  (name) => {
    expect(() =>
      calendarSaveColumns(shape(name), { id: randomUUID() }),
    ).toThrow('cannot write this object');
  },
);

it.each(['missing', 'files', 'composite'] as const)(
  'refuses %s metadata for a declared scalar plan field',
  (kind) => {
    const column =
      kind === 'files'
        ? { fieldMetadataType: 'FILES' }
        : { compositeParentFieldName: 'unexpected' };
    const metadata = shape(
      'calendarEvent',
      kind === 'missing' ? {} : { title: column },
    );
    expect(() => calendarSaveColumns(metadata, { title: 'Meeting' })).toThrow(
      'column metadata mismatch',
    );
  },
);

it('refuses a composite property mapped to a different metadata parent', () => {
  const metadata = shape('calendarEvent', {
    conferenceLinkPrimaryLinkUrl: { compositeParentFieldName: 'otherLink' },
  });
  expect(() =>
    calendarSaveColumns(metadata, {
      conferenceLink: { primaryLinkUrl: 'https://example.test' },
    }),
  ).toThrow('composite metadata mismatch');
  expect(() =>
    calendarSaveColumns(shape(), {
      conferenceLink: { unrecognizedLink: 'https://example.test' },
    }),
  ).toThrow('invalid conference property');
});

it('keeps exact PostgreSQL JSON text without parsing large numeric or timestamp values', () => {
  const id = randomUUID();
  const row = {
    id,
    payload: '{"exact":9007199254740993123456789}',
    startsAt: '"2026-10-29T12:34:56.123456+00:00"',
    nullable: 'null',
  };
  expect(JSON.parse(calendarSaveSnapshotJson(row))).toEqual({
    ...row,
    id: JSON.stringify(id),
  });
  expect(row.payload).toBe('{"exact":9007199254740993123456789}');
});

it('quotes schema and table identifiers separately for the native table projection', () => {
  expect(calendarSaveTableSql(shape('calendarEvent'))).toBe(
    '"workspace_quoted""schema"."calendarEvent"',
  );
});
