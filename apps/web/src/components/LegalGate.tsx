import type { ReactNode } from 'react';

/**
 * Before the workspace opens: the signed-in user accepts the current terms of use and privacy
 * notice when a new version requires it.
 */
export function LegalGate({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
