import { describe, expect, it } from 'vitest';
import { createFakeIssuer } from '../src/oidc/testing';

const ISSUER = 'https://issuer.test';

/** Verifies a compact ES256 JWS against the issuer's JWKS, independently of the fake. */
async function verifyJwt(fetch: typeof globalThis.fetch, jwt: string) {
  const discovery = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
  const { keys } = await (await fetch(discovery.jwks_uri)).json();
  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(decode(h));
  const jwk = keys.find((k: { kid: string }) => k.kid === header.kid);
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    bytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  return { valid, header, payload: JSON.parse(decode(p)) };
}

function bytes(b64url: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decode(b64url: string): string {
  return new TextDecoder().decode(bytes(b64url));
}

const CLIENT = { id: 'rig', secret: 's3cret', redirectUri: 'https://rig.example/callback' };
const VERIFIER = 'a-code-verifier-that-is-long-enough-for-pkce-0123456789';

async function challenge(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Follows an authorize URL as the browser would, and returns the callback's query. */
async function authorize(fetch: typeof globalThis.fetch, params: Record<string, string> = {}) {
  const url = new URL(`${ISSUER}/oauth2/authorize`);
  const query = {
    response_type: 'code',
    client_id: CLIENT.id,
    redirect_uri: CLIENT.redirectUri,
    scope: 'openid profile',
    state: 'st1',
    nonce: 'n1',
    code_challenge: await challenge(VERIFIER),
    code_challenge_method: 'S256',
    ...params,
  };
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!);
  expect(`${location.origin}${location.pathname}`).toBe(CLIENT.redirectUri);
  return location.searchParams;
}

function token(fetch: typeof globalThis.fetch, body: Record<string, string>) {
  return fetch(`${ISSUER}/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${CLIENT.id}:${CLIENT.secret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
}

async function exchange(fetch: typeof globalThis.fetch, code: string) {
  return token(fetch, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: CLIENT.redirectUri,
    code_verifier: VERIFIER,
  });
}

describe('createFakeIssuer', () => {
  it('serves discovery for its issuer', async () => {
    const { fetch } = createFakeIssuer({ issuer: ISSUER });
    const res = await fetch(`${ISSUER}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const discovery = await res.json();
    expect(discovery).toMatchObject({
      issuer: ISSUER,
      id_token_signing_alg_values_supported: ['ES256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
    });
    for (const endpoint of [
      'authorization_endpoint',
      'token_endpoint',
      'userinfo_endpoint',
      'end_session_endpoint',
      'revocation_endpoint',
      'jwks_uri',
    ]) {
      expect(discovery[endpoint]).toMatch(new RegExp(`^${ISSUER}/`));
    }
  });

  it('signs an ID token with chosen claims that verifies against its JWKS', async () => {
    const issuer = createFakeIssuer({ issuer: ISSUER });
    const jwt = await issuer.idToken({ sub: 'usr_1', aud: 'rig', nonce: 'n1' });
    const { valid, header, payload } = await verifyJwt(issuer.fetch, jwt);
    expect(valid).toBe(true);
    expect(header.alg).toBe('ES256');
    expect(payload).toMatchObject({ iss: ISSUER, sub: 'usr_1', aud: 'rig', nonce: 'n1' });
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('signs a user in: authorize redirects with a code, token returns an ID token for it', async () => {
    const issuer = createFakeIssuer({ issuer: ISSUER });
    const callback = await authorize(issuer.fetch);
    expect(callback.get('state')).toBe('st1');

    const res = await exchange(issuer.fetch, callback.get('code')!);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    const { valid, payload } = await verifyJwt(issuer.fetch, body.id_token);
    expect(valid).toBe(true);
    expect(payload).toMatchObject({ iss: ISSUER, aud: 'rig', nonce: 'n1', sub: 'usr_fake' });
  });

  it('refuses a code twice, and a code with the wrong verifier', async () => {
    const issuer = createFakeIssuer({ issuer: ISSUER });
    const code = (await authorize(issuer.fetch)).get('code')!;
    expect((await exchange(issuer.fetch, code)).status).toBe(200);
    const reused = await exchange(issuer.fetch, code);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: 'invalid_grant' });

    const other = (await authorize(issuer.fetch)).get('code')!;
    const wrong = await token(issuer.fetch, {
      grant_type: 'authorization_code',
      code: other,
      redirect_uri: CLIENT.redirectUri,
      code_verifier: 'not-the-verifier-that-made-the-challenge-0123456789',
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses an authorize request without PKCE', async () => {
    const issuer = createFakeIssuer({ issuer: ISSUER });
    const url = new URL(`${ISSUER}/oauth2/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT.id);
    url.searchParams.set('redirect_uri', CLIENT.redirectUri);
    expect((await issuer.fetch(url, { redirect: 'manual' })).status).toBe(400);
  });

  it('refuses a token request without client_secret_basic', async () => {
    const issuer = createFakeIssuer({ issuer: ISSUER });
    const res = await issuer.fetch(`${ISSUER}/oauth2/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic /);
    expect(await res.json()).toMatchObject({ error: 'invalid_client' });
  });

  describe('scripted outcomes', () => {
    it.each(['login_required', 'interaction_required', 'access_denied'] as const)(
      'authorize refuses with %s when scripted, then issues codes again',
      async (error) => {
        const issuer = createFakeIssuer({ issuer: ISSUER });
        issuer.nextAuthorize({ error });
        const refused = await authorize(issuer.fetch, { prompt: 'none' });
        expect(refused.get('error')).toBe(error);
        expect(refused.get('state')).toBe('st1');
        expect(refused.has('code')).toBe(false);

        expect((await authorize(issuer.fetch)).has('code')).toBe(true);
      },
    );

    it('authorize issues the scripted code', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      issuer.nextAuthorize({ code: 'code_chosen' });
      expect((await authorize(issuer.fetch)).get('code')).toBe('code_chosen');
      expect((await exchange(issuer.fetch, 'code_chosen')).status).toBe(200);
    });

    it('token answers invalid_grant when scripted', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      const code = (await authorize(issuer.fetch)).get('code')!;
      issuer.nextToken({ error: 'invalid_grant' });
      const res = await exchange(issuer.fetch, code);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
    });

    it('token answers a 5xx when scripted, and the next request succeeds', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      issuer.nextToken({ status: 503 });
      const failed = await token(issuer.fetch, { grant_type: 'client_credentials' });
      expect(failed.status).toBe(503);
      expect((await token(issuer.fetch, { grant_type: 'client_credentials' })).status).toBe(200);
    });

    it('token signs the scripted claims into the ID token, over the ones it fills in', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      const code = (await authorize(issuer.fetch)).get('code')!;
      const entitlements = {
        organizationId: 'org_1',
        role: 'owner',
        products: {},
        unseatedProducts: [],
      };
      issuer.nextToken({
        claims: { sub: 'usr_2', 'urn:auth:entitlements': entitlements, iss: 'https://evil.test' },
      });
      const body = await (await exchange(issuer.fetch, code)).json();
      const { payload } = await verifyJwt(issuer.fetch, body.id_token);
      expect(payload).toMatchObject({
        sub: 'usr_2',
        aud: 'rig',
        nonce: 'n1',
        iss: 'https://evil.test',
        'urn:auth:entitlements': entitlements,
      });
    });

    it('token returns a scripted raw ID token unchanged', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      const code = (await authorize(issuer.fetch)).get('code')!;
      issuer.nextToken({ idToken: 'not.a.jwt' });
      expect((await (await exchange(issuer.fetch, code)).json()).id_token).toBe('not.a.jwt');
    });

    it('outcomes queue in order', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      issuer.nextToken({ status: 500 });
      issuer.nextToken({ error: 'invalid_grant' });
      const cc = { grant_type: 'client_credentials' };
      expect((await token(issuer.fetch, cc)).status).toBe(500);
      expect((await token(issuer.fetch, cc)).status).toBe(400);
      expect((await token(issuer.fetch, cc)).status).toBe(200);
    });
  });

  describe('userinfo', () => {
    async function signIn(issuer: ReturnType<typeof createFakeIssuer>) {
      const code = (await authorize(issuer.fetch)).get('code')!;
      return (await exchange(issuer.fetch, code)).json();
    }

    function userInfo(fetch: typeof globalThis.fetch, accessToken: string) {
      return fetch(`${ISSUER}/oauth2/userinfo`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    }

    it('returns the signed-in claims for an access token it issued', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      issuer.nextToken({ claims: { sub: 'usr_3', email: 'c@example.org' } });
      const { access_token } = await signIn(issuer);
      const res = await userInfo(issuer.fetch, access_token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sub: 'usr_3', email: 'c@example.org' });
    });

    it('answers 401 for a token it did not issue', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      expect((await userInfo(issuer.fetch, 'unknown')).status).toBe(401);
    });

    it('returns scripted claims, a scripted 401 and a scripted 5xx', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      const { access_token } = await signIn(issuer);
      issuer.nextUserInfo({ claims: { sub: 'usr_fake', 'urn:auth:organizations': [] } });
      issuer.nextUserInfo({ status: 401 });
      issuer.nextUserInfo({ status: 502 });
      expect(await (await userInfo(issuer.fetch, access_token)).json()).toEqual({
        sub: 'usr_fake',
        'urn:auth:organizations': [],
      });
      expect((await userInfo(issuer.fetch, access_token)).status).toBe(401);
      expect((await userInfo(issuer.fetch, access_token)).status).toBe(502);
      expect((await userInfo(issuer.fetch, access_token)).status).toBe(200);
    });
  });

  describe('access tokens, refresh and sign-out', () => {
    it('signs a JWT access token for the requested resource, carrying the entitlements', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      const entitlements = {
        organizationId: 'org_1',
        role: null,
        products: {},
        unseatedProducts: [],
      };
      issuer.nextToken({ claims: { sub: 'usr_4', 'urn:auth:entitlements': entitlements } });
      const code = (await authorize(issuer.fetch, { resource: 'https://rig.example' })).get(
        'code',
      )!;
      const { access_token } = await (await exchange(issuer.fetch, code)).json();
      const { valid, payload } = await verifyJwt(issuer.fetch, access_token);
      expect(valid).toBe(true);
      expect(payload).toMatchObject({
        iss: ISSUER,
        aud: 'https://rig.example',
        sub: 'usr_4',
        client_id: 'rig',
        scope: 'openid profile',
        'urn:auth:entitlements': entitlements,
      });
    });

    it('signs an access token with chosen claims', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      const jwt = await issuer.accessToken(
        { sub: 'usr_5', exp: 1 },
        { aud: 'https://rig.example' },
      );
      const { valid, header, payload } = await verifyJwt(issuer.fetch, jwt);
      expect(valid).toBe(true);
      // RFC 9068: a JWT access token is typed at+jwt and carries a jti.
      expect(header.typ).toBe('at+jwt');
      expect(typeof payload.jti).toBe('string');
      expect(payload).toMatchObject({ aud: 'https://rig.example', sub: 'usr_5', exp: 1 });
    });

    it('refreshes for the same user, rotating the refresh token', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      issuer.nextToken({ claims: { sub: 'usr_6' } });
      const code = (await authorize(issuer.fetch)).get('code')!;
      const first = await (await exchange(issuer.fetch, code)).json();

      const refresh = (refresh_token: string) =>
        token(issuer.fetch, { grant_type: 'refresh_token', refresh_token });
      const res = await refresh(first.refresh_token);
      expect(res.status).toBe(200);
      const second = await res.json();
      expect((await verifyJwt(issuer.fetch, second.id_token)).payload).toMatchObject({
        sub: 'usr_6',
        aud: 'rig',
      });
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(await (await refresh(first.refresh_token)).json()).toMatchObject({
        error: 'invalid_grant',
      });
    });

    it('refuses a refresh token after it is revoked', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      const code = (await authorize(issuer.fetch)).get('code')!;
      const { refresh_token } = await (await exchange(issuer.fetch, code)).json();
      const revoked = await issuer.fetch(`${ISSUER}/oauth2/revoke`, {
        method: 'POST',
        body: new URLSearchParams({ token: refresh_token }),
      });
      expect(revoked.status).toBe(200);
      const res = await token(issuer.fetch, { grant_type: 'refresh_token', refresh_token });
      expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
    });

    it('issues an app-to-app access token for the client', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      const res = await token(issuer.fetch, {
        grant_type: 'client_credentials',
        resource: 'https://feedback.example',
        scope: 'feedback.write',
      });
      const body = await res.json();
      expect(body.refresh_token).toBeUndefined();
      expect(body.id_token).toBeUndefined();
      expect((await verifyJwt(issuer.fetch, body.access_token)).payload).toMatchObject({
        aud: 'https://feedback.example',
        sub: 'rig',
        client_id: 'rig',
        scope: 'feedback.write',
      });
    });

    it('ends the session by redirecting to the post-logout URI with the state', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      const url = new URL(`${ISSUER}/oauth2/end-session`);
      url.searchParams.set('id_token_hint', await issuer.idToken({ sub: 'usr_1', aud: 'rig' }));
      url.searchParams.set('post_logout_redirect_uri', 'https://rig.example/');
      url.searchParams.set('state', 'bye');
      const res = await issuer.fetch(url, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://rig.example/?state=bye');
    });

    it('serves an issuer with a path', async () => {
      const issuer = createFakeIssuer({ issuer: 'https://issuer.test/api/auth' });
      const res = await issuer.fetch(
        'https://issuer.test/api/auth/.well-known/openid-configuration',
      );
      expect(await res.json()).toMatchObject({
        issuer: 'https://issuer.test/api/auth',
        token_endpoint: 'https://issuer.test/api/auth/oauth2/token',
      });
    });
  });

  describe('active organization', () => {
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

    function setActive(issuer: ReturnType<typeof createFakeIssuer>, bearer: string, id: string) {
      return issuer.fetch('https://issuer.test/api/oidc/organizations/active', {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: id }),
      });
    }

    it("sets an org the user's token lists, and answers 404 for any other", async () => {
      const issuer = createFakeIssuer({ issuer: 'https://issuer.test/api/auth' });
      const bearer = await issuer.accessToken(
        { sub: 'usr_1', 'urn:auth:organizations': ORGS },
        { aud: 'https://rig.example' },
      );
      const res = await setActive(issuer, bearer, 'org_b');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: 'org_b',
        name: 'B',
        slug: 'b',
        logo: null,
        type: 'shared',
        role: 'member',
      });
      expect((await setActive(issuer, bearer, 'org_z')).status).toBe(404);
    });

    it('answers 401 for an unknown token, and a scripted status', async () => {
      const issuer = createFakeIssuer({ issuer: ISSUER });
      expect((await setActive(issuer, 'nope', 'org_a')).status).toBe(401);
      issuer.nextActiveOrganization({ status: 503 });
      expect((await setActive(issuer, 'nope', 'org_a')).status).toBe(503);
    });
  });
});
