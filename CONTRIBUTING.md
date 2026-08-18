# Contributing

Requirements: Node.js 20 or newer and npm.

```bash
npm ci
npm run ci
```

The package root is the Promise API. `/effect` is the Effect-native API; both
must delegate to the implementation in `src/Client.ts`.

Use `@get-air/http` for all requests. Never add a package-specific transport,
persist source credentials, or log signed media URLs.

Releases are created only from a published GitHub Release after CI passes.
Do not publish locally or add an npm token to repository configuration.
