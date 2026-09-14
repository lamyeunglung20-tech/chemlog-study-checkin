'use client';
/* eslint-disable @next/next/no-img-element -- The administrator chooses a small app icon stored as a data URL. */

import { ChangeEvent, useState } from 'react';
import { collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { callAdminApi } from './admin-api';
import { firebaseAuth, firebaseDb } from './firebase-client';
import { type AppConfig } from './app-config';

type AdminUser = {
  uid: string;
  email: string;
  displayName: string;
  disabled: boolean;
  emailVerified: boolean;
  createdAt: string;
  lastSignInTime: string;
};

type AdminSession = {
  id: string;
  studyDate: string;
  minutes: number;
  topic: string;
  note: string;
  hasStartImage: boolean;
  hasEndImage: boolean;
  startImageData?: string;
  endImageData?: string;
};

type AdminUserData = {
  user: AdminUser;
  totalMinutes: number;
  weekMinutes: number;
  monthMinutes: number;
  customTopics: string[];
  sessions: AdminSession[];
};

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (!hours) return `${mins} 分鐘`;
  return mins ? `${hours} 小時 ${mins} 分鐘` : `${hours} 小時`;
}

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function periodStarts() {
  const now = new Date();
  const week = new Date(now);
  week.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return { week: localDateKey(week), month: localDateKey(now).slice(0, 7) };
}

async function deleteDocuments(paths: Array<{ path: string[] }>) {
  for (let index = 0; index < paths.length; index += 400) {
    const batch = writeBatch(firebaseDb);
    for (const item of paths.slice(index, index + 400)) batch.delete(doc(firebaseDb, ...item.path));
    await batch.commit();
  }
}

async function compressAdminIcon(file: File) {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('IMAGE_UNREADABLE'));
      image.src = sourceUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('IMAGE_UNREADABLE');
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - sourceSize) / 2, (image.naturalHeight - sourceSize) / 2, sourceSize, sourceSize, 0, 0, 256, 256);
    let quality = .82;
    let result = canvas.toDataURL('image/jpeg', quality);
    while (result.length > 160000 && quality > .42) {
      quality -= .08;
      result = canvas.toDataURL('image/jpeg', quality);
    }
    if (result.length > 160000) throw new Error('IMAGE_TOO_LARGE');
    return result;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export default function AdminPanel({ appConfig, onClose }: { appConfig: AppConfig; onClose: () => void }) {
  const [tab, setTab] = useState<'appearance' | 'accounts'>('appearance');
  const [draft, setDraft] = useState(appConfig);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<AdminUserData | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function loadUsers() {
    setLoading(true);
    setError('');
    try {
      const result = await callAdminApi<{ users: AdminUser[] }>('listUsers');
      setUsers(result.users);
    } catch {
      setError('未能載入帳戶。請確認你正使用總管理員電郵登入。');
    } finally {
      setLoading(false);
    }
  }

  async function openUser(uid: string) {
    setLoading(true);
    setError('');
    setConfirmDelete(false);
    try {
      const user = users.find((account) => account.uid === uid);
      if (!user) throw new Error('USER_NOT_FOUND');
      const [sessionsSnapshot, imagesSnapshot, preferencesSnapshot] = await Promise.all([
        getDocs(collection(firebaseDb, 'users', uid, 'sessions')),
        getDocs(collection(firebaseDb, 'users', uid, 'sessionImages')),
        getDoc(doc(firebaseDb, 'users', uid, 'preferences', 'studyTopics')),
      ]);
      const images = new Map(imagesSnapshot.docs.map((entry) => [entry.id, String(entry.data().imageData || '')]));
      const sessions: AdminSession[] = sessionsSnapshot.docs.map((entry) => {
        const data = entry.data();
        return {
          id: entry.id,
          studyDate: String(data.studyDate || ''),
          minutes: Number(data.minutes || 0),
          topic: String(data.topic || ''),
          note: String(data.note || ''),
          hasStartImage: data.hasStartImage === true,
          hasEndImage: data.hasEndImage === true || data.hasImage === true,
          startImageData: images.get(`${entry.id}-start`) || '',
          endImageData: images.get(`${entry.id}-end`) || images.get(entry.id) || '',
        };
      }).sort((a, b) => b.studyDate.localeCompare(a.studyDate));
      const starts = periodStarts();
      const totalMinutes = sessions.reduce((total, session) => total + session.minutes, 0);
      const weekMinutes = sessions.filter((session) => session.studyDate >= starts.week).reduce((total, session) => total + session.minutes, 0);
      const monthMinutes = sessions.filter((session) => session.studyDate.startsWith(starts.month)).reduce((total, session) => total + session.minutes, 0);
      setSelectedUser({
        user,
        totalMinutes,
        weekMinutes,
        monthMinutes,
        customTopics: (preferencesSnapshot.data()?.customTopics as string[] | undefined) || [],
        sessions,
      });
      setNameDraft(user.displayName || '');
    } catch {
      setError('未能載入這個帳戶的資料。');
    } finally {
      setLoading(false);
    }
  }

  async function saveAppearance() {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await setDoc(doc(firebaseDb, 'appConfig', 'public'), { ...draft, updatedAt: serverTimestamp() });
      setMessage('APP 外觀及字句已更新。');
    } catch {
      setError('未能儲存設定，請稍後再試。');
    } finally {
      setSaving(false);
    }
  }

  async function deleteUser() {
    if (!selectedUser) return;
    if (selectedUser.user.uid === firebaseAuth.currentUser?.uid) {
      setError('為保障管理功能，總管理員不能刪除自己的帳戶。');
      setConfirmDelete(false);
      return;
    }
    setDeleting(true);
    setError('');
    try {
      const uid = selectedUser.user.uid;
      const [sessionsSnapshot, imagesSnapshot, preferencesSnapshot] = await Promise.all([
        getDocs(collection(firebaseDb, 'users', uid, 'sessions')),
        getDocs(collection(firebaseDb, 'users', uid, 'sessionImages')),
        getDocs(collection(firebaseDb, 'users', uid, 'preferences')),
      ]);
      await deleteDocuments([
        ...sessionsSnapshot.docs.map((entry) => ({ path: ['users', uid, 'sessions', entry.id] })),
        ...imagesSnapshot.docs.map((entry) => ({ path: ['users', uid, 'sessionImages', entry.id] })),
        ...preferencesSnapshot.docs.map((entry) => ({ path: ['users', uid, 'preferences', entry.id] })),
      ]);
      await deleteDoc(doc(firebaseDb, 'leaderboard', uid)).catch(() => undefined);
      await deleteDoc(doc(firebaseDb, 'leaderboardAvatars', uid)).catch(() => undefined);
      await callAdminApi<{ ok: boolean }>('deleteUser', { uid });
      setUsers((current) => current.filter((user) => user.uid !== selectedUser.user.uid));
      setSelectedUser(null);
      setConfirmDelete(false);
      setMessage('帳戶及其 APP 資料已刪除。');
    } catch {
      setError('未能刪除帳戶。總管理員不能刪除自己的帳戶。');
    } finally {
      setDeleting(false);
    }
  }

  async function saveUserName() {
    if (!selectedUser) return;
    const displayName = nameDraft.trim().slice(0, 40);
    if (!displayName) {
      setError('請輸入帳戶名稱。');
      return;
    }
    setNameSaving(true);
    setError('');
    setMessage('');
    try {
      await callAdminApi<{ ok: boolean; displayName: string }>('updateUserName', { uid: selectedUser.user.uid, displayName });
      const leaderboardRef = doc(firebaseDb, 'leaderboard', selectedUser.user.uid);
      const leaderboardDocument = await getDoc(leaderboardRef);
      if (leaderboardDocument.exists()) await setDoc(leaderboardRef, { displayName, updatedAt: serverTimestamp() }, { merge: true });
      setSelectedUser((current) => current ? { ...current, user: { ...current.user, displayName } } : current);
      setUsers((current) => current.map((account) => account.uid === selectedUser.user.uid ? { ...account, displayName } : account));
      setMessage('帳戶名稱已更新。');
    } catch {
      setError('未能更新帳戶名稱，請稍後再試。');
    } finally {
      setNameSaving(false);
    }
  }

  async function handleIcon(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 8 * 1024 * 1024) {
      setError('請選擇不超過 8 MB 的圖片。');
      return;
    }
    try {
      const iconData = await compressAdminIcon(file);
      setDraft((current) => ({ ...current, iconData }));
    } catch {
      setError('未能處理圖片，請轉用 JPG 或 PNG。');
    }
  }

  return <div className="record-modal-backdrop admin-backdrop" role="presentation" onClick={onClose}>
    <section className="admin-panel" role="dialog" aria-modal="true" aria-labelledby="admin-title" onClick={(event) => event.stopPropagation()}>
      <button className="modal-close" type="button" aria-label="關閉管理中心" onClick={onClose}>×</button>
      <p className="auth-kicker">總管理員專用</p>
      <h2 id="admin-title">APP 管理中心</h2>
      <div className="admin-tabs" role="tablist">
        <button className={tab === 'appearance' ? 'selected' : ''} type="button" onClick={() => setTab('appearance')}>APP 外觀</button>
        <button className={tab === 'accounts' ? 'selected' : ''} type="button" onClick={() => { setTab('accounts'); if (users.length === 0) void loadUsers(); }}>帳戶管理</button>
      </div>
      {message && <p className="auth-success" role="status">{message}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}

      {tab === 'appearance' ? <div className="admin-appearance">
        <label>APP 名稱<input value={draft.appName} maxLength={30} onChange={(event) => setDraft({ ...draft, appName: event.target.value })} /></label>
        <label>副標題（可留空）<input value={draft.subtitle} maxLength={60} placeholder="留空即不顯示副標題" onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })} /></label>
        <label>登入標題<input value={draft.loginHeading} maxLength={40} onChange={(event) => setDraft({ ...draft, loginHeading: event.target.value })} /></label>
        <label>登入字句<input value={draft.loginCopy} maxLength={100} onChange={(event) => setDraft({ ...draft, loginCopy: event.target.value })} /></label>
        <label>頁尾字句<input value={draft.footerQuote} maxLength={120} onChange={(event) => setDraft({ ...draft, footerQuote: event.target.value })} /></label>
        <div className="admin-color-row"><label>背景顏色<input type="color" value={draft.backgroundColor} onChange={(event) => setDraft({ ...draft, backgroundColor: event.target.value })} /></label><span>{draft.backgroundColor}</span></div>
        <label className="admin-icon-upload">APP Icon<span>{draft.iconData ? <img src={draft.iconData} alt="目前 APP icon" /> : '⚗'}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void handleIcon(event); }} /></label>
        <div className="admin-setting-actions"><button type="button" onClick={() => setDraft({ ...draft, iconData: '' })}>恢復預設 Icon</button><button className="admin-primary" disabled={saving} type="button" onClick={() => { void saveAppearance(); }}>{saving ? '正在儲存…' : '儲存設定'}</button></div>
      </div> : <div className="admin-accounts">
        {selectedUser ? <div className="admin-user-detail">
          <button className="admin-back" type="button" onClick={() => setSelectedUser(null)}>← 返回帳戶列表</button>
          <h3>{selectedUser.user.displayName || '未設定姓名'}</h3>
          <p>{selectedUser.user.email}</p>
          <div className="admin-name-editor"><label>帳戶名稱<input value={nameDraft} minLength={1} maxLength={40} onChange={(event) => setNameDraft(event.target.value)} /></label><button type="button" disabled={nameSaving || !nameDraft.trim()} onClick={() => { void saveUserName(); }}>{nameSaving ? '正在儲存…' : '更新名稱'}</button></div>
          <div className="admin-stats"><span><small>總時數</small><strong>{formatDuration(selectedUser.totalMinutes)}</strong></span><span><small>本週</small><strong>{formatDuration(selectedUser.weekMinutes)}</strong></span><span><small>本月</small><strong>{formatDuration(selectedUser.monthMinutes)}</strong></span></div>
          <h4>最近打卡資料</h4>
          {selectedUser.customTopics.length > 0 && <p className="admin-custom-topics"><strong>個人溫習選單：</strong>{selectedUser.customTopics.join('、')}</p>}
          <div className="admin-session-list">{selectedUser.sessions.length ? selectedUser.sessions.map((session) => <article key={session.id}><time>{session.studyDate}</time><div><strong>{session.topic}</strong><small>{session.note || '沒有備註'}</small>{(session.startImageData || session.endImageData) && <span className="admin-session-images">{session.startImageData && <img src={session.startImageData} alt={`${session.studyDate} 學習開始`} />}{session.endImageData && <img src={session.endImageData} alt={`${session.studyDate} 學習結束`} />}</span>}</div><b>{formatDuration(session.minutes)}</b></article>) : <p>此帳戶尚未有打卡紀錄。</p>}</div>
          <div className="admin-delete-zone">{selectedUser.user.uid === firebaseAuth.currentUser?.uid ? <p>總管理員帳戶受保護，不能在此刪除。</p> : !confirmDelete ? <button type="button" onClick={() => setConfirmDelete(true)}>刪除這個帳戶</button> : <div><p>將永久刪除帳戶及所有 APP 資料，無法復原。</p><button type="button" onClick={() => setConfirmDelete(false)}>取消</button><button className="danger" disabled={deleting} type="button" onClick={() => { void deleteUser(); }}>{deleting ? '正在刪除…' : '確認永久刪除'}</button></div>}</div>
        </div> : <div className="admin-user-list">{loading ? <p>正在載入帳戶…</p> : users.map((user) => <button type="button" key={user.uid} onClick={() => { void openUser(user.uid); }}><span>{(user.displayName || user.email).slice(0, 1).toUpperCase()}</span><div><strong>{user.displayName || '未設定姓名'}</strong><small>{user.email}</small></div><i>{user.emailVerified ? '已驗證' : '未驗證'} →</i></button>)}</div>}
      </div>}
    </section>
  </div>;
}
