import { useState } from 'react';
import { useCertificates, type IssuedCertificate } from '../../../api/certificates';
import { useUser } from '../../../auth/AuthContext';
import { Alert, Button, Card, QueryView } from '../../../components/ui';
import { t } from '../../../i18n';
import { CertificateList } from '../../certificates/CertificateList';
import { CertificatePrintDialog } from '../../certificates/CertificateSheet';
import { IssueCertificateDialog } from '../../certificates/IssueCertificateDialog';

/** Medical certificates of the patient: sick leave, fitness, school absence, general. */
export function CertificatesTab({ patientId }: { patientId: string }) {
  const user = useUser();
  const list = useCertificates(patientId);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<IssuedCertificate | null>(null);
  const [printId, setPrintId] = useState<string | null>(null);
  return (
    <Card
      title={t('Medical certificates')}
      actions={
        user.role === 'DOCTOR' ? (
          <Button onClick={() => setIssuing(true)}>{t('Issue a certificate')}</Button>
        ) : undefined
      }
    >
      {issued && (
        <Alert
          tone={issued.warnings.length ? 'warning' : 'success'}
          title={t('Certificate {serial} issued', { serial: issued.serialNumber })}
        >
          {issued.warnings.map((w) => (
            <p key={w.code}>
              {t(w.message)} ({t('{count} days in a row in total', { count: w.days })})
            </p>
          ))}
          <Button size="sm" onClick={() => setPrintId(issued.id)}>
            {t('Show and print')}
          </Button>
        </Alert>
      )}
      <QueryView query={list}>
        {(items) => (
          <>
            <CertificateList items={items} patientId={patientId} showDiagnosis />
            <IssueCertificateDialog
              open={issuing}
              onClose={() => setIssuing(false)}
              patientId={patientId}
              existing={items}
              onIssued={setIssued}
            />
          </>
        )}
      </QueryView>
      <CertificatePrintDialog id={printId} onClose={() => setPrintId(null)} />
    </Card>
  );
}
