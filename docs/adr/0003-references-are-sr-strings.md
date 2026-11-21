---
status: accepted
---

# References are `sr:<app>:<type>:<id>` strings

A Reference to another App's Record is one string, `sr:<app>:<type>:<id>`, such as `sr:platform:location:loc_123`. It is not a URL, a URN or a `{ app, type, id }` object. Holders store References in their own databases and Events carry one as `subject`, so changing the format later means migrating every App.

A single string fits in one column and one envelope attribute, and it can be compared and indexed as-is. It names the Owner without naming a host, so an Owner can move its API without breaking stored References. The Owner documents how to resolve each Record type.

## Considered options

- **An HTTPS URL to the Owner's API.** Rejected: it ties every stored Reference to a hostname and an API version.
- **A URN (`urn:sr:…`).** Rejected: it adds a prefix and registration rules for no gain inside Scene Ready.
- **A structured `{ app, type, id }` object.** Rejected: it takes three columns per Reference and doesn't fit the CloudEvents `subject` string.

## Consequences

- No part may contain `:`. Ids are limited to URL-safe characters, at most 128 long.
- `refs` and `events` share one grammar: app keys use lowercase letters, digits and single hyphens, and Record types use snake_case.
