export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Resource not found') =>
  new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message: string) => new HttpError(409, 'CONFLICT', message);
export const tooManyRequests = (message: string) =>
  new HttpError(429, 'TOO_MANY_REQUESTS', message);

/**
 * The action needs proof that the account holder is at the keyboard: a recent sign-in or the
 * password again (code REAUTH_REQUIRED). The passkey settings answer 403 as they always have;
 * requireRecentAuth() answers 401 so the web client knows to ask for the password and retry.
 */
export const reauthRequired = (status: 401 | 403 = 403) =>
  new HttpError(status, 'REAUTH_REQUIRED', 'Confirm your password to continue');
/** A route or function that is declared but not built yet. */
export const notImplemented = (message = 'Not implemented yet') =>
  new HttpError(501, 'NOT_IMPLEMENTED', message);
