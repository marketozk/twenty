# Incoming message envelope v1

`omni-incoming-envelope.ts` is the runtime schema. The adjacent versioned JSON
Schema is generated with `z.toJSONSchema(omniIncomingEnvelopeSchema)` and checked
against it by `omni-incoming-envelope.spec.ts`. Future connector implementations
must use this contract, not the historical illustrative JSON in design notes.

This first slice supports text `message.received`, `message.edited`, and
`message.deleted`. `command.receipt`, `connection.state`, attachments, history
pull and other variants are unsupported and rejected before acknowledgement.
There is no exposed transport endpoint or qualified real adapter yet. The
Telegram/MAX fixtures are synthetic contract examples, not production payloads.

All fields are required; unknown keys are rejected at every object level.
Provider IDs/event IDs stay opaque nonempty strings, up to 512 Unicode code
points, without control characters. `accountBindingId` is a UUID normalized to
lowercase by the service. `routeGeneration` is a canonical positive decimal
string within signed PostgreSQL bigint range, never a JSON number; it represents
immutable capture generation. The ordinary accept path requires the current
binding generation. Old captured events require the future authenticated
reconciliation path; a retry must not rewrite their generation or content.

`direction` is `incoming` or `outgoing`; `sourceVariant` is `complete` or
`placeholder`. Neither value assigns actor, trusted provenance or authority.
`nativeMessageKeyVersion` is 1. A future qualified projector constructs the
versioned canonical key from raw provider identity; this envelope does not prove
that placeholder and populated events refer to the same canonical Message.

`occurredAt` is an ISO datetime with offset, or null if unavailable. It remains
part of the semantic hash. `sourcePosition` is null or `{type,value}` with opaque
strings; a qualified adapter must define comparison before automatic effects.
`payload` contains only nullable `text`, `sourceAuthorId`, `sourceDisplayName`.
Text allows at most 65,536 Unicode code points and excludes NUL/lone surrogates.
Sender fields are untrusted display evidence, never CRM IDs or permissions.

The JSON Schema uses Unicode-aware regular expressions. Beyond schema checks,
the parser rejects a canonical UTF-8 envelope larger than 128 KiB. The future
HTTP adapter must limit raw body bytes before JSON parsing as well; the internal
service does not implement network limits, HMAC, credential storage or rate
limits. Signature/request timestamp belong in transport headers, outside this
semantic envelope. External origin/workspace/actor/grants are forbidden; import
will use a separate trusted service.

The whole validated, detached envelope is canonically serialized and hashed
before the first await. Key order does not matter; semantic fields do. A successful
receipt only transfers durable replay responsibility to the CRM. Message apply,
automation dispatch and sending are separate subsequent work.

## Trusted capture context

The separate internal `omni-incoming-capture-context.ts` schema snapshots capture
origin (`live`, `history_import`, `restore_replay`), qualification adapter ID and
version, canonical native key/version, completeness and opaque source position.
Its `envelopeHash` binds the entire normalized wire envelope. Shape validation
and hashes are not signatures or authority: the optional fifth ingress argument
requires its own current server authorizer under policy/binding locks, including
replay. The future transport must obtain this context from a qualified server
adapter/import boundary, never forward it from the public JSON body.

The receipt stores both context and its separate hash atomically with its audit.
The existing wire hash is unchanged. Replaying the same event with different
capture context, or switching between null and qualified context, conflicts.
The four-argument internal call remains unqualified (both columns NULL). No
backfill invents `live`, a key or an ordering guarantee for existing receipts.
A future apply must reject/quarantine unqualified context. This addition does
not activate connectors or implement the old-generation recovery path.
