'use client';
/* eslint-disable @next/next/no-img-element -- The administrator chooses a small app icon stored as a data URL. */

import { ChangeEvent, useEffect, useRef, useState } from 'react';
import { collection, deleteDoc, doc, getDoc, getDocs, runTransaction, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { callAdminApi } from './admin-api';
import { firebaseAuth, firebaseDb } from './firebase-client';
import { type AppConfig, defaultRewardOptions } from './app-config';

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
  removedStickerCount: number;
  stickerBonusCount: number;
  customTopics: string[];
  sessions: AdminSession[];
  redemptions: AdminRedemption[];
};

type AdminRedemption = {
  id: string;
  rewardLabel: string;
  stickerCost: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  deducted: boolean;
  createdAt: number;
};

type AdminRedemptionInboxItem = AdminRedemption & {
  userId: string;
  displayName: string;
  email: string;
};

type EditableNumber = number | '';

function editableNumber(value: string, min: number, max: number): EditableNumber {
  if (value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function numberValue(value: EditableNumber) {
  return value === '' ? 0 : value;
}

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

function adminStats(sessions: AdminSession[]) {
  const starts = periodStarts();
  return {
    totalMinutes: sessions.reduce((total, session) => total + session.minutes, 0),
    weekMinutes: sessions.filter((session) => session.studyDate >= starts.week).reduce((total, session) => total + session.minutes, 0),
    monthMinutes: sessions.filter((session) => session.studyDate.startsWith(starts.month)).reduce((total, session) => total + session.minutes, 0),
    weekKey: starts.week,
    monthKey: starts.month,
  };
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
  const activeTabRef = useRef<'appearance' | 'accounts'>('appearance');
  const [draft, setDraft] = useState(appConfig);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<AdminUserData | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [confirmSessionDelete, setConfirmSessionDelete] = useState(false);
  const [sessionDeleting, setSessionDeleting] = useState(false);
  const [stickerAddCount, setStickerAddCount] = useState<EditableNumber>(1);
  const [stickerAdding, setStickerAdding] = useState(false);
  const [stickerDeleteCount, setStickerDeleteCount] = useState<EditableNumber>(1);
  const [confirmStickerDelete, setConfirmStickerDelete] = useState(false);
  const [stickerDeleting, setStickerDeleting] = useState(false);
  const [redemptionResolvingId, setRedemptionResolvingId] = useState('');
  const [redemptionInboxOpen, setRedemptionInboxOpen] = useState(false);
  const [redemptionInboxLoading, setRedemptionInboxLoading] = useState(false);
  const [redemptionInbox, setRedemptionInbox] = useState<AdminRedemptionInboxItem[]>([]);
  const [redemptionInboxError, setRedemptionInboxError] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousOverscrollBehavior = document.body.style.overscrollBehavior;
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscrollBehavior;
    };
  }, []);

  async function loadUsers() {
    setLoading(true);
    setError('');
    setMessage('');
    let appUsers: AdminUser[] = [];
    try {
      const [leaderboardSnapshot, profilesSnapshot] = await Promise.all([
        getDocs(collection(firebaseDb, 'leaderboard')),
        getDocs(collection(firebaseDb, 'profiles')),
      ]);
      const profileEmails = new Map(profilesSnapshot.docs.map((entry) => [entry.id, String(entry.data().email || '')]));
      appUsers = leaderboardSnapshot.docs.map((entry) => ({
        uid: entry.id,
        email: profileEmails.get(entry.id) || '',
        displayName: String(entry.data().displayName || ''),
        disabled: false,
        emailVerified: true,
        createdAt: '',
        lastSignInTime: '',
      }));
      for (const profile of profilesSnapshot.docs) {
        if (appUsers.some((account) => account.uid === profile.id)) continue;
        appUsers.push({
          uid: profile.id,
          email: String(profile.data().email || ''),
          displayName: '',
          disabled: false,
          emailVerified: true,
          createdAt: '',
          lastSignInTime: '',
        });
      }
      if (appUsers.length > 0) setUsers(appUsers);
    } catch {
      // The secure Firebase account service below remains available as the secondary source.
    }
    if (appUsers.length > 0) setLoading(false);
    try {
      const result = await callAdminApi<{ users: AdminUser[] }>('listUsers');
      const officialUsers = new Map(result.users.map((account) => [account.uid, account]));
      for (const appUser of appUsers) {
        const officialUser = officialUsers.get(appUser.uid);
        officialUsers.set(appUser.uid, officialUser ? {
          ...officialUser,
          email: officialUser.email || appUser.email,
          displayName: appUser.displayName || officialUser.displayName,
        } : appUser);
      }
      setUsers(Array.from(officialUsers.values()));
    } catch {
      if (appUsers.length === 0 && activeTabRef.current === 'accounts') {
        setError('暫時未能載入帳戶清單，請按「重新載入帳戶」再試。');
      }
    } finally {
      setLoading(false);
    }
  }

  function changeTab(nextTab: 'appearance' | 'accounts') {
    activeTabRef.current = nextTab;
    setTab(nextTab);
    setError('');
    setMessage('');
    setRedemptionInboxOpen(false);
    setRedemptionInboxError('');
    if (nextTab === 'accounts' && users.length === 0) void loadUsers();
  }

  async function openRedemptionInbox() {
    setRedemptionInboxOpen(true);
    setSelectedUser(null);
    setRedemptionInboxLoading(true);
    setRedemptionInboxError('');
    setError('');
    setMessage('');
    try {
      const accountRequests = await Promise.all(users.map(async (account) => {
        try {
          const snapshot = await getDocs(collection(firebaseDb, 'users', account.uid, 'redemptions'));
          return snapshot.docs.map((entry) => {
            const values = entry.data();
            const createdAt = values.createdAt as { toMillis?: () => number } | undefined;
            return {
              id: entry.id,
              userId: account.uid,
              displayName: account.displayName || '未設定姓名',
              email: account.email || '',
              rewardLabel: typeof values.rewardLabel === 'string' ? values.rewardLabel : '獎勵',
              stickerCost: Math.max(0, Math.floor(Number(values.stickerCost) || 0)),
              status: values.status === 'approved' || values.status === 'rejected' || values.status === 'cancelled' ? values.status : 'pending',
              deducted: values.deducted !== false,
              createdAt: createdAt?.toMillis?.() ?? 0,
            } satisfies AdminRedemptionInboxItem;
          });
        } catch {
          return [];
        }
      }));
      const items = accountRequests.flat().sort((left, right) => {
        if (left.status === 'pending' && right.status !== 'pending') return -1;
        if (left.status !== 'pending' && right.status === 'pending') return 1;
        return right.createdAt - left.createdAt;
      });
      setRedemptionInbox(items);
    } catch {
      setRedemptionInboxError('暫時未能載入換領申請，請按「重新整理」再試。');
    } finally {
      setRedemptionInboxLoading(false);
    }
  }

  async function openInboxAccount(userId: string) {
    setRedemptionInboxOpen(false);
    await openUser(userId);
  }

  async function openUser(uid: string) {
    setLoading(true);
    setError('');
    setConfirmDelete(false);
    try {
      const user = users.find((account) => account.uid === uid);
      if (!user) throw new Error('USER_NOT_FOUND');
      const [sessionsSnapshot, imagesSnapshot, preferencesSnapshot, leaderboardDocument, redemptionsSnapshot] = await Promise.all([
        getDocs(collection(firebaseDb, 'users', uid, 'sessions')),
        getDocs(collection(firebaseDb, 'users', uid, 'sessionImages')),
        getDoc(doc(firebaseDb, 'users', uid, 'preferences', 'studyTopics')),
        getDoc(doc(firebaseDb, 'leaderboard', uid)),
        getDocs(collection(firebaseDb, 'users', uid, 'redemptions')),
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
      const stats = adminStats(sessions);
      const redemptions: AdminRedemption[] = redemptionsSnapshot.docs.map((entry) => {
        const values = entry.data();
        const createdAt = values.createdAt as { toMillis?: () => number } | undefined;
        return {
          id: entry.id,
          rewardLabel: typeof values.rewardLabel === 'string' ? values.rewardLabel : '獎勵',
          stickerCost: Math.max(0, Math.floor(Number(values.stickerCost) || 0)),
          status: values.status === 'approved' || values.status === 'rejected' || values.status === 'cancelled' ? values.status : 'pending',
          deducted: values.deducted !== false,
          createdAt: createdAt?.toMillis?.() ?? 0,
        };
      }).sort((left, right) => right.createdAt - left.createdAt);
      setSelectedUser({
        user,
        totalMinutes: stats.totalMinutes,
        weekMinutes: stats.weekMinutes,
        monthMinutes: stats.monthMinutes,
        removedStickerCount: Math.max(0, Math.floor(Number(leaderboardDocument.data()?.removedStickerCount) || 0)),
        stickerBonusCount: Math.max(0, Math.floor(Number(leaderboardDocument.data()?.stickerBonusCount) || 0)),
        customTopics: (preferencesSnapshot.data()?.customTopics as string[] | undefined) || [],
        sessions,
        redemptions,
      });
      setNameDraft(user.displayName || '');
      setSelectedSessionIds([]);
      setConfirmSessionDelete(false);
      setStickerAddCount(1);
      setStickerDeleteCount(1);
      setConfirmStickerDelete(false);
      setRedemptionResolvingId('');
    } catch {
      setError('未能載入這個帳戶的資料。');
    } finally {
      setLoading(false);
    }
  }

  async function saveAppearance() {
    if (draft.rewards.some((reward) => !reward.label.trim() || reward.stickerCost < 1 || reward.stickerCost > 999 || !reward.icon.trim())) {
      setError('每項獎勵都要有名稱、圖示及 1 至 999 張貼紙的換領數量。');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await setDoc(doc(firebaseDb, 'appConfig', 'public'), {
        ...draft,
        rewards: draft.rewards.map((reward) => ({ ...reward, label: reward.label.trim(), icon: Array.from(reward.icon.trim()).slice(0, 4).join(''), stickerCost: Math.floor(reward.stickerCost) })),
        updatedAt: serverTimestamp(),
      });
      setMessage('APP 外觀、字句及換領獎勵已更新。');
    } catch {
      setError('未能儲存設定，請稍後再試。');
    } finally {
      setSaving(false);
    }
  }

  function updateReward(id: AppConfig['rewards'][number]['id'], changes: Partial<AppConfig['rewards'][number]>) {
    setDraft((current) => ({
      ...current,
      rewards: current.rewards.map((reward) => reward.id === id ? { ...reward, ...changes } : reward),
    }));
  }

  function deleteReward(id: AppConfig['rewards'][number]['id']) {
    setDraft((current) => ({ ...current, rewards: current.rewards.filter((reward) => reward.id !== id) }));
    setError('');
    setMessage('獎勵已從草稿移除；按「儲存設定」後才會正式刪除。');
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
      const [sessionsSnapshot, imagesSnapshot, preferencesSnapshot, redemptionsSnapshot] = await Promise.all([
        getDocs(collection(firebaseDb, 'users', uid, 'sessions')),
        getDocs(collection(firebaseDb, 'users', uid, 'sessionImages')),
        getDocs(collection(firebaseDb, 'users', uid, 'preferences')),
        getDocs(collection(firebaseDb, 'users', uid, 'redemptions')),
      ]);
      await deleteDocuments([
        ...sessionsSnapshot.docs.map((entry) => ({ path: ['users', uid, 'sessions', entry.id] })),
        ...imagesSnapshot.docs.map((entry) => ({ path: ['users', uid, 'sessionImages', entry.id] })),
        ...preferencesSnapshot.docs.map((entry) => ({ path: ['users', uid, 'preferences', entry.id] })),
        ...redemptionsSnapshot.docs.map((entry) => ({ path: ['users', uid, 'redemptions', entry.id] })),
      ]);
      await deleteDoc(doc(firebaseDb, 'leaderboard', uid)).catch(() => undefined);
      await deleteDoc(doc(firebaseDb, 'leaderboardAvatars', uid)).catch(() => undefined);
      await deleteDoc(doc(firebaseDb, 'profiles', uid)).catch(() => undefined);
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
    const previousDisplayName = selectedUser.user.displayName;
    setSelectedUser((current) => current ? { ...current, user: { ...current.user, displayName } } : current);
    setUsers((current) => current.map((account) => account.uid === selectedUser.user.uid ? { ...account, displayName } : account));
    try {
      const leaderboardRef = doc(firebaseDb, 'leaderboard', selectedUser.user.uid);
      const stats = adminStats(selectedUser.sessions);
      await setDoc(leaderboardRef, {
        displayName,
        totalMinutes: stats.totalMinutes,
        weekMinutes: stats.weekMinutes,
        monthMinutes: stats.monthMinutes,
        weekKey: stats.weekKey,
        monthKey: stats.monthKey,
        removedStickerCount: selectedUser.removedStickerCount,
        stickerBonusCount: selectedUser.stickerBonusCount,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      await callAdminApi<{ ok: boolean; displayName: string }>('updateUserName', { uid: selectedUser.user.uid, displayName }).catch(() => undefined);
      setMessage('帳戶名稱已更新，學生頁面會即時顯示新名稱。');
    } catch {
      setSelectedUser((current) => current ? { ...current, user: { ...current.user, displayName: previousDisplayName } } : current);
      setUsers((current) => current.map((account) => account.uid === selectedUser.user.uid ? { ...account, displayName: previousDisplayName } : account));
      setError('未能更新帳戶名稱，請稍後再試。');
    } finally {
      setNameSaving(false);
    }
  }

  function toggleAdminSession(sessionId: string) {
    setSelectedSessionIds((current) => current.includes(sessionId)
      ? current.filter((id) => id !== sessionId)
      : [...current, sessionId]);
    setConfirmSessionDelete(false);
  }

  async function deleteSelectedUserSessions() {
    if (!selectedUser) return;
    if (selectedUser.user.uid === firebaseAuth.currentUser?.uid) {
      setError('總管理員只可在此管理其他帳戶的打卡紀錄。');
      return;
    }
    const chosenSessions = selectedUser.sessions.filter((session) => selectedSessionIds.includes(session.id));
    if (chosenSessions.length === 0) {
      setError('請先選擇要刪除的打卡紀錄。');
      return;
    }
    setSessionDeleting(true);
    setError('');
    setMessage('');
    try {
      const uid = selectedUser.user.uid;
      await deleteDocuments(chosenSessions.flatMap((session) => [
        { path: ['users', uid, 'sessions', session.id] },
        { path: ['users', uid, 'sessionImages', session.id] },
        { path: ['users', uid, 'sessionImages', `${session.id}-start`] },
        { path: ['users', uid, 'sessionImages', `${session.id}-end`] },
      ]));
      const remainingSessions = selectedUser.sessions.filter((session) => !selectedSessionIds.includes(session.id));
      const stats = adminStats(remainingSessions);
      const removedStickerCount = Math.min(selectedUser.removedStickerCount, Math.floor(stats.totalMinutes / 60) + selectedUser.stickerBonusCount);
      await setDoc(doc(firebaseDb, 'leaderboard', uid), {
        displayName: selectedUser.user.displayName.trim().slice(0, 40) || '同學',
        totalMinutes: stats.totalMinutes,
        weekMinutes: stats.weekMinutes,
        monthMinutes: stats.monthMinutes,
        weekKey: stats.weekKey,
        monthKey: stats.monthKey,
        removedStickerCount,
        stickerBonusCount: selectedUser.stickerBonusCount,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setSelectedUser((current) => current ? {
        ...current,
        sessions: remainingSessions,
        totalMinutes: stats.totalMinutes,
        weekMinutes: stats.weekMinutes,
        monthMinutes: stats.monthMinutes,
        removedStickerCount,
      } : current);
      setSelectedSessionIds([]);
      setConfirmSessionDelete(false);
      setMessage(`已刪除 ${chosenSessions.length} 筆打卡紀錄，學生頁面會即時更新。`);
    } catch {
      setError('未能刪除所選打卡紀錄，請稍後再試。');
    } finally {
      setSessionDeleting(false);
    }
  }

  async function deleteUserStickers() {
    if (!selectedUser) return;
    const availableStickerCount = Math.max(0, Math.floor(selectedUser.totalMinutes / 60) + selectedUser.stickerBonusCount - selectedUser.removedStickerCount);
    const requestedAmount = Math.floor(numberValue(stickerDeleteCount));
    const amount = Number.isFinite(requestedAmount) ? Math.min(availableStickerCount, Math.max(0, requestedAmount)) : 0;
    if (amount < 1) {
      setError('請輸入可刪除的貼紙數量。');
      return;
    }
    setStickerDeleting(true);
    setError('');
    setMessage('');
    try {
      const stats = adminStats(selectedUser.sessions);
      const removedStickerCount = selectedUser.removedStickerCount + amount;
      await setDoc(doc(firebaseDb, 'leaderboard', selectedUser.user.uid), {
        displayName: selectedUser.user.displayName.trim().slice(0, 40) || '同學',
        totalMinutes: stats.totalMinutes,
        weekMinutes: stats.weekMinutes,
        monthMinutes: stats.monthMinutes,
        weekKey: stats.weekKey,
        monthKey: stats.monthKey,
        removedStickerCount,
        stickerBonusCount: selectedUser.stickerBonusCount,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setSelectedUser((current) => current ? { ...current, removedStickerCount } : current);
      setStickerDeleteCount(1);
      setConfirmStickerDelete(false);
      setMessage(`已刪除 ${amount} 張貼紙，學生頁面及排行榜會即時更新。`);
    } catch {
      setError('未能刪除貼紙，請稍後再試。');
    } finally {
      setStickerDeleting(false);
    }
  }

  async function addUserStickers() {
    if (!selectedUser) return;
    const requestedAmount = Math.floor(numberValue(stickerAddCount));
    const availableCapacity = Math.max(0, 87600 - selectedUser.stickerBonusCount);
    const amount = Number.isFinite(requestedAmount) ? Math.min(availableCapacity, Math.max(0, requestedAmount)) : 0;
    if (amount < 1) {
      setError('請輸入要新增的貼紙數量。');
      return;
    }
    setStickerAdding(true);
    setError('');
    setMessage('');
    try {
      const stats = adminStats(selectedUser.sessions);
      const stickerBonusCount = selectedUser.stickerBonusCount + amount;
      await setDoc(doc(firebaseDb, 'leaderboard', selectedUser.user.uid), {
        displayName: selectedUser.user.displayName.trim().slice(0, 40) || '同學',
        totalMinutes: stats.totalMinutes,
        weekMinutes: stats.weekMinutes,
        monthMinutes: stats.monthMinutes,
        weekKey: stats.weekKey,
        monthKey: stats.monthKey,
        removedStickerCount: selectedUser.removedStickerCount,
        stickerBonusCount,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setSelectedUser((current) => current ? { ...current, stickerBonusCount } : current);
      setStickerAddCount(1);
      setMessage(`已新增 ${amount} 張貼紙，學生頁面及排行榜會即時更新。`);
    } catch {
      setError('未能新增貼紙，請稍後再試。');
    } finally {
      setStickerAdding(false);
    }
  }

  async function resolveRedemption(redemptionId: string, resolution: 'approved' | 'rejected') {
    if (!selectedUser || redemptionResolvingId) return;
    setRedemptionResolvingId(redemptionId);
    setError('');
    setMessage('');
    let nextRemovedStickerCount = selectedUser.removedStickerCount;
    try {
      const uid = selectedUser.user.uid;
      const redemptionRef = doc(firebaseDb, 'users', uid, 'redemptions', redemptionId);
      const leaderboardRef = doc(firebaseDb, 'leaderboard', uid);
      await runTransaction(firebaseDb, async (transaction) => {
        const [redemptionDocument, leaderboardDocument] = await Promise.all([
          transaction.get(redemptionRef),
          transaction.get(leaderboardRef),
        ]);
        if (!redemptionDocument.exists() || !leaderboardDocument.exists()) throw new Error('REQUEST_NOT_FOUND');
        const redemption = redemptionDocument.data();
        if (redemption.status !== 'pending') throw new Error('ALREADY_RESOLVED');
        const stickerCost = Math.max(1, Math.floor(Number(redemption.stickerCost) || 0));
        const leaderboard = leaderboardDocument.data();
        const removedStickerCount = Math.max(0, Math.floor(Number(leaderboard.removedStickerCount) || 0));
        const wasDeducted = redemption.deducted !== false;
        nextRemovedStickerCount = removedStickerCount;

        if (resolution === 'approved' && !wasDeducted) {
          const availableStickerCount = Math.max(0, Math.floor((Number(leaderboard.totalMinutes) || 0) / 60) + Math.floor(Number(leaderboard.stickerBonusCount) || 0) - removedStickerCount);
          if (availableStickerCount < stickerCost) throw new Error('INSUFFICIENT_STICKERS');
          nextRemovedStickerCount = removedStickerCount + stickerCost;
          transaction.update(leaderboardRef, { removedStickerCount: nextRemovedStickerCount, updatedAt: serverTimestamp() });
        } else if (resolution === 'rejected' && wasDeducted) {
          nextRemovedStickerCount = Math.max(0, removedStickerCount - stickerCost);
          transaction.update(leaderboardRef, { removedStickerCount: nextRemovedStickerCount, updatedAt: serverTimestamp() });
        }

        transaction.update(redemptionRef, { status: resolution, deducted: resolution === 'approved', resolvedAt: serverTimestamp() });
      });
      setSelectedUser((current) => current ? {
        ...current,
        removedStickerCount: nextRemovedStickerCount,
        redemptions: current.redemptions.map((redemption) => redemption.id === redemptionId ? { ...redemption, status: resolution, deducted: resolution === 'approved' } : redemption),
      } : current);
      setMessage(resolution === 'approved' ? '換領申請已批准，貼紙已自動扣除。' : '換領申請已拒絕，沒有扣除貼紙。');
    } catch (caught) {
      const reason = (caught as Error).message;
      setError(reason === 'INSUFFICIENT_STICKERS' ? '這個帳戶現有貼紙不足，未能批准申請。' : reason === 'ALREADY_RESOLVED' ? '這項申請已經處理，請重新載入帳戶資料。' : '未能處理換領申請，請稍後再試。');
    } finally {
      setRedemptionResolvingId('');
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

  const selectedUserIsAdmin = selectedUser?.user.uid === firebaseAuth.currentUser?.uid;
  const selectedUserStickerCount = selectedUser
    ? Math.max(0, Math.floor(selectedUser.totalMinutes / 60) + selectedUser.stickerBonusCount - selectedUser.removedStickerCount)
    : 0;

  return <div className="record-modal-backdrop admin-backdrop" role="presentation" onClick={onClose}>
    <section className="admin-panel" role="dialog" aria-modal="true" aria-labelledby="admin-title" onClick={(event) => event.stopPropagation()}>
      <button className="modal-close" type="button" aria-label="關閉管理中心" onClick={onClose}>×</button>
      <p className="auth-kicker">總管理員專用</p>
      <h2 id="admin-title">APP 管理中心</h2>
      <div className="admin-tabs" role="tablist">
        <button className={tab === 'appearance' ? 'selected' : ''} type="button" onClick={() => changeTab('appearance')}>APP 外觀</button>
        <button className={tab === 'accounts' ? 'selected' : ''} type="button" onClick={() => changeTab('accounts')}>帳戶管理</button>
      </div>
      {message && <p className="auth-success" role="status">{message}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}

      {tab === 'appearance' ? <div className="admin-appearance">
        <label>APP 名稱<input value={draft.appName} maxLength={30} onChange={(event) => setDraft({ ...draft, appName: event.target.value })} /></label>
        <label>副標題（可留空）<input value={draft.subtitle} maxLength={60} placeholder="留空即不顯示副標題" onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })} /></label>
        <label>登入標題<input value={draft.loginHeading} maxLength={40} onChange={(event) => setDraft({ ...draft, loginHeading: event.target.value })} /></label>
        <label>登入字句<input value={draft.loginCopy} maxLength={100} onChange={(event) => setDraft({ ...draft, loginCopy: event.target.value })} /></label>
        <label>本週榜首鼓勵字句<input value={draft.championMessage} maxLength={80} placeholder="例如：藍老師愛你💌" onChange={(event) => setDraft({ ...draft, championMessage: event.target.value })} /></label>
        <label>頁尾字句<input value={draft.footerQuote} maxLength={120} onChange={(event) => setDraft({ ...draft, footerQuote: event.target.value })} /></label>
        <section className="admin-reward-editor" aria-labelledby="admin-rewards-title">
          <div className="admin-reward-heading"><div><h3 id="admin-rewards-title">換領獎勵內容</h3><p>可修改或刪除獎勵；按「儲存設定」後，學生會即時看到更新。</p></div><button type="button" onClick={() => setDraft((current) => ({ ...current, rewards: defaultRewardOptions.map((reward) => ({ ...reward })) }))}>還原預設獎勵</button></div>
          <div className="admin-reward-list">{draft.rewards.length ? draft.rewards.map((reward) => <article key={reward.id}>
            <label className="admin-reward-icon">圖示<input aria-label={`${reward.label || '獎勵'}圖示`} value={reward.icon} maxLength={8} onChange={(event) => updateReward(reward.id, { icon: event.target.value })} /></label>
            <label>獎勵內容<input value={reward.label} maxLength={80} onChange={(event) => updateReward(reward.id, { label: event.target.value })} /></label>
            <label className="admin-reward-cost">所需貼紙<input type="number" inputMode="numeric" min={1} max={999} value={reward.stickerCost === 0 ? '' : reward.stickerCost} onChange={(event) => updateReward(reward.id, { stickerCost: event.target.value === '' ? 0 : Math.min(999, Math.max(1, Math.floor(Number(event.target.value) || 1))) })} /></label>
            <button className="admin-delete-reward" type="button" onClick={() => deleteReward(reward.id)}>刪除這項獎勵</button>
          </article>) : <p className="admin-reward-empty">目前沒有獎勵。儲存後，學生的換領計劃會顯示為空。</p>}</div>
        </section>
        <div className="admin-color-row"><label>背景顏色<input type="color" value={draft.backgroundColor} onChange={(event) => setDraft({ ...draft, backgroundColor: event.target.value })} /></label><span>{draft.backgroundColor}</span></div>
        <label className="admin-icon-upload">APP Icon<span>{draft.iconData ? <img src={draft.iconData} alt="目前 APP icon" /> : '⚗'}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void handleIcon(event); }} /></label>
        <div className="admin-setting-actions"><button type="button" onClick={() => setDraft({ ...draft, iconData: '' })}>恢復預設 Icon</button><button className="admin-primary" disabled={saving} type="button" onClick={() => { void saveAppearance(); }}>{saving ? '正在儲存…' : '儲存設定'}</button></div>
      </div> : <div className="admin-accounts">
        {!selectedUser && !redemptionInboxOpen && <div className="admin-account-toolbar"><button type="button" disabled={loading} onClick={() => { void openRedemptionInbox(); }}>🎁 {loading ? '正在載入帳戶…' : '查看換領獎勵申請'}</button><small>集中查看所有帳戶的申請及待批准項目</small></div>}
        {redemptionInboxOpen ? <section className="admin-redemption-inbox" aria-labelledby="redemption-inbox-title">
          <div className="admin-inbox-heading"><div><button className="admin-back" type="button" onClick={() => { setRedemptionInboxOpen(false); setRedemptionInboxError(''); }}>← 返回帳戶列表</button><h3 id="redemption-inbox-title">所有換領獎勵申請</h3><p>待批准申請會置頂顯示；按帳戶即可查看及處理。</p></div><button type="button" disabled={redemptionInboxLoading} onClick={() => { void openRedemptionInbox(); }}>{redemptionInboxLoading ? '載入中…' : '重新整理'}</button></div>
          {redemptionInboxError && <p className="auth-error" role="alert">{redemptionInboxError}</p>}
          {redemptionInboxLoading ? <p className="admin-inbox-loading">正在載入所有申請…</p> : redemptionInbox.length ? <div className="admin-redemption-inbox-list">{redemptionInbox.map((redemption) => <article key={`${redemption.userId}-${redemption.id}`}>
            <div className="admin-inbox-account"><span>{(redemption.displayName || redemption.email || '同').slice(0, 1).toUpperCase()}</span><div><strong>{redemption.displayName}</strong><small>{redemption.email || '已註冊帳戶'}</small></div></div>
            <div className="admin-inbox-request"><strong>{redemption.rewardLabel}</strong><small>{redemption.stickerCost} 張貼紙 · {redemption.createdAt ? new Intl.DateTimeFormat('zh-HK', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Hong_Kong' }).format(new Date(redemption.createdAt)) : '剛剛申請'}</small></div>
            <span className={`admin-redemption-status ${redemption.status}`}>{redemption.status === 'approved' ? '已批准' : redemption.status === 'cancelled' ? '學生已取消' : redemption.status === 'rejected' ? '已拒絕' : '待批准'}</span>
            <button className="admin-open-request-account" type="button" onClick={() => { void openInboxAccount(redemption.userId); }}>{redemption.status === 'pending' ? '查看並處理' : '查看帳戶'}</button>
          </article>)}</div> : !redemptionInboxError && <p className="admin-redemption-empty">目前沒有任何換領申請。</p>}
        </section> : selectedUser ? <div className="admin-user-detail">
          <button className="admin-back" type="button" onClick={() => setSelectedUser(null)}>← 返回帳戶列表</button>
          <h3>{selectedUser.user.displayName || '未設定姓名'}</h3>
          <p>{selectedUser.user.email || '電郵資料將於學生下次登入後同步'}</p>
          <div className="admin-name-editor"><label>帳戶名稱<input value={nameDraft} minLength={1} maxLength={40} onChange={(event) => setNameDraft(event.target.value)} /></label><button type="button" disabled={nameSaving || !nameDraft.trim()} onClick={() => { void saveUserName(); }}>{nameSaving ? '正在儲存…' : '更新名稱'}</button></div>
          <div className="admin-stats"><span><small>總時數</small><strong>{formatDuration(selectedUser.totalMinutes)}</strong></span><span><small>本週</small><strong>{formatDuration(selectedUser.weekMinutes)}</strong></span><span><small>本月</small><strong>{formatDuration(selectedUser.monthMinutes)}</strong></span><span><small>印度指數</small><strong>{selectedUserStickerCount} 張</strong></span></div>
          <div className="admin-sticker-manager">
            <div className="admin-sticker-summary"><strong>管理印度貼紙</strong><small>現有 {selectedUserStickerCount} 張，可自行新增或刪除</small></div>
            <div className="admin-sticker-action"><input aria-label="要新增的貼紙數量" type="number" inputMode="numeric" min={1} max={87600} value={stickerAddCount} disabled={stickerAdding} onChange={(event) => setStickerAddCount(editableNumber(event.target.value, 1, 87600))} /><button className="add" type="button" disabled={stickerAdding || numberValue(stickerAddCount) < 1} onClick={() => { void addUserStickers(); }}>{stickerAdding ? '新增中…' : '＋ 新增'}</button></div>
            <div className="admin-sticker-action"><input aria-label="要刪除的貼紙數量" type="number" inputMode="numeric" min={1} max={Math.max(1, selectedUserStickerCount)} value={stickerDeleteCount} disabled={selectedUserStickerCount === 0 || stickerDeleting} onChange={(event) => { setStickerDeleteCount(editableNumber(event.target.value, 1, Math.max(1, selectedUserStickerCount))); setConfirmStickerDelete(false); }} />{!confirmStickerDelete ? <button type="button" disabled={selectedUserStickerCount === 0 || stickerDeleting || numberValue(stickerDeleteCount) < 1 || numberValue(stickerDeleteCount) > selectedUserStickerCount} onClick={() => setConfirmStickerDelete(true)}>－ 刪除</button> : <div className="admin-inline-confirm"><button type="button" onClick={() => setConfirmStickerDelete(false)}>取消</button><button className="danger" type="button" disabled={stickerDeleting} onClick={() => { void deleteUserStickers(); }}>{stickerDeleting ? '刪除中…' : `確認 ${Math.floor(numberValue(stickerDeleteCount))} 張`}</button></div>}</div>
          </div>
          <section className="admin-redemption-manager">
            <div className="admin-data-heading"><h4>換領獎勵申請</h4><small>{selectedUser.redemptions.filter((redemption) => redemption.status === 'pending').length} 項待批</small></div>
            {selectedUser.redemptions.length ? <div className="admin-redemption-list">{selectedUser.redemptions.map((redemption) => <article key={redemption.id}>
              <div><strong>{redemption.rewardLabel}</strong><small>{redemption.stickerCost} 張貼紙 · {redemption.createdAt ? new Intl.DateTimeFormat('zh-HK', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Hong_Kong' }).format(new Date(redemption.createdAt)) : '剛剛申請'}</small></div>
              {redemption.status === 'pending' ? <div className="admin-redemption-actions"><button type="button" disabled={Boolean(redemptionResolvingId)} onClick={() => { void resolveRedemption(redemption.id, 'rejected'); }}>拒絕</button><button className="approve" type="button" disabled={Boolean(redemptionResolvingId)} onClick={() => { void resolveRedemption(redemption.id, 'approved'); }}>{redemptionResolvingId === redemption.id ? '處理中…' : '批准並扣除'}</button></div> : <span className={`admin-redemption-status ${redemption.status}`}>{redemption.status === 'approved' ? '已批准' : redemption.status === 'cancelled' ? '學生已取消' : '已拒絕'}</span>}
            </article>)}</div> : <p className="admin-redemption-empty">這個帳戶暫時沒有換領申請。</p>}
          </section>
          <div className="admin-data-heading"><h4>最近打卡資料</h4>{!selectedUserIsAdmin && selectedUser.sessions.length > 0 && <small>勾選要刪除的紀錄</small>}</div>
          {selectedUser.customTopics.length > 0 && <p className="admin-custom-topics"><strong>個人溫習選單：</strong>{selectedUser.customTopics.join('、')}</p>}
          <div className="admin-session-list">{selectedUser.sessions.length ? selectedUser.sessions.map((session) => {
            const sessionSelected = selectedSessionIds.includes(session.id);
            return <article className={sessionSelected ? 'selected' : ''} key={session.id}>
              {!selectedUserIsAdmin && <button className="admin-session-select" type="button" aria-label={`${sessionSelected ? '取消選擇' : '選擇'} ${session.studyDate} 的打卡`} aria-pressed={sessionSelected} onClick={() => toggleAdminSession(session.id)}><span>{sessionSelected ? '✓' : ''}</span></button>}
              <time>{session.studyDate}</time><div><strong>{session.topic}</strong><small>{session.note || '沒有備註'}</small>{(session.startImageData || session.endImageData) && <span className="admin-session-images">{session.startImageData && <img src={session.startImageData} alt={`${session.studyDate} 學習開始`} />}{session.endImageData && <img src={session.endImageData} alt={`${session.studyDate} 學習結束`} />}</span>}</div><b>{formatDuration(session.minutes)}</b>
            </article>;
          }) : <p>此帳戶尚未有打卡紀錄。</p>}</div>
          {!selectedUserIsAdmin && selectedSessionIds.length > 0 && <div className="admin-session-delete-bar"><div><strong>已選 {selectedSessionIds.length} 筆</strong><small>會同時刪除相關學習相片</small></div>{!confirmSessionDelete ? <button type="button" onClick={() => setConfirmSessionDelete(true)}>刪除已選紀錄</button> : <div className="admin-inline-confirm"><button type="button" disabled={sessionDeleting} onClick={() => setConfirmSessionDelete(false)}>取消</button><button className="danger" type="button" disabled={sessionDeleting} onClick={() => { void deleteSelectedUserSessions(); }}>{sessionDeleting ? '正在刪除…' : '確認刪除'}</button></div>}</div>}
          <div className="admin-delete-zone">{selectedUser.user.uid === firebaseAuth.currentUser?.uid ? <p>總管理員帳戶受保護，不能在此刪除。</p> : !confirmDelete ? <button type="button" onClick={() => setConfirmDelete(true)}>刪除這個帳戶</button> : <div><p>將永久刪除帳戶及所有 APP 資料，無法復原。</p><button type="button" onClick={() => setConfirmDelete(false)}>取消</button><button className="danger" disabled={deleting} type="button" onClick={() => { void deleteUser(); }}>{deleting ? '正在刪除…' : '確認永久刪除'}</button></div>}</div>
        </div> : <div className="admin-user-list">{loading ? <p>正在載入帳戶…</p> : users.length > 0 ? users.map((user) => <button type="button" key={user.uid} onClick={() => { void openUser(user.uid); }}><span>{(user.displayName || user.email || '同').slice(0, 1).toUpperCase()}</span><div><strong>{user.displayName || '未設定姓名'}</strong><small>{user.email || '已註冊帳戶'}</small></div><i>{user.emailVerified ? '已驗證' : '未驗證'} →</i></button>) : <div className="admin-empty-users"><p>未能顯示帳戶清單。</p><button type="button" onClick={() => { void loadUsers(); }}>重新載入帳戶</button></div>}</div>}
      </div>}
    </section>
  </div>;
}
