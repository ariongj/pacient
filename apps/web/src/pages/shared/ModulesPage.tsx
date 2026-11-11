import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icon } from '../../components/icons';
import { useNavigation } from '../../components/SideNav';
import { EmptyState, PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/**
 * Every main module of the signed-in user with its pages – the same registry as the sidebar, as a
 * launcher that is easier to scan (and to use on a phone).
 */
export function ModulesPage() {
  const nav = useNavigation();
  const { hash } = useLocation();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  }, [hash]);

  const q = query.trim().toLocaleLowerCase();
  const modules = nav.modules
    .map((m) => ({
      ...m,
      items: q
        ? m.items.filter(
            (i) =>
              t(i.label).toLocaleLowerCase().includes(q) ||
              t(m.title).toLocaleLowerCase().includes(q),
          )
        : m.items,
    }))
    .filter((m) => m.items.length);

  return (
    <>
      <PageHeader
        title={t('All modules')}
        subtitle={t('Everything you can open, grouped by area of work.')}
      />
      <div className="field module-search">
        <label htmlFor="module-search">{t('Find a page')}</label>
        <input
          id="module-search"
          type="search"
          value={query}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {modules.length === 0 ? (
        <EmptyState title={t('No page matches “{query}”', { query: query.trim() })} />
      ) : (
        <div className="module-grid">
          {modules.map((m) => (
            <section key={m.id} id={m.id} className="card module-card" tabIndex={-1}>
              <h2 className="module-card-title">
                <span className="module-card-icon" aria-hidden="true">
                  <Icon name={m.icon} size={20} />
                </span>
                {t(m.title)}
              </h2>
              <p className="muted">{t(m.summary)}</p>
              <ul>
                {m.items.map((item) => (
                  <li key={item.to}>
                    <Link to={item.to}>
                      <Icon name={item.icon} size={16} />
                      <span>{t(item.label)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
