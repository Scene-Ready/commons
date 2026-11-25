---
status: accepted
---

# Secrets rotate by signing with both keys

While a secret is being rotated, the signer puts two signatures on each Attempt, one with the new key and one with the old: `X-SR-Signature: t=<timestamp>,v1=<new>,v1=<old>`. `verifyDelivery` accepts the Attempt if **any** `v1` matches the Subscriber's secret. A Subscriber holds one secret and switches to the new one whenever it likes during the overlap. The signer drops the old signature when the overlap ends.

The old signature goes **last**. Releases before this one read the header with last-value-wins, so a Subscriber that hasn't upgraded commons yet keeps verifying with its old secret while a rotation is under way. A Subscriber has to upgrade commons before it switches to a new secret during an overlap.

## Considered options

- **The Subscriber verifies against a list of secrets** (`secret: string | string[]`), while the signer issues the new secret and keeps signing with the old one until an admin promotes it. Rejected: it takes three manual steps, and a promote nobody makes leaves the rotation half-done. If the signer instead switches straight away, every Subscriber that hasn't deployed the new secret rejects every Attempt.
- **A new signature version** (`v2=`) for the new key. Rejected: the scheme hasn't changed, only the key has.

## Consequences

- The header grammar allows a repeated `v1`. ADR-0004's `v1=` versioning still applies: any future scheme gets its own label.
- Auth's RP webhooks share the scheme, so they can rotate the same way.
