import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  categoryLabel,
  REQUEST_CATEGORIES,
  SUBJECT_MAX,
  BODY_MAX,
  useCreateRequest,
  useMyRequests,
  type RequestCategory,
  type RequestStatus,
} from '../../api/operatorRequests';
import { usePlatformInfo } from '../../api/platform';
import { SupportContacts } from '../../components/ContactOperator';
import {
  Alert,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Table,
  Tabs,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDateTime } from '../../format';
import { t } from '../../i18n';
import { NO_PATIENT_INFO, patientNumberProblem, PriorityBadge, RequestStatusBadge } from './parts';

type Filter = RequestStatus | '';

/**
 * "Contact the operator" (/operator-requests) for a facility's directors and IT support: their
 * facility's requests and a new request. Round 2, builder G.
 */
export function OperatorRequests() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('new') as RequestCategory | null;
  const creating = requested !== null;
  const [filter, setFilter] = useState<Filter>('');
  const [page, setPage] = useState(1);
  const list = useMyRequests(filter, page);
  const info = usePlatformInfo();
  const setCreating = (category: RequestCategory | null) => {
    if (category) params.set('new', category);
    else params.delete('new');
    setParams(params, { replace: true });
  };
  return (
    <>
      <PageHeader
        title={t('Contact the operator')}
        subtitle={t(
          'Questions and problems for the operator of the service: billing, accounts, technical problems, data protection and security incidents. The operator never sees patient records.',
        )}
        actions={<Button onClick={() => setCreating('OTHER')}>{t('New request')}</Button>}
      />
      <div className="stack">
        {info.data && (info.data.supportEmail || info.data.supportPhone) && (
          <p className="muted" style={{ margin: 0 }}>
            {t('Also by e-mail or phone')}: <SupportContacts info={info.data} /> ·{' '}
            <Link to="/help">{t('Help and contact')}</Link>
          </p>
        )}
        <Card title={t('Requests of your facility')}>
          <Tabs<Filter>
            label={t('Requests of your facility')}
            withPanels={false}
            active={filter}
            onChange={(f) => {
              setFilter(f);
              setPage(1);
            }}
            tabs={[
              { id: '', label: t('All') },
              { id: 'OPEN', label: t('Open|request status') },
              { id: 'WAITING_CUSTOMER', label: t('Waiting for your answer|request status') },
              { id: 'RESOLVED', label: t('Resolved|request status') },
            ]}
          />
          <QueryView query={list}>
            {(d) =>
              d.items.length === 0 ? (
                <EmptyState title={t('No requests here')}>
                  {t('Write to the operator with “New request”.')}
                </EmptyState>
              ) : (
                <>
                  <Table caption={t('Requests of your facility')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('Request')}</th>
                        <th scope="col">{t('Category')}</th>
                        <th scope="col">{t('Status')}</th>
                        <th scope="col">{t('Requested by')}</th>
                        <th scope="col">{t('Last change')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.items.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <Link to={`/operator-requests/${r.id}`}>{r.subject}</Link>
                            <div className="muted">
                              <code>{r.reference}</code>
                            </div>
                          </td>
                          <td>{categoryLabel(r.category)}</td>
                          <td>
                            <div className="row">
                              <RequestStatusBadge status={r.status} audience="facility" />
                              <PriorityBadge priority={r.priority} />
                            </div>
                          </td>
                          <td>{r.requesterName}</td>
                          <td>{formatDateTime(r.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
                </>
              )
            }
          </QueryView>
        </Card>
      </div>
      <Dialog
        open={creating}
        onClose={() => setCreating(null)}
        title={t('New request to the operator')}
        wide
      >
        {creating && (
          <NewRequestForm
            initialCategory={
              requested && REQUEST_CATEGORIES.includes(requested) ? requested : 'OTHER'
            }
            onCancel={() => setCreating(null)}
          />
        )}
      </Dialog>
    </>
  );
}

function NewRequestForm({
  initialCategory,
  onCancel,
}: {
  initialCategory: RequestCategory;
  onCancel: () => void;
}) {
  const navigate = useNavigate();
  const create = useCreateRequest();
  const [category, setCategory] = useState<RequestCategory>(initialCategory);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const subjectProblem = patientNumberProblem(subject);
  const bodyProblem = patientNumberProblem(body);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (subjectProblem || bodyProblem) return;
    create.mutate(
      { category, subject: subject.trim(), body: body.trim() },
      { onSuccess: (r) => navigate(`/operator-requests/${r.id}`) },
    );
  }
  return (
    <form onSubmit={submit} className="stack">
      <Alert tone="warning" title={t('Do not include patient information')}>
        {t(
          'Requests reach the operator, who never sees patient records. Write about the service – no names, personal numbers or health details of patients.',
        )}
      </Alert>
      <SelectField
        label={t('What is it about?')}
        name="category"
        value={category}
        onChange={(e) => setCategory(e.target.value as RequestCategory)}
        options={REQUEST_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
      />
      {category === 'SECURITY_INCIDENT' && (
        <Alert tone="danger" title={t('A security incident reaches every administrator at once')}>
          {t(
            'It is of high priority and e-mailed to all the operator’s administrators. Also follow your facility’s own incident procedure, and in an emergency call 112.',
          )}
        </Alert>
      )}
      <TextField
        label={t('Subject')}
        name="subject"
        required
        minLength={3}
        maxLength={SUBJECT_MAX}
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        error={subjectProblem}
      />
      <TextAreaField
        label={t('Message')}
        name="body"
        required
        minLength={2}
        maxLength={BODY_MAX}
        rows={7}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        hint={NO_PATIENT_INFO()}
        error={bodyProblem}
      />
      <ErrorAlert error={create.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          type="submit"
          loading={create.isPending}
          disabled={Boolean(subjectProblem || bodyProblem)}
        >
          {t('Send the request')}
        </Button>
      </div>
    </form>
  );
}
