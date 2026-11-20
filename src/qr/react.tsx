import { useMemo, type CSSProperties } from 'react';
import { brandedQr, markTransform, plateRadius, qrPathData } from './brandedQr';
import type { BrandedQrOptions } from './types';

export interface QrCodeProps extends BrandedQrOptions {
  /** The text to encode, usually a link. */
  value: string;
  /** The code's accessible name, such as what scanning it opens. */
  title: string;
  /** Dark modules; black by default. */
  dark?: string;
  /** The background, quiet zone and logo plate; white by default. */
  light?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * A QR code with the Scene Ready mark in the middle, as inline SVG. It has
 * no size of its own: size it with `className` or `style`, square.
 */
export function QrCode({
  value,
  title,
  dark = '#000000',
  light = '#FFFFFF',
  className,
  style,
  logo,
  logoScale,
  ecc,
  quietZone,
}: QrCodeProps) {
  const qr = useMemo(
    () => brandedQr(value, { logo, logoScale, ecc, quietZone }),
    [value, logo, logoScale, ecc, quietZone],
  );
  const d = useMemo(() => qrPathData(qr.modules), [qr]);
  const plate = qr.logo;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={title}
      data-qr-version={qr.version}
      className={className}
      style={style}
    >
      <title>{title}</title>
      <rect width={qr.size} height={qr.size} fill={light} />
      <path d={d} fill={dark} />
      {plate && (
        <>
          <rect
            x={plate.x}
            y={plate.y}
            width={plate.size}
            height={plate.size}
            rx={plateRadius(plate)}
            fill={light}
          />
          <g transform={markTransform(plate)} shapeRendering="geometricPrecision">
            {plate.mark.paths.map((p, i) => (
              <path key={i} d={p.d} fill={p.fill} />
            ))}
          </g>
        </>
      )}
    </svg>
  );
}
