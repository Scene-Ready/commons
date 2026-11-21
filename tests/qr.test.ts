import { describe, it, expect, expectTypeOf } from 'vitest';
import jsQR from 'jsqr';
import {
  brandedQr,
  brandedQrSvg,
  qrPathData,
  SCENE_READY_MARK,
  type BrandedQr,
  type BrandedQrOptions,
  type QrLogo,
  type QrLogoPath,
  type QrMark,
  type QrMarkPath,
} from '../src/qr';

/** Pixels per module when a code is drawn for the decoder. */
const PX = 6;

/**
 * Draws the code's modules for the decoder: dark black, light white. The
 * plate's modules are drawn light; the logo on it is left out, since every
 * module under the plate is lost to the decoder whatever is drawn there.
 */
function decode(qr: BrandedQr): string | null {
  const side = qr.size * PX;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      for (let dy = 0; dy < PX; dy++) {
        for (let dx = 0; dx < PX; dx++) {
          const i = ((y * PX + dy) * side + x * PX + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return jsQR(data, side, side)?.data ?? null;
}

const SHARE = `https://rig.sceneready.app/s/${'A'.repeat(43)}`;
const ORG = 'https://rig.sceneready.app/app?doc=01JABCDEFGHJKMNPQRSTVWXYZ01&view=1';

describe('brandedQr', () => {
  it.each([
    ['a short link', 'https://sceneready.app'],
    ['a Share link', SHARE],
    ['an Organization link', ORG],
    ['a long link', `${ORG}&${'x'.repeat(120)}`],
  ])('decodes %s with the logo in the middle', (_name, text) => {
    const qr = brandedQr(text);
    expect(qr.logo).not.toBeNull();
    expect(decode(qr)).toBe(text);
  });

  it('fails to decode when the plate outruns the error correction', () => {
    // The check above is a real one: the same plate on a low-correction code
    // hides more modules than it can recover.
    expect(decode(brandedQr(ORG, { ecc: 'L', logoScale: 0.3 }))).toBeNull();
  });

  it('decodes without a logo', () => {
    const qr = brandedQr(SHARE, { logo: null });
    expect(qr.logo).toBeNull();
    expect(decode(qr)).toBe(SHARE);
  });

  it('types the logo option as QrLogo, keeping QrMark as an alias', () => {
    expectTypeOf(SCENE_READY_MARK).toEqualTypeOf<QrLogo>();
    expectTypeOf<NonNullable<BrandedQrOptions['logo']>>().toEqualTypeOf<QrLogo>();
    expectTypeOf<QrLogo['paths'][number]>().toEqualTypeOf<QrLogoPath>();
    expectTypeOf<QrMark>().toEqualTypeOf<QrLogo>();
    expectTypeOf<QrMarkPath>().toEqualTypeOf<QrLogoPath>();
  });

  it('carries the Scene Ready mark by default', () => {
    expect(brandedQr(SHARE).logo?.logo).toBe(SCENE_READY_MARK);
  });

  it('centres the logo plate and clears every module under it', () => {
    const qr = brandedQr(ORG);
    const logo = qr.logo!;
    expect(logo.x + logo.size / 2).toBeCloseTo(qr.size / 2);
    expect(logo.y + logo.size / 2).toBeCloseTo(qr.size / 2);
    for (let y = logo.y; y < logo.y + logo.size; y++) {
      for (let x = logo.x; x < logo.x + logo.size; x++) {
        expect(qr.modules[y][x]).toBe(false);
      }
    }
  });

  it('keeps the plate small enough for the error correction to cover', () => {
    for (const text of ['https://sceneready.app', SHARE, ORG]) {
      const qr = brandedQr(text);
      const symbol = qr.size - 2 * qr.quietZone;
      expect(qr.logo!.size ** 2 / symbol ** 2).toBeLessThanOrEqual(0.08);
    }
  });

  it('surrounds the symbol with a light quiet zone, 4 modules by default', () => {
    const qr = brandedQr(SHARE);
    expect(qr.quietZone).toBe(4);
    for (let i = 0; i < qr.size; i++) {
      for (let q = 0; q < 4; q++) {
        expect(qr.modules[q][i]).toBe(false);
        expect(qr.modules[i][q]).toBe(false);
        expect(qr.modules[qr.size - 1 - q][i]).toBe(false);
        expect(qr.modules[i][qr.size - 1 - q]).toBe(false);
      }
    }
    expect(brandedQr(SHARE, { quietZone: 2 }).quietZone).toBe(2);
  });

  it('refuses a logo scale that would hide too much of the code', () => {
    expect(() => brandedQr(SHARE, { logoScale: 0.4 })).toThrow(RangeError);
  });

  it('refuses empty text', () => {
    expect(() => brandedQr('')).toThrow(RangeError);
  });
});

describe('qrPathData', () => {
  it('draws each run of dark modules in a row as one rectangle', () => {
    const modules = [
      [true, true, false, true],
      [false, false, false, false],
      [false, true, true, true],
    ];
    expect(qrPathData(modules)).toBe('M0 0h2v1h-2zM3 0h1v1h-1zM1 2h3v1h-3z');
  });

  it('is empty for an all-light grid', () => {
    expect(qrPathData([[false]])).toBe('');
  });
});

describe('brandedQrSvg', () => {
  it('is a standalone SVG of the modules and the mark', () => {
    const qr = brandedQr(SHARE);
    const svg = brandedQrSvg(SHARE, { title: 'Open the live rig' });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain(`viewBox="0 0 ${qr.size} ${qr.size}"`);
    expect(svg).toContain(qrPathData(qr.modules));
    for (const path of SCENE_READY_MARK.paths) expect(svg).toContain(path.d);
    expect(svg).toContain('<title>Open the live rig</title>');
  });

  it('escapes the title', () => {
    expect(brandedQrSvg(SHARE, { title: 'a < b & "c"' })).toContain(
      '<title>a &lt; b &amp; &quot;c&quot;</title>',
    );
  });

  it('takes its colours from the options', () => {
    const svg = brandedQrSvg(SHARE, { dark: '#123456', light: '#fedcba' });
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('fill="#fedcba"');
  });
});
