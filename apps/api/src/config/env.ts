import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  WEB_APP_URL: z.string().url().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Number of proxies in front of the API (for correct client IPs in audit logs / rate limits). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /** Key for encrypting MFA secrets at rest. Required in production; keep it out of the database. */
  MFA_ENCRYPTION_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32).optional(),
  ),
  /** Require staff (doctors, directors, Ministry) to use two-step sign-in. Defaults to on in production. */
  /** smtp (real delivery), log (development), memory (tests). Defaults depend on NODE_ENV. */
  EMAIL_TRANSPORT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['smtp', 'log', 'memory']).optional(),
  ),
  /** e.g. smtps://user:pass@smtp.example.org:465 or smtp://localhost:1025 (Mailpit). */
  SMTP_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  EMAIL_FROM: z.string().default('Pacient <no-reply@pacient.local>'),
  /** twilio (real delivery), log (development), memory (tests). Defaults depend on NODE_ENV. */
  SMS_PROVIDER: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['twilio', 'log', 'memory']).optional(),
  ),
  TWILIO_ACCOUNT_SID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  TWILIO_AUTH_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Sender: an E.164 number or an approved alphanumeric sender id. */
  SMS_FROM: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(20).optional()),
  /** Country code used to normalise local numbers such as 044 123 456 (default Kosovo, +383). */
  SMS_DEFAULT_COUNTRY_CODE: z
    .string()
    .regex(/^\+[1-9][0-9]{0,3}$/)
    .default('+383'),
  /** Non-urgent SMS are held during quiet hours (local time), e.g. "22-7". Empty disables. */
  SMS_QUIET_HOURS: z
    .string()
    .regex(/^(\d{1,2}-\d{1,2})?$/)
    .default('22-7'),
  SMS_TIMEZONE: z.string().default('Europe/Belgrade'),
  SMS_WORKER: z.enum(['true', 'false']).default('true'),
  /** Malware scanning of uploaded documents: 'clamav' (clamd over TCP) or 'off'. */
  DOCUMENT_SCANNER: z.enum(['off', 'clamav']).default('off'),
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  /**
   * Image archive for radiology: 'dicomweb' (a PACS such as Orthanc via DICOMweb), 'demo'
   * (built-in synthetic images, development only) or 'off'. Default: demo outside production.
   */
  PACS_MODE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['off', 'demo', 'dicomweb']).optional(),
  ),
  /** DICOMweb root, e.g. http://orthanc:8042/dicom-web */
  PACS_DICOMWEB_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  /** Optional Authorization header value sent to the PACS, e.g. "Basic …". Never sent to browsers. */
  PACS_AUTH_HEADER: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  PACS_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  /** Run the email delivery worker in this process (disable on read-only replicas). */
  EMAIL_WORKER: z.enum(['true', 'false']).default('true'),
  REQUIRE_STAFF_MFA: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['true', 'false']).optional(),
  ),
});

export type Env = Omit<
  z.infer<typeof EnvSchema>,
  'MFA_ENCRYPTION_KEY' | 'REQUIRE_STAFF_MFA' | 'EMAIL_TRANSPORT' | 'SMS_PROVIDER' | 'PACS_MODE'
> & {
  PACS_MODE: 'off' | 'demo' | 'dicomweb';
  /** 'held' = queue only, no delivery (production without SMS provider settings). */
  SMS_PROVIDER: 'twilio' | 'log' | 'memory' | 'held';
  MFA_ENCRYPTION_KEY: string;
  REQUIRE_STAFF_MFA: boolean;
  /** 'held' = queue only, no delivery (production without SMTP settings). */
  EMAIL_TRANSPORT: 'smtp' | 'log' | 'memory' | 'held';
};

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    // Fail fast: never boot with an invalid security configuration.
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  const data = parsed.data;
  // Production without SMTP settings holds email in the outbox (delivered once SMTP is configured)
  // rather than refusing to start; an explicit EMAIL_TRANSPORT=smtp without SMTP_URL is an error.
  const emailTransport: Env['EMAIL_TRANSPORT'] =
    data.EMAIL_TRANSPORT ??
    (data.NODE_ENV === 'test'
      ? 'memory'
      : data.SMTP_URL
        ? 'smtp'
        : data.NODE_ENV === 'production'
          ? 'held'
          : 'log');
  const twilioReady = Boolean(data.TWILIO_ACCOUNT_SID && data.TWILIO_AUTH_TOKEN && data.SMS_FROM);
  const smsProvider: Env['SMS_PROVIDER'] =
    data.SMS_PROVIDER ??
    (data.NODE_ENV === 'test'
      ? 'memory'
      : twilioReady
        ? 'twilio'
        : data.NODE_ENV === 'production'
          ? 'held'
          : 'log');
  if (smsProvider === 'twilio' && !twilioReady) {
    throw new Error(
      'Invalid environment configuration:\n  - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and SMS_FROM are required for SMS',
    );
  }
  if (emailTransport === 'smtp' && !data.SMTP_URL) {
    throw new Error(
      'Invalid environment configuration:\n  - SMTP_URL is required for email delivery',
    );
  }
  if (data.DOCUMENT_SCANNER === 'clamav' && !data.CLAMAV_HOST) {
    throw new Error(
      'Invalid environment configuration:\n  - CLAMAV_HOST is required when DOCUMENT_SCANNER=clamav',
    );
  }
  const pacsMode: Env['PACS_MODE'] =
    data.PACS_MODE ??
    (data.PACS_DICOMWEB_URL ? 'dicomweb' : data.NODE_ENV === 'production' ? 'off' : 'demo');
  if (pacsMode === 'dicomweb' && !data.PACS_DICOMWEB_URL) {
    throw new Error(
      'Invalid environment configuration:\n  - PACS_DICOMWEB_URL is required when PACS_MODE=dicomweb',
    );
  }
  if (pacsMode === 'demo' && data.NODE_ENV === 'production') {
    throw new Error(
      'Invalid environment configuration:\n  - PACS_MODE=demo (synthetic images) is not allowed in production',
    );
  }
  if (data.NODE_ENV === 'production' && !data.MFA_ENCRYPTION_KEY) {
    throw new Error(
      'Invalid environment configuration:\n  - MFA_ENCRYPTION_KEY is required in production',
    );
  }
  return {
    ...data,
    // Development fallback only: a key derived from (but distinct from) the JWT secret.
    MFA_ENCRYPTION_KEY: data.MFA_ENCRYPTION_KEY ?? `dev-mfa-key:${data.JWT_ACCESS_SECRET}`,
    REQUIRE_STAFF_MFA: data.REQUIRE_STAFF_MFA
      ? data.REQUIRE_STAFF_MFA === 'true'
      : data.NODE_ENV === 'production',
    EMAIL_TRANSPORT: emailTransport,
    SMS_PROVIDER: smsProvider,
    PACS_MODE: pacsMode,
  };
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
