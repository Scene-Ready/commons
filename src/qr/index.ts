/**
 * Scene Ready QR codes: a link encoded as a QR code with the Scene Ready
 * mark in the middle. Framework-neutral; the React component is in
 * `@scene-ready/commons/qr/react`.
 */
export {
  brandedQr,
  brandedQrSvg,
  DEFAULT_LOGO_SCALE,
  DEFAULT_QUIET_ZONE,
  MAX_LOGO_SCALE,
  qrPathData,
} from './brandedQr';
export { SCENE_READY_MARK } from './sceneReadyMark';
export type {
  BrandedQr,
  BrandedQrOptions,
  BrandedQrSvgOptions,
  QrErrorCorrection,
  QrLogo,
  QrLogoPath,
  QrLogoPlate,
} from './types';
