# CHEMLOG release safeguards

These product invariants must survive every future change:

- Never render the login form from cached or bundled app configuration before the first server configuration request completes. A neutral loading state is required.
- Google authentication must remain popup-only. Do not add `signInWithRedirect` or `getRedirectResult`; redirect authentication fails in storage-partitioned mobile browsers.
- Keep `https://chemlog-study-check-in.web.app/` as the canonical runtime. The GitHub Pages homepage is a redirect-only entry and must not load the application bundle itself.
- Keep no-cache headers on the Firebase HTML shell and stable loader assets.
- Run `pnpm run check:regressions`, `pnpm run lint`, the normal Site build, and `pnpm run build:firebase` before every deployment. Firebase Hosting predeploy also enforces the Firebase build automatically.
- Publish the same validated source to Firebase Hosting, GitHub, GitHub Pages, and Sites. Do not restore an older deployment artifact.

If a requested feature conflicts with one of these safeguards, preserve the safeguard and adapt the feature around it.
