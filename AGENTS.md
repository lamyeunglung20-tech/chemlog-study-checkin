# CHEMLOG release safeguards

These product invariants must survive every future change:

- Never render the login form from cached or bundled app configuration before the first server configuration request completes. A neutral loading state is required.
- Keep the no-cache REST app-config bootstrap and Firestore preconnect so the latest login screen arrives before the heavier realtime connection is ready.
- Google authentication must keep the same-origin design: every public entry converges on `https://chemlog-study-check-in.firebaseapp.com/`, which matches Firebase `authDomain`. Mobile uses redirect and desktop uses popup; never run either flow from GitHub Pages, `web.app`, or Sites.
- Keep `https://chemlog-study-check-in.firebaseapp.com/` as the canonical runtime. The GitHub Pages homepage is a redirect-only entry and must not load the application bundle itself. The `web.app` alias and Sites copy must also redirect before exposing authentication.
- Keep no-cache headers on the Firebase HTML shell and stable loader assets.
- Run `pnpm run check:regressions`, `pnpm run lint`, the normal Site build, and `pnpm run build:firebase` before every deployment. Firebase Hosting predeploy also enforces the Firebase build automatically.
- Publish the same validated source to Firebase Hosting, GitHub, GitHub Pages, and Sites. Do not restore an older deployment artifact.
- Keep the countdown feature removed. The dashboard records manually entered study duration only.
- Keep the start-study photo as an account-scoped Firestore draft that auto-saves immediately, survives logout/login, can be deleted by the student, and is cleared only after a successful check-in that copies it into the saved record.
- On mobile, keep the leaderboard as a full-viewport modal with its header, tabs, and close button always visible. Only the leaderboard list may scroll, with momentum touch scrolling and no horizontal overflow.
- Keep the total administrator account out of every public ranking period and the weekly champion spotlight. The leaderboard document must retain its `isAdmin` marker.
- Reward names, icons, and sticker costs come from the server app configuration and remain editable only in the total administrator panel.
- Selecting an avatar must always open the crop-and-position step before the cropped square image is saved.
- On mobile, keep both the reward exchange and avatar crop dialogs full viewport. Their close controls must remain reachable, scrolling must stay vertical and smooth, and the reward dialog must scroll only its content region below the fixed header.

If a requested feature conflicts with one of these safeguards, preserve the safeguard and adapt the feature around it.
