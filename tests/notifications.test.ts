import { describe, expect, it } from 'vitest';
import { validateEmailInput, type EmailInput } from '../src/notifications';

const message: EmailInput = {
  to: 'chief@boonefire.org',
  subject: 'Verify your email',
  layout: 'message',
  content: {
    headline: 'Verify your email',
    body: ['Confirm this address to finish signing up.'],
    cta: { label: 'Verify', url: 'https://auth.sceneready.app/verify?t=abc' },
  },
};

const alert: EmailInput = {
  to: 'chief@boonefire.org',
  subject: 'Severe thunderstorm warning',
  layout: 'alert',
  content: {
    severity: 'warning',
    badgeLabel: 'Weather',
    headline: 'Severe thunderstorm warning',
    summary: 'Until 7:45 PM for Boone County.',
    facts: [{ label: 'Wind', value: '60 mph' }],
  },
};

function errorsFor(input: unknown): string[] {
  const result = validateEmailInput(input);
  return result.ok ? [] : result.errors;
}

describe('validateEmailInput', () => {
  it('accepts a message and an alert', () => {
    expect(validateEmailInput(message)).toEqual({ ok: true, input: message });
    expect(validateEmailInput(alert)).toEqual({ ok: true, input: alert });
  });

  it('drops fields the contract does not define, so they never reach the wrapper', () => {
    const result = validateEmailInput({
      ...message,
      content: { ...message.content, logoUrl: 'https://evil.example/logo.png' },
    });
    expect(result).toEqual({ ok: true, input: message });
  });

  it('rejects a missing or malformed to', () => {
    expect(errorsFor({ ...message, to: undefined })).toEqual(['to must be a non-empty string']);
    expect(errorsFor({ ...message, to: 'chief at boonefire.org' })).toEqual([
      'to must be an email address',
    ]);
  });

  it('rejects an unknown layout', () => {
    expect(errorsFor({ ...message, layout: 'digest' })).toEqual([
      'layout must be "message" or "alert"',
    ]);
  });

  it('rejects a button that is not http or https', () => {
    const cta = { label: 'Write us', url: 'mailto:help@sceneready.app' };
    expect(errorsFor({ ...message, content: { ...message.content, cta } })).toEqual([
      'content.cta.url must be an http or https URL',
    ]);
  });

  it('rejects an empty body', () => {
    for (const body of ['', []]) {
      expect(errorsFor({ ...message, content: { ...message.content, body } })).toEqual([
        'content.body must be a non-empty string or a non-empty array of them',
      ]);
    }
  });
});
