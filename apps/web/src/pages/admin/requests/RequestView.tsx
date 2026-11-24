import { Link, useParams } from 'react-router-dom';
import {
  statusLabel,
  useAdminRequest,
  useAnswer,
  useSetRequestStatus,
  type OperatorRequestDetail,
  type RequestStatus,
} from '../../../api/operatorRequests';
import {
  Button,
  Card,
  DefinitionList,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
} from '../../../components/ui';
import { t } from '../../../i18n';
import { Conversation, MessageForm, requestFacts } from '../../requests/parts';

/** Where an answer leaves the request: usually waiting for the facility, or resolved. */
const AFTER_ANSWER: { value: RequestStatus | ''; label: () => string }[] = [
  { value: 'WAITING_CUSTOMER', label: () => statusLabel('WAITING_CUSTOMER', 'admin') },
  { value: 'RESOLVED', label: () => statusLabel('RESOLVED', 'admin') },
  { value: '', label: () => t('Leave the status as it is') },
];

/** One request to the operator (/admin/requests/:id): conversation, answer, status. Round 2, G. */
export function RequestView() {
  const { id = '' } = useParams();
  const request = useAdminRequest(id);
  return (
    <>
      <PageHeader
        title={request.data?.subject ?? t('Request')}
        subtitle={
          <>
            <Link to="/admin/requests">{t('All requests')}</Link>
            {request.data && (
              <>
                {' · '}
                <Link to={`/admin/organizations/${request.data.facilityId}`}>
                  {request.data.facilityName}
                </Link>
              </>
            )}
          </>
        }
      />
      <QueryView query={request}>{(r) => <RequestBody r={r} />}</QueryView>
    </>
  );
}

function RequestBody({ r }: { r: OperatorRequestDetail }) {
  const answer = useAnswer(r.id);
  const setStatus = useSetRequestStatus(r.id);
  return (
    <div className="two-col">
      <Card title={t('Conversation')}>
        <div className="stack">
          <Conversation request={r} audience="admin" />
          <MessageForm
            label={t('Answer')}
            submitLabel={t('Send the answer')}
            pending={answer.isPending}
            error={answer.error}
            hint={t(
              'The person who asked is notified; the facility sees the answer as from the operator, without your name. Never ask for patient information.',
            )}
            extra={
              <SelectField
                label={t('Status after the answer')}
                name="status"
                defaultValue="WAITING_CUSTOMER"
                options={AFTER_ANSWER.map((o) => ({ value: o.value, label: o.label() }))}
              />
            }
            onSend={(body, form) => {
              const status = new FormData(form).get('status');
              return answer.mutateAsync({
                body,
                ...(status ? { status: status as RequestStatus } : {}),
              });
            }}
          />
        </div>
      </Card>
      <div className="stack">
        <Card title={t('Details')}>
          <DefinitionList
            items={[
              [
                t('Facility'),
                <Link key="f" to={`/admin/organizations/${r.facilityId}`}>
                  {r.facilityName}
                </Link>,
              ],
              ...requestFacts(r, 'admin'),
            ]}
          />
        </Card>
        <Card title={t('Status')}>
          <div className="row">
            {r.status !== 'RESOLVED' && (
              <Button loading={setStatus.isPending} onClick={() => setStatus.mutate('RESOLVED')}>
                {t('Mark as resolved')}
              </Button>
            )}
            {r.status !== 'OPEN' && (
              <Button
                variant="secondary"
                loading={setStatus.isPending}
                onClick={() => setStatus.mutate('OPEN')}
              >
                {r.status === 'RESOLVED' ? t('Open again') : t('Mark as open')}
              </Button>
            )}
            {r.status === 'OPEN' && (
              <Button
                variant="secondary"
                loading={setStatus.isPending}
                onClick={() => setStatus.mutate('WAITING_CUSTOMER')}
              >
                {t('Wait for the facility')}
              </Button>
            )}
          </div>
          <ErrorAlert error={setStatus.error} />
        </Card>
      </div>
    </div>
  );
}
