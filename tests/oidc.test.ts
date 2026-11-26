import { describe, expect, it } from 'vitest';
import { createOidcClient, type OidcClientConfig, type PendingSignIn } from '../src/oidc';
import { createFakeIssuer, type FakeIssuer } from '../src/oidc/testing';

const ISSUER = 'https://issuer.test';
const REDIRECT_URI = 'https://rig.example/callback';

function setup(overrides: Partial<OidcClientConfig> = {}) {
  const issuer = createFakeIssuer({ issuer: ISSUER });
  const client = createOidcClient({
    issuer: ISSUER,
    clientId: 'rig',
    clientSecret: 's3cret',
    redirectUri: REDIRECT_URI,
    scopes: ['openid', 'profile', 'email'],
    fetch: issuer.fetch,
    ...overrides,
  });
  return { issuer, client };
}

/** Follows an authorize URL as the browser would, and returns the callback URL. */
async function follow(issuer: FakeIssuer, url: string): Promise<string> {
  const res = await issuer.fetch(url, { redirect: 'manual' });
  expect(res.status).toBe(302);
  return res.headers.get('location')!;
}

async function start(client: ReturnType<typeof setup>['client'], silent = false) {
  const started = await client.startSignIn({ returnTo: '/rigs/7?tab=log', silent });
  if (!started.ok) throw new Error(`startSignIn failed: ${started.reason}`);
  return started;
}

describe('createOidcClient sign-in', () => {
  it('signs a user in: authorize, callback, verified tokens and the returnTo', async () => {
    const { issuer, client } = setup();
    issuer.nextToken({ claims: { sub: 'usr_1', email: 'a@example.org', name: 'Ada' } });
    const { url, pending } = await start(client);

    const result = await client.finishSignIn(await follow(issuer, url), pending);

    expect(result).toMatchObject({
      ok: true,
      returnTo: '/rigs/7?tab=log',
      tokens: {
        refreshToken: expect.any(String),
        idToken: expect.any(String),
        claims: { subject: 'usr_1', email: 'a@example.org', name: 'Ada' },
      },
    });
    if (!result.ok) return;
    expect(result.tokens.accessExpiresAt).toBeGreaterThan(Date.now() + 3500_000);
    expect(result.tokens.claimsAt).toBeLessThanOrEqual(Date.now());
  });

  it('signs in silently: the authorize URL sends prompt=none', async () => {
    const { issuer, client } = setup();
    const { url, pending } = await start(client, true);
    expect(new URL(url).searchParams.get('prompt')).toBe('none');
    expect(pending.silent).toBe(true);

    const result = await client.finishSignIn(await follow(issuer, url), pending);
    expect(result).toMatchObject({ ok: true, tokens: { claims: { subject: 'usr_fake' } } });
  });

  it('adds openid to the scopes, and asks for each resource', async () => {
    const { client } = setup({
      scopes: ['profile'],
      resources: ['https://rig.example', 'https://feedback.example'],
    });
    const { url } = await start(client);
    const q = new URL(url).searchParams;
    expect(q.get('scope')).toBe('openid profile');
    expect(q.getAll('resource')).toEqual(['https://rig.example', 'https://feedback.example']);
    expect(q.get('prompt')).toBeNull();
  });

  it.each([
    'login_required',
    'interaction_required',
    'consent_required',
    'account_selection_required',
  ] as const)('answers a silent sign-in refused with %s as not_signed_in', async (error) => {
    const { issuer, client } = setup();
    issuer.nextAuthorize({ error });
    const { url, pending } = await start(client, true);

    expect(await client.finishSignIn(await follow(issuer, url), pending)).toEqual({
      ok: false,
      reason: 'not_signed_in',
      returnTo: '/rigs/7?tab=log',
    });
  });

  it('answers a refusal of a sign-in that was not silent as invalid', async () => {
    const { issuer, client } = setup();
    issuer.nextAuthorize({ error: 'login_required' });
    const { url, pending } = await start(client);

    expect(await client.finishSignIn(await follow(issuer, url), pending)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('answers a cancelled sign-in as denied', async () => {
    const { issuer, client } = setup();
    issuer.nextAuthorize({ error: 'access_denied' });
    const { url, pending } = await start(client);

    expect(await client.finishSignIn(await follow(issuer, url), pending)).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  describe('answers invalid', () => {
    it('for a state mismatch', async () => {
      const { issuer, client } = setup();
      const { url, pending } = await start(client);
      const callback = await follow(issuer, url);
      expect(await client.finishSignIn(callback, { ...pending, state: 'other' })).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('for a nonce mismatch', async () => {
      const { issuer, client } = setup();
      const { url, pending } = await start(client);
      const callback = await follow(issuer, url);
      expect(await client.finishSignIn(callback, { ...pending, nonce: 'other' })).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('for a pending sign-in older than 10 minutes', async () => {
      const { issuer, client } = setup();
      const { url, pending } = await start(client);
      const callback = await follow(issuer, url);
      const stale: PendingSignIn = { ...pending, createdAt: Date.now() - 10 * 60_000 - 1000 };
      expect(await client.finishSignIn(callback, stale)).toEqual({ ok: false, reason: 'invalid' });
    });

    it.each([
      ['a createdAt in the future', { createdAt: Date.now() + 60 * 60_000 }],
      ['an off-origin returnTo', { returnTo: '//evil.example/' }],
    ])('for a pending sign-in with %s', async (_, change) => {
      const { issuer, client } = setup();
      const { url, pending } = await start(client);
      const callback = await follow(issuer, url);
      expect(await client.finishSignIn(callback, { ...pending, ...change })).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('for a tampered pending sign-in', async () => {
      const { issuer, client } = setup();
      const { url } = await start(client);
      const callback = await follow(issuer, url);
      const tampered = { state: 1 } as unknown as PendingSignIn;
      expect(await client.finishSignIn(callback, tampered)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    const now = () => Math.floor(Date.now() / 1000);
    it.each([
      ['a bad issuer', { iss: 'https://evil.test' }],
      ['a bad audience', { aud: 'someone-else' }],
      ['an expired ID token', { iat: now() - 7200, exp: now() - 3600 }],
    ])('for %s', async (_, claims) => {
      const { issuer, client } = setup();
      issuer.nextToken({ claims: { sub: 'usr_1', ...claims } });
      const { url, pending } = await start(client);
      expect(await client.finishSignIn(await follow(issuer, url), pending)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('for an ID token signed by another key', async () => {
      const { issuer, client } = setup();
      const impostor = createFakeIssuer({ issuer: ISSUER });
      const { url, pending } = await start(client);
      issuer.nextToken({
        idToken: await impostor.idToken({ sub: 'usr_1', aud: 'rig', nonce: pending.nonce }),
      });
      expect(await client.finishSignIn(await follow(issuer, url), pending)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('for an ID token whose payload was changed after signing', async () => {
      const { issuer, client } = setup();
      const { url, pending } = await start(client);
      const [header, , signature] = (
        await issuer.idToken({ sub: 'usr_1', aud: 'rig', nonce: pending.nonce })
      ).split('.');
      const forged = await issuer.idToken({ sub: 'usr_admin', aud: 'rig', nonce: pending.nonce });
      issuer.nextToken({ idToken: `${header}.${forged.split('.')[1]}.${signature}` });
      expect(await client.finishSignIn(await follow(issuer, url), pending)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });
  });

  describe('answers unavailable', () => {
    it('for a 5xx from the token endpoint', async () => {
      const { issuer, client } = setup();
      issuer.nextToken({ status: 503 });
      const { url, pending } = await start(client);
      expect(await client.finishSignIn(await follow(issuer, url), pending)).toEqual({
        ok: false,
        reason: 'unavailable',
      });
    });

    it('from startSignIn when discovery answers 5xx, and retries discovery next time', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      let down = true;
      const { client } = setup({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (down && new URL(request.url).pathname === '/.well-known/openid-configuration') {
            return new Response('Bad gateway', { status: 502 });
          }
          return issuer.fetch(request);
        },
      });
      expect(await client.startSignIn({ returnTo: '/' })).toEqual({
        ok: false,
        reason: 'unavailable',
      });
      down = false;
      expect(await client.startSignIn({ returnTo: '/' })).toMatchObject({ ok: true });
    });

    it('when the JWKS answers 5xx', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      const { client } = setup({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname === '/jwks') return new Response(null, { status: 503 });
          return issuer.fetch(request);
        },
      });
      const { url, pending } = await start(client);
      expect(await client.finishSignIn(await follow(issuer, url), pending)).toEqual({
        ok: false,
        reason: 'unavailable',
      });
    });

    it('when authorize answers temporarily_unavailable', async () => {
      const { client } = setup();
      const { pending } = await start(client);
      const callback = new URL(REDIRECT_URI);
      callback.searchParams.set('error', 'temporarily_unavailable');
      callback.searchParams.set('state', pending.state);
      callback.searchParams.set('iss', ISSUER);
      expect(await client.finishSignIn(callback, pending)).toEqual({
        ok: false,
        reason: 'unavailable',
      });
    });

    it('when the network fails', async () => {
      const { client } = setup({
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      });
      expect(await client.startSignIn({ returnTo: '/' })).toEqual({
        ok: false,
        reason: 'unavailable',
      });
    });
  });

  describe('throws', () => {
    it.each([
      ['an issuer that is not a URL', { issuer: 'issuer.test' }],
      ['an http issuer', { issuer: 'http://issuer.test' }],
      ['no client secret', { clientSecret: '' }],
      ['no client id', { clientId: undefined as unknown as string }],
      ['a relative redirect URI', { redirectUri: '/callback' }],
      ['no scopes', { scopes: undefined as unknown as string[] }],
    ])('for %s', (_, overrides) => {
      expect(() => setup(overrides)).toThrow(TypeError);
    });

    it.each(['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'rigs/7', ''])(
      'from startSignIn for returnTo %j',
      async (returnTo) => {
        const { client } = setup();
        await expect(client.startSignIn({ returnTo })).rejects.toThrow(TypeError);
      },
    );
  });
});
