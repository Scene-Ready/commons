/**
 * The notifications contract as an App sees it over its `NOTIFY` service
 * binding. So far that is transactional email, `sendEmail()`. Apps send
 * content, never HTML; the notifications Worker renders it with the
 * design-system email wrappers, so the brand stays in one place.
 */

/** A link button: `url` must be http or https. */
export interface EmailLink {
  label: string;
  url: string;
}

/** The content of a `message` email, rendered with design-system's `wrapSimpleMessage`. */
export interface MessageContent {
  headline: string;
  /** One paragraph, or several. */
  body: string | string[];
  cta: EmailLink;
  /** Adds a greeting line when set. */
  recipientName?: string;
  footnote?: string;
}

/** design-system's `SEVERITIES`, copied: design-system ships no TypeScript types. */
export const EMAIL_SEVERITIES = ['info', 'success', 'warning', 'danger', 'neutral'] as const;
export type EmailSeverity = (typeof EMAIL_SEVERITIES)[number];

/** The content of an `alert` email, rendered with design-system's `wrapIncidentAlert`. */
export interface AlertContent {
  severity: EmailSeverity;
  badgeLabel: string;
  headline: string;
  summary: string;
  facts?: { label: string; value: string }[];
  cta?: EmailLink;
  secondaryCta?: EmailLink;
}

/** One transactional email. The calling App is never a field: notifications takes it from the binding. */
export type EmailInput = {
  to: string;
  subject: string;
} & ({ layout: 'message'; content: MessageContent } | { layout: 'alert'; content: AlertContent });

export type SendResult =
  { ok: true; id: string } | { ok: false; reason: 'suppressed' | 'invalid' | 'send_failed' };

/** The notifications Worker as an App sees it over its `NOTIFY` service binding. */
export interface Notify {
  /** Transactional email: verification, reset, invitations. No Preference stops it; Suppression does. */
  sendEmail(input: EmailInput): Promise<SendResult>;
}

export type EmailValidation = { ok: true; input: EmailInput } | { ok: false; errors: string[] };

/** One `@`, a non-empty local part, a dotted domain, no whitespace. Not RFC 5322. */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collects errors while reading fields, and keeps only the fields it read. */
class Reader {
  readonly errors: string[] = [];

  string(fields: Fields, name: string, path: string, optional = false): string | undefined {
    const value = fields[name];
    if (value === undefined && optional) return undefined;
    if (typeof value !== 'string' || value.trim() === '') {
      this.errors.push(`${path} must be a non-empty string`);
      return undefined;
    }
    return value;
  }

  link(fields: Fields, name: string, path: string, optional = false): EmailLink | undefined {
    const value = fields[name];
    if (value === undefined && optional) return undefined;
    if (!isObject(value)) {
      this.errors.push(`${path} must be { label, url }`);
      return undefined;
    }
    const label = this.string(value, 'label', `${path}.label`);
    const url = this.string(value, 'url', `${path}.url`);
    if (url !== undefined && !isHttpUrl(url)) {
      this.errors.push(`${path}.url must be an http or https URL`);
    }
    return { label: label!, url: url! };
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function readMessage(r: Reader, c: Fields): MessageContent {
  const content: MessageContent = {
    headline: r.string(c, 'headline', 'content.headline')!,
    body: '',
    cta: r.link(c, 'cta', 'content.cta')!,
  };
  const { body } = c;
  if (typeof body === 'string' && body.trim() !== '') {
    content.body = body;
  } else if (
    Array.isArray(body) &&
    body.length > 0 &&
    body.every((p) => typeof p === 'string' && p.trim() !== '')
  ) {
    content.body = [...(body as string[])];
  } else {
    r.errors.push('content.body must be a non-empty string or a non-empty array of them');
  }
  const recipientName = r.string(c, 'recipientName', 'content.recipientName', true);
  if (recipientName !== undefined) content.recipientName = recipientName;
  const footnote = r.string(c, 'footnote', 'content.footnote', true);
  if (footnote !== undefined) content.footnote = footnote;
  return content;
}

function readAlert(r: Reader, c: Fields): AlertContent {
  if (!EMAIL_SEVERITIES.includes(c.severity as EmailSeverity)) {
    r.errors.push(`content.severity must be one of ${EMAIL_SEVERITIES.join(', ')}`);
  }
  const content: AlertContent = {
    severity: c.severity as EmailSeverity,
    badgeLabel: r.string(c, 'badgeLabel', 'content.badgeLabel')!,
    headline: r.string(c, 'headline', 'content.headline')!,
    summary: r.string(c, 'summary', 'content.summary')!,
  };
  if (c.facts !== undefined) {
    if (Array.isArray(c.facts)) {
      content.facts = c.facts.map((fact: unknown, i) => {
        const f = isObject(fact) ? fact : {};
        return {
          label: r.string(f, 'label', `content.facts[${i}].label`)!,
          value: r.string(f, 'value', `content.facts[${i}].value`)!,
        };
      });
    } else {
      r.errors.push('content.facts must be an array of { label, value }');
    }
  }
  const cta = r.link(c, 'cta', 'content.cta', true);
  if (cta !== undefined) content.cta = cta;
  const secondaryCta = r.link(c, 'secondaryCta', 'content.secondaryCta', true);
  if (secondaryCta !== undefined) content.secondaryCta = secondaryCta;
  return content;
}

/**
 * Checks an email before it is sent. The caller checks it before calling
 * `sendEmail`, and notifications checks it on receipt, so the two can't
 * diverge. It rejects anything the design-system wrappers would throw on, and
 * returns every problem found. The returned `input` holds only the fields this
 * contract defines, so nothing else, such as a logo option, reaches the wrapper.
 */
export function validateEmailInput(input: unknown): EmailValidation {
  if (!isObject(input)) return { ok: false, errors: ['email must be an object'] };
  const r = new Reader();

  const to = r.string(input, 'to', 'to');
  if (to !== undefined && !ADDRESS.test(to)) r.errors.push('to must be an email address');
  const subject = r.string(input, 'subject', 'subject');
  if (subject !== undefined && /[\r\n]/.test(subject)) {
    r.errors.push('subject must be one line');
  }

  const { layout, content } = input;
  if (layout !== 'message' && layout !== 'alert') {
    r.errors.push('layout must be "message" or "alert"');
    return { ok: false, errors: r.errors };
  }
  if (!isObject(content)) {
    r.errors.push('content must be an object');
    return { ok: false, errors: r.errors };
  }

  const email: EmailInput =
    layout === 'message'
      ? { to: to!, subject: subject!, layout: 'message', content: readMessage(r, content) }
      : { to: to!, subject: subject!, layout: 'alert', content: readAlert(r, content) };
  return r.errors.length > 0 ? { ok: false, errors: r.errors } : { ok: true, input: email };
}
