import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { API_BASE, api } from '../../api/client';
import type { OpenApiDocument, OpenApiOperation } from '../../api/partner';
import { Badge, Card, EmptyState, PageHeader, QueryView, TextField } from '../../components/ui';
import { t } from '../../i18n';

const METHOD_TONE: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  get: 'info',
  post: 'success',
  put: 'warning',
  patch: 'warning',
  delete: 'danger',
};

const AUTH_LABEL = (security: OpenApiOperation['security']) => {
  const scheme = security?.[0] ? Object.keys(security[0])[0] : undefined;
  if (!scheme) return t('Public');
  return (
    { userBearer: t('User session'), partnerKey: t('Partner key'), labKey: t('Laboratory key') }[
      scheme
    ] ?? scheme
  );
};

/** Short JSON Schema rendering: { field: type, … } with required fields marked. */
function schemaSummary(schema: Record<string, unknown> | undefined): string {
  if (!schema) return '';
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return String(schema.format ?? schema.type ?? '');
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const typeOf = (s: Record<string, unknown>): string =>
    Array.isArray(s.enum)
      ? (s.enum as string[]).join(' | ')
      : s.type === 'array'
        ? `${typeOf((s.items as Record<string, unknown>) ?? {})}[]`
        : String(s.format ?? s.type ?? 'any');
  return `{\n${Object.entries(props)
    .map(([k, v]) => `  ${k}${required.has(k) ? '' : '?'}: ${typeOf(v)}`)
    .join('\n')}\n}`;
}

/**
 * API reference for integrators, rendered from the server's OpenAPI document (no third-party
 * scripts), plus a quick start for partner systems.
 */
export function ApiDocsPage() {
  const doc = useQuery({
    queryKey: ['openapi'],
    queryFn: () => api<OpenApiDocument>('/partner/openapi.json'),
    staleTime: 10 * 60_000,
  });
  const [filter, setFilter] = useState('');
  const base = API_BASE.startsWith('http') ? API_BASE : `${window.location.origin}${API_BASE}`;

  return (
    <>
      <PageHeader
        title={t('API documentation')}
        subtitle={t(
          'Every part of Pacient works on one shared database through one API. External systems use that API with a scoped key – never direct database access.',
        )}
      />

      <Card title={t('Quick start for partner systems')}>
        <ol className="stack" style={{ gap: '0.5rem', paddingLeft: '1.2rem' }}>
          <li>
            {t(
              'The Ministry registers your system under Partner systems and gives you a key with the scopes you need.',
            )}
          </li>
          <li>{t('Send the key with every request: “Authorization: Bearer pk_…”.')}</li>
          <li>
            {t(
              'For patient data, state why you need it in X-Purpose-Of-Use: TREATMENT (with X-Requesting-Practitioner), PAYMENT or PUBLIC_HEALTH. You receive only what that purpose needs.',
            )}
          </li>
          <li>
            {t(
              'Patients who withdrew consent to sharing are never returned, and every call appears in the patient’s “Who viewed my record”.',
            )}
          </li>
        </ol>
        <pre className="note mono" style={{ overflowX: 'auto' }}>
          {`curl -H "Authorization: Bearer $PACIENT_KEY" \\
     -H "X-Purpose-Of-Use: PAYMENT" \\
     "${base}/partner/fhir/Patient?identifier=urn:pacient:national-id|1234567890"

curl -H "Authorization: Bearer $PACIENT_KEY" \\
     -H "X-Purpose-Of-Use: TREATMENT" \\
     -H "X-Requesting-Practitioner: Dr. Name (licence 123)" \\
     "${base}/partner/fhir/Patient/<id>/$everything"`}
        </pre>
        <p className="muted">
          {t('Machine-readable description (OpenAPI 3.1):')}{' '}
          <a href={`${base}/partner/openapi.json`} target="_blank" rel="noreferrer">
            {`${base}/partner/openapi.json`}
          </a>
        </p>
      </Card>

      <Card
        title={t('Reference')}
        actions={
          <div style={{ minWidth: 220 }}>
            <TextField
              label={t('Filter endpoints')}
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
              placeholder={t('e.g. fhir, births, admissions')}
            />
          </div>
        }
      >
        <QueryView query={doc}>{(d) => <Reference doc={d} filter={filter} />}</QueryView>
      </Card>
    </>
  );
}

function Reference({ doc, filter }: { doc: OpenApiDocument; filter: string }) {
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const byTag = new Map<string, { method: string; path: string; op: OpenApiOperation }[]>();
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (q && !`${method} ${path} ${op.summary}`.toLowerCase().includes(q)) continue;
        const tag = op.tags[0] ?? 'Other';
        byTag.set(tag, [...(byTag.get(tag) ?? []), { method, path, op }]);
      }
    }
    return doc.tags
      .map((tag) => ({ ...tag, ops: byTag.get(tag.name) ?? [] }))
      .filter((g) => g.ops.length);
  }, [doc, filter]);

  if (!groups.length) return <EmptyState title={t('No endpoints match')} />;
  return (
    <div className="stack" style={{ gap: '1.5rem' }}>
      {groups.map((g) => (
        <section key={g.name} aria-labelledby={`tag-${g.name}`}>
          <h3 id={`tag-${g.name}`}>{t(g.name)}</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            {t(g.description)}
          </p>
          <div className="stack" style={{ gap: '0.5rem' }}>
            {g.ops.map(({ method, path, op }) => (
              <details
                key={`${method} ${path}`}
                className="card"
                style={{ padding: '0.6rem 0.8rem' }}
              >
                <summary
                  style={{
                    cursor: 'pointer',
                    display: 'flex',
                    gap: '0.6rem',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  <Badge tone={METHOD_TONE[method] ?? 'neutral'}>{method.toUpperCase()}</Badge>
                  <code className="mono" style={{ wordBreak: 'break-all' }}>
                    {path}
                  </code>
                  <span>{t(op.summary)}</span>
                  <span className="muted" style={{ marginLeft: 'auto', fontSize: '0.85rem' }}>
                    {AUTH_LABEL(op.security)}
                    {op['x-access'] ? ` · ${op['x-access']}` : ''}
                  </span>
                </summary>
                <div className="stack" style={{ gap: '0.5rem', marginTop: '0.6rem' }}>
                  {op.parameters?.length ? (
                    <div>
                      <strong>{t('Parameters')}</strong>
                      <ul style={{ margin: '0.25rem 0', paddingLeft: '1.2rem' }}>
                        {op.parameters.map((p) => (
                          <li key={`${p.in}-${p.name}`}>
                            <code className="mono">{p.name}</code>{' '}
                            <span className="muted">
                              ({p.in}
                              {p.required ? `, ${t('required')}` : ''})
                            </span>
                            {p.description ? ` – ${p.description}` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {op.requestBody ? (
                    <div>
                      <strong>{t('Request body')}</strong>{' '}
                      <span className="muted">
                        {Object.keys(op.requestBody.content).join(', ')}
                      </span>
                      {Object.values(op.requestBody.content)[0]?.schema?.properties ? (
                        <pre className="note mono" style={{ overflowX: 'auto' }}>
                          {schemaSummary(Object.values(op.requestBody.content)[0]!.schema)}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                  <div>
                    <strong>{t('Responses')}</strong>
                    <ul style={{ margin: '0.25rem 0', paddingLeft: '1.2rem' }}>
                      {Object.entries(op.responses).map(([code, r]) => (
                        <li key={code}>
                          <code className="mono">{code}</code> {r.description}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
