import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  clearImageCache,
  imageUrl,
  presetLabel,
  useStudyImages,
  type ImageSeries,
  type StudyImages,
  type WindowSetting,
} from '../../api/pacs';
import { modalityLabel, type Modality } from '../../api/imaging';
import { useUser } from '../../auth/AuthContext';
import { Alert, Badge, Button, PageHeader, QueryView, StatusBadge } from '../../components/ui';
import { formatDate, fullName } from '../../format';
import { t } from '../../i18n';
import './viewer.css';

/**
 * Review viewer for radiology images: series strip, stack scrolling (wheel, slider, keys, swipe),
 * zoom and pan, window presets rendered by the server plus brightness / contrast / invert in the
 * browser. Not a diagnostic workstation.
 */
export function ImageViewer() {
  const { orderId = '' } = useParams();
  const q = useStudyImages(orderId);
  useEffect(() => () => clearImageCache(), []);
  return <QueryView query={q}>{(data) => <Viewer orderId={orderId} data={data} />}</QueryView>;
}

function Thumbnail({
  orderId,
  series,
  active,
  onSelect,
}: {
  orderId: string;
  series: ImageSeries;
  active: boolean;
  onSelect: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const middle = series.instances[Math.floor(series.instances.length / 2)];
  useEffect(() => {
    let live = true;
    if (middle) {
      imageUrl(orderId, series.uid, middle.uid)
        .then((u) => live && setSrc(u))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [orderId, series.uid, middle]);
  return (
    <button
      type="button"
      className={`pv-thumb${active ? ' active' : ''}`}
      aria-pressed={active}
      onClick={onSelect}
    >
      {src ? <img src={src} alt="" /> : <span className="pv-thumb-empty" aria-hidden="true" />}
      <span className="pv-thumb-label">
        {series.description || t('Series {number}', { number: series.number })}
        <small>{t('{count} images', { count: series.instances.length })}</small>
      </span>
    </button>
  );
}

function Viewer({ orderId, data }: { orderId: string; data: StudyImages }) {
  const user = useUser();
  const [seriesIndex, setSeriesIndex] = useState(0);
  const [index, setIndex] = useState(0);
  const [preset, setPreset] = useState(data.presets[0]?.key ?? 'default');
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [invert, setInvert] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; acc: number; pointers: number } | null>(null);

  const series = data.series[seriesIndex];
  const count = series?.instances.length ?? 0;
  const instance = series?.instances[Math.min(index, count - 1)];
  const win: WindowSetting | undefined = data.presets.find((p) => p.key === preset)?.window;

  // Load the current image and prefetch its neighbours.
  useEffect(() => {
    if (!series || !instance) return;
    let live = true;
    setError(null);
    imageUrl(orderId, series.uid, instance.uid, win)
      .then((u) => live && setSrc(u))
      .catch((e: unknown) => live && setError(e));
    for (const d of [1, -1, 2, -2]) {
      const n = series.instances[index + d];
      if (n) void imageUrl(orderId, series.uid, n.uid, win).catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [orderId, series, instance, index, win]);

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.max(0, Math.min(count - 1, i + delta))),
    [count],
  );
  const selectSeries = (i: number) => {
    setSeriesIndex(i);
    setIndex(Math.floor((data.series[i]?.instances.length ?? 1) / 2));
  };
  const reset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setBrightness(100);
    setContrast(100);
    setInvert(false);
  };

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    // Wheel scrolls the stack; with Ctrl (or a pinch on trackpads) it zooms.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) setZoom((z) => Math.max(1, Math.min(8, z * (e.deltaY < 0 ? 1.1 : 0.9))));
      else go(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [go]);

  const onKey = (e: React.KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => go(1),
      ArrowUp: () => go(-1),
      PageDown: () => go(10),
      PageUp: () => go(-10),
      Home: () => setIndex(0),
      End: () => setIndex(count - 1),
      ArrowRight: () => selectSeries(Math.min(data.series.length - 1, seriesIndex + 1)),
      ArrowLeft: () => selectSeries(Math.max(0, seriesIndex - 1)),
      '+': () => setZoom((z) => Math.min(8, z * 1.25)),
      '=': () => setZoom((z) => Math.min(8, z * 1.25)),
      '-': () => setZoom((z) => Math.max(1, z / 1.25)),
      i: () => setInvert((v) => !v),
      '0': reset,
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  // Drag: pans when zoomed in, otherwise scrolls the stack (also on touch screens).
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, acc: 0, pointers: 1 };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (zoom > 1) {
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else {
      d.acc += dy;
      while (Math.abs(d.acc) >= 14) {
        go(d.acc > 0 ? 1 : -1);
        d.acc -= Math.sign(d.acc) * 14;
      }
    }
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const fullscreen = () => {
    const el = frame.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const back =
    user.role === 'PATIENT'
      ? '/portal/imaging'
      : `${user.role === 'NURSE' ? '/nurse' : '/doctor'}/patients/${data.order.patientId}?tab=imaging`;
  const name = data.patient ? fullName(data.patient) : '';
  const filter = useMemo(
    () => `brightness(${brightness}%) contrast(${contrast}%)${invert ? ' invert(1)' : ''}`,
    [brightness, contrast, invert],
  );

  return (
    <>
      <PageHeader
        title={t('{modality} · {bodyPart}', {
          modality: modalityLabel(data.order.modality as Modality),
          bodyPart: data.order.bodyPart,
        })}
        subtitle={
          <>
            {name}
            {data.patient && ` · ${formatDate(data.patient.dateOfBirth)}`} ·{' '}
            {t('Accession {number}', { number: data.order.accessionNumber })} ·{' '}
            {t('Examination on {date}', { date: formatDate(data.order.performedAt) })}
          </>
        }
        actions={
          <Link className="btn btn-secondary btn-md" to={back}>
            {user.role === 'PATIENT' ? t('Back to my reports') : t('Back to the record')}
          </Link>
        }
      />
      {data.mode === 'demo' && (
        <Alert tone="info" title={t('Demonstration images')}>
          {t(
            'No image archive is connected. These are synthetic images generated for testing, not images of this patient.',
          )}
        </Alert>
      )}
      <div className="pv-report">
        <StatusBadge value={data.order.status} />
        {data.order.critical && <Badge tone="danger">{t('Critical finding')}</Badge>}
        {data.order.impression ? (
          <span>
            <strong>{t('Conclusion')}:</strong> {data.order.impression}
          </span>
        ) : (
          <span className="muted">{t('The report is not written yet.')}</span>
        )}
      </div>

      {data.series.length === 0 ? (
        <Alert tone="warning" title={t('The archive has no images for this examination yet.')} />
      ) : (
        <div className="pv">
          <nav className="pv-series" aria-label={t('Series')}>
            {data.series.map((s, i) => (
              <Thumbnail
                key={s.uid}
                orderId={orderId}
                series={s}
                active={i === seriesIndex}
                onSelect={() => selectSeries(i)}
              />
            ))}
          </nav>
          <div className="pv-main">
            <div className="pv-toolbar" role="toolbar" aria-label={t('Image tools')}>
              {data.presets.length > 1 && (
                <label className="pv-field">
                  <span>{t('Window')}</span>
                  <select value={preset} onChange={(e) => setPreset(e.target.value)}>
                    {data.presets.map((p) => (
                      <option key={p.key} value={p.key}>
                        {presetLabel(p.key)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="pv-field">
                <span>{t('Brightness')}</span>
                <input
                  type="range"
                  min={30}
                  max={200}
                  value={brightness}
                  onChange={(e) => setBrightness(Number(e.target.value))}
                />
              </label>
              <label className="pv-field">
                <span>{t('Contrast')}</span>
                <input
                  type="range"
                  min={30}
                  max={300}
                  value={contrast}
                  onChange={(e) => setContrast(Number(e.target.value))}
                />
              </label>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setZoom((z) => Math.max(1, z / 1.25))}
                aria-label={t('Zoom out')}
              >
                −
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setZoom((z) => Math.min(8, z * 1.25))}
                aria-label={t('Zoom in')}
              >
                +
              </Button>
              <Button
                size="sm"
                variant={invert ? 'primary' : 'secondary'}
                onClick={() => setInvert((v) => !v)}
                aria-pressed={invert}
              >
                {t('Invert')}
              </Button>
              <Button size="sm" variant="secondary" onClick={reset}>
                {t('Reset')}
              </Button>
              <Button size="sm" variant="secondary" onClick={fullscreen}>
                {t('Full screen')}
              </Button>
            </div>
            <div className="pv-stage">
              <div
                ref={frame}
                className={`pv-frame${zoom > 1 ? ' zoomed' : ''}`}
                tabIndex={0}
                role="img"
                aria-label={t('{series}, image {n} of {total}', {
                  series: series?.description ?? '',
                  n: index + 1,
                  total: count,
                })}
                aria-describedby="pv-help"
                onKeyDown={onKey}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDoubleClick={reset}
              >
                {src && (
                  <img
                    src={src}
                    alt=""
                    draggable={false}
                    style={{
                      filter,
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    }}
                  />
                )}
                <div className="pv-overlay" aria-hidden="true">
                  <span>{series?.description}</span>
                  <span>
                    {t('Image {n} / {total}', { n: index + 1, total: count })}
                    {zoom > 1 && ` · ${Math.round(zoom * 100)}%`}
                  </span>
                </div>
              </div>
              {error !== null && (
                <Alert tone="danger" title={t('The image could not be loaded.')} />
              )}
            </div>
            {count > 1 && (
              <label className="pv-field pv-stack">
                <span>{t('Image {n} / {total}', { n: index + 1, total: count })}</span>
                <input
                  type="range"
                  min={1}
                  max={count}
                  value={index + 1}
                  onChange={(e) => setIndex(Number(e.target.value) - 1)}
                  aria-label={t('Image in series')}
                />
              </label>
            )}
            <p id="pv-help" className="muted pv-help">
              {t(
                'Scroll, drag or use the arrow keys to move through the images; Ctrl + scroll or + / − to zoom; double-click to reset.',
              )}
            </p>
            <p className="muted pv-help">
              {t('For diagnosis use a certified diagnostic workstation.')}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
