/**
 * The OIDC relying party every Scene Ready app uses to sign users in with
 * auth. Network-facing methods return `{ ok: true, ... } | { ok: false, reason }`;
 * misconfiguration throws.
 *
 * Built on oauth4webapi (protocol) and jose (ID-token signature): oauth4webapi
 * checks the ID token's claims on a token-endpoint response but not its
 * signature, so `finishSignIn` and `refresh` verify it with jose against the
 * cached JWKS.
 */
import * as oauth from 'oauth4webapi';
import { createRemoteJWKSet, customFetch as joseFetch, errors, jwtVerify } from 'jose';
import { parseIdentity, type Entitlements, type Identity, type TokenSet } from './claims';

export * from './claims';

export interface OidcClientConfig {
  /** Auth's issuer identifier, an https URL. */
  issuer: string;
  clientId: string;
  /** Sent with `client_secret_basic`, the only token-endpoint auth method. */
  clientSecret: string;
  /** The absolute callback URL registered for this client. */
  redirectUri: string;
  /** Required, with no default; `openid` is added when missing. */
  scopes: string[];
  /** The app's API origin(s), registered as `oauthResource`s in auth. */
  resources?: string[];
  /** For service bindings and the fake issuer. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** Plain JSON the app stores between `startSignIn` and `finishSignIn`. Times are epoch ms. */
export interface PendingSignIn {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  silent: boolean;
  createdAt: number;
}

export type StartSignInResult =
  { ok: true; url: string; pending: PendingSignIn } | { ok: false; reason: 'unavailable' };

export type FinishSignInResult =
  | { ok: true; tokens: TokenSet; returnTo: string }
  | { ok: false; reason: 'not_signed_in'; returnTo: string }
  | { ok: false; reason: 'invalid' | 'denied' | 'unavailable' };

export type RefreshResult =
  | { ok: true; tokens: TokenSet }
  | { ok: false; reason: 'not_signed_in' | 'invalid' | 'unavailable' }
  /** The new ID token's Active Org differs from the old; null when it has none. */
  | { ok: false; reason: 'org_changed'; activeOrgId: string | null };

export type UserInfoResult =
  | { ok: true; identity: Identity }
  | { ok: false; reason: 'not_signed_in' | 'invalid' | 'unavailable' };

export type SetActiveOrganizationResult =
  { ok: true } | { ok: false; reason: 'not_member' | 'not_signed_in' | 'unavailable' };

export type RevokeResult = { ok: true } | { ok: false; reason: 'unavailable' };

export type EndSessionUrlResult = { ok: true; url: string } | { ok: false; reason: 'unavailable' };

/** A verified access token: who it is for and what it allows. */
export interface VerifiedAccessToken {
  /** The user, or for an app-to-app token the calling client. */
  subject: string;
  /** The client the token was issued to. */
  clientId: string;
  scopes: string[];
  /** The user's entitlements in their Active Org; null for app-to-app tokens or without an Active Org. */
  entitlements: Entitlements | null;
}

export type VerifyAccessTokenResult =
  ({ ok: true } & VerifiedAccessToken) | { ok: false; reason: 'invalid' | 'unavailable' };

export type ClientCredentialsTokenResult =
  { ok: true; accessToken: string; expiresAt: number } | { ok: false; reason: 'unavailable' };

export interface OidcClient {
  /**
   * The authorize URL to send the browser to, and the pending sign-in to keep
   * until the callback. `returnTo` must be a same-origin path (`/...`) or this
   * throws. `silent` sends `prompt=none`.
   */
  startSignIn(options: { returnTo: string; silent?: boolean }): Promise<StartSignInResult>;
  /**
   * Completes a sign-in from the callback URL: checks state, exchanges the code
   * and verifies the ID token (signature, issuer, audience, expiry, nonce).
   */
  finishSignIn(callbackUrl: string | URL, pending: PendingSignIn): Promise<FinishSignInResult>;
  /**
   * A new `TokenSet` from the refresh token. It never moves a session to
   * another org: when the new ID token's Active Org differs from the old one it
   * answers `org_changed` and no tokens, and the app runs Org follow.
   */
  refresh(tokens: TokenSet): Promise<RefreshResult>;
  /** Whether the access token expires within `skewMs` of `now` (epoch ms). */
  isExpiring(tokens: Pick<TokenSet, 'accessExpiresAt'>, now: number, skewMs?: number): boolean;
  /**
   * The user's claims from userinfo: the Org-follow check (home ADR 0002). When
   * the org is unchanged, they replace `TokenSet.claims`; check first that
   * `identity.subject` is the session's user (OIDC Core 5.3.2).
   */
  userInfo(accessToken: string): Promise<UserInfoResult>;
  /**
   * Sets the user's Active Org in auth, user-wide (every app the user has open
   * follows). `not_member` is auth's 404. Throws when the token lacks the
   * `organizations` scope (auth's 403): the app asked for the wrong scopes.
   */
  setActiveOrganization(accessToken: string, orgId: string): Promise<SetActiveOrganizationResult>;
  /**
   * The URL of auth's end-session endpoint, to send the browser to after the
   * app's own sign-out. `unavailable` when discovery can't be fetched.
   */
  endSessionUrl(options: {
    idToken: string;
    postLogoutRedirectUri: string;
    /** Echoed back on the redirect, for the app's CSRF check. */
    state?: string;
  }): Promise<EndSessionUrlResult>;
  /** Revokes a refresh token. A failure must not block sign-out: this never throws. */
  revoke(refreshToken: string): Promise<RevokeResult>;
  /**
   * Checks a JWT access token sent to this app's API, locally against the
   * cached JWKS: signature, issuer, expiry, and an `aud` that includes one of
   * this client's `resources`. `unavailable` only when discovery or the JWKS
   * can't be fetched. Throws when the client has no `resources`.
   */
  verifyAccessToken(token: string): Promise<VerifyAccessTokenResult>;
  /**
   * An app-to-app access token for another app's API (`audience`, its
   * registered resource), from the client-credentials grant. Kept in memory per
   * audience and scopes until 60 s before it expires; concurrent callers share
   * one request. `unavailable` for a network error or a 5xx; any OAuth error
   * from auth (`invalid_client`, `invalid_scope`, ...) is misconfiguration and
   * throws.
   */
  clientCredentialsToken(options: {
    audience: string;
    scopes: string[];
  }): Promise<ClientCredentialsTokenResult>;
}

type JWKS = ReturnType<typeof createRemoteJWKSet>;

/** An app-to-app token is minted anew this long before it expires. */
const CLIENT_CREDENTIALS_SKEW_MS = 60_000;

/** A pending sign-in older than this is `invalid`. */
const PENDING_MAX_AGE_MS = 10 * 60_000;
/** Clock skew allowed when checking ID-token times, matching oauth4webapi's default. */
const CLOCK_TOLERANCE_S = 30;

/** Authorize errors a refused silent sign-in comes back with. */
const NOT_SIGNED_IN = new Set([
  'login_required',
  'interaction_required',
  'consent_required',
  'account_selection_required',
]);

export function createOidcClient(config: OidcClientConfig): OidcClient {
  const settings = checkConfig(config);
  const { issuer, clientId, redirectUri, resources, scope } = settings;
  const fetch = settings.fetch;
  const client: oauth.Client = { client_id: clientId };
  const clientAuth = oauth.ClientSecretBasic(settings.clientSecret);
  // auth's Organizations API sits on its origin, outside the issuer path, and
  // isn't in discovery (auth integration guide §11b).
  const activeOrgEndpoint = new URL('/api/oidc/organizations/active', issuer);

  /** App-to-app tokens by audience and scopes: the only state commons keeps. */
  const clientCredentials = new Map<
    string,
    Promise<{ accessToken: string; expiresAt: number } | null>
  >();

  /** Discovery and JWKS, cached for the isolate's lifetime once discovery succeeds. */
  let metadata: Promise<{
    as: oauth.AuthorizationServer;
    authorizationEndpoint: string;
    jwks: JWKS;
  }> | null = null;

  /** Throws on any failure; callers answer `unavailable`. */
  function discover() {
    metadata ??= (async () => {
      const response = await oauth.discoveryRequest(issuer, {
        algorithm: 'oidc',
        [oauth.customFetch]: fetch,
      });
      const as = await oauth.processDiscoveryResponse(issuer, response);
      if (!as.authorization_endpoint || !as.jwks_uri) {
        throw new TypeError('OIDC discovery has no authorization_endpoint or jwks_uri');
      }
      // Kept for the isolate's lifetime; jose still refetches for an unknown `kid`.
      const jwks = createRemoteJWKSet(new URL(as.jwks_uri), {
        cacheMaxAge: Infinity,
        [joseFetch]: fetch,
      });
      return { as, authorizationEndpoint: as.authorization_endpoint, jwks };
    })();
    // A failed discovery is retried on the next call, not cached.
    metadata.catch(() => (metadata = null));
    return metadata;
  }

  /**
   * A client-credentials token for `audience`, or null when auth can't be
   * reached. Throws on an OAuth error: with no user involved, it is misconfiguration.
   */
  async function mintClientCredentials(audience: string, scope: string) {
    const found = await discovered();
    if (!found) return null;
    const parameters = new URLSearchParams({ resource: audience });
    if (scope) parameters.set('scope', scope);
    let response: Response;
    try {
      response = await oauth.clientCredentialsGrantRequest(
        found.as,
        client,
        clientAuth,
        parameters,
        { [oauth.customFetch]: fetch },
      );
    } catch {
      return null;
    }
    if (response.status >= 500) return null;
    let body: oauth.TokenEndpointResponse;
    try {
      body = await oauth.processClientCredentialsResponse(found.as, client, response);
    } catch (error) {
      if (error instanceof oauth.ResponseBodyError) {
        throw new Error(
          `clientCredentialsToken: auth refused the request (${error.error}): check the client and its grants for ${audience}`,
          { cause: error },
        );
      }
      // A malformed answer: auth misbehaving.
      return null;
    }
    return {
      accessToken: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 0) * 1000,
    };
  }

  /** Discovery, or null when it can't be fetched: callers answer `unavailable`. */
  async function discovered() {
    try {
      return await discover();
    } catch {
      return null;
    }
  }

  return {
    async startSignIn({ returnTo, silent = false }) {
      checkReturnTo(returnTo);
      const found = await discovered();
      if (!found) return { ok: false, reason: 'unavailable' };
      const pending: PendingSignIn = {
        state: oauth.generateRandomState(),
        nonce: oauth.generateRandomNonce(),
        verifier: oauth.generateRandomCodeVerifier(),
        returnTo,
        silent,
        createdAt: Date.now(),
      };
      const url = new URL(found.authorizationEndpoint);
      const q = url.searchParams;
      q.set('response_type', 'code');
      q.set('client_id', clientId);
      q.set('redirect_uri', redirectUri);
      q.set('scope', scope);
      q.set('state', pending.state);
      q.set('nonce', pending.nonce);
      q.set('code_challenge', await oauth.calculatePKCECodeChallenge(pending.verifier));
      q.set('code_challenge_method', 'S256');
      for (const resource of resources) q.append('resource', resource);
      if (silent) q.set('prompt', 'none');
      return { ok: true, url: url.href, pending };
    },

    async finishSignIn(callbackUrl, pending) {
      const age = isPending(pending) ? Date.now() - pending.createdAt : NaN;
      // A tampered pending sign-in, one from the future or one too old.
      if (!(age >= 0 && age <= PENDING_MAX_AGE_MS)) {
        return { ok: false, reason: 'invalid' };
      }
      const found = await discovered();
      if (!found) return { ok: false, reason: 'unavailable' };
      const { as, jwks } = found;

      let params: URLSearchParams;
      try {
        params = oauth.validateAuthResponse(as, client, new URL(callbackUrl), pending.state);
      } catch (error) {
        if (error instanceof oauth.AuthorizationResponseError) {
          // Only a silent sign-in may come back refused; any other refusal is unexpected.
          if (NOT_SIGNED_IN.has(error.error) && pending.silent) {
            return { ok: false, reason: 'not_signed_in', returnTo: pending.returnTo };
          }
          if (error.error === 'access_denied') return { ok: false, reason: 'denied' };
          if (error.error === 'temporarily_unavailable' || error.error === 'server_error') {
            return { ok: false, reason: 'unavailable' };
          }
        }
        return { ok: false, reason: 'invalid' };
      }

      let response: Response;
      try {
        response = await oauth.authorizationCodeGrantRequest(
          as,
          client,
          clientAuth,
          params,
          redirectUri,
          pending.verifier,
          {
            additionalParameters: resources.map((r): [string, string] => ['resource', r]),
            [oauth.customFetch]: fetch,
          },
        );
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      if (response.status >= 500) return { ok: false, reason: 'unavailable' };

      let body: oauth.TokenEndpointResponse;
      try {
        body = await oauth.processAuthorizationCodeResponse(as, client, response, {
          expectedNonce: pending.nonce,
          requireIdToken: true,
        });
      } catch (error) {
        throwIfClientRefused(error);
        return { ok: false, reason: 'invalid' };
      }

      const verified = await verifyIdToken(body.id_token!, { as, jwks, clientId });
      if (!verified.ok) return verified;
      // oauth4webapi checked the nonce too; checked again so it doesn't rest on one library.
      if (verified.payload.nonce !== pending.nonce) return { ok: false, reason: 'invalid' };
      return {
        ok: true,
        returnTo: pending.returnTo,
        tokens: tokenSet(body, body.id_token!, verified.claims, null),
      };
    },

    async refresh(tokens) {
      if (!tokens.refreshToken) return { ok: false, reason: 'not_signed_in' };
      const found = await discovered();
      if (!found) return { ok: false, reason: 'unavailable' };
      const { as, jwks } = found;

      let response: Response;
      try {
        response = await oauth.refreshTokenGrantRequest(
          as,
          client,
          clientAuth,
          tokens.refreshToken,
          {
            additionalParameters: resources.map((r): [string, string] => ['resource', r]),
            [oauth.customFetch]: fetch,
          },
        );
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      if (response.status >= 500) return { ok: false, reason: 'unavailable' };

      let body: oauth.TokenEndpointResponse;
      try {
        body = await oauth.processRefreshTokenResponse(as, client, response);
      } catch (error) {
        throwIfClientRefused(error);
        const grantRefused =
          error instanceof oauth.ResponseBodyError && error.error === 'invalid_grant';
        return { ok: false, reason: grantRefused ? 'not_signed_in' : 'invalid' };
      }

      // Without a new ID token the claims stand; auth sends one on every refresh.
      if (!body.id_token) {
        return { ok: true, tokens: tokenSet(body, tokens.idToken, tokens.claims, tokens) };
      }
      const verified = await verifyIdToken(body.id_token, { as, jwks, clientId });
      if (!verified.ok) return verified;
      // OIDC Core 12.2: the new ID token is about the same user.
      if (verified.claims.subject !== tokens.claims.subject)
        return { ok: false, reason: 'invalid' };

      const before = tokens.claims.entitlements?.organizationId ?? null;
      const after = verified.claims.entitlements?.organizationId ?? null;
      if (after !== before) return { ok: false, reason: 'org_changed', activeOrgId: after };
      return { ok: true, tokens: tokenSet(body, body.id_token, verified.claims, tokens) };
    },

    isExpiring(tokens, now, skewMs = 60_000) {
      return tokens.accessExpiresAt - now <= skewMs;
    },

    async setActiveOrganization(accessToken, orgId) {
      let response: Response;
      try {
        response = await fetch(activeOrgEndpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ organizationId: orgId }),
        });
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      await response.body?.cancel();
      if (response.status === 404) return { ok: false, reason: 'not_member' };
      if (response.status === 403) {
        throw new Error('setActiveOrganization: the access token lacks the organizations scope');
      }
      const failed = failure(response);
      // Anything else auth doesn't send; treat it as auth misbehaving.
      if (failed)
        return { ok: false, reason: failed.reason === 'invalid' ? 'unavailable' : failed.reason };
      return { ok: true };
    },

    async endSessionUrl({ idToken, postLogoutRedirectUri, state }) {
      absoluteUrl(postLogoutRedirectUri, 'postLogoutRedirectUri', 'endSessionUrl');
      const found = await discovered();
      if (!found) return { ok: false, reason: 'unavailable' };
      if (!found.as.end_session_endpoint) {
        throw new TypeError('endSessionUrl: auth advertises no end_session_endpoint');
      }
      const url = new URL(found.as.end_session_endpoint);
      url.searchParams.set('id_token_hint', idToken);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
      if (state !== undefined) url.searchParams.set('state', state);
      return { ok: true, url: url.href };
    },

    async revoke(refreshToken) {
      const found = await discovered();
      if (!found) return { ok: false, reason: 'unavailable' };
      try {
        const response = await oauth.revocationRequest(found.as, client, clientAuth, refreshToken, {
          additionalParameters: { token_type_hint: 'refresh_token' },
          [oauth.customFetch]: fetch,
        });
        await oauth.processRevocationResponse(response);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },

    async verifyAccessToken(token) {
      if (resources.length === 0) {
        throw new TypeError('verifyAccessToken: the client has no resources to check aud against');
      }
      const found = await discovered();
      if (!found) return { ok: false, reason: 'unavailable' };
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(token, found.jwks, {
          issuer: found.as.issuer,
          // jose accepts the token when its `aud` includes any of these.
          audience: resources,
          clockTolerance: CLOCK_TOLERANCE_S,
          requiredClaims: ['exp', 'sub', 'client_id'],
        }));
      } catch (error) {
        return { ok: false, reason: jwksUnreachable(error) ? 'unavailable' : 'invalid' };
      }
      const { sub, client_id, scope } = payload;
      if (
        typeof sub !== 'string' ||
        sub === '' ||
        typeof client_id !== 'string' ||
        (scope !== undefined && typeof scope !== 'string')
      ) {
        return { ok: false, reason: 'invalid' };
      }
      return {
        ok: true,
        subject: sub,
        clientId: client_id,
        scopes: scope ? scope.split(' ').filter(Boolean) : [],
        entitlements: parseIdentity({
          sub,
          'urn:auth:entitlements': payload['urn:auth:entitlements'],
        }).entitlements,
      };
    },

    async clientCredentialsToken({ audience, scopes }) {
      absoluteUrl(audience, 'audience', 'clientCredentialsToken');
      if (
        !Array.isArray(scopes) ||
        !scopes.every((s) => typeof s === 'string' && /^\S+$/.test(s))
      ) {
        throw new TypeError('clientCredentialsToken: scopes must be an array of scope names');
      }
      const scope = [...new Set(scopes)].sort().join(' ');
      const key = `${audience} ${scope}`;
      let entry = clientCredentials.get(key);
      if (entry) {
        // A failed request is dropped once it settles, so an entry is either in
        // flight or a token: concurrent callers share the request and its outcome.
        const token = await entry;
        if (!token) return { ok: false, reason: 'unavailable' };
        if (token.expiresAt - Date.now() > CLIENT_CREDENTIALS_SKEW_MS)
          return { ok: true, ...token };
        if (clientCredentials.get(key) === entry) clientCredentials.delete(key);
      }
      entry = clientCredentials.get(key);
      if (!entry) {
        const minting = mintClientCredentials(audience, scope);
        clientCredentials.set(key, minting);
        // A failed request isn't kept: the next call tries again.
        const drop = () => {
          if (clientCredentials.get(key) === minting) clientCredentials.delete(key);
        };
        minting.then((token) => token ?? drop(), drop);
        entry = minting;
      }
      const token = await entry;
      return token ? { ok: true, ...token } : { ok: false, reason: 'unavailable' };
    },

    async userInfo(accessToken) {
      const found = await discovered();
      if (!found) return { ok: false, reason: 'unavailable' };
      let response: Response;
      try {
        response = await oauth.userInfoRequest(found.as, client, accessToken, {
          [oauth.customFetch]: fetch,
        });
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      const failed = failure(response);
      if (failed) return failed;
      try {
        return { ok: true, identity: parseIdentity(await response.json()) };
      } catch {
        return { ok: false, reason: 'invalid' };
      }
    },
  };
}

/** auth's `invalid_client` is misconfiguration (a wrong client id or secret), so it throws. */
function throwIfClientRefused(error: unknown): void {
  if (error instanceof oauth.ResponseBodyError && error.error === 'invalid_client') {
    throw new Error('auth refused the client: check the client id and client secret', {
      cause: error,
    });
  }
}

/**
 * What a non-2xx answer from a bearer-token endpoint means: a 401 is a session
 * that ended, a 5xx is auth being down. Null for a 2xx.
 */
function failure(
  response: Response,
): { ok: false; reason: 'not_signed_in' | 'invalid' | 'unavailable' } | null {
  if (response.ok) return null;
  if (response.status === 401) return { ok: false, reason: 'not_signed_in' };
  if (response.status >= 500) return { ok: false, reason: 'unavailable' };
  return { ok: false, reason: 'invalid' };
}

/**
 * Checks an ID token's signature (which oauth4webapi doesn't, on a token
 * response), issuer, audience and expiry, and reads its claims.
 */
async function verifyIdToken(
  idToken: string,
  { as, jwks, clientId }: { as: oauth.AuthorizationServer; jwks: JWKS; clientId: string },
): Promise<
  | { ok: true; payload: Record<string, unknown>; claims: Identity }
  | { ok: false; reason: 'invalid' | 'unavailable' }
> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, {
      issuer: as.issuer,
      audience: clientId,
      clockTolerance: CLOCK_TOLERANCE_S,
    }));
  } catch (error) {
    return { ok: false, reason: jwksUnreachable(error) ? 'unavailable' : 'invalid' };
  }
  try {
    return { ok: true, payload, claims: parseIdentity(payload) };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/**
 * The `TokenSet` a token response gives. A refresh response that leaves out
 * the refresh token keeps the old one.
 */
function tokenSet(
  body: oauth.TokenEndpointResponse,
  idToken: string,
  claims: Identity,
  previous: TokenSet | null,
): TokenSet {
  const now = Date.now();
  return {
    accessToken: body.access_token,
    accessExpiresAt: now + (body.expires_in ?? 0) * 1000,
    refreshToken: body.refresh_token ?? previous?.refreshToken ?? null,
    idToken,
    claims,
    claimsAt: previous && claims === previous.claims ? previous.claimsAt : now,
  };
}

/** Whether a jose failure was fetching the JWKS rather than verifying the token. */
function jwksUnreachable(error: unknown): boolean {
  if (error instanceof errors.JWKSTimeout) return true;
  // jose's own errors are verification failures, except its bare "Expected 200 OK" on the JWKS.
  if (error instanceof errors.JOSEError) return error.code === 'ERR_JOSE_GENERIC';
  // Anything else came from fetch: a network error.
  return true;
}

function checkConfig(config: OidcClientConfig) {
  const { issuer, clientId, clientSecret, redirectUri, scopes, resources = [] } = config;
  const issuerUrl = absoluteUrl(issuer, 'issuer');
  if (issuerUrl.protocol !== 'https:') {
    throw new TypeError('createOidcClient: issuer must be an https URL');
  }
  absoluteUrl(redirectUri, 'redirectUri');
  for (const [name, value] of [
    ['clientId', clientId],
    ['clientSecret', clientSecret],
  ] as const) {
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(`createOidcClient: ${name} is required`);
    }
  }
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string' && /^\S+$/.test(s))) {
    throw new TypeError('createOidcClient: scopes must be an array of scope names');
  }
  if (!Array.isArray(resources)) {
    throw new TypeError('createOidcClient: resources must be an array of URLs');
  }
  for (const resource of resources) absoluteUrl(resource, 'resources');
  const fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    issuer: issuerUrl,
    clientId,
    clientSecret,
    redirectUri,
    resources,
    scope: (scopes.includes('openid') ? scopes : ['openid', ...scopes]).join(' '),
    fetch,
  };
}

function absoluteUrl(value: unknown, name: string, method = 'createOidcClient'): URL {
  const url = typeof value === 'string' ? parseUrl(value) : null;
  if (!url) throw new TypeError(`${method}: ${name} must be an absolute URL`);
  return url;
}

function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/** Throws unless `returnTo` is a path on the app's own origin. */
function checkReturnTo(returnTo: unknown): asserts returnTo is string {
  if (!isSameOriginPath(returnTo)) {
    throw new TypeError('startSignIn: returnTo must be a same-origin path such as /rigs/7');
  }
}

function isSameOriginPath(value: unknown): value is string {
  const base = 'https://app.invalid';
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    // `//evil.example` and `/\evil.example` both leave the origin.
    parseUrl(value, base)?.origin === base
  );
}

function isPending(value: unknown): value is PendingSignIn {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.state === 'string' &&
    typeof p.nonce === 'string' &&
    typeof p.verifier === 'string' &&
    isSameOriginPath(p.returnTo) &&
    typeof p.silent === 'boolean' &&
    typeof p.createdAt === 'number'
  );
}
