import { useCertificates } from '../../api/certificates';
import { useAuth } from '../../auth/AuthContext';
import { Card, PageHeader, QueryView } from '../../components/ui';
import { t } from '../../i18n';
import { CertificateList } from './CertificateList';

/** The patient's (or child's) medical certificates, to show or print for an employer or school. */
export function PortalCertificatesPage() {
  const { user, acting } = useAuth();
  const patientId = acting?.patientId ?? user?.patientId ?? null;
  const list = useCertificates(patientId);
  return (
    <>
      <PageHeader
        title={
          acting
            ? t('Medical certificates – {name}', { name: acting.firstName })
            : t('My certificates')
        }
        subtitle={t(
          'Certificates from your doctors. Employers and schools can check one by scanning its QR code; they see only its validity, kind, dates and issuer – never your diagnosis.',
        )}
      />
      <Card title={t('Medical certificates')}>
        <QueryView query={list}>
          {(items) => <CertificateList items={items} patientId={patientId ?? ''} showDiagnosis />}
        </QueryView>
      </Card>
    </>
  );
}
