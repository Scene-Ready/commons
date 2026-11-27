import { afterEach, describe, expect, it, vi } from 'vitest';
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
    it('from finishSignIn when auth refuses the client: the secret is wrong', async () => {
      const { issuer, client } = setup();
      issuer.nextToken({ error: 'invalid_client' });
      const { url, pending } = await start(client);
      await expect(client.finishSignIn(await follow(issuer, url), pending)).rejects.toThrow(
        /client secret/,
      );
    });

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

/** A signed-in client: tokens from a full sign-in as `claims`. */
async function signedIn(claims: Record<string, unknown> = { sub: 'usr_1' }, overrides = {}) {
  const { issuer, client } = setup(overrides);
  issuer.nextToken({ claims });
  const { url, pending } = await start(client);
  const result = await client.finishSignIn(await follow(issuer, url), pending);
  if (!result.ok) throw new Error(`sign-in failed: ${result.reason}`);
  return { issuer, client, tokens: result.tokens };
}

const org = (organizationId: string) => ({
  organizationId,
  role: 'member',
  products: {},
  unseatedProducts: [],
});

describe('refresh', () => {
  it('returns a new TokenSet with the new claims and rotated refresh token', async () => {
    const { issuer, client, tokens } = await signedIn({
      sub: 'usr_1',
      name: 'Ada',
      'urn:auth:entitlements': org('org_a'),
    });
    issuer.nextToken({
      claims: { sub: 'usr_1', name: 'Ada L.', 'urn:auth:entitlements': org('org_a') },
    });

    const result = await client.refresh(tokens);

    expect(result).toMatchObject({
      ok: true,
      tokens: {
        claims: { subject: 'usr_1', name: 'Ada L.', entitlements: { organizationId: 'org_a' } },
      },
    });
    if (!result.ok) return;
    expect(result.tokens.accessToken).not.toBe(tokens.accessToken);
    expect(result.tokens.refreshToken).toEqual(expect.any(String));
    expect(result.tokens.refreshToken).not.toBe(tokens.refreshToken);
    expect(result.tokens.idToken).not.toBe(tokens.idToken);
  });

  it('keeps the old refresh token when the response leaves it out', async () => {
    const { issuer, client, tokens } = await signedIn();
    issuer.nextToken({ refreshToken: null });
    const result = await client.refresh(tokens);
    expect(result).toMatchObject({ ok: true, tokens: { refreshToken: tokens.refreshToken } });
  });

  it('answers invalid_grant as not_signed_in', async () => {
    const { issuer, client, tokens } = await signedIn();
    issuer.nextToken({ error: 'invalid_grant' });
    expect(await client.refresh(tokens)).toEqual({ ok: false, reason: 'not_signed_in' });
  });

  it('answers not_signed_in without a refresh token', async () => {
    const { client, tokens } = await signedIn();
    expect(await client.refresh({ ...tokens, refreshToken: null })).toEqual({
      ok: false,
      reason: 'not_signed_in',
    });
  });

  it('answers org_changed with the new Active Org and no tokens', async () => {
    const { issuer, client, tokens } = await signedIn({
      sub: 'usr_1',
      'urn:auth:entitlements': org('org_a'),
    });
    issuer.nextToken({ claims: { sub: 'usr_1', 'urn:auth:entitlements': org('org_b') } });
    expect(await client.refresh(tokens)).toEqual({
      ok: false,
      reason: 'org_changed',
      activeOrgId: 'org_b',
    });
  });

  it('answers org_changed with a null activeOrgId when the Active Org is gone', async () => {
    const { issuer, client, tokens } = await signedIn({
      sub: 'usr_1',
      'urn:auth:entitlements': org('org_a'),
    });
    issuer.nextToken({ claims: { sub: 'usr_1' } });
    expect(await client.refresh(tokens)).toEqual({
      ok: false,
      reason: 'org_changed',
      activeOrgId: null,
    });
  });

  it('answers invalid for a new ID token about another user, or signed by another key', async () => {
    const { issuer, client, tokens } = await signedIn();
    issuer.nextToken({ claims: { sub: 'usr_2' } });
    expect(await client.refresh(tokens)).toEqual({ ok: false, reason: 'invalid' });

    const again = await signedIn();
    const impostor = createFakeIssuer({ issuer: ISSUER });
    again.issuer.nextToken({ idToken: await impostor.idToken({ sub: 'usr_1', aud: 'rig' }) });
    expect(await again.client.refresh(again.tokens)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('answers a 5xx as unavailable', async () => {
    const { issuer, client, tokens } = await signedIn();
    issuer.nextToken({ status: 503 });
    expect(await client.refresh(tokens)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('throws when auth refuses the client: the secret is wrong', async () => {
    const { issuer, client, tokens } = await signedIn();
    issuer.nextToken({ error: 'invalid_client' });
    await expect(client.refresh(tokens)).rejects.toThrow(/client secret/);
  });
});

describe('isExpiring', () => {
  const tokens = { accessExpiresAt: 1_000_000 } as Parameters<
    ReturnType<typeof setup>['client']['isExpiring']
  >[0];

  it('is true within the default 60 s skew, and false before it', () => {
    const { client } = setup();
    expect(client.isExpiring(tokens, 1_000_000 - 60_001)).toBe(false);
    expect(client.isExpiring(tokens, 1_000_000 - 60_000)).toBe(true);
    expect(client.isExpiring(tokens, 1_000_001)).toBe(true);
  });

  it('honours a given skew', () => {
    const { client } = setup();
    expect(client.isExpiring(tokens, 1_000_000 - 5_000, 1_000)).toBe(false);
    expect(client.isExpiring(tokens, 1_000_000 - 5_000, 5_000)).toBe(true);
  });
});

describe('userInfo', () => {
  it('returns the parsed Identity', async () => {
    const { issuer, client, tokens } = await signedIn();
    issuer.nextUserInfo({
      claims: { sub: 'usr_1', email: 'a@example.org', 'urn:auth:entitlements': org('org_b') },
    });
    expect(await client.userInfo(tokens.accessToken)).toMatchObject({
      ok: true,
      identity: {
        subject: 'usr_1',
        email: 'a@example.org',
        entitlements: { organizationId: 'org_b' },
      },
    });
  });

  it('answers the claims the access token was issued for, without scripting', async () => {
    const { client, tokens } = await signedIn({ sub: 'usr_1', name: 'Ada' });
    expect(await client.userInfo(tokens.accessToken)).toMatchObject({
      ok: true,
      identity: { subject: 'usr_1', name: 'Ada' },
    });
  });

  it('answers a 401 as not_signed_in', async () => {
    const { issuer, client, tokens } = await signedIn();
    issuer.nextUserInfo({ status: 401 });
    expect(await client.userInfo(tokens.accessToken)).toEqual({
      ok: false,
      reason: 'not_signed_in',
    });
  });

  it('answers a 5xx as unavailable', async () => {
    const { issuer, client, tokens } = await signedIn();
    issuer.nextUserInfo({ status: 502 });
    expect(await client.userInfo(tokens.accessToken)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('answers a body without sub as invalid', async () => {
    const { issuer, client, tokens } = await signedIn();
    issuer.nextUserInfo({ claims: { email: 'a@example.org' } });
    expect(await client.userInfo(tokens.accessToken)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('setActiveOrganization', () => {
  const ORGS = [
    {
      id: 'org_a',
      name: 'A',
      slug: 'a',
      logo: null,
      type: 'shared',
      role: 'owner',
      isActive: true,
    },
    {
      id: 'org_b',
      name: 'B',
      slug: 'b',
      logo: null,
      type: 'shared',
      role: 'member',
      isActive: false,
    },
  ];
  const member = () => signedIn({ sub: 'usr_1', 'urn:auth:organizations': ORGS });

  it('sets an org the user belongs to: ok', async () => {
    const { client, tokens } = await member();
    expect(await client.setActiveOrganization(tokens.accessToken, 'org_b')).toEqual({ ok: true });
  });

  it("answers auth's 404 as not_member", async () => {
    const { client, tokens } = await member();
    expect(await client.setActiveOrganization(tokens.accessToken, 'org_z')).toEqual({
      ok: false,
      reason: 'not_member',
    });
  });

  it('answers a 401 as not_signed_in', async () => {
    const { client } = await member();
    expect(await client.setActiveOrganization('expired', 'org_b')).toEqual({
      ok: false,
      reason: 'not_signed_in',
    });
  });

  it('answers a 5xx as unavailable', async () => {
    const { issuer, client, tokens } = await member();
    issuer.nextActiveOrganization({ status: 500 });
    expect(await client.setActiveOrganization(tokens.accessToken, 'org_b')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('throws on a 403: the token lacks the organizations scope', async () => {
    const { issuer, client, tokens } = await member();
    issuer.nextActiveOrganization({ status: 403 });
    await expect(client.setActiveOrganization(tokens.accessToken, 'org_b')).rejects.toThrow(
      /organizations scope/,
    );
  });

  it('calls auth on the issuer origin when the issuer has a path, as auth does', async () => {
    const issuer = createFakeIssuer({ issuer: 'https://issuer.test/api/auth' });
    const client = createOidcClient({
      issuer: 'https://issuer.test/api/auth',
      clientId: 'rig',
      clientSecret: 's3cret',
      redirectUri: REDIRECT_URI,
      scopes: ['organizations'],
      fetch: issuer.fetch,
    });
    const bearer = await issuer.accessToken(
      { sub: 'usr_1', 'urn:auth:organizations': ORGS },
      { aud: 'https://rig.example' },
    );
    expect(await client.setActiveOrganization(bearer, 'org_b')).toEqual({ ok: true });
  });
});

/** A client whose fetch answers `status` for one path and passes the rest to the fake. */
function failingAt(path: string, status: number) {
  const issuer = createFakeIssuer({ issuer: ISSUER });
  const { client } = setup({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === path) return new Response(null, { status });
      return issuer.fetch(request);
    },
  });
  return { issuer, client };
}

describe('endSessionUrl', () => {
  it("is auth's end-session URL, which signs out and returns to the app", async () => {
    const { issuer, client, tokens } = await signedIn();
    const result = await client.endSessionUrl({
      idToken: tokens.idToken,
      postLogoutRedirectUri: 'https://rig.example/signed-out',
    });
    if (!result.ok) throw new Error(result.reason);
    const url = new URL(result.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/oauth2/end-session`);
    expect(url.searchParams.get('id_token_hint')).toBe(tokens.idToken);
    expect(url.searchParams.get('client_id')).toBe('rig');
    const res = await issuer.fetch(url, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('https://rig.example/signed-out');
  });

  it('sends a state, which auth echoes back', async () => {
    const { issuer, client, tokens } = await signedIn();
    const result = await client.endSessionUrl({
      idToken: tokens.idToken,
      postLogoutRedirectUri: 'https://rig.example/signed-out',
      state: 'csrf-1',
    });
    if (!result.ok) throw new Error(result.reason);
    const res = await issuer.fetch(result.url, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('https://rig.example/signed-out?state=csrf-1');
  });

  it('answers unavailable when discovery answers 5xx', async () => {
    const { client } = failingAt('/.well-known/openid-configuration', 503);
    expect(
      await client.endSessionUrl({ idToken: 'x', postLogoutRedirectUri: 'https://rig.example/' }),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('throws for a relative post-logout redirect URI', async () => {
    const { client } = setup();
    await expect(
      client.endSessionUrl({ idToken: 'x', postLogoutRedirectUri: '/signed-out' }),
    ).rejects.toThrow(TypeError);
  });
});

describe('revoke', () => {
  it('revokes the refresh token: ok, and it no longer refreshes', async () => {
    const { client, tokens } = await signedIn();
    expect(await client.revoke(tokens.refreshToken!)).toEqual({ ok: true });
    expect(await client.refresh(tokens)).toEqual({ ok: false, reason: 'not_signed_in' });
  });

  it('answers a 5xx as unavailable', async () => {
    const { client } = failingAt('/oauth2/revoke', 503);
    expect(await client.revoke('rt')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('answers a network failure as unavailable rather than throwing', async () => {
    const { client } = setup({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await client.revoke('rt')).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('verifyAccessToken', () => {
  const RIG = 'https://rig.example';
  const entitlements = {
    organizationId: 'org_a',
    role: 'member',
    products: { rig: { tier: 'pro', capabilities: ['rigs.edit'], limits: { rigs: null } } },
    unseatedProducts: [],
  };

  function api() {
    return setup({ resources: [RIG] });
  }

  it('returns the subject, client id, scopes and entitlements of a valid token', async () => {
    const { issuer, client } = api();
    const token = await issuer.accessToken(
      {
        sub: 'usr_1',
        client_id: 'rig-web',
        scope: 'openid rigs:read',
        'urn:auth:entitlements': entitlements,
      },
      { aud: RIG },
    );
    expect(await client.verifyAccessToken(token)).toEqual({
      ok: true,
      subject: 'usr_1',
      clientId: 'rig-web',
      scopes: ['openid', 'rigs:read'],
      entitlements,
    });
  });

  it('passes a token whose aud is an array that includes the resource', async () => {
    const { issuer, client } = api();
    const token = await issuer.accessToken(
      { sub: 'usr_1', client_id: 'rig-web' },
      { aud: ['https://feedback.example', RIG] },
    );
    expect(await client.verifyAccessToken(token)).toEqual({
      ok: true,
      subject: 'usr_1',
      clientId: 'rig-web',
      scopes: [],
      entitlements: null,
    });
  });

  it('verifies the tokens a sign-in gets for the resource', async () => {
    const { issuer, client } = api();
    issuer.nextToken({ claims: { sub: 'usr_1', 'urn:auth:entitlements': entitlements } });
    const { url, pending } = await start(client);
    const signedIn = await client.finishSignIn(await follow(issuer, url), pending);
    if (!signedIn.ok) throw new Error(signedIn.reason);
    expect(await client.verifyAccessToken(signedIn.tokens.accessToken)).toMatchObject({
      ok: true,
      subject: 'usr_1',
      clientId: 'rig',
      entitlements,
    });
  });

  describe('answers invalid', () => {
    it('for a token for another audience', async () => {
      const { issuer, client } = api();
      const token = await issuer.accessToken(
        { sub: 'usr_1', client_id: 'x' },
        { aud: 'https://feedback.example' },
      );
      expect(await client.verifyAccessToken(token)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('for a token signed by another key', async () => {
      const { client } = api();
      const impostor = createFakeIssuer({ issuer: ISSUER });
      const token = await impostor.accessToken({ sub: 'usr_1', client_id: 'x' }, { aud: RIG });
      expect(await client.verifyAccessToken(token)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('for a token whose payload was changed after signing', async () => {
      const { issuer, client } = api();
      const [header, , signature] = (
        await issuer.accessToken({ sub: 'usr_1', client_id: 'x' }, { aud: RIG })
      ).split('.');
      const other = await issuer.accessToken({ sub: 'usr_admin', client_id: 'x' }, { aud: RIG });
      const forged = `${header}.${other.split('.')[1]}.${signature}`;
      expect(await client.verifyAccessToken(forged)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('for a token from another issuer', async () => {
      const { issuer, client } = api();
      const token = await issuer.accessToken(
        { iss: 'https://other.test', sub: 'usr_1', client_id: 'x' },
        { aud: RIG },
      );
      expect(await client.verifyAccessToken(token)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('for an expired token', async () => {
      const { issuer, client } = api();
      const now = Math.floor(Date.now() / 1000);
      const token = await issuer.accessToken(
        { sub: 'usr_1', client_id: 'x', iat: now - 3600, exp: now - 60 },
        { aud: RIG },
      );
      expect(await client.verifyAccessToken(token)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('for a token without client_id, or that is not a JWT', async () => {
      const { issuer, client } = api();
      const token = await issuer.accessToken({ sub: 'usr_1' }, { aud: RIG });
      expect(await client.verifyAccessToken(token)).toEqual({ ok: false, reason: 'invalid' });
      expect(await client.verifyAccessToken('opaque')).toEqual({ ok: false, reason: 'invalid' });
    });
  });

  it('makes no network call beyond discovery and the JWKS, once cached', async () => {
    const issuer = createFakeIssuer({ issuer: ISSUER });
    const urls: string[] = [];
    const { client } = setup({
      resources: [RIG],
      fetch: (input, init) => {
        urls.push(new Request(input, init).url);
        return issuer.fetch(input, init);
      },
    });
    const token = await issuer.accessToken({ sub: 'usr_1', client_id: 'x' }, { aud: RIG });
    await client.verifyAccessToken(token);
    await client.verifyAccessToken(token);
    expect(urls).toEqual([`${ISSUER}/.well-known/openid-configuration`, `${ISSUER}/jwks`]);
  });

  it('answers unavailable when the JWKS answers 5xx', async () => {
    const issuer = createFakeIssuer({ issuer: ISSUER });
    const { client } = setup({
      resources: [RIG],
      fetch: (input, init) =>
        new Request(input, init).url.endsWith('/jwks')
          ? Promise.resolve(new Response(null, { status: 503 }))
          : issuer.fetch(input, init),
    });
    const token = await issuer.accessToken({ sub: 'usr_1', client_id: 'x' }, { aud: RIG });
    expect(await client.verifyAccessToken(token)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('throws when the client has no resources', async () => {
    const { client } = setup();
    await expect(client.verifyAccessToken('x')).rejects.toThrow(/resources/);
  });
});

describe('clientCredentialsToken', () => {
  const FEEDBACK = 'https://feedback.example';

  function counted() {
    const issuer = createFakeIssuer({ issuer: ISSUER });
    const tokenRequests: URLSearchParams[] = [];
    const { client } = setup({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url === `${ISSUER}/oauth2/token`) {
          tokenRequests.push(new URLSearchParams(await request.clone().text()));
        }
        return issuer.fetch(request);
      },
    });
    return { issuer, client, tokenRequests };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mints a token for the audience and scopes, which the audience can verify', async () => {
    const { issuer, client, tokenRequests } = counted();
    const result = await client.clientCredentialsToken({
      audience: FEEDBACK,
      scopes: ['feedback:write'],
    });
    expect(result).toMatchObject({ ok: true, accessToken: expect.any(String) });
    if (!result.ok) return;
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
    expect(tokenRequests[0].get('grant_type')).toBe('client_credentials');
    expect(tokenRequests[0].get('resource')).toBe(FEEDBACK);
    expect(tokenRequests[0].get('scope')).toBe('feedback:write');

    const feedback = createOidcClient({
      issuer: ISSUER,
      clientId: 'feedback',
      clientSecret: 's3cret',
      redirectUri: 'https://feedback.example/callback',
      scopes: [],
      resources: [FEEDBACK],
      fetch: issuer.fetch,
    });
    expect(await feedback.verifyAccessToken(result.accessToken)).toEqual({
      ok: true,
      subject: 'rig',
      clientId: 'rig',
      scopes: ['feedback:write'],
      entitlements: null,
    });
  });

  it('reuses the token per audience, and shares one request between concurrent callers', async () => {
    const { client, tokenRequests } = counted();
    const options = { audience: FEEDBACK, scopes: ['feedback:write'] };
    const [a, b] = await Promise.all([
      client.clientCredentialsToken(options),
      client.clientCredentialsToken(options),
    ]);
    const c = await client.clientCredentialsToken(options);
    expect(tokenRequests).toHaveLength(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);

    const other = await client.clientCredentialsToken({
      audience: 'https://platform.example',
      scopes: [],
    });
    expect(tokenRequests).toHaveLength(2);
    expect(other).not.toEqual(a);
  });

  it('mints a new token 60 s before the cached one expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const { issuer, client, tokenRequests } = counted();
    issuer.nextToken({ expiresIn: 600 });
    const options = { audience: FEEDBACK, scopes: [] };
    const first = await client.clientCredentialsToken(options);

    vi.setSystemTime(start + 540_000 - 1);
    expect(await client.clientCredentialsToken(options)).toEqual(first);
    expect(tokenRequests).toHaveLength(1);

    vi.setSystemTime(start + 540_000);
    const second = await client.clientCredentialsToken(options);
    expect(tokenRequests).toHaveLength(2);
    expect(second).not.toEqual(first);
  });

  it('answers a 5xx as unavailable, keeps nothing, and tries again next time', async () => {
    const { issuer, client, tokenRequests } = counted();
    issuer.nextToken({ status: 503 });
    const options = { audience: FEEDBACK, scopes: [] };
    expect(await client.clientCredentialsToken(options)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await client.clientCredentialsToken(options)).toMatchObject({ ok: true });
    expect(tokenRequests).toHaveLength(2);
  });

  it('gives concurrent callers of a failing request one unavailable, not a retry each', async () => {
    const { issuer, client, tokenRequests } = counted();
    issuer.nextToken({ status: 503 });
    const options = { audience: FEEDBACK, scopes: [] };
    const results = await Promise.all([
      client.clientCredentialsToken(options),
      client.clientCredentialsToken(options),
    ]);
    expect(results).toEqual([
      { ok: false, reason: 'unavailable' },
      { ok: false, reason: 'unavailable' },
    ]);
    expect(tokenRequests).toHaveLength(1);
  });

  it('answers a network failure as unavailable', async () => {
    const issuer = createFakeIssuer({ issuer: ISSUER });
    const { client } = setup({
      fetch: (input, init) =>
        new Request(input, init).url.endsWith('/oauth2/token')
          ? Promise.reject(new TypeError('fetch failed'))
          : issuer.fetch(input, init),
    });
    expect(await client.clientCredentialsToken({ audience: FEEDBACK, scopes: [] })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('throws when auth refuses the request: misconfiguration', async () => {
    const { issuer, client } = counted();
    issuer.nextToken({ error: 'invalid_scope' });
    await expect(
      client.clientCredentialsToken({ audience: FEEDBACK, scopes: ['admin'] }),
    ).rejects.toThrow(/invalid_scope/);
  });

  it('throws for an audience that is not an absolute URL', async () => {
    const { client } = setup();
    await expect(
      client.clientCredentialsToken({ audience: 'feedback', scopes: [] }),
    ).rejects.toThrow(/audience/);
  });
});
