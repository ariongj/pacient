import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../i18n';
import { Button } from './ui';

/** The parts of the Barcode Detection API we use (not yet in TypeScript's DOM library). */
interface DetectedBarcode {
  rawValue: string;
  format: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

const WANTED_FORMATS = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'data_matrix', 'upc_a'];

function detectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return ctor && typeof navigator.mediaDevices?.getUserMedia === 'function' ? ctor : null;
}

/**
 * Scans a wristband (QR code) or a medicine pack (EAN-13 / Code 128 / GS1 DataMatrix).
 *
 * The text field always works: handheld scanners act as a keyboard ("keyboard wedge") and end
 * with Enter, and staff can type the code when a label cannot be read. When the browser supports
 * the Barcode Detection API, the camera can be used as well.
 */
export function BarcodeScanner({
  label,
  hint,
  onScan,
  autoFocus,
  disabled,
  scanned,
}: {
  label: string;
  hint?: string;
  onScan: (value: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Shown after a successful read (e.g. the patient's name or the medicine). */
  scanned?: string | null;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const statusId = `${id}-status`;
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(false);
  const [status, setStatus] = useState('');
  const ctor = detectorCtor();

  const stopCamera = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    setCamera(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  useEffect(() => {
    if (autoFocus && !disabled) inputRef.current?.focus();
  }, [autoFocus, disabled]);

  const submit = useCallback(
    (raw: string) => {
      const v = raw.trim();
      if (!v) return;
      setValue('');
      setStatus(t('Code read'));
      onScan(v);
    },
    [onScan],
  );

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      // Keep the surrounding form from submitting: Enter ends a scan, it does not save.
      e.preventDefault();
      submit(e.currentTarget.value);
    }
  }

  async function startCamera() {
    if (!ctor) return;
    try {
      const supported = ctor.getSupportedFormats
        ? await ctor.getSupportedFormats()
        : WANTED_FORMATS;
      const formats = WANTED_FORMATS.filter((f) => supported.includes(f));
      const detector = new ctor(formats.length ? { formats } : undefined);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      setCamera(true);
      setStatus(t('Camera on – hold the code in front of the camera'));
      // The video element renders after setCamera; attach on the next frame.
      requestAnimationFrame(async () => {
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        const tick = async () => {
          if (!streamRef.current) return;
          try {
            const found = await detector.detect(video);
            const hit = found.find((b) => b.rawValue);
            if (hit) {
              stopCamera();
              submit(hit.rawValue);
              return;
            }
          } catch {
            /* frame not ready */
          }
          timerRef.current = window.setTimeout(() => void tick(), 250);
        };
        void tick();
      });
    } catch {
      stopCamera();
      setStatus(t('The camera is not available. Use the scanner or type the code.'));
    }
  }

  return (
    <div className="field barcode-scanner">
      <label htmlFor={id}>{label}</label>
      <div className="row">
        <input
          id={id}
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="text"
          aria-describedby={`${hintId} ${statusId}`}
          placeholder={t('Scan or type, then Enter')}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || !value.trim()}
          onClick={() => submit(value)}
        >
          {t('Enter code')}
        </Button>
        {ctor &&
          (camera ? (
            <Button variant="ghost" size="sm" onClick={stopCamera}>
              {t('Stop camera')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => void startCamera()}
            >
              {t('Use camera')}
            </Button>
          ))}
      </div>
      <small id={hintId} className="muted">
        {hint ?? t('Handheld scanners type the code and press Enter for you.')}
      </small>
      {camera && (
        <video
          ref={videoRef}
          className="barcode-video"
          muted
          playsInline
          aria-label={t('Camera preview')}
          style={{ width: '100%', maxWidth: 360, borderRadius: 8, marginTop: 8 }}
        />
      )}
      <div id={statusId} role="status" aria-live="polite" className="muted">
        {scanned ? `✓ ${scanned}` : status}
      </div>
    </div>
  );
}
