/**
 * A fake OIDC issuer for apps' tests. It answers discovery, JWKS, authorize,
 * token, userinfo, end-session, revocation and auth's set-active-organization
 * endpoint through the `fetch` it returns,
 * so tests need no server or ports and run under Node and workerd.
 *
 * Not part of the production export: nothing in `oidc` or `oidc/claims`
 * imports it.
 */

export interface FakeIssuerOptions {
  /** The issuer identifier. Defaults to `https://issuer.test`. */
  issuer?: string;
}

/** JWT claims; registered claims the fake fills in can be overridden. */
export type Claims = Record<string, unknown>;

export interface FakeIssuer {
  /** Pass to `createOidcClient({ fetch })`; follow the authorize URL with it too. */
  fetch: typeof globalThis.fetch;
  /** An ES256 ID token: `iss`, `iat` and `exp` are filled in, and `claims` override them. */
  idToken(claims: Claims): Promise<string>;
  /**
   * An ES256 JWT access token for `aud`, as auth issues for an `oauthResource`.
   * Userinfo answers it with `claims`.
   */
  accessToken(claims: Claims, options: { aud: string | string[] }): Promise<string>;
  /** Scripts the next authorize request: a chosen code, or a refusal. */
  nextAuthorize(outcome: AuthorizeOutcome): void;
  /** Scripts the next token request, whatever its grant. */
  nextToken(outcome: TokenOutcome): void;
  /** Scripts the next userinfo request. */
  nextUserInfo(outcome: UserInfoOutcome): void;
  /**
   * Scripts the next `POST /api/oidc/organizations/active`, such as a 5xx.
   * Unscripted, it answers 200 for an org in the token's
   * `urn:auth:organizations`, 404 for any other and 401 for an unknown token. It
   * changes nothing that userinfo or the token endpoint answer: script those.
   */
  nextActiveOrganization(outcome: StatusOutcome): void;
}

/** Errors authorize sends back to the redirect URI. */
export type AuthorizeError =
  | 'login_required'
  | 'interaction_required'
  | 'consent_required'
  | 'account_selection_required'
  | 'access_denied';

/** A refusal, or a code (random when not given) that the token endpoint will accept. */
export type AuthorizeOutcome = { code?: string } | { error: AuthorizeError };

/** An OAuth error body, such as `invalid_grant` (400) or `invalid_token` at userinfo (401). */
export interface ErrorOutcome {
  error: string;
}

/** A bare HTTP status, such as a 5xx. */
export interface StatusOutcome {
  status: number;
}

/**
 * A successful token response. `claims` replace the user's claims (by default
 * `{ sub: 'usr_fake' }` at sign-in, the same user's at refresh) and are signed
 * over the `iss`, `aud`, `iat`, `exp` and `nonce` the fake fills in, so they
 * can override them. `idToken` and `accessToken` are returned unchanged
 * instead of signed ones. `refreshToken: null` leaves the refresh token out.
 */
export interface TokenSuccess {
  claims?: Claims;
  idToken?: string;
  accessToken?: string;
  refreshToken?: null;
  expiresIn?: number;
}

export type TokenOutcome = TokenSuccess | ErrorOutcome | StatusOutcome;

/** Userinfo answers `claims` as its body, whatever the access token. */
export type UserInfoOutcome = { claims: Claims } | ErrorOutcome | StatusOutcome;

const LIFETIME_S = 3600;

/** The claims a sign-in gets when the test scripted none. */
const DEFAULT_CLAIMS: Claims = { sub: 'usr_fake' };

/** What authorize remembers about a code until it is exchanged. */
interface Grant {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string | null;
  scope: string;
  resource: string[];
}

/** What a refresh token stands for. */
interface Session {
  clientId: string;
  scope: string;
  resource: string[];
  claims: Claims;
}

export function createFakeIssuer(options: FakeIssuerOptions = {}): FakeIssuer {
  const issuer = (options.issuer ?? 'https://issuer.test').replace(/\/$/, '');
  const keys = generateKey();

  const endpoint = (path: string) => `${issuer}${path}`;
  /** auth serves its Organizations API on its origin, outside the issuer path. */
  const activeOrgEndpoint = `${new URL(issuer).origin}/api/oidc/organizations/active`;
  const discovery = {
    issuer,
    authorization_endpoint: endpoint('/oauth2/authorize'),
    token_endpoint: endpoint('/oauth2/token'),
    userinfo_endpoint: endpoint('/oauth2/userinfo'),
    end_session_endpoint: endpoint('/oauth2/end-session'),
    revocation_endpoint: endpoint('/oauth2/revoke'),
    jwks_uri: endpoint('/jwks'),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
  };

  const authorizeOutcomes: AuthorizeOutcome[] = [];
  const tokenOutcomes: TokenOutcome[] = [];
  const userInfoOutcomes: UserInfoOutcome[] = [];
  const activeOrgOutcomes: StatusOutcome[] = [];

  const codes = new Map<string, Grant>();
  const refreshTokens = new Map<string, Session>();
  /** Userinfo's answer for each access token issued. */
  const accessClaims = new Map<string, Claims>();

  async function sign(claims: Claims, typ = 'JWT'): Promise<string> {
    const { privateKey, kid } = await keys;
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(json({ alg: 'ES256', typ, kid }));
    const payload = base64url(json({ iss: issuer, iat: now, exp: now + LIFETIME_S, ...claims }));
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
  }

  async function accessToken(claims: Claims, { aud }: { aud: string | string[] }) {
    // RFC 9068 JWT access token.
    const jwt = await sign({ aud, jti: randomToken(), ...claims }, 'at+jwt');
    accessClaims.set(jwt, claims);
    return jwt;
  }

  function authorize(url: URL): Response {
    const q = url.searchParams;
    const redirectUri = q.get('redirect_uri');
    const clientId = q.get('client_id');
    const codeChallenge = q.get('code_challenge');
    if (
      !redirectUri ||
      !clientId ||
      q.get('response_type') !== 'code' ||
      !codeChallenge ||
      q.get('code_challenge_method') !== 'S256'
    ) {
      return oauthError('invalid_request');
    }
    const outcome = authorizeOutcomes.shift() ?? {};
    const callback = new URL(redirectUri);
    if ('error' in outcome) {
      callback.searchParams.set('error', outcome.error);
    } else {
      const code = outcome.code ?? randomToken();
      codes.set(code, {
        clientId,
        redirectUri,
        codeChallenge,
        nonce: q.get('nonce'),
        scope: q.get('scope') ?? '',
        resource: q.getAll('resource'),
      });
      callback.searchParams.set('code', code);
    }
    const state = q.get('state');
    if (state !== null) callback.searchParams.set('state', state);
    callback.searchParams.set('iss', issuer);
    return Response.redirect(callback.href, 302);
  }

  async function token(request: Request): Promise<Response> {
    const outcome = tokenOutcomes.shift() ?? {};
    if ('error' in outcome) return oauthError(outcome.error);
    if ('status' in outcome) return statusOnly(outcome.status);

    const clientId = basicClientId(request);
    if (clientId === null) return oauthError('invalid_client');
    const form = new URLSearchParams(await request.text());
    const requested = form.getAll('resource');

    switch (form.get('grant_type')) {
      case 'authorization_code': {
        const code = form.get('code') ?? '';
        const grant = codes.get(code);
        codes.delete(code);
        if (
          !grant ||
          grant.clientId !== clientId ||
          grant.redirectUri !== form.get('redirect_uri') ||
          (await s256(form.get('code_verifier') ?? '')) !== grant.codeChallenge
        ) {
          return oauthError('invalid_grant');
        }
        return issue(outcome, {
          clientId,
          scope: grant.scope,
          resource: requested.length ? requested : grant.resource,
          claims: outcome.claims ?? DEFAULT_CLAIMS,
          nonce: grant.nonce,
        });
      }
      case 'refresh_token': {
        const old = form.get('refresh_token') ?? '';
        const session = refreshTokens.get(old);
        if (!session || session.clientId !== clientId) return oauthError('invalid_grant');
        refreshTokens.delete(old);
        return issue(outcome, {
          ...session,
          resource: requested.length ? requested : session.resource,
          claims: outcome.claims ?? session.claims,
          nonce: null,
        });
      }
      case 'client_credentials': {
        const resource = requested;
        const scope = form.get('scope') ?? '';
        const claims = { sub: clientId, client_id: clientId, scope, ...outcome.claims };
        // A JWT for the requested resource; without one, an opaque token that
        // userinfo answers, as auth issues for its own app-to-app routes.
        const access =
          outcome.accessToken ??
          (resource.length
            ? await accessToken(claims, { aud: audience(resource) })
            : opaque(claims));
        return tokenResponse({
          access_token: access,
          expires_in: outcome.expiresIn ?? LIFETIME_S,
          scope,
        });
      }
      default:
        return oauthError('unsupported_grant_type');
    }
  }

  /** Tokens for a user: an ID token, an access token and, unless left out, a refresh token. */
  async function issue(
    outcome: TokenSuccess,
    session: Session & { nonce: string | null },
  ): Promise<Response> {
    const { clientId, scope, resource, claims, nonce } = session;
    const idToken =
      outcome.idToken ??
      (await sign({ aud: clientId, ...(nonce === null ? {} : { nonce }), ...claims }));
    const access =
      outcome.accessToken ??
      (resource.length
        ? await accessToken(
            {
              client_id: clientId,
              scope,
              ...pick(claims, ['sub', 'urn:auth:entitlements']),
            },
            { aud: audience(resource) },
          )
        : opaque(claims));
    // Userinfo answers with the user's claims, not the access token's.
    accessClaims.set(access, claims);
    let refresh: string | undefined;
    if (outcome.refreshToken !== null) {
      refresh = randomToken();
      refreshTokens.set(refresh, { clientId, scope, resource, claims });
    }
    return tokenResponse({
      access_token: access,
      expires_in: outcome.expiresIn ?? LIFETIME_S,
      refresh_token: refresh,
      id_token: idToken,
      scope,
    });
  }

  function opaque(claims: Claims): string {
    const access = randomToken();
    accessClaims.set(access, claims);
    return access;
  }

  function userInfo(request: Request): Response {
    const bearer = /^Bearer (.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    const outcome = userInfoOutcomes.shift();
    if (outcome && 'status' in outcome) {
      return outcome.status === 401 ? invalidToken() : statusOnly(outcome.status);
    }
    if (outcome && 'error' in outcome) {
      return Response.json(
        { error: outcome.error },
        { status: 401, headers: { 'www-authenticate': `Bearer error="${outcome.error}"` } },
      );
    }
    if (outcome) return Response.json(outcome.claims);
    const claims = bearer === undefined ? undefined : accessClaims.get(bearer);
    return claims ? Response.json(claims) : invalidToken();
  }

  /** auth's `POST /api/oidc/organizations/active`, on the issuer's origin. */
  async function setActiveOrganization(request: Request): Promise<Response> {
    const outcome = activeOrgOutcomes.shift();
    if (outcome) return statusOnly(outcome.status);
    const bearer = /^Bearer (.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    const claims = bearer === undefined ? undefined : accessClaims.get(bearer);
    if (!claims) return invalidToken();
    const { organizationId } = (await request.json().catch(() => ({}))) as {
      organizationId?: unknown;
    };
    const orgs = claims['urn:auth:organizations'];
    const org = Array.isArray(orgs)
      ? (orgs as Claims[]).find((o) => o?.id === organizationId)
      : undefined;
    if (!org) return Response.json({ error: 'not_found' }, { status: 404 });
    const { id, name, slug, logo, type, role } = org;
    return Response.json({ id, name, slug, logo, type, role });
  }

  async function revoke(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const revoked = form.get('token') ?? '';
    refreshTokens.delete(revoked);
    accessClaims.delete(revoked);
    // RFC 7009: 200 whether or not the token was known.
    return new Response(null, { status: 200 });
  }

  function endSession(url: URL): Response {
    const redirect = url.searchParams.get('post_logout_redirect_uri');
    if (!redirect) return new Response('Signed out', { status: 200 });
    const target = new URL(redirect);
    const state = url.searchParams.get('state');
    if (state !== null) target.searchParams.set('state', state);
    return Response.redirect(target.href, 302);
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const post = request.method === 'POST';
    switch (`${url.origin}${url.pathname}`) {
      case endpoint('/.well-known/openid-configuration'):
        return Response.json(discovery);
      case discovery.jwks_uri:
        return Response.json({ keys: [(await keys).publicJwk] });
      case discovery.authorization_endpoint:
        return authorize(url);
      case discovery.token_endpoint:
        return post ? token(request) : methodNotAllowed();
      case discovery.userinfo_endpoint:
        return userInfo(request);
      case discovery.revocation_endpoint:
        return post ? revoke(request) : methodNotAllowed();
      case discovery.end_session_endpoint:
        return endSession(url);
      case activeOrgEndpoint:
        return post ? setActiveOrganization(request) : methodNotAllowed();
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  return {
    fetch: async (input, init) => handle(new Request(input, init)),
    idToken: sign,
    accessToken,
    nextAuthorize: (outcome) => void authorizeOutcomes.push(outcome),
    nextToken: (outcome) => void tokenOutcomes.push(outcome),
    nextUserInfo: (outcome) => void userInfoOutcomes.push(outcome),
    nextActiveOrganization: (outcome) => void activeOrgOutcomes.push(outcome),
  };
}

function audience(resource: string[]): string | string[] {
  return resource.length === 1 ? resource[0] : resource;
}

function pick(claims: Claims, names: string[]): Claims {
  return Object.fromEntries(names.filter((n) => n in claims).map((n) => [n, claims[n]]));
}

function tokenResponse(body: Record<string, unknown>): Response {
  return Response.json(
    { token_type: 'Bearer', ...body },
    { headers: { 'cache-control': 'no-store' } },
  );
}

function statusOnly(status: number): Response {
  return new Response(`Status ${status}`, { status });
}

function invalidToken(): Response {
  return new Response(null, {
    status: 401,
    headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
  });
}

/**
 * An OAuth error from the token endpoint. `invalid_client` is a 401 with
 * `WWW-Authenticate`, as RFC 6749 §5.2 requires after `client_secret_basic`.
 */
function oauthError(error: string, status = 400): Response {
  if (error === 'invalid_client') {
    return Response.json(
      { error },
      {
        status: 401,
        headers: { 'cache-control': 'no-store', 'www-authenticate': 'Basic realm="token"' },
      },
    );
  }
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 });
}

/** The client id from `client_secret_basic`, or null without one. */
function basicClientId(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Basic (.+)$/i.exec(header);
  if (!match) return null;
  try {
    const decoded = atob(match[1]);
    const colon = decoded.indexOf(':');
    if (colon <= 0) return null;
    return decodeURIComponent(decoded.slice(0, colon));
  } catch {
    return null;
  }
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function generateKey() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const kid = randomToken(8);
  const { kty, crv, x, y } = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return {
    privateKey: pair.privateKey,
    kid,
    publicJwk: { kty, crv, x, y, kid, alg: 'ES256', use: 'sig' },
  };
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(byteLength = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}
