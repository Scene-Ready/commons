---
status: accepted
---

# Deliveries are signed with auth's webhook scheme

Every Attempt is signed the way auth signs its webhooks: `v1 = hex(HMAC-SHA256(key, "v1:" + timestamp + ":" + raw_body))`, where `key` is the **text** of `base64url(SHA-256(secret))`, not the secret itself. Apps already verify auth's webhooks this way, so there is one scheme to build, document and audit. The Hub stores only the derived key, never a Subscription's secret.

Hashing the secret before using it as the key looks like a mistake. It is deliberate: it is what lets auth and the Hub sign without keeping the secret. Changing the scheme breaks every Subscriber at once.

## Considered options

- **Standard Webhooks** (`webhook-id`, `webhook-timestamp`, `webhook-signature`, keyed by the raw secret). Rejected: it would be a second scheme beside auth's, and the signer would have to keep the raw secret.
- **The raw secret as the HMAC key.** Rejected for the same reason: the Hub would have to store the secret.

## Consequences

- Subscribers verify with `verifyDelivery` and must read the raw body before parsing it.
- The signature is versioned (`v1=`), so a future scheme can be sent beside it.
