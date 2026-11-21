/**
 * Cross-app references: a pointer to a record another Scene Ready app owns,
 * written `sr:<app>:<type>:<id>`, for example `sr:platform:location:loc_123`.
 *
 * A reference is stored, never the record it points at. The owning app
 * documents how to resolve each type it exposes. See
 * docs/contracts/api-standard.md.
 */

import { APP_KEY, RECORD_TYPE } from './grammar';

/** A parsed cross-app reference. */
export interface Ref {
  /** The owning app's key, such as `platform` or `rig-prep`. */
  app: string;
  /** The record type, in the owner's vocabulary, such as `location`. */
  type: string;
  /** The owner's id for the record. */
  id: string;
}

const PREFIX = 'sr';
/** URL-safe characters, no colon, at most 128 long. */
const ID = /^[A-Za-z0-9._~-]{1,128}$/;

/** Parses `sr:<app>:<type>:<id>`; returns null for anything else. */
export function parseRef(value: string): Ref | null {
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, app, type, id] = parts as [string, string, string, string];
  if (!APP_KEY.test(app) || !RECORD_TYPE.test(type) || !ID.test(id)) return null;
  return { app, type, id };
}

/** Writes a reference; throws if a part could not be parsed back. */
export function formatRef(ref: Ref): string {
  const value = `${PREFIX}:${ref.app}:${ref.type}:${ref.id}`;
  if (parseRef(value) === null) {
    throw new TypeError(`Not a valid reference: ${value}`);
  }
  return value;
}

/** True when `value` is a well-formed reference. */
export function isRef(value: unknown): value is string {
  return typeof value === 'string' && parseRef(value) !== null;
}
