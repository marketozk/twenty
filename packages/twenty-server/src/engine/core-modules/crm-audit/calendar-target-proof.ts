import { type createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import {
  readNativeCrmAuditRows,
  type NativeCrmAuditTableShape,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import {
  calendarSaveTableSql,
  calendarSaveSnapshotJson,
  quoteCalendarSaveIdentifier,
  type CalendarSaveSnapshot,
  type CalendarSaveTable,
} from 'src/engine/core-modules/crm-audit/calendar-save-proof';

type CalendarProofQueryScope = Parameters<
  typeof createCrmAuditWorkspaceExecutor
>[0];

export const readCalendarProofGraph = async ({
  scope,
  shape,
  name,
  rootIds,
  originalIds,
  lock = false,
}: {
  scope: CalendarProofQueryScope;
  shape: NativeCrmAuditTableShape;
  name: CalendarSaveTable;
  rootIds: readonly string[];
  originalIds: readonly string[];
  lock?: boolean;
}): Promise<CalendarSaveSnapshot[]> => {
  const ids = (
    await scope.executeRawQuery(
      'SELECT id FROM ' +
        calendarSaveTableSql(shape) +
        ' WHERE ' +
        quoteCalendarSaveIdentifier(
          name === 'calendarEvent' ? 'id' : 'calendarEventId',
        ) +
        '=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id' +
        (lock ? ' FOR UPDATE' : ''),
      [[...rootIds], [...originalIds]],
    )
  ).map((row) => String(row.id));
  const rows = await readNativeCrmAuditRows(
    { execute: ({ text, values }) => scope.executeRawQuery(text, values) },
    shape,
    [...new Set(ids)],
  );
  if (rows.length !== new Set(ids).size)
    throw new Error('Calendar matching source disappeared');
  return rows.sort((a, b) => a.id.localeCompare(b.id));
};

export const castCalendarProofImage = async (
  scope: CalendarProofQueryScope,
  shape: NativeCrmAuditTableShape,
  columns: Record<string, unknown>,
  before?: CalendarSaveSnapshot,
): Promise<CalendarSaveSnapshot> => {
  const definitions = await scope.executeRawQuery(
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
  const [result] = await scope.executeRawQuery(
    `WITH previous AS (SELECT COALESCE(jsonb_object_agg(key,value::jsonb),'{}'::jsonb) AS data FROM jsonb_each_text($1::jsonb)), image AS (SELECT (jsonb_populate_record(NULL::${calendarSaveTableSql(shape)}, previous.data ${defaults.map((sql) => '|| ' + sql).join(' ')} || $2::jsonb ${before && shape.columnShapeByColumnName.updatedAt ? "|| jsonb_build_object('updatedAt',CURRENT_TIMESTAMP)" : ''})).* FROM previous) SELECT image.id,(SELECT jsonb_object_agg(key,value::text) FROM jsonb_each(to_jsonb(image) ${generated.map((sql) => '|| ' + sql).join(' ')})) AS snapshot FROM image`,
    [before ? calendarSaveSnapshotJson(before) : '{}', JSON.stringify(columns)],
  );
  if (
    !result ||
    typeof result.id !== 'string' ||
    !result.snapshot ||
    typeof result.snapshot !== 'object'
  )
    throw new Error('Calendar matching cannot compute expected image');
  return { ...(result.snapshot as Record<string, unknown>), id: result.id };
};
