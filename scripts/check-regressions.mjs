import { readFile } from 'node:fs/promises';

const files = {
  auth: await readFile(new URL('../app/auth-shell.tsx', import.meta.url), 'utf8'),
  firebase: await readFile(new URL('../firebase.json', import.meta.url), 'utf8'),
  firebaseEntry: await readFile(new URL('../firebase-hosting/index.html', import.meta.url), 'utf8'),
  githubEntry: await readFile(new URL('../github-pages/index.html', import.meta.url), 'utf8'),
};

const checks = [
  ['Google login must stay popup-only', files.auth.includes('signInWithPopup') && !files.auth.includes('signInWithRedirect') && !files.auth.includes('getRedirectResult')],
  ['Login must wait for server app config', files.auth.includes('getDocFromServer(configDocument)') && files.auth.includes('if (checking || !configReady)')],
  ['Cached configuration must never unlock the login screen', !files.auth.includes('localStorage') && !files.auth.includes('fromCache && !')],
  ['Firebase HTML must disable caching', files.firebase.includes('no-cache, no-store, must-revalidate') && files.firebaseEntry.includes('no-cache, no-store, must-revalidate')],
  ['GitHub entry must redirect directly to the canonical Firebase site', files.githubEntry.includes("window.location.replace('https://chemlog-study-check-in.web.app/')")],
  ['GitHub entry must not load an app bundle', !files.githubEntry.includes('app-loader.js') && !files.githubEntry.includes('id="root"')],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);
if (failures.length) {
  console.error(`Regression checks failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(`Regression checks passed (${checks.length}).`);
