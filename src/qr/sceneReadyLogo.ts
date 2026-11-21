import type { QrLogo } from './types';

/**
 * The default logo: the Scene Ready icon mark, the navy and red chevron pair of
 * `public/scene-ready-icon.svg`, in its 100-unit square. The chevrons span
 * x 12–88 and y 12–84, so `box` is the 76-unit square centred on them.
 */
export const SCENE_READY_LOGO: QrLogo = {
  box: { x: 12, y: 10, size: 76 },
  paths: [
    { d: 'M 50 12 L 88 44 L 88 58 L 50 28 L 12 58 L 12 44 Z', fill: '#1B2A4A' },
    { d: 'M 50 38 L 88 70 L 88 84 L 50 54 L 12 84 L 12 70 Z', fill: '#C8102E' },
  ],
};
