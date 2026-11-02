import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ApiError } from '../api/client';
import { humanize } from '../format';

/* ------------------------------------------------------------------ layout ------------------- */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · Pacient`;
  }, [title]);
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-header">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Grid({ children, min = 220 }: { children: ReactNode; min?: number }) {
  return (
    <div
      className="grid"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))` }}
    >
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ status ------------------- */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Badges always carry text (and an icon glyph), never colour alone, for accessibility. */
const GLYPH: Record<Tone, string> = {
  neutral: '•',
  info: 'ℹ',
  success: '✓',
  warning: '!',
  danger: '‼',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      <span aria-hidden="true">{GLYPH[tone]}</span>
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  ACTIVE: 'info',
  CHRONIC: 'warning',
  RESOLVED: 'success',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
  REQUESTED: 'warning',
  CONFIRMED: 'success',
  NO_SHOW: 'danger',
  NORMAL: 'success',
  LOW: 'warning',
  HIGH: 'warning',
  CRITICAL: 'danger',
  MILD: 'info',
  MODERATE: 'warning',
  SEVERE: 'danger',
  LIFE_THREATENING: 'danger',
  DRAFT: 'warning',
  SIGNED: 'success',
  OPEN: 'warning',
  ACCEPTED: 'success',
  REJECTED: 'neutral',
  UNCONFIRMED: 'warning',
  REFUTED: 'neutral',
  ENTERED_IN_ERROR: 'neutral',
  PRELIMINARY: 'warning',
  FINAL: 'success',
  CORRECTED: 'info',
  SUCCESS: 'success',
  FAILURE: 'warning',
  DENIED: 'danger',
  EMERGENCY: 'danger',
  CARE_TEAM: 'info',
  CHECKED_IN: 'info',
  PENDING: 'warning',
  VERIFIED: 'info',
  RETURNED: 'danger',
  DISPENSED: 'success',
  GIVEN: 'success',
  WITHHELD: 'warning',
  REFUSED: 'warning',
  OMITTED: 'danger',
  DONE: 'success',
  URGENT: 'danger',
  ROUTINE: 'neutral',
  APPROPRIATE: 'success',
  INAPPROPRIATE: 'danger',
  NEEDS_FOLLOW_UP: 'warning',
};

export function StatusBadge({ value }: { value: string }) {
  return <Badge tone={STATUS_TONES[value] ?? 'neutral'}>{humanize(value)}</Badge>;
}

/* ------------------------------------------------------------------ feedback ----------------- */

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {title && <strong>{title}</strong>}
      {children && <div>{children}</div>}
    </div>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong';
  const details =
    error instanceof ApiError && Array.isArray(error.details)
      ? (error.details as { path?: string; message?: string }[]).filter((d) => d.message)
      : [];
  return (
    <Alert tone="danger" title={message}>
      {details.length > 0 && (
        <ul>
          {details.map((d, i) => (
            <li key={i}>
              {d.path ? <code>{d.path}</code> : null} {d.message}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}

/** Renders loading / error / content for a TanStack Query result. */
export function QueryView<T>({
  query,
  children,
}: {
  query: { isPending: boolean; error: unknown; data: T | undefined };
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorAlert error={query.error} />;
  return <>{children(query.data as T)}</>;
}

/* ------------------------------------------------------------------ controls ----------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  loading?: boolean;
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  children,
  disabled,
  type = 'button',
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="spinner spinner-sm" aria-hidden="true" />}
      {children}
    </button>
  );
}

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (props: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }) => ReactNode;
}

function FieldShell({ label, hint, error, required, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field ${error ? 'field-error' : ''}`}>
      <label htmlFor={id}>
        {label}
        {required && (
          <span className="required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && (
        <small id={hintId} className="muted">
          {hint}
        </small>
      )}
      {error && (
        <small id={errorId} className="error-text">
          {error}
        </small>
      )}
    </div>
  );
}

type Common = { label: string; hint?: string; error?: string };

export function TextField({
  label,
  hint,
  error,
  required,
  ...rest
}: Common & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required}>
      {(a11y) => <input {...a11y} required={required} {...rest} />}
    </FieldShell>
  );
}

export function SelectField({
  label,
  hint,
  error,
  required,
  options,
  placeholder,
  ...rest
}: Common &
  SelectHTMLAttributes<HTMLSelectElement> & {
    options: { value: string; label: string }[];
    placeholder?: string;
  }) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required}>
      {(a11y) => (
        <select {...a11y} required={required} {...rest}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  required,
  ...rest
}: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required}>
      {(a11y) => <textarea rows={4} {...a11y} required={required} {...rest} />}
    </FieldShell>
  );
}

/** Builds select options from an enum list, humanizing labels. */
export const enumOptions = (values: readonly string[]) =>
  values.map((v) => ({ value: v, label: humanize(v) }));

/** Reads a form's fields into a plain object of trimmed strings. */
export function formValues(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  new FormData(form).forEach((v, k) => {
    if (typeof v === 'string') out[k] = v.trim();
  });
  return out;
}

/** Converts empty strings to undefined so optional API fields are omitted. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined && v !== null),
  ) as Partial<T>;
}

/* ------------------------------------------------------------------ overlays ----------------- */

/** Accessible modal built on the native <dialog> element (focus trap and Esc handled natively). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog">
          ×
        </button>
      </div>
      {open && <div className="dialog-body">{children}</div>}
    </dialog>
  );
}

/* ------------------------------------------------------------------ tabs & tables ------------ */

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: { id: T; label: string; count?: number }[];
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={active === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={active === t.id ? 0 : -1}
          className={`tab ${active === t.id ? 'tab-active' : ''}`}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const i = tabs.findIndex((x) => x.id === active);
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              const next =
                tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
              onChange(next.id);
              document.getElementById(`tab-${next.id}`)?.focus();
            }
          }}
        >
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0}>
      {children}
    </div>
  );
}

export function Table({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label="Pagination">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        ← Previous
      </Button>
      <span className="muted">
        Page {page} of {totalPages}
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        Next →
      </Button>
    </nav>
  );
}

export function DefinitionList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="dl">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
