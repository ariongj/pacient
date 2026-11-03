import { t } from '../i18n';

export type PartnerScope = 'fhir.patient.read' | 'stats.read' | 'directory.read' | 'births.notify';

export interface PartnerClient {
  id: string;
  name: string;
  organisation: string;
  scopes: PartnerScope[];
  apiKeyPrefix: string;
  isActive: boolean;
  allowedIps: string[] | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface PartnerUsage {
  client: PartnerClient;
  total: number;
  denied: number;
  distinctPatients: number;
  days: { day: string; scope: string | null; outcome: string; calls: number }[];
}

export const PARTNER_SCOPES: PartnerScope[] = [
  'fhir.patient.read',
  'stats.read',
  'directory.read',
  'births.notify',
];

/** Plain-language description of what a scope allows (translated at call time). */
export function scopeInfo(scope: PartnerScope): { title: string; description: string } {
  switch (scope) {
    case 'fhir.patient.read':
      return {
        title: t('Patient records (FHIR)'),
        description: t(
          'Find a patient by national ID and read their record for a stated purpose (treatment, payment or public health). Never returned when the patient has withdrawn consent to sharing.',
        ),
      };
    case 'stats.read':
      return {
        title: t('National statistics'),
        description: t('Aggregate figures only, with small numbers suppressed. No patient data.'),
      };
    case 'directory.read':
      return {
        title: t('Directory of facilities and practitioners'),
        description: t('Names, specialties and facilities. No staff contact details.'),
      };
    case 'births.notify':
      return {
        title: t('Births for civil registration'),
        description: t(
          'List newborns waiting for a national number and report the number once it is issued.',
        ),
      };
  }
}

export interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface OpenApiOperation {
  tags: string[];
  summary: string;
  description?: string;
  operationId: string;
  security?: Record<string, string[]>[];
  parameters?: OpenApiParameter[];
  requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
  responses: Record<string, { description: string }>;
  'x-access'?: string;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
}
