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
  REQUIRE_STAFF_MFA: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['true', 'false']).optional(),
  ),
});

export type Env = Omit<z.infer<typeof EnvSchema>, 'MFA_ENCRYPTION_KEY' | 'REQUIRE_STAFF_MFA'> & {
  MFA_ENCRYPTION_KEY: string;
  REQUIRE_STAFF_MFA: boolean;
};

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    // Fail fast: never boot with an invalid security configuration.
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  const data = parsed.data;
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
  };
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
