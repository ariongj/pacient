import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { auditLogs, codeSystemVersions } from '../src/db/schema.js';
import {
  csvCell,
  lookupConcept,
  parseCsv,
  translateCode,
  validateCode,
  validateConceptCsv,
} from '../src/modules/terminology/terminology.service.js';
import { api, bearer, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
const seq = Math.floor(Math.random() * 1e6);
const ministry = () => bearer(w.tokens.ministry);
const director = () => bearer(w.tokens.director);

const csv = (lines: string[]) => lines.join('\n');
const HEADER = 'code,display,display_sq,display_sr,parent,active';
const V1 = csv([
  HEADER,
  'I,Diseases of the circulatory system,Sëmundjet e sistemit të qarkullimit,Bolesti sistema krvotoka,,true',
  'I10,Essential (primary) hypertension,Hipertension esencial,Esencijalna hipertenzija,I,true',
  'I21,Acute myocardial infarction,Infarkt akut i miokardit,Akutni infarkt miokarda,I,true',
  'I21.9,"Acute myocardial infarction, unspecified",,,I21,true',
  'I48,Atrial fibrillation and flutter,,,I,true',
]);
const V2 = csv([
  HEADER,
  'I,Diseases of the circulatory system,Sëmundjet e sistemit të qarkullimit,Bolesti sistema krvotoka,,true',
  'I10,Essential (primary) hypertension,Hipertensioni esencial (primar),Esencijalna hipertenzija,I,true',
  'I21,Acute myocardial infarction,Infarkt akut i miokardit,Akutni infarkt miokarda,I,true',
  'I21.9,"Acute myocardial infarction, unspecified",,,I21,false',
  'I50,Heart failure,Insuficienca e zemrës,Srčana insuficijencija,I,true',
]);

const upload = (path: string, body: string, token: { Authorization: string }, query = '') =>
  api()
    .post(`/api/v1/terminology${path}${query}`)
    .set(token)
    .set('Content-Type', 'text/csv')
    .send(body);

async function createSystem(
  token: { Authorization: string },
  kind: 'EXTERNAL' | 'LOCAL',
  code: string,
) {
  return api()
    .post('/api/v1/terminology/systems')
    .set(token)
    .send({
      code,
      name: `Test system ${code}`,
      url: `http://example.org/fhir/CodeSystem/${code.toLowerCase()}`,
      kind,
    });
}

beforeAll(async () => {
  w = await createWorld();
});

describe('CSV handling', () => {
  it('parses quoted fields with commas, doubled quotes, CRLF and a BOM, keeping line numbers', () => {
    const rows = parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\r\n\r\n"multi\nline",z\n');
    expect(rows.map((r) => r.cells)).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
    ]);
    expect(rows.map((r) => r.line)).toEqual([1, 2, 4]);
  });

  it('protects exported cells against spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+381')).toBe("'+381");
    expect(csvCell('@SUM')).toBe("'@SUM");
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
  });

  it('reports every problem by line and accepts its own export again', () => {
    const bad = validateConceptCsv(
      csv([
        HEADER,
        'A1,One,,,,true',
        'A1,Duplicate,,,,true',
        ',No code,,,,true',
        'B 2,Space in code,,,,true',
        'C3,,,,,true',
        'D4,Unknown parent,,,ZZ,true',
        'E5,Bad flag,,,,maybe',
        'F6,Loop one,,,G7,true',
        'G7,Loop two,,,F6,true',
      ]),
    );
    expect(bad.errorCount).toBe(8);
    expect(bad.errors.map((e) => e.path)).toEqual([
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 8',
      'line 7',
      'line 9',
      'line 10',
    ]);
    expect(validateConceptCsv('foo,bar\n1,2').errors[0]!.message).toMatch(/first line/);
    const ok = validateConceptCsv(csv([HEADER, `X1,'=calm display,,,,`]));
    expect(ok.errorCount).toBe(0);
    expect(ok.rows[0]).toMatchObject({ code: 'X1', display: '=calm display', active: true });
  });
});

describe('code system versions', () => {
  let systemId: string;
  let v1Id: string;
  let v2Id: string;
  const code = `TEST-ICD-${seq}`;

  it('lets the Ministry create national systems but not directors, and directors local ones', async () => {
    const created = await createSystem(ministry(), 'EXTERNAL', code);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'EXTERNAL', facilityId: null, canManage: true });
    systemId = created.body.id;
    expect((await createSystem(director(), 'EXTERNAL', `NOPE-${seq}`)).status).toBe(403);
    expect((await createSystem(ministry(), 'LOCAL', `NOPE2-${seq}`)).status).toBe(403);
    expect((await createSystem(ministry(), 'EXTERNAL', code)).status).toBe(409);
    expect((await createSystem(bearer(w.tokens.doctor), 'EXTERNAL', `NOPE3-${seq}`)).status).toBe(
      403,
    );
  });

  it('refuses an import with errors (nothing saved) and imports a valid file as a draft', async () => {
    const bad = await upload(
      `/systems/${systemId}/versions`,
      csv([HEADER, 'Q1,,,,,']),
      ministry(),
      '?version=bad',
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0]).toMatchObject({
      path: 'line 2',
      message: 'The display text is missing',
    });
    expect(
      await db
        .select()
        .from(codeSystemVersions)
        .where(eq(codeSystemVersions.codeSystemId, systemId)),
    ).toHaveLength(0);

    const dry = await upload(
      `/systems/${systemId}/versions`,
      V1,
      ministry(),
      '?version=1&dryRun=true',
    );
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, conceptCount: 5 });
    expect(
      await db
        .select()
        .from(codeSystemVersions)
        .where(eq(codeSystemVersions.codeSystemId, systemId)),
    ).toHaveLength(0);

    const v1 = await upload(
      `/systems/${systemId}/versions`,
      V1,
      ministry(),
      '?version=1&notes=First',
    );
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ status: 'DRAFT', conceptCount: 5 });
    expect(v1.body.diff.counts.added).toBe(5);
    v1Id = v1.body.id;
    expect(
      (await upload(`/systems/${systemId}/versions`, V1, ministry(), '?version=1')).status,
    ).toBe(409);
    expect(
      (await upload(`/systems/${systemId}/versions`, V1, director(), '?version=9')).status,
    ).toBe(403);
  });

  it('activates the draft; concepts are searchable in all three languages', async () => {
    const act = await api().post(`/api/v1/terminology/versions/${v1Id}/activate`).set(ministry());
    expect(act.status).toBe(200);
    expect(act.body).toMatchObject({ status: 'ACTIVE', retired: null });
    expect(
      (await api().post(`/api/v1/terminology/versions/${v1Id}/activate`).set(ministry())).status,
    ).toBe(409);

    const nurse = bearer(w.tokens.nurse);
    const byCode = await api()
      .get(`/api/v1/terminology/systems/${systemId}/concepts?q=I21`)
      .set(nurse);
    expect(byCode.status).toBe(200);
    expect(byCode.body.items.map((c: { code: string }) => c.code)).toEqual(['I21', 'I21.9']);
    const sq = await api()
      .get(`/api/v1/terminology/systems/${systemId}/concepts`)
      .query({ q: 'hipertension' })
      .set(nurse);
    expect(sq.body.items.map((c: { code: string }) => c.code)).toEqual(['I10']);
    const sr = await api()
      .get(`/api/v1/terminology/systems/${systemId}/concepts`)
      .query({ q: 'krvotoka' })
      .set(nurse);
    expect(sr.body.items.map((c: { code: string }) => c.code)).toEqual(['I']);

    const detail = await api()
      .get(`/api/v1/terminology/systems/${systemId}/concept`)
      .query({ code: 'I21' })
      .set(nurse);
    expect(detail.status).toBe(200);
    expect(detail.body.parent.code).toBe('I');
    expect(detail.body.children.map((c: { code: string }) => c.code)).toEqual(['I21.9']);
  });

  it('compares the next draft with the active version and retires the old one atomically', async () => {
    const v2 = await upload(`/systems/${systemId}/versions`, V2, ministry(), '?version=2');
    expect(v2.status).toBe(201);
    v2Id = v2.body.id;
    const diff = await api()
      .get(`/api/v1/terminology/versions/${v2Id}/diff`)
      .set(bearer(w.tokens.doctor));
    expect(diff.status).toBe(200);
    expect(diff.body.against.version).toBe('1');
    expect(diff.body.counts).toMatchObject({
      added: 1,
      removed: 1,
      displayChanged: 1,
      inactivated: 1,
      reactivated: 0,
      parentChanged: 0,
      unchanged: 2,
    });
    expect(diff.body.added).toEqual([{ code: 'I50', display: 'Heart failure' }]);
    expect(diff.body.removed[0].code).toBe('I48');
    expect(diff.body.displayChanged[0]).toMatchObject({ code: 'I10', field: 'displaySq' });

    // The service answers from the active version (and its cache) until activation.
    expect((await validateCode(code, 'I21.9')).valid).toBe(true);
    const act = await api().post(`/api/v1/terminology/versions/${v2Id}/activate`).set(ministry());
    expect(act.status).toBe(200);
    expect(act.body.retired.version).toBe('1');
    const versions = await db
      .select()
      .from(codeSystemVersions)
      .where(eq(codeSystemVersions.codeSystemId, systemId));
    expect(versions.filter((v) => v.status === 'ACTIVE').map((v) => v.version)).toEqual(['2']);
    expect(versions.find((v) => v.version === '1')!.status).toBe('RETIRED');

    expect(await validateCode(code, 'I21.9')).toMatchObject({
      valid: false,
      message: 'The code is inactive',
    });
    expect(await validateCode(code, 'I48')).toMatchObject({ valid: false });
    expect((await validateCode(code, 'I50')).valid).toBe(true);
    expect((await lookupConcept(code, 'I10'))?.displaySq).toBe('Hipertensioni esencial (primar)');

    // Two concurrent activations of competing drafts: exactly one active version remains.
    const a = await upload(`/systems/${systemId}/versions`, V1, ministry(), '?version=3a');
    const b = await upload(`/systems/${systemId}/versions`, V2, ministry(), '?version=3b');
    const results = await Promise.all([
      api().post(`/api/v1/terminology/versions/${a.body.id}/activate`).set(ministry()),
      api().post(`/api/v1/terminology/versions/${b.body.id}/activate`).set(ministry()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200]);
    const after = await db
      .select()
      .from(codeSystemVersions)
      .where(
        and(eq(codeSystemVersions.codeSystemId, systemId), eq(codeSystemVersions.status, 'ACTIVE')),
      );
    expect(after).toHaveLength(1);
  });

  it('exports CSV that imports again, and discards drafts only', async () => {
    const exp = await api()
      .get(`/api/v1/terminology/versions/${v2Id}/export`)
      .set(bearer(w.tokens.pharmacist));
    expect(exp.status).toBe(200);
    expect(exp.headers['content-type']).toMatch(/text\/csv/);
    const text = exp.text.replace(/^\uFEFF/, '');
    expect(text.split('\r\n')[0]).toBe(HEADER);
    expect(validateConceptCsv(text).errorCount).toBe(0);
    const draft = await upload(`/systems/${systemId}/versions`, text, ministry(), '?version=4');
    expect(draft.status).toBe(201);
    expect(
      (await api().delete(`/api/v1/terminology/versions/${v2Id}`).set(ministry())).status,
    ).toBe(409);
    expect(
      (await api().delete(`/api/v1/terminology/versions/${draft.body.id}`).set(ministry())).status,
    ).toBe(204);
  });

  it('writes the imports and activations to the audit trail', async () => {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.actorUserId, w.users.ministry.id), eq(auditLogs.resourceId, v2Id)));
    expect(rows.map((r) => r.action).sort()).toEqual([
      'terminology.activated',
      'terminology.imported',
    ]);
  });

  it('serves FHIR CodeSystem, $lookup and $validate-code', async () => {
    const doc = bearer(w.tokens.doctor);
    const cs = await api().get(`/api/v1/terminology/fhir/CodeSystem/${systemId}`).set(doc);
    expect(cs.status).toBe(200);
    expect(cs.headers['content-type']).toMatch(/application\/fhir\+json/);
    const body = JSON.parse(cs.text);
    expect(body).toMatchObject({ resourceType: 'CodeSystem', content: 'complete' });
    expect(body.concept[0].code).toBe('I');
    expect(body.concept[0].concept.map((c: { code: string }) => c.code)).toContain('I21');

    const url = `http://example.org/fhir/CodeSystem/${code.toLowerCase()}`;
    const lookup = await api()
      .get('/api/v1/terminology/fhir/CodeSystem/$lookup')
      .query({ system: url, code: 'I10' })
      .set(doc);
    expect(lookup.status).toBe(200);
    const params = JSON.parse(lookup.text).parameter as { name: string; valueString?: string }[];
    expect(params.find((p) => p.name === 'display')?.valueString).toBe(
      'Essential (primary) hypertension',
    );
    expect(params.filter((p) => p.name === 'designation')).toHaveLength(2);
    const missing = await api()
      .get('/api/v1/terminology/fhir/CodeSystem/$lookup')
      .query({ system: url, code: 'Z99' })
      .set(doc);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.text).resourceType).toBe('OperationOutcome');

    const valid = await api()
      .get('/api/v1/terminology/fhir/CodeSystem/$validate-code')
      .query({ url, code: 'I50', display: 'heart failure' })
      .set(doc);
    expect(JSON.parse(valid.text).parameter[0]).toEqual({ name: 'result', valueBoolean: true });
    const wrongDisplay = await api()
      .get('/api/v1/terminology/fhir/CodeSystem/$validate-code')
      .query({ url, code: 'I50', display: 'Asthma' })
      .set(doc);
    expect(JSON.parse(wrongDisplay.text).parameter[0].valueBoolean).toBe(false);
    const search = await api().get('/api/v1/terminology/fhir/CodeSystem').query({ url }).set(doc);
    expect(JSON.parse(search.text)).toMatchObject({ resourceType: 'Bundle', total: 1 });
  });
});

describe('local systems and mappings', () => {
  let nationalId: string;
  let localId: string;
  let mapId: string;
  const nationalCode = `TEST-LOINC-${seq}`;
  const localCode = `TEST-LOCAL-${seq}`;
  const mapCode = `TEST-MAP-${seq}`;

  beforeAll(async () => {
    nationalId = (await createSystem(ministry(), 'EXTERNAL', nationalCode)).body.id;
    const v = await upload(
      `/systems/${nationalId}/versions`,
      csv([
        HEADER,
        '718-7,Hemoglobin [Mass/volume] in Blood,,,,',
        '2345-7,Glucose [Mass/volume] in Serum or Plasma,,,,',
        '9999-9,Retired test,,,,false',
      ]),
      ministry(),
      '?version=1',
    );
    await api().post(`/api/v1/terminology/versions/${v.body.id}/activate`).set(ministry());
  });

  it('lets a director manage only the local systems of their own facility', async () => {
    const local = await createSystem(director(), 'LOCAL', localCode);
    expect(local.status).toBe(201);
    expect(local.body).toMatchObject({ kind: 'LOCAL', facilityId: w.facility.id, canManage: true });
    localId = local.body.id;
    const v = await upload(
      `/systems/${localId}/versions`,
      csv([
        HEADER,
        'HGB,Hemoglobina,,,,',
        'GLU,Glukoza,,,,',
        'ESR,Sedimentimi,,,,',
        'SMEAR,Njollosja e gjakut,,,,',
      ]),
      director(),
      '?version=1',
    );
    expect(v.status).toBe(201);
    expect(
      (await api().post(`/api/v1/terminology/versions/${v.body.id}/activate`).set(director()))
        .status,
    ).toBe(200);
    // Another facility's director and the Ministry cannot change it.
    const other = bearer(w.tokens.otherDirector);
    expect((await upload(`/systems/${localId}/versions`, V1, other, '?version=2')).status).toBe(
      403,
    );
    expect(
      (await upload(`/systems/${localId}/versions`, V1, ministry(), '?version=2')).status,
    ).toBe(403);
    expect(
      (
        await api()
          .patch(`/api/v1/terminology/systems/${localId}`)
          .set(other)
          .send({ name: 'Hijack' })
      ).status,
    ).toBe(403);
    // Everyone else reads.
    const list = await api().get('/api/v1/terminology/systems').set(other);
    const mine = list.body.items.find((s: { id: string }) => s.id === localId);
    expect(mine).toMatchObject({ canManage: false, activeVersion: { conceptCount: 4 } });
  });

  it('validates mapping imports against both systems and reports unmapped codes', async () => {
    const created = await api()
      .post('/api/v1/terminology/maps')
      .set(director())
      .send({
        code: mapCode,
        name: 'Local lab to LOINC',
        url: `http://example.org/fhir/ConceptMap/${mapCode.toLowerCase()}`,
        sourceSystemId: localId,
        targetSystemId: nationalId,
      });
    expect(created.status).toBe(201);
    mapId = created.body.id;
    expect(
      (
        await api()
          .post('/api/v1/terminology/maps')
          .set(ministry())
          .send({
            code: `${mapCode}-X`,
            name: 'Not the Ministry’s',
            url: `http://example.org/fhir/ConceptMap/${mapCode.toLowerCase()}-x`,
            sourceSystemId: localId,
            targetSystemId: nationalId,
          })
      ).status,
    ).toBe(403);

    const MAP_HEADER = 'source_code,target_code,equivalence,comment';
    const bad = await upload(
      `/maps/${mapId}/versions`,
      csv([
        MAP_HEADER,
        'HGB,1234-5,EQUIVALENT,',
        'XXX,718-7,EQUIVALENT,',
        'GLU,,EQUIVALENT,',
        'ESR,718-7,UNMATCHED,',
        'SMEAR,718-7,SIMILAR,',
      ]),
      director(),
      '?version=1',
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { message: string }) => d.message)).toEqual([
      'The target code is not in the active version of the target system',
      'The source code is not in the active version of the source system',
      'The target code is missing',
      'An UNMATCHED row must not have a target code',
      'The equivalence must be EQUIVALENT, WIDER, NARROWER, RELATEDTO or UNMATCHED',
    ]);

    const good = await upload(
      `/maps/${mapId}/versions`,
      csv([
        MAP_HEADER,
        'HGB,718-7,equivalent,',
        'GLU,2345-7,WIDER,Fasting only locally',
        'ESR,,UNMATCHED,No LOINC in the subset',
        'GLU,9999-9,RELATEDTO,',
      ]),
      director(),
      '?version=1',
    );
    expect(good.status).toBe(201);
    expect(good.body).toMatchObject({
      entryCount: 4,
      unmappedSourceCodes: { count: 1, codes: ['SMEAR'] },
      byEquivalence: { EQUIVALENT: 1, WIDER: 1, UNMATCHED: 1, RELATEDTO: 1 },
    });
    expect(good.body.warnings).toEqual([
      { path: 'line 5', message: 'The target code is inactive' },
    ]);
    expect(
      (
        await api()
          .post(`/api/v1/terminology/map-versions/${good.body.id}/activate`)
          .set(director())
      ).status,
    ).toBe(200);
  });

  it('translates codes (service, REST and FHIR $translate)', async () => {
    const t = await translateCode(mapCode, 'GLU');
    expect(t?.matches.map((m) => [m.code, m.equivalence])).toEqual([
      ['2345-7', 'WIDER'],
      ['9999-9', 'RELATEDTO'],
    ]);
    expect(t?.matches[0]!.display).toBe('Glucose [Mass/volume] in Serum or Plasma');
    expect((await translateCode(mapCode, 'ESR'))?.matches[0]!.equivalence).toBe('UNMATCHED');

    const lab = bearer(w.tokens.nurse);
    const rest = await api()
      .get('/api/v1/terminology/translate')
      .query({ map: mapCode, code: 'HGB' })
      .set(lab);
    expect(rest.status).toBe(200);
    expect(rest.body.matches[0]).toMatchObject({ code: '718-7', equivalence: 'EQUIVALENT' });

    const url = `http://example.org/fhir/ConceptMap/${mapCode.toLowerCase()}`;
    const fhir = await api()
      .get('/api/v1/terminology/fhir/ConceptMap/$translate')
      .query({ url, code: 'HGB' })
      .set(lab);
    const params = JSON.parse(fhir.text).parameter;
    expect(params[0]).toEqual({ name: 'result', valueBoolean: true });
    expect(params[1].part[1].valueCoding).toMatchObject({ code: '718-7' });
    const none = await api()
      .get('/api/v1/terminology/fhir/ConceptMap/$translate')
      .query({ url, code: 'ESR' })
      .set(lab);
    expect(JSON.parse(none.text).parameter[0].valueBoolean).toBe(false);
    const cm = await api().get(`/api/v1/terminology/fhir/ConceptMap/${mapId}`).set(lab);
    expect(JSON.parse(cm.text).group[0].element).toHaveLength(3);

    const entries = await api()
      .get(`/api/v1/terminology/maps/${mapId}/entries`)
      .query({ q: 'GLU' })
      .set(lab);
    expect(entries.body.total).toBe(2);
  });

  it('refuses patients everywhere', async () => {
    const p = bearer(w.tokens.patient);
    expect((await api().get('/api/v1/terminology/systems').set(p)).status).toBe(403);
    expect((await api().get('/api/v1/terminology/fhir/CodeSystem').set(p)).status).toBe(403);
    expect(
      (await api().get('/api/v1/terminology/translate').query({ map: mapCode, code: 'HGB' }).set(p))
        .status,
    ).toBe(403);
  });
});
