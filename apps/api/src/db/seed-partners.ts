/**
 * Demo partner systems (development seed only). Two have fixed development keys so the partner
 * API can be tried straight away; never use these keys anywhere else.
 */
import { isProd } from '../config/env.js';
import { hashToken } from '../lib/tokens.js';
import { newPartnerKey } from '../modules/partner/partner.auth.js';
import { db } from './client.js';
import { partnerClients, type PartnerScope } from './schema.js';

export const DEMO_HIF_API_KEY = 'pk_dev_hif_demo_key_not_for_production';
export const DEMO_CIVIL_REGISTRY_API_KEY = 'pk_dev_civil_registry_demo_key_not_for_production';

export async function seedPartners(_: { facilityId: string }) {
  if (isProd) throw new Error('Refusing to create demo partner keys in production');
  const demo: { name: string; organisation: string; scopes: PartnerScope[]; key: string }[] = [
    {
      name: 'Fondi i Sigurimit Shëndetësor (demo)',
      organisation: 'Fondi i Sigurimit Shëndetësor të Kosovës',
      scopes: ['fhir.patient.read', 'stats.read'],
      key: DEMO_HIF_API_KEY,
    },
    {
      name: 'Agjencia e Regjistrimit Civil (demo)',
      organisation: 'Agjencia e Regjistrimit Civil – Ministria e Punëve të Brendshme',
      scopes: ['births.notify', 'deaths.read'],
      key: DEMO_CIVIL_REGISTRY_API_KEY,
    },
    {
      name: 'Drejtoria e shëndetit publik (demo)',
      organisation: 'Instituti Kombëtar i Shëndetit Publik',
      scopes: ['stats.read', 'directory.read'],
      key: newPartnerKey(),
    },
  ];
  await db.insert(partnerClients).values(
    demo.map((d) => ({
      name: d.name,
      organisation: d.organisation,
      scopes: d.scopes,
      apiKeyHash: hashToken(d.key),
      apiKeyPrefix: d.key.slice(0, 10),
    })),
  );
}
