import { readFile } from 'node:fs/promises';

const files = {
  auth: await readFile(new URL('../app/auth-shell.tsx', import.meta.url), 'utf8'),
  firebase: await readFile(new URL('../firebase.json', import.meta.url), 'utf8'),
  package: await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  firebaseEntry: await readFile(new URL('../firebase-hosting/index.html', import.meta.url), 'utf8'),
  githubEntry: await readFile(new URL('../github-pages/index.html', import.meta.url), 'utf8'),
  dashboard: await readFile(new URL('../app/study-dashboard.tsx', import.meta.url), 'utf8'),
  appConfig: await readFile(new URL('../app/app-config.ts', import.meta.url), 'utf8'),
  admin: await readFile(new URL('../app/admin-panel.tsx', import.meta.url), 'utf8'),
  styles: await readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
  firestoreRules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8'),
};

const checks = [
  ['Mobile Google login must use same-origin redirect with desktop popup fallback', files.auth.includes('shouldUseMobileRedirect()') && files.auth.includes('signInWithRedirect') && files.auth.includes('getRedirectResult') && files.auth.includes('signInWithPopup')],
  ['Every non-local app entry must converge on the Firebase auth origin', files.auth.includes("CANONICAL_APP_ORIGIN = 'https://chemlog-study-check-in.firebaseapp.com'") && files.firebaseEntry.includes("window.location.hostname === 'chemlog-study-check-in.web.app'")],
  ['Login must wait for a no-cache server app config', files.auth.includes('fetchLatestAppConfig()') && files.auth.includes('if (checking || !configReady)')],
  ['Cached configuration must never unlock the login screen', !files.auth.includes('localStorage') && !files.auth.includes('fromCache && !')],
  ['Firebase HTML must disable caching', files.firebase.includes('no-cache, no-store, must-revalidate') && files.firebaseEntry.includes('no-cache, no-store, must-revalidate')],
  ['Firebase HTML must preconnect the fresh config endpoint', files.firebaseEntry.includes('rel="preconnect" href="https://firestore.googleapis.com"')],
  ['Firebase deploy must rebuild through regression checks', files.firebase.includes('pnpm run build:firebase') && files.package.includes('pnpm run check:regressions && vite build')],
  ['GitHub entry must redirect directly to the canonical Firebase auth site', files.githubEntry.includes("window.location.replace('https://chemlog-study-check-in.firebaseapp.com/')")],
  ['GitHub entry must not load an app bundle', !files.githubEntry.includes('app-loader.js') && !files.githubEntry.includes('id="root"')],
  ['Countdown must stay removed from the dashboard', !files.dashboard.includes('倒數計時') && !files.dashboard.includes('timer-card')],
  ['Start-study photo draft must persist and remain deletable', files.dashboard.includes("'draftImages', 'studyStart'") && files.dashboard.includes('deleteSavedStartImage') && files.firestoreRules.includes('match /users/{userId}/draftImages/{draftId}')],
  ['Mobile leaderboard must keep a fixed header and independently scrollable list', files.dashboard.includes('leaderboard-modal-header') && files.dashboard.includes('leaderboard-scroll-region') && files.styles.includes('.leaderboard-backdrop') && files.styles.includes('height: 100dvh')],
  ['The administrator must stay out of rankings and the weekly champion', files.dashboard.includes('rankableEntries') && files.dashboard.includes('!entry.isAdmin') && files.dashboard.includes('isAdmin,') && files.firestoreRules.includes("'isAdmin'" )],
  ['Reward choices must come from administrator-editable server configuration', files.appConfig.includes('defaultRewardOptions') && files.appConfig.includes('decodeFirestoreValue') && files.admin.includes('admin-reward-editor') && files.dashboard.includes('const rewardOptions = appConfig.rewards') && files.firestoreRules.includes('validRewardItem')],
  ['Avatar selection must open an adjustable crop step before saving', files.dashboard.includes('setAvatarCropSource(source)') && files.dashboard.includes('renderCroppedAvatar') && files.dashboard.includes('avatar-crop-window') && files.styles.includes('.avatar-crop-backdrop')],
  ['Mobile rewards must keep a fixed close button and independently scrollable content', files.dashboard.includes('rewards-modal-header') && files.dashboard.includes('rewards-scroll-region') && files.styles.includes('.rewards-backdrop') && files.styles.includes('.rewards-modal-header .modal-close')],
  ['Administrator must be able to remove reward options without deleted defaults returning', files.admin.includes('deleteReward') && files.admin.includes('admin-delete-reward') && files.appConfig.includes('if (!item) return []') && files.firestoreRules.includes('rewards.size() <= 4')],
  ['Every new check-in must include both start and end photos in UI and Firestore rules', files.dashboard.includes('請先上載學習開始及學習結束相片') && files.dashboard.includes('hasStartImage: true') && files.dashboard.includes('hasEndImage: true') && files.firestoreRules.includes('request.resource.data.hasStartImage == true') && files.firestoreRules.includes("sessionId + '-start'") && files.firestoreRules.includes("sessionId + '-end'")],
  ['Reward requests must wait for administrator approval before sticker deduction', files.dashboard.includes("status: 'pending', deducted: false") && !files.dashboard.includes('removedStickerCount: removedStickerCount + reward.stickerCost') && files.admin.includes('resolveRedemption') && files.admin.includes('批准並扣除') && files.firestoreRules.includes('request.resource.data.deducted == false') && files.firestoreRules.includes("affectedKeys().hasAny(['removedStickerCount', 'stickerBonusCount'])")],
  ['Students must be able to cancel only their own undeducted pending reward requests', files.dashboard.includes('cancelRedemption') && files.dashboard.includes("status: 'cancelled'") && files.dashboard.includes('取消申請') && files.firestoreRules.includes("resource.data.status == 'pending'") && files.firestoreRules.includes("request.resource.data.status == 'cancelled'") && files.firestoreRules.includes("affectedKeys().hasOnly(['status', 'cancelledAt'])")],
  ['Photo library and camera avatar choices must share the adjustable crop flow', files.dashboard.includes('avatarLibraryInputRef') && files.dashboard.includes('avatarCameraInputRef') && files.dashboard.includes('capture="user"') && files.dashboard.includes('setAvatarCropSource(source)') && files.dashboard.includes('從相片庫選擇') && files.dashboard.includes('即時拍攝照片') && !files.dashboard.includes('正在整理你的資料，請稍後再選擇頭像')],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);
if (failures.length) {
  console.error(`Regression checks failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(`Regression checks passed (${checks.length}).`);
