import { describe, expect, it } from 'vitest';
import { parseIdentity } from '../src/oidc/claims';

describe('parseIdentity', () => {
  it('reads the standard claims under their wire names', () => {
    const identity = parseIdentity({
      sub: 'usr_1',
      email: 'a@example.org',
      name: 'Ada Lovelace',
      picture: 'https://img.example.org/a.png',
      is_platform_admin: true,
    });
    expect(identity).toMatchObject({
      subject: 'usr_1',
      email: 'a@example.org',
      name: 'Ada Lovelace',
      picture: 'https://img.example.org/a.png',
      isPlatformAdmin: true,
    });
  });

  it('leaves profile and email claims null when the scope was not granted', () => {
    expect(parseIdentity({ sub: 'usr_1' })).toMatchObject({
      email: null,
      name: null,
      picture: null,
    });
  });

  it.each([undefined, false, 'true', 1])(
    'is not a platform admin when the claim is %s',
    (claim) => {
      expect(parseIdentity({ sub: 'usr_1', is_platform_admin: claim }).isPlatformAdmin).toBe(false);
    },
  );

  it.each([{}, { sub: '' }, { sub: 42 }])('refuses a payload without a subject: %j', (payload) => {
    expect(() => parseIdentity(payload)).toThrow(TypeError);
  });

  describe('organizations', () => {
    const team = {
      id: 'org_1',
      name: 'Station 7',
      slug: 'station-7',
      logo: null,
      type: 'shared',
      role: 'admin',
      isActive: true,
    };

    it('reads urn:auth:organizations', () => {
      const personal = {
        ...team,
        id: 'org_2',
        logo: 'https://img/x.png',
        type: 'personal',
        isActive: false,
      };
      const identity = parseIdentity({ sub: 'usr_1', 'urn:auth:organizations': [team, personal] });
      expect(identity.organizations).toEqual([team, personal]);
    });

    it('is empty without the claim', () => {
      expect(parseIdentity({ sub: 'usr_1' }).organizations).toEqual([]);
      expect(
        parseIdentity({ sub: 'usr_1', 'urn:auth:organizations': 'nope' }).organizations,
      ).toEqual([]);
    });

    it('drops a malformed entry and keeps the rest', () => {
      const identity = parseIdentity({
        sub: 'usr_1',
        'urn:auth:organizations': [
          null,
          'org_9',
          { ...team, id: 'org_3', type: 'club' },
          { ...team, id: 'org_4', isActive: 'yes' },
          { ...team, id: 'org_5', logo: undefined },
          { ...team, id: undefined },
          team,
        ],
      });
      expect(identity.organizations).toEqual([team]);
    });

    it('ignores unknown fields', () => {
      const identity = parseIdentity({
        sub: 'usr_1',
        'urn:auth:organizations': [{ ...team, colour: 'red' }],
      });
      expect(identity.organizations).toEqual([team]);
    });
  });

  describe('entitlements', () => {
    const rig = {
      tier: 'pro',
      capabilities: ['rig.edit', 'rig.share'],
      limits: { rigs: 50, seats: null },
    };
    const claim = {
      organizationId: 'org_1',
      role: 'member',
      products: { rig: rig },
      unseatedProducts: ['quarters'],
    };
    const parse = (entitlements: unknown) =>
      parseIdentity({ sub: 'usr_1', 'urn:auth:entitlements': entitlements }).entitlements;

    it('reads urn:auth:entitlements', () => {
      expect(parse(claim)).toEqual(claim);
    });

    it('keeps a null role', () => {
      expect(parse({ ...claim, role: null })?.role).toBeNull();
    });

    it('is null when the claim is absent', () => {
      expect(parseIdentity({ sub: 'usr_1' }).entitlements).toBeNull();
    });

    it.each([
      ['not an object', 'org_1'],
      ['no organizationId', { ...claim, organizationId: undefined }],
      ['a role that is not a string', { ...claim, role: 3 }],
    ])('is null for an entitlements claim with %s', (_, entitlements) => {
      expect(parse(entitlements)).toBeNull();
    });

    it('drops a malformed product and keeps the rest', () => {
      const entitlements = parse({
        ...claim,
        products: {
          rig,
          noTier: { ...rig, tier: undefined },
          badCapability: { ...rig, capabilities: ['ok', 7] },
          capabilitiesNotList: { ...rig, capabilities: 'rig.edit' },
          badLimit: { ...rig, limits: { rigs: '50' } },
          limitsNotObject: { ...rig, limits: [] },
          notObject: 'pro',
        },
      });
      expect(entitlements?.products).toEqual({ rig });
    });

    it('drops an unseated product that is not a slug', () => {
      expect(
        parse({ ...claim, unseatedProducts: ['quarters', 4, null] })?.unseatedProducts,
      ).toEqual(['quarters']);
    });

    it('ignores unknown fields', () => {
      const entitlements = parse({
        ...claim,
        plan: 'legacy',
        products: { rig: { ...rig, trialEndsAt: 1 } },
      });
      expect(entitlements).toEqual(claim);
    });
  });
});
