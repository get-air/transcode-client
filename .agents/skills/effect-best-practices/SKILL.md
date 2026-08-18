---
name: effect-best-practices
description: Local projection of the Air Effect conventions for this package.
upstream-version: 1.0.0
---

- Use `Effect.fn("Qualified.name")` for Effect operations.
- Use `Schema.TaggedError` with a `message` field for typed failures.
- Preserve specific error tags with `catchTag`; do not collapse them with `catchAll`.
- Do not throw inside `Effect.gen`, run Effect inside services, or expose Effect values from the Promise API.
- Keep infrastructure injectable through `@get-air/http`.
- Run Effect language-service diagnostics in CI.
