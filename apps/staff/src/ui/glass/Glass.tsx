/**
 * Glass: one liquid glass body of the dashboard chrome (sidebar, header groups, the quick
 * navigation dialog, the phone tab bar). Four layers: the optics (the bend filter and the fill),
 * a glow, the specular rim, and the content. Content is never inside the filter: labels and
 * controls stay flat, sharp and at full contrast (SPK-UX-010 readability; SPK-UX-009), and a
 * glass body never holds another glass body.
 *
 * Where the bend cannot render (every engine but Chromium, jsdom, or no canvas) the stylesheet's
 * frost fallback applies by itself; `prefers-reduced-transparency` replaces the optics with a
 * solid fill and `prefers-reduced-motion` removes the press transition (`glass.css`).
 */
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  glassFilterSvg,
  squircleCorners,
  supportsSvgBackdrop,
  type GlassProfile,
} from './liquidGlass';
import './glass.css';

export type GlassMaterial = 'lens' | 'regular' | 'frost';

export interface GlassProps {
  /** Corner radius in px; a capsule passes half its height or more. */
  radius: number;
  /** Width of the band along the edge that bends the backdrop; defaults to the radius. */
  bezel?: number;
  /** Largest shift in px; defaults to 0.4 x bezel (bevel) or 0.5 x bezel (convex). */
  displacement?: number;
  /** Blur of what shows through, in px (lens 0.5-1, regular 2-6, frost 10-20). */
  blur?: number;
  profile?: GlassProfile;
  material?: GlassMaterial;
  /** Continuous corners for panels where the browser draws them; capsules leave it off. */
  squircle?: boolean;
  className?: string;
  contentClassName?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

const DEFAULT_BLUR: Record<GlassMaterial, number> = { lens: 0.8, regular: 4, frost: 14 };

export function Glass({
  radius,
  bezel = radius,
  displacement,
  blur,
  profile = 'bevel',
  material = 'regular',
  squircle = false,
  className,
  contentClassName,
  style,
  children,
}: GlassProps) {
  const corner = squircle && squircleCorners ? 'squircle' : 'round';
  const ref = useRef<HTMLDivElement>(null);
  const id = `lg${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const bends = useMemo(() => supportsSvgBackdrop(), []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!bends || !el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      // Layout size, unaffected by transforms; integer px, as the filter region needs.
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bends]);

  const svg = useMemo(() => {
    if (!bends || !size || size.w <= 0 || size.h <= 0) return null;
    const band = Math.min(bezel, size.w / 2, size.h / 2);
    return glassFilterSvg(id, {
      w: size.w,
      h: size.h,
      radius,
      bezel: band,
      profile,
      displacement: displacement ?? band * (profile === 'convex' ? 0.5 : 0.4),
      blur: blur ?? DEFAULT_BLUR[material],
      corner,
    });
  }, [bends, size, id, radius, bezel, profile, displacement, blur, material, corner]);

  const classes = [
    'glass',
    material === 'regular' ? null : `glass--${material}`,
    corner === 'squircle' ? 'glass--squircle' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={ref} className={classes} style={{ ...style, ['--radius' as string]: `${radius}px` }}>
      {svg ? (
        <svg
          className="glass__defs"
          width="0"
          height="0"
          aria-hidden="true"
          focusable="false"
          dangerouslySetInnerHTML={{ __html: `<defs>${svg}</defs>` }}
        />
      ) : null}
      <span
        className="glass__optic"
        style={svg ? ({ ['--glass-filter' as string]: `url(#${id})` } as CSSProperties) : undefined}
      />
      <span className="glass__glow" />
      <span className="glass__rim" />
      <div className={['glass__content', contentClassName].filter(Boolean).join(' ')}>
        {children}
      </div>
    </div>
  );
}
