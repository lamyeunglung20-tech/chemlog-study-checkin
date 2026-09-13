'use client';
/* eslint-disable @next/next/no-img-element -- The administrator-configured app icon is stored as a small data URL. */

import { type CSSProperties, FormEvent, useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { defaultAppConfig, readAppConfig } from './app-config';
import { firebaseAuth, firebaseDb, verificationActionSettings } from './firebase-client';
import StudyDashboard from './study-dashboard';

type Mode = 'login' | 'register';

function authMessage(code?: string) {
  const messages: Record<string, string> = {
    'auth/email-already-in-use': '這個電郵地址已經註冊，請直接登入。',
    'auth/invalid-credential': '電郵地址或密碼不正確。',
    'auth/invalid-email': '請輸入有效的電郵地址。',
    'auth/too-many-requests': '嘗試次數太多，請稍後再試。',
    'auth/weak-password': '密碼強度不足，請至少使用 8 個字元。',
    'auth/user-disabled': '這個帳戶已被停用，請聯絡老師。',
    'auth/account-exists-with-different-credential': '這個電郵已使用密碼註冊，請先使用電郵及密碼登入。',
    'auth/operation-not-allowed': 'Google 登入尚未啟用，請聯絡老師。',
    'auth/unauthorized-domain': '目前網址尚未獲授權使用 Google 登入。',
    'auth/popup-blocked': '瀏覽器阻擋了 Google 登入視窗，正為你轉用整頁登入。',
    'auth/popup-closed-by-user': 'Google 登入視窗已關閉，請再試一次。',
    'auth/operation-not-supported-in-this-environment': '這個內置瀏覽器不支援 Google 登入，請用 Safari 或 Chrome 開啟網站再試。',
    'auth/web-storage-unsupported': '這個瀏覽器禁止了登入所需的儲存功能，請用 Safari 或 Chrome 開啟網站再試。',
  };
  return messages[code ?? ''] ?? '未能完成操作，請稍後再試。';
}

export default function AuthShell() {
  const [user, setUser] = useState<User | null>(null);
  const [studentName, setStudentName] = useState('');
  const [pendingVerification, setPendingVerification] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<Mode>('login');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [appConfig, setAppConfig] = useState(defaultAppConfig);

  useEffect(() => onSnapshot(doc(firebaseDb, 'appConfig', 'public'), (snapshot) => {
    setAppConfig(readAppConfig(snapshot.data()));
  }, () => setAppConfig(defaultAppConfig)), []);

  useEffect(() => {
    void getRedirectResult(firebaseAuth).catch((caught) => {
      setError(authMessage((caught as { code?: string }).code));
      setSubmitting(false);
    });

    return onAuthStateChanged(firebaseAuth, (currentUser) => {
      if (currentUser?.emailVerified) {
        setUser(currentUser);
        setStudentName(currentUser.displayName || '同學');
        setPendingVerification(null);
      } else {
        setUser(null);
        setPendingVerification(currentUser);
      }
      setChecking(false);
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setMessage('');
    try {
      if (mode === 'register') {
        const credential = await createUserWithEmailAndPassword(firebaseAuth, email.trim(), password);
        await updateProfile(credential.user, { displayName: displayName.trim() });
        await sendEmailVerification(credential.user, verificationActionSettings);
        setPendingVerification(credential.user);
        setMessage('驗證電郵已寄出，請檢查收件箱。');
      } else {
        const credential = await signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
        if (!credential.user.emailVerified) {
          setPendingVerification(credential.user);
          setMessage('你的電郵尚未驗證。完成驗證後便可登入。');
        } else {
          setUser(credential.user);
        }
      }
      setPassword('');
    } catch (caught) {
      setError(authMessage((caught as { code?: string }).code));
    } finally {
      setSubmitting(false);
    }
  }

  async function logout() {
    await signOut(firebaseAuth);
    setUser(null);
    setPendingVerification(null);
    setMode('login');
  }

  async function changeDisplayName(nextName: string) {
    if (!user) throw new Error('NOT_AUTHENTICATED');
    const cleanedName = nextName.trim().slice(0, 40);
    if (!cleanedName) throw new Error('NAME_REQUIRED');
    await updateProfile(user, { displayName: cleanedName });
    setStudentName(cleanedName);
  }

  async function signInWithGoogle() {
    setSubmitting(true);
    setError('');
    setMessage('');
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const credential = await signInWithPopup(firebaseAuth, provider);
      setPendingVerification(null);
      setUser(credential.user);
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      const shouldUseRedirect = [
        'auth/popup-blocked',
        'auth/cancelled-popup-request',
        'auth/operation-not-supported-in-this-environment',
      ].includes(code ?? '');

      if (shouldUseRedirect) {
        try {
          const provider = new GoogleAuthProvider();
          provider.setCustomParameters({ prompt: 'select_account' });
          setMessage('正在為你開啟 Google 安全登入頁面…');
          await signInWithRedirect(firebaseAuth, provider);
          return;
        } catch (redirectError) {
          setError(authMessage((redirectError as { code?: string }).code));
        }
      } else {
        setError(authMessage(code));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function checkVerification() {
    if (!pendingVerification) return;
    setSubmitting(true);
    setError('');
    try {
      await reload(pendingVerification);
      if (!pendingVerification.emailVerified) {
        setError('仍未完成驗證。請按電郵內的連結後再試。');
        return;
      }
      await pendingVerification.getIdToken(true);
      setUser(pendingVerification);
      setPendingVerification(null);
    } catch (caught) {
      setError(authMessage((caught as { code?: string }).code));
    } finally {
      setSubmitting(false);
    }
  }

  async function resendVerification() {
    if (!pendingVerification) return;
    setSubmitting(true);
    setError('');
    try {
      await sendEmailVerification(pendingVerification, verificationActionSettings);
      setMessage('新的驗證電郵已寄出，請同時檢查垃圾郵件匣。');
    } catch (caught) {
      setError(authMessage((caught as { code?: string }).code));
    } finally {
      setSubmitting(false);
    }
  }

  async function resetPassword() {
    if (!email.trim()) {
      setError('請先輸入你的電郵地址。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await sendPasswordResetEmail(firebaseAuth, email.trim(), verificationActionSettings);
      setMessage('如帳戶存在，密碼重設電郵已寄出。');
    } catch (caught) {
      setError(authMessage((caught as { code?: string }).code));
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return <main className="signin-shell" style={{ '--app-bg': appConfig.backgroundColor } as CSSProperties}><div className="auth-loading"><span className="auth-logo" aria-hidden="true">{appConfig.iconData ? <img src={appConfig.iconData} alt="" /> : '⚗'}</span><p>正在準備你的研習誌…</p></div></main>;
  }

  if (user) return <StudyDashboard appConfig={appConfig} isAdmin={user.email?.toLowerCase() === 'lamyeunglung20@gmail.com'} studentName={studentName || '同學'} userId={user.uid} onChangeName={changeDisplayName} onLogout={logout} />;

  if (pendingVerification) {
    return (
      <main className="signin-shell" style={{ '--app-bg': appConfig.backgroundColor } as CSSProperties}>
        <section className="signin-card verification-card">
          <div className="auth-logo mail-logo" aria-hidden="true">✉</div>
          <p className="auth-kicker">只差最後一步</p>
          <h1>請驗證你的電郵</h1>
          <p className="signin-copy">我們已把驗證連結寄到 <strong>{pendingVerification.email}</strong>。請按下電郵內的連結，驗證後才可登入 {appConfig.appName}。</p>
          {message && <p className="auth-success" role="status">{message}</p>}
          {error && <p className="auth-error standalone" role="alert">{error}</p>}
          <button className="auth-submit verify-submit" disabled={submitting} onClick={checkVerification} type="button">{submitting ? '正在檢查…' : '我已完成驗證'}<span>→</span></button>
          <div className="verification-actions">
            <button disabled={submitting} onClick={resendVerification} type="button">重新寄出驗證電郵</button>
            <button disabled={submitting} onClick={logout} type="button">使用其他帳戶</button>
          </div>
          <small className="verification-credit">Designed by LYL</small>
        </section>
      </main>
    );
  }

  return (
    <main className="signin-shell" style={{ '--app-bg': appConfig.backgroundColor } as CSSProperties}>
      <div className="auth-orb auth-orb-one" aria-hidden="true" />
      <div className="auth-orb auth-orb-two" aria-hidden="true" />
      <section className="signin-card auth-card">
        <span className="auth-designer">Designed by LYL</span>
        <header className="auth-brand">
          <div className="auth-logo" aria-hidden="true">{appConfig.iconData ? <img src={appConfig.iconData} alt="" /> : '⚗'}</div>
          <p className="auth-product">{appConfig.appName}</p>
          {appConfig.subtitle && <p className="auth-tagline">{appConfig.subtitle}</p>}
        </header>
        <div className="auth-form-panel">
          <form className="auth-form" onSubmit={submit}>
            <div className="auth-heading">
              <h1>{mode === 'login' ? appConfig.loginHeading : '建立你的研習誌'}</h1>
              <p>{mode === 'login' ? appConfig.loginCopy : '完成註冊及電郵驗證後便可開始打卡。'}</p>
            </div>
            {mode === 'register' && <label className="auth-field"><span>學生姓名</span><div className="input-shell"><span className="field-icon" aria-hidden="true">●</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" minLength={2} maxLength={40} placeholder="例：陳大文" required /></div></label>}
            <label className="auth-field"><span>電郵地址</span><div className="input-shell"><span className="field-icon at-icon" aria-hidden="true">@</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" inputMode="email" placeholder="student@example.com" required /></div></label>
            <label className="auth-field">
              <span className="password-label"><span>密碼</span>{mode === 'login' && <button className="forgot-inline" disabled={submitting} onClick={resetPassword} type="button">忘記密碼？</button>}</span>
              <div className="input-shell"><span className="field-icon" aria-hidden="true">◆</span><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} maxLength={128} placeholder="至少 8 個字元" required /><button className="password-toggle" type="button" aria-label={showPassword ? '隱藏密碼' : '顯示密碼'} onClick={() => setShowPassword((value) => !value)}>{showPassword ? '隱藏' : '顯示'}</button></div>
            </label>
            {error && <p className="auth-error" role="alert">{error}</p>}
            {message && <p className="auth-success" role="status">{message}</p>}
            <button className="auth-submit" disabled={submitting} type="submit">{submitting ? '請稍候…' : mode === 'login' ? '登入' : '建立帳戶並寄出驗證信'}<span aria-hidden="true">→</span></button>
            <div className="auth-divider"><span /><small>或</small><span /></div>
            <button className="google-signin" disabled={submitting} type="button" onClick={signInWithGoogle}><span aria-hidden="true">G</span>使用 Google 登入</button>
            <p className="auth-switch">{mode === 'login' ? '還沒有帳戶？' : '已經有帳戶？'} <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); setMessage(''); setPassword(''); }}>{mode === 'login' ? '立即註冊' : '返回登入'}</button></p>
          </form>
        </div>
        <footer className="auth-footer"><span>登入後只有你能查看自己的溫習紀錄</span></footer>
      </section>
    </main>
  );
}
