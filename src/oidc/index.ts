/**
 * The OIDC relying party every Scene Ready app uses to sign users in with
 * auth. Network-facing methods return `{ ok: true, ... } | { ok: false, reason }`;
 * misconfiguration throws.
 *
 * Built on oauth4webapi (protocol) and jose (ID-token signature): oauth4webapi
 * checks the ID token's claims on a token-endpoint response but not its
 * signature, so `finishSignIn` verifies it with jose against the cached JWKS.
 */
import * as oauth from 'oauth4webapi';
import { createRemoteJWKSet, customFetch as joseFetch, errors, jwtVerify } from 'jose';
import { parseIdentity, type TokenSet } from './claims';

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
}

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

  /** Discovery and JWKS, cached for the isolate's lifetime once discovery succeeds. */
  let metadata: Promise<{
    as: oauth.AuthorizationServer;
    authorizationEndpoint: string;
    jwks: ReturnType<typeof createRemoteJWKSet>;
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

  return {
    async startSignIn({ returnTo, silent = false }) {
      checkReturnTo(returnTo);
      let authorizationEndpoint: string;
      try {
        ({ authorizationEndpoint } = await discover());
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      const pending: PendingSignIn = {
        state: oauth.generateRandomState(),
        nonce: oauth.generateRandomNonce(),
        verifier: oauth.generateRandomCodeVerifier(),
        returnTo,
        silent,
        createdAt: Date.now(),
      };
      const url = new URL(authorizationEndpoint);
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
      let found: Awaited<ReturnType<typeof discover>>;
      try {
        found = await discover();
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
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
      } catch {
        return { ok: false, reason: 'invalid' };
      }

      // oauth4webapi checked the claims but not the signature. jose checks both, and the
      // nonce is checked again below, so verification doesn't rest on one library.
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(body.id_token!, jwks, {
          issuer: as.issuer,
          audience: clientId,
          clockTolerance: CLOCK_TOLERANCE_S,
        }));
      } catch (error) {
        return { ok: false, reason: jwksUnreachable(error) ? 'unavailable' : 'invalid' };
      }
      if (payload.nonce !== pending.nonce) return { ok: false, reason: 'invalid' };

      const now = Date.now();
      let claims: TokenSet['claims'];
      try {
        claims = parseIdentity(payload);
      } catch {
        return { ok: false, reason: 'invalid' };
      }
      return {
        ok: true,
        returnTo: pending.returnTo,
        tokens: {
          accessToken: body.access_token,
          accessExpiresAt: now + (body.expires_in ?? 0) * 1000,
          refreshToken: body.refresh_token ?? null,
          idToken: body.id_token!,
          claims,
          claimsAt: now,
        },
      };
    },
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

function absoluteUrl(value: unknown, name: string): URL {
  const url = typeof value === 'string' ? parseUrl(value) : null;
  if (!url) throw new TypeError(`createOidcClient: ${name} must be an absolute URL`);
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
