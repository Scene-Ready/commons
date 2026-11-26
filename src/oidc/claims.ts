/**
 * The claims auth puts in ID tokens and userinfo, typed once for the issuer
 * and every app. Field names inside `urn:auth:organizations` and
 * `urn:auth:entitlements` are auth's wire names unchanged.
 *
 * No dependencies: runs in Workers, browsers and offline.
 */

/** What a sign-in or refresh leaves the app holding. Times are epoch ms. */
export interface TokenSet {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string | null;
  /** Kept for `id_token_hint` at sign-out. */
  idToken: string;
  claims: Identity;
  /** When `claims` were last read, from the ID token or userinfo. */
  claimsAt: number;
}

/** The signed-in user, from an ID token or userinfo. */
export interface Identity {
  subject: string;
  /** Null without the `email` scope. */
  email: string | null;
  /** Null without the `profile` scope. */
  name: string | null;
  /** Null without the `profile` scope or when the user has no picture. */
  picture: string | null;
  isPlatformAdmin: boolean;
  /** From `urn:auth:organizations`; `[]` without the `organizations` scope. */
  organizations: Organization[];
  /** From `urn:auth:entitlements`; null when there is no valid Active Org. */
  entitlements: Entitlements | null;
}

/** An organization the user is a member of. */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  type: 'personal' | 'shared';
  /** The user's member role in this organization. */
  role: string;
  /** True for the user's Active Org. */
  isActive: boolean;
}

/** What the user may use in their Active Org. */
export interface Entitlements {
  organizationId: string;
  /** The user's member role in the Active Org. */
  role: string | null;
  /** The Products the user may use, by Product slug. */
  products: Record<string, ProductEntitlement>;
  /** Slugs of seated Products the org has but the user holds no Seat for. */
  unseatedProducts: string[];
}

/** One Product's Tier, as the user gets it. */
export interface ProductEntitlement {
  tier: string;
  capabilities: string[];
  /** Each Limit by name; null means unlimited. */
  limits: Record<string, number | null>;
}

/**
 * Reads an ID token payload or a userinfo response. Throws a TypeError when
 * there is no `sub`. A malformed organization or product is dropped and the
 * rest kept; unknown fields are ignored.
 */
export function parseIdentity(payload: Record<string, unknown>): Identity {
  const subject = payload.sub;
  if (typeof subject !== 'string' || subject === '') {
    throw new TypeError('Not an identity: the payload has no sub claim');
  }
  return {
    subject,
    email: stringOrNull(payload.email),
    name: stringOrNull(payload.name),
    picture: stringOrNull(payload.picture),
    isPlatformAdmin: payload.is_platform_admin === true,
    organizations: parseOrganizations(payload['urn:auth:organizations']),
    entitlements: parseEntitlements(payload['urn:auth:entitlements']),
  };
}

function parseEntitlements(claim: unknown): Entitlements | null {
  if (!isRecord(claim)) return null;
  const { organizationId, role, products, unseatedProducts } = claim;
  if (typeof organizationId !== 'string' || (role !== null && typeof role !== 'string')) {
    return null;
  }
  return {
    organizationId,
    role,
    products: parseProducts(products),
    unseatedProducts: Array.isArray(unseatedProducts)
      ? unseatedProducts.filter((slug) => typeof slug === 'string')
      : [],
  };
}

function parseProducts(claim: unknown): Record<string, ProductEntitlement> {
  if (!isRecord(claim)) return {};
  // fromEntries defines own properties, so a `__proto__` slug can't set the prototype.
  return Object.fromEntries(
    Object.entries(claim).flatMap(([slug, entry]) => {
      const product = parseProduct(entry);
      return product ? [[slug, product]] : [];
    }),
  );
}

function parseProduct(entry: unknown): ProductEntitlement | null {
  if (!isRecord(entry)) return null;
  const { tier, capabilities, limits } = entry;
  if (
    typeof tier !== 'string' ||
    !Array.isArray(capabilities) ||
    !capabilities.every((c) => typeof c === 'string') ||
    !isRecord(limits) ||
    !Object.values(limits).every((v) => v === null || typeof v === 'number')
  ) {
    return null;
  }
  return { tier, capabilities, limits: limits as Record<string, number | null> };
}

function parseOrganizations(claim: unknown): Organization[] {
  if (!Array.isArray(claim)) return [];
  return claim.flatMap((entry) => {
    const org = parseOrganization(entry);
    return org ? [org] : [];
  });
}

function parseOrganization(entry: unknown): Organization | null {
  if (!isRecord(entry)) return null;
  const { id, name, slug, logo, type, role, isActive } = entry;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof slug !== 'string' ||
    (logo !== null && typeof logo !== 'string') ||
    (type !== 'personal' && type !== 'shared') ||
    typeof role !== 'string' ||
    typeof isActive !== 'boolean'
  ) {
    return null;
  }
  return { id, name, slug, logo, type, role, isActive };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
