import * as fhir from '../fhir/fhir.mapper.js';
import { VERSIONED_TABLES, type VersionedTable } from './definitions.js';
import { camel, type VersionRow } from './history.service.js';

/**
 * FHIR `_history` for the resources stored in versioned tables. Ids: the row id, except vital
 * signs, where one row becomes several Observations (`{rowId}-bp`, `{rowId}-{LOINC}`).
 */
export const HISTORY_TYPES = [
  'AllergyIntolerance',
  'Condition',
  'MedicationRequest',
  'Observation',
  'Immunization',
  'Encounter',
] as const;
export type HistoryType = (typeof HISTORY_TYPES)[number];

type R = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The table and row id behind a FHIR id, or null when the id cannot be one of ours. */
export function locate(
  type: HistoryType,
  id: string,
): { table: VersionedTable; rowId: string } | null {
  const rowId = id.slice(0, 36);
  if (!UUID.test(rowId)) return null;
  const suffix = id.slice(36);
  if (type === 'Observation') {
    if (!suffix) return { table: 'lab_results', rowId };
    return /^-(bp|[\d]+-\d)$/.test(suffix) ? { table: 'vital_signs', rowId } : null;
  }
  if (suffix) return null;
  const table = (Object.keys(VERSIONED_TABLES) as VersionedTable[]).find(
    (t) => VERSIONED_TABLES[t].fhirType === type,
  );
  return table ? { table, rowId } : null;
}

/** The FHIR resource as it was in one version (null when it did not exist then). */
export function resourceAt(table: VersionedTable, fhirId: string, row: VersionRow): R | null {
  if (row.operation === 'DELETE') return null;
  const d = camel(row.data) as R & { id: string; patientId: string };
  const pid = d.patientId;
  let r: R | undefined;
  switch (table) {
    case 'allergies':
      r = fhir.allergyResource(d as never, pid);
      break;
    case 'diagnoses':
      r = fhir.conditionResource(d as never, pid);
      break;
    case 'prescriptions':
      r = fhir.medicationRequestResource(d as never, pid);
      break;
    case 'lab_results':
      r = fhir.labObservation(d as never, pid);
      break;
    case 'immunizations':
      r = fhir.immunizationResource(d as never, pid);
      break;
    case 'encounters':
      r = fhir.encounterResource(d as never, pid);
      break;
    case 'vital_signs':
      r = fhir.vitalObservations(d as never, pid).find((o) => o.id === fhirId);
      break;
  }
  if (!r) return null;
  return {
    ...r,
    meta: { versionId: String(row.version), lastUpdated: row.recordedAt.toISOString() },
  };
}

/** A FHIR history Bundle, newest first. */
export function historyBundle(
  type: HistoryType,
  fhirId: string,
  table: VersionedTable,
  rows: VersionRow[],
  base: string,
) {
  const url = `${type}/${fhirId}`;
  let existed = false;
  const entries = rows.flatMap((row) => {
    const resource = resourceAt(table, fhirId, row);
    const lastModified = row.recordedAt.toISOString();
    if (!resource) {
      if (!existed) return [];
      existed = false;
      return [
        {
          request: { method: 'DELETE', url },
          response: { status: '204 No Content', lastModified },
        },
      ];
    }
    const created = !existed;
    existed = true;
    return [
      {
        fullUrl: `${base}/${url}`,
        resource,
        request: { method: created ? 'POST' : 'PUT', url: created ? type : url },
        response: {
          status: created ? '201 Created' : '200 OK',
          etag: `W/"${row.version}"`,
          lastModified,
        },
      },
    ];
  });
  entries.reverse();
  return { resourceType: 'Bundle', type: 'history', total: entries.length, entry: entries };
}
