/** One filled path of a logo, in the logo's own units. */
export interface QrLogoPath {
  d: string;
  fill: string;
}

/**
 * A logo drawn in the middle of a code: filled paths, and the square of
 * their units, `box`, that is fitted to the plate. Crop `box` to the
 * artwork so the logo fills its plate.
 */
export interface QrLogo {
  box: { x: number; y: number; size: number };
  paths: readonly QrLogoPath[];
}

/** @deprecated Use QrLogo. */
export type QrMark = QrLogo;
/** @deprecated Use QrLogoPath. */
export type QrMarkPath = QrLogoPath;

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface BrandedQrOptions {
  /** The logo in the middle; `null` for a plain code. The Scene Ready mark by default. */
  logo?: QrLogo | null;
  /**
   * The logo plate's side as a share of the symbol's side, at most
   * `MAX_LOGO_SCALE`. 0.25 by default: about 6% of the modules.
   */
  logoScale?: number;
  /** Error correction; `H` (30%) by default, so the code reads past the logo. */
  ecc?: QrErrorCorrection;
  /** Light modules round the symbol; the standard's 4 by default. */
  quietZone?: number;
}

/** The logo plate, in modules from the top-left of the whole grid. */
export interface QrLogoPlate {
  x: number;
  y: number;
  size: number;
  /** The logo drawn on the plate. */
  mark: QrLogo;
}

/** A code laid out on a square grid of modules, quiet zone included. */
export interface BrandedQr {
  /** The grid's side, in modules. */
  size: number;
  quietZone: number;
  version: number;
  /** Row-major; `true` is dark. Modules under the logo plate are light. */
  modules: boolean[][];
  logo: QrLogoPlate | null;
}

export interface BrandedQrSvgOptions extends BrandedQrOptions {
  /** The code's accessible name, as the SVG's `<title>`. */
  title?: string;
  /** Dark modules; black by default. */
  dark?: string;
  /** The background, quiet zone and logo plate; white by default. */
  light?: string;
}
