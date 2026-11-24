import { Link, useParams } from 'react-router-dom';
import { useMyRequest, useReply } from '../../api/operatorRequests';
import { Card, DefinitionList, PageHeader, QueryView } from '../../components/ui';
import { t } from '../../i18n';
import { Conversation, MessageForm, requestFacts } from './parts';

/** One request to the operator (/operator-requests/:id) and its conversation. Round 2, G. */
export function OperatorRequestPage() {
  const { id = '' } = useParams();
  const request = useMyRequest(id);
  const reply = useReply(id);
  return (
    <>
      <PageHeader
        title={request.data?.subject ?? t('Request')}
        subtitle={<Link to="/operator-requests">{t('All requests of your facility')}</Link>}
      />
      <QueryView query={request}>
        {(r) => (
          <div className="two-col">
            <Card title={t('Conversation')}>
              <div className="stack">
                <Conversation request={r} audience="facility" />
                <MessageForm
                  label={t('Your message')}
                  submitLabel={t('Send')}
                  pending={reply.isPending}
                  error={reply.error}
                  hint={
                    r.status === 'RESOLVED'
                      ? t('Writing again opens the request again.')
                      : r.status === 'WAITING_CUSTOMER'
                        ? t('The operator is waiting for your answer.')
                        : undefined
                  }
                  onSend={(body) => reply.mutateAsync(body)}
                />
              </div>
            </Card>
            <Card title={t('Details')}>
              <DefinitionList items={requestFacts(r, 'facility')} />
            </Card>
          </div>
        )}
      </QueryView>
    </>
  );
}
