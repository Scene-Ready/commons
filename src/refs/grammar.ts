/**
 * The spelling rules `refs` and `events` share, per ADR-0003. Internal: not
 * an entry point.
 */

/** Pattern source for an app key: lowercase letters, digits and hyphens, starting with a letter. */
export const APP_KEY_PATTERN = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
/** Pattern source for snake_case, starting with a letter: Record types and Event verbs. */
export const SNAKE_CASE_PATTERN = '[a-z][a-z0-9]*(?:_[a-z0-9]+)*';

/** An app key, such as `platform` or `rig-prep`. */
export const APP_KEY = new RegExp(`^${APP_KEY_PATTERN}$`);
/** A Record type, such as `corrective_action`. */
export const RECORD_TYPE = new RegExp(`^${SNAKE_CASE_PATTERN}$`);
