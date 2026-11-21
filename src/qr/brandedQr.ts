import { encode } from 'uqr';
import { SCENE_READY_MARK } from './sceneReadyMark';
import type { BrandedQr, BrandedQrOptions, BrandedQrSvgOptions, QrLogoPlate } from './types';

/** The plate's default side, as a share of the symbol's side. */
export const DEFAULT_LOGO_SCALE = 0.25;
/**
 * The largest plate allowed: 30% of the side hides 9% of the modules, which
 * `H` error correction still covers with room for a smudge.
 */
export const MAX_LOGO_SCALE = 0.3;
/** The standard's quiet zone, in modules. */
export const DEFAULT_QUIET_ZONE = 4;
/** The plate's corner radius, as a share of its side. */
const PLATE_RADIUS = 0.12;
/**
 * The light margin between the plate's edge and the logo, in modules. A
 * whole number, so the logo's box lands on module edges, as the modules do.
 */
const LOGO_MARGIN = 1;
/** Plates smaller than this many modules keep half a module of margin. */
const MIN_PLATE_FOR_MARGIN = 5;

/**
 * Encodes `text` as a QR code with a logo plate in the middle: the modules
 * under the plate are cleared, and the error correction recovers them.
 */
export function brandedQr(text: string, options: BrandedQrOptions = {}): BrandedQr {
  const {
    logo = SCENE_READY_MARK,
    logoScale = DEFAULT_LOGO_SCALE,
    ecc = 'H',
    quietZone = DEFAULT_QUIET_ZONE,
  } = options;
  if (text.length === 0) throw new RangeError('Nothing to encode.');
  if (!(logoScale > 0 && logoScale <= MAX_LOGO_SCALE)) {
    throw new RangeError(`The logo scale must be above 0 and at most ${MAX_LOGO_SCALE}.`);
  }
  const qr = encode(text, { ecc, border: quietZone });
  const modules = qr.data.map((row) => [...row]);
  let plate: QrLogoPlate | null = null;
  if (logo) {
    const symbol = qr.size - 2 * quietZone;
    // An odd side, like the symbol's, so the plate sits exactly in the middle.
    const side = Math.max(1, 2 * Math.round((symbol * logoScale - 1) / 2) + 1);
    const start = (qr.size - side) / 2;
    for (let y = start; y < start + side; y++) {
      for (let x = start; x < start + side; x++) modules[y][x] = false;
    }
    plate = { x: start, y: start, size: side, mark: logo };
  }
  return {
    size: qr.size,
    quietZone,
    version: qr.version,
    modules,
    logo: plate,
  };
}

/**
 * SVG path data for the dark modules, one unit per module: each run of dark
 * modules in a row is one rectangle, so a code is a few hundred commands.
 */
export function qrPathData(modules: readonly (readonly boolean[])[]): string {
  let d = '';
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const from = x;
      while (x < row.length && row[x]) x++;
      const run = x - from;
      d += `M${from} ${y}h${run}v1h-${run}z`;
    }
  });
  return d;
}

/** The plate's corner radius, in modules. */
export function plateRadius(plate: QrLogoPlate): number {
  return round(plate.size * PLATE_RADIUS);
}

/**
 * The transform that draws the plate's logo, from its own units into the
 * grid's modules: its box fills the plate but for a one-module margin, so it
 * is as large as the plate allows and its edges sit on the module grid.
 */
export function logoTransform(plate: QrLogoPlate): string {
  const { box } = plate.mark;
  const inset = plate.size >= MIN_PLATE_FOR_MARGIN ? LOGO_MARGIN : 0.5;
  const scale = (plate.size - 2 * inset) / box.size;
  const x = plate.x + inset - box.x * scale;
  const y = plate.y + inset - box.y * scale;
  return `translate(${round(x)} ${round(y)}) scale(${round(scale)})`;
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * The code as a standalone SVG document, one unit per module, for any page,
 * email or file; it has no width or height, so it fills its box.
 */
export function brandedQrSvg(text: string, options: BrandedQrSvgOptions = {}): string {
  const { title, dark = '#000000', light = '#FFFFFF' } = options;
  const qr = brandedQr(text, options);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${qr.size} ${qr.size}" shape-rendering="crispEdges"${title ? ' role="img"' : ''}>`,
  ];
  if (title) parts.push(`<title>${escapeXml(title)}</title>`);
  parts.push(
    `<rect width="${qr.size}" height="${qr.size}" fill="${light}"/>`,
    `<path d="${qrPathData(qr.modules)}" fill="${dark}"/>`,
  );
  const plate = qr.logo;
  if (plate) {
    parts.push(
      `<rect x="${plate.x}" y="${plate.y}" width="${plate.size}" height="${plate.size}" rx="${plateRadius(plate)}" fill="${light}"/>`,
      `<g transform="${logoTransform(plate)}" shape-rendering="geometricPrecision">`,
      ...plate.mark.paths.map((p) => `<path d="${escapeXml(p.d)}" fill="${escapeXml(p.fill)}"/>`),
      '</g>',
    );
  }
  parts.push('</svg>');
  return parts.join('');
}
