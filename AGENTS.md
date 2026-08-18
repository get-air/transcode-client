# `@get-air/transcode` repository guidance

- This repository publishes the npm package `@get-air/transcode`.
- Keep the root Promise API free of Effect boundary values.
- Keep `/effect` Effect-native; both entrypoints share `src/Client.ts`.
- Use `Effect.fn` for Effect operations and `Schema.TaggedError` for failures.
- Use `@get-air/http` for Request-based transport injection.
- Source URLs and headers may contain credentials. Never persist or log them.
- Validate with `npm run ci`; CI must install from the frozen lockfile.
- Publishing uses GitHub trusted publishing with provenance and no long-lived token.
