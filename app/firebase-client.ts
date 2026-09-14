'use client';

import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyDreQjvNuGgCJ_XfRM2UOTiADmbLD8SANI',
  authDomain: 'chemlog-study-check-in.firebaseapp.com',
  projectId: 'chemlog-study-check-in',
  storageBucket: 'chemlog-study-check-in.firebasestorage.app',
  messagingSenderId: '478513966119',
  appId: '1:478513966119:web:63ac27e8986ed35823f202',
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const firebaseAuth = getAuth(app);
export const firebaseDb = getFirestore(app, 'chemlog');
firebaseAuth.languageCode = 'zh-TW';

export const verificationActionSettings = {
  url: 'https://chemlog-study-check-in.firebaseapp.com/',
  handleCodeInApp: false,
};
