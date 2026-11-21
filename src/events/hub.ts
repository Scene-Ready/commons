import { validateEvent, type EventDraft, type EventEnvelope, type Validation } from './envelope';

/** What the Hub answers a `publish` with. `ok: true` means the event is in its log. */
export type PublishResult =
  | { ok: true; id: string; duplicate: boolean; deliveries: number }
  | { ok: false; errors: string[] };

/** One page of Catch-up. Pass `nextCursor` back until it is null. */
export type CatchUpResult =
  | { ok: true; events: EventEnvelope[]; nextCursor: string | null }
  | { ok: false; error: 'no_subscription' | 'cursor_expired' };

/**
 * The Hub as an App sees it over its `EVENTS_HUB` service binding. The Hub
 * takes the publishing App from the binding's props, never from the event.
 */
export interface EventsHub {
  /** Accepts an event. A repeated id is acknowledged as a duplicate and changes nothing. */
  publish(draft: EventDraft): Promise<PublishResult>;
  /** The events the App's Subscription would have received after `cursor`, oldest first. */
  catchUp(options?: { cursor?: string; limit?: number }): Promise<CatchUpResult>;
}

/**
 * Checks a draft as the Hub will once `app` publishes it: `specversion` and
 * `source` are filled in, and anything the draft says about them is replaced.
 * Publishers call it before committing, and the Hub calls it on receipt, so
 * the two checks can't diverge.
 */
export function validateDraft(draft: unknown, app: string): Validation {
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
    return validateEvent(draft);
  }
  return validateEvent({ ...draft, specversion: '1.0', source: app });
}
