import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, useUser } from '../auth/AuthContext';
import { t } from '../i18n';
import {
  allItems,
  locate,
  NAVIGATION,
  type NavItem,
  type NavModule,
  type RoleNav,
} from '../modules';
import { Icon } from './icons';

/** Pages an appointments-only guardian may open. */
export const APPOINTMENT_SCOPE_PATHS = [
  '/portal/appointments',
  '/portal/account',
  '/notifications',
];

/**
 * The signed-in user's navigation. A guardian whose access covers appointments only gets just
 * those pages, with the appointments page as home.
 */
export function useNavigation(): RoleNav {
  const user = useUser();
  const { acting } = useAuth();
  const appointmentsOnly = acting?.scope === 'APPOINTMENTS';
  return useMemo(() => {
    const nav = NAVIGATION[user.role];
    if (!appointmentsOnly) return nav;
    const allowed = allItems(nav).filter((i) => APPOINTMENT_SCOPE_PATHS.includes(i.to));
    const home = allowed.find((i) => i.to === '/portal/appointments') ?? nav.home;
    return {
      home: { ...home, end: true },
      modules: nav.modules
        .map((m) => ({
          ...m,
          items: m.items.filter((i) => APPOINTMENT_SCOPE_PATHS.includes(i.to) && i.to !== home.to),
        }))
        .filter((m) => m.items.length),
    };
  }, [user.role, appointmentsOnly]);
}

const storageKey = (role: string) => `pacient.nav.${role}`;

function readOpen(role: string): string[] | null {
  try {
    const raw = localStorage.getItem(storageKey(role));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

function PageLink({ item, sub = false }: { item: NavItem; sub?: boolean }) {
  return (
    <NavLink to={item.to} end={item.end} className={sub ? 'nav-sub' : undefined}>
      <Icon name={item.icon} />
      <span>{t(item.label)}</span>
    </NavLink>
  );
}

/**
 * Sidebar: the home page, then each main module as a group that opens to show its pages. The
 * module of the current page is always open; the others stay as the user left them. The finder
 * searches every page by name.
 */
export function SideNav({
  id,
  open,
  children,
}: {
  id: string;
  open: boolean;
  children?: React.ReactNode;
}) {
  const user = useUser();
  const nav = useNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const activeModule = locate(nav, location.pathname)?.module?.id ?? null;
  // Modules the user chose to keep open (remembered). The module of the current page is open by
  // itself and closes again when the user moves elsewhere, so the menu never grows on its own.
  const [pinned, setPinned] = useState<string[]>(() => readOpen(user.role) ?? []);
  const [activeClosed, setActiveClosed] = useState(false);
  useEffect(() => setActiveClosed(false), [activeModule]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(user.role), JSON.stringify(pinned));
    } catch {
      /* storage unavailable: the menu still works */
    }
  }, [pinned, user.role]);

  const isOpenModule = (m: NavModule) =>
    m.id === activeModule ? !activeClosed : pinned.includes(m.id);
  const toggle = (m: NavModule) => {
    if (m.id === activeModule) setActiveClosed((c) => !c);
    else setPinned((o) => (o.includes(m.id) ? o.filter((x) => x !== m.id) : [...o, m.id]));
  };

  const q = query.trim().toLocaleLowerCase();
  const matches = q
    ? [
        ...(t(nav.home.label).toLocaleLowerCase().includes(q)
          ? [{ item: nav.home, module: null as NavModule | null }]
          : []),
        ...nav.modules.flatMap((m) =>
          m.items
            .filter(
              (i) =>
                t(i.label).toLocaleLowerCase().includes(q) ||
                t(m.title).toLocaleLowerCase().includes(q),
            )
            .map((item) => ({ item, module: m as NavModule | null })),
        ),
      ]
    : [];

  return (
    <nav id={id} className={`sidenav ${open ? 'open' : ''}`} aria-label={t('Main')}>
      {children}
      <form
        className="nav-find"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const first = matches[0];
          if (first) {
            setQuery('');
            navigate(first.item.to);
          }
        }}
      >
        <label htmlFor="nav-find" className="sr-only">
          {t('Find a page')}
        </label>
        <Icon name="search" size={16} />
        <input
          id="nav-find"
          type="search"
          value={query}
          placeholder={t('Find a page…')}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>

      {q ? (
        <div className="nav-section" aria-live="polite">
          {matches.length === 0 ? (
            <p className="nav-empty">{t('No page matches “{query}”', { query: query.trim() })}</p>
          ) : (
            <ul>
              {matches.map(({ item, module }) => (
                <li key={`${module?.id ?? 'home'}:${item.to}`}>
                  <NavLink to={item.to} end={item.end} onClick={() => setQuery('')}>
                    <Icon name={item.icon} />
                    <span>
                      {t(item.label)}
                      {module && module.items.length > 1 && (
                        <span className="nav-where">{t(module.title)}</span>
                      )}
                    </span>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <ul className="nav-home">
            <li>
              <PageLink item={nav.home} />
            </li>
          </ul>
          {nav.modules.map((m) => {
            // A module with a single page is shown as that page.
            if (m.items.length === 1) {
              return (
                <ul key={m.id} className="nav-single">
                  <li>
                    <PageLink item={m.items[0]!} />
                  </li>
                </ul>
              );
            }
            const isOpen = isOpenModule(m);
            const listId = `${id}-${m.id}`;
            return (
              <div key={m.id} className={`nav-module ${m.id === activeModule ? 'current' : ''}`}>
                <button
                  type="button"
                  className="nav-module-toggle"
                  aria-expanded={isOpen}
                  aria-controls={listId}
                  onClick={() => toggle(m)}
                >
                  <Icon name={m.icon} />
                  <span className="nav-module-title">{t(m.title)}</span>
                  <span className="nav-count" aria-hidden="true">
                    {m.items.length}
                  </span>
                  <span className={`nav-chevron ${isOpen ? 'open' : ''}`} aria-hidden="true">
                    <Icon name="chevron" size={14} />
                  </span>
                </button>
                {isOpen && (
                  <ul id={listId}>
                    {m.items.map((item) => (
                      <li key={item.to}>
                        <PageLink item={item} sub />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          {nav.modules.length > 1 && (
            <ul className="nav-all">
              <li>
                <NavLink to="/modules">
                  <Icon name="grid" />
                  <span>{t('All modules')}</span>
                </NavLink>
              </li>
            </ul>
          )}
        </>
      )}
    </nav>
  );
}

/** "Module › Page" above the page, so it is clear where a page belongs (not shown on home). */
export function Breadcrumb() {
  const nav = useNavigation();
  const { pathname } = useLocation();
  const here = locate(nav, pathname);
  if (!here?.module || here.module.items.length === 1) return null;
  return (
    <nav className="crumbs" aria-label={t('You are here')}>
      <ol>
        <li>
          <NavLink to={`/modules#${here.module.id}`}>{t(here.module.title)}</NavLink>
        </li>
        <li aria-current={pathname === here.item.to ? 'page' : undefined}>
          {pathname === here.item.to ? (
            t(here.item.label)
          ) : (
            <NavLink to={here.item.to}>{t(here.item.label)}</NavLink>
          )}
        </li>
      </ol>
    </nav>
  );
}
