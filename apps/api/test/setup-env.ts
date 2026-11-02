// Loaded before every test file (before any app module reads the environment).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ?? 'postgres://pacient:pacient@localhost:5432/pacient_test';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-that-is-definitely-long-enough-123';
process.env.WEB_APP_URL ??= 'http://localhost:5173';
// Quiet hours depend on the clock; integration tests disable them (unit-tested separately).
process.env.SMS_QUIET_HOURS ??= '';
