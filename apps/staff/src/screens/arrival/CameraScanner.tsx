/**
 * Camera scanning at the desk (SPK-ENTRY-002: a pass carries an opaque reference; the scan opens the
 * selection flow and records nothing). Uses the browser's own BarcodeDetector API and the device
 * camera when both exist; no library is added. Where the browser has neither, nothing is offered
 * and the desk keeps the connected reader or the typed reference. Which scanning hardware the desk
 * uses and the pass code format are pending (DEC-023): this reads whatever QR code the pass shows
 * and hands its text to the same scan command as the reader.
 *
 * The camera stream is stopped as soon as a code is read, when the desk closes the camera, and when
 * the screen goes away. Nothing from the camera is stored or sent except the decoded reference.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

/** The browser's BarcodeDetector, when it has one (not in every browser yet). */
function detectorConstructor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

export function cameraScanningSupported(): boolean {
  return (
    detectorConstructor() !== null &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

const SCAN_INTERVAL_MS = 300;

export function CameraScanner({
  disabled,
  onDetected,
}: {
  disabled?: boolean;
  /** The decoded pass reference; the caller opens the selection with it. */
  onDetected: (reference: string) => void;
}) {
  const [supported] = useState(cameraScanningSupported);
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const detected = useRef(onDetected);
  useEffect(() => {
    detected.current = onDetected;
  });

  useEffect(() => {
    if (!open) return;
    const Ctor = detectorConstructor();
    if (!Ctor) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (timer) clearInterval(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
    const detector = new Ctor({ formats: ['qr_code'] });
    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((media) => {
        stream = media;
        if (stopped) {
          stop();
          return;
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = media;
          void video.play?.()?.catch?.(() => undefined);
        }
        timer = setInterval(() => {
          const source = videoRef.current;
          if (!source || stopped) return;
          void detector
            .detect(source)
            .then((codes) => {
              const value = codes.find((c) => c.rawValue.trim().length > 0)?.rawValue.trim();
              if (!value || stopped) return;
              stop();
              setOpen(false);
              detected.current(value);
            })
            .catch(() => undefined);
        }, SCAN_INTERVAL_MS);
      })
      .catch(() => {
        setProblem(
          'The camera could not be opened. Allow camera access, or use the reader or type the reference.',
        );
        setOpen(false);
      });
    return stop;
  }, [open]);

  if (!supported) {
    return (
      <p className="caption" data-testid="camera-unsupported">
        Camera scanning is not available in this browser; use the reader or type the reference.
      </p>
    );
  }
  return (
    <div className="camera-scanner">
      {open ? (
        <>
          <video
            ref={videoRef}
            className="camera-video"
            muted
            playsInline
            aria-label="Camera view: hold the pass code inside the frame"
          />
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close camera
          </Button>
        </>
      ) : (
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => {
            setProblem(null);
            setOpen(true);
          }}
        >
          <Icon name="photo_camera" size={18} /> Scan with camera
        </Button>
      )}
      {problem ? (
        <p className="caption" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
