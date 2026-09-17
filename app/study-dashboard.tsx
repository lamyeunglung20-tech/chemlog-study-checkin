'use client';
/* eslint-disable @next/next/no-img-element -- User uploads use authenticated Firebase Storage URLs. */

import { type CSSProperties, ChangeEvent, FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, deleteDoc, deleteField, doc, getDoc, getDocs, onSnapshot, orderBy, query, runTransaction, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import AdminPanel from './admin-panel';
import { type AppConfig, type RewardOption } from './app-config';
import { firebaseDb } from './firebase-client';

type Session = {
  id: string;
  studyDate: string;
  minutes: number;
  topic: string;
  note: string | null;
  hasImage: boolean;
  hasStartImage: boolean;
  hasEndImage: boolean;
};

type DashboardData = {
  totalMinutes: number;
  weekMinutes: number;
  monthMinutes: number;
  sessions: Session[];
  daily: { date: string; minutes: number }[];
};

type LeaderboardEntry = {
  id: string;
  displayName: string;
  totalMinutes: number;
  weekMinutes: number;
  monthMinutes: number;
  weekKey: string;
  monthKey: string;
  avatarData: string;
  removedStickerCount: number;
  stickerBonusCount: number;
  isAdmin: boolean;
};

type LeaderboardPeriod = 'week' | 'month' | 'total';

type AvatarCropSource = {
  src: string;
  width: number;
  height: number;
};

type AvatarCropRect = {
  x: number;
  y: number;
  size: number;
};

type AvatarCropMode = 'move' | 'north-west' | 'north-east' | 'south-west' | 'south-east';

type EditableNumber = number | '';

type RedemptionRecord = {
  id: string;
  rewardLabel: string;
  stickerCost: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  deducted: boolean;
  createdAt: number;
};

const AVATAR_EDITOR_PADDING = 8;

const defaultTopicOptions = [
  ['mistakes', '溫習錯題簿'],
  ['notes', '溫習筆記'],
  ['flashcards', '溫習閃卡'],
  ['practice_questions', '操練試題'],
  ['practice_papers', '操練試卷'],
] as const;

const topicLabels: Record<string, string> = {
  ...Object.fromEntries(defaultTopicOptions),
  // Keep labels for records created before the menu was updated.
  concepts: '概念重溫',
  mc: '選擇題操練',
  structured: '結構題操練',
  experiment: '實驗與數據題',
  pastpaper: '歷屆試題',
};

function topicLabel(value: string) {
  return value.startsWith('custom:') ? value.slice(7) : topicLabels[value] ?? value;
}

function localDate(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function weekStartKey(dateString = localDate()) {
  const cursor = new Date(`${dateString}T12:00:00+08:00`);
  const weekday = cursor.getDay() || 7;
  cursor.setDate(cursor.getDate() - weekday + 1);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' }).format(cursor);
}

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (!hours) return `${mins} 分鐘`;
  if (!mins) return `${hours} 小時`;
  return `${hours} 小時 ${mins} 分鐘`;
}

function dashboardDataFromSessions(sessions: Session[]) {
  const today = localDate();
  const weekStart = weekStartKey(today);
  const monthKey = today.slice(0, 7);
  const dailyMap = new Map<string, number>();
  for (const session of sessions) dailyMap.set(session.studyDate, (dailyMap.get(session.studyDate) ?? 0) + session.minutes);
  return {
    totalMinutes: sessions.reduce((total, session) => total + session.minutes, 0),
    weekMinutes: sessions.filter((session) => session.studyDate >= weekStart).reduce((total, session) => total + session.minutes, 0),
    monthMinutes: sessions.filter((session) => session.studyDate.startsWith(monthKey)).reduce((total, session) => total + session.minutes, 0),
    sessions,
    daily: Array.from(dailyMap, ([date, minutes]) => ({ date, minutes })),
  } satisfies DashboardData;
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function editableNumber(value: string, min: number, max: number): EditableNumber {
  return value === '' ? '' : clampNumber(Number(value), min, max);
}

function numberValue(value: EditableNumber) {
  return value === '' ? 0 : value;
}

function isImageFile(file: File) {
  return file.type.startsWith('image/') || /\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/i.test(file.name);
}

function collectibleStickerIndex(userId: string, earnedIndex: number) {
  let hash = 2166136261;
  const seed = `${userId}:${earnedIndex}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 14;
}

async function compressImage(file: File) {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('IMAGE_UNREADABLE'));
      image.src = sourceUrl;
    });
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('IMAGE_UNREADABLE');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let quality = 0.78;
    let result = canvas.toDataURL('image/jpeg', quality);
    while (result.length > 720000 && quality > 0.42) {
      quality -= 0.08;
      result = canvas.toDataURL('image/jpeg', quality);
    }
    if (result.length > 720000) throw new Error('IMAGE_TOO_LARGE');
    return result;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function readAvatarSource(file: File) {
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('IMAGE_UNREADABLE'));
    reader.onerror = () => reject(new Error('IMAGE_UNREADABLE'));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('IMAGE_UNREADABLE'));
    image.src = src;
  });
  return { src, width: image.naturalWidth, height: image.naturalHeight } satisfies AvatarCropSource;
}

function defaultAvatarCrop(source: AvatarCropSource) {
  const size = Math.max(1, Math.min(source.width, source.height) * 0.82);
  return { x: (source.width - size) / 2, y: (source.height - size) / 2, size } satisfies AvatarCropRect;
}

function avatarEditorLayout(source: AvatarCropSource, editorSize: number) {
  const availableSize = Math.max(1, editorSize - AVATAR_EDITOR_PADDING * 2);
  const scale = availableSize / Math.max(source.width, source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    width,
    height,
    scale,
    left: (editorSize - width) / 2,
    top: (editorSize - height) / 2,
  };
}

function clampAvatarCrop(source: AvatarCropSource, crop: AvatarCropRect) {
  const minimum = Math.min(Math.min(source.width, source.height), Math.max(32, Math.min(source.width, source.height) * 0.15));
  const size = Math.min(Math.min(source.width, source.height), Math.max(minimum, crop.size));
  return {
    x: Math.min(source.width - size, Math.max(0, crop.x)),
    y: Math.min(source.height - size, Math.max(0, crop.y)),
    size,
  };
}

async function renderCroppedAvatar(source: AvatarCropSource, crop: AvatarCropRect) {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('IMAGE_UNREADABLE'));
    image.src = source.src;
  });
  const safeCrop = clampAvatarCrop(source, crop);
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 192;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('IMAGE_UNREADABLE');
  context.drawImage(image, safeCrop.x, safeCrop.y, safeCrop.size, safeCrop.size, 0, 0, canvas.width, canvas.height);
  let quality = 0.82;
  let result = canvas.toDataURL('image/jpeg', quality);
  while (result.length > 80000 && quality > 0.45) {
    quality -= 0.08;
    result = canvas.toDataURL('image/jpeg', quality);
  }
  if (result.length > 80000) throw new Error('IMAGE_TOO_LARGE');
  return result;
}

export default function StudyDashboard({ appConfig, isAdmin, studentEmail, studentName, userId, onChangeName, onLogout }: { appConfig: AppConfig; isAdmin: boolean; studentEmail: string; studentName: string; userId: string; onChangeName: (name: string) => Promise<void>; onLogout: () => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [manualHours, setManualHours] = useState<EditableNumber>(1);
  const [manualMinutePart, setManualMinutePart] = useState<EditableNumber>(0);
  const [studyDate, setStudyDate] = useState(localDate());
  const [topic, setTopic] = useState('mistakes');
  const [customTopics, setCustomTopics] = useState<string[]>([]);
  const [customTopicDraft, setCustomTopicDraft] = useState('');
  const [topicSaving, setTopicSaving] = useState(false);
  const [note, setNote] = useState('');
  const [startImageData, setStartImageData] = useState('');
  const [startImageName, setStartImageName] = useState('');
  const [startImageLoading, setStartImageLoading] = useState(true);
  const [startImageSaving, setStartImageSaving] = useState(false);
  const [startImagePreviewOpen, setStartImagePreviewOpen] = useState(false);
  const [endImageFile, setEndImageFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [selectedImageData, setSelectedImageData] = useState({ start: '', end: '' });
  const [imageLoading, setImageLoading] = useState(false);
  const startFileInputRef = useRef<HTMLInputElement | null>(null);
  const endFileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedDayDate, setSelectedDayDate] = useState('');
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [leaderboardPeriod, setLeaderboardPeriod] = useState<LeaderboardPeriod>('week');
  const [leaderboardEntries, setLeaderboardEntries] = useState<LeaderboardEntry[]>([]);
  const [leaderboardAvatarMap, setLeaderboardAvatarMap] = useState<Record<string, string>>({});
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [leaderboardReady, setLeaderboardReady] = useState(false);
  const [leaderboardReloadKey, setLeaderboardReloadKey] = useState(0);
  const [leaderboardError, setLeaderboardError] = useState('');
  const [avatarData, setAvatarData] = useState('');
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarSourcePickerOpen, setAvatarSourcePickerOpen] = useState(false);
  const [avatarCropSource, setAvatarCropSource] = useState<AvatarCropSource | null>(null);
  const [avatarCropRect, setAvatarCropRect] = useState<AvatarCropRect | null>(null);
  const [avatarEditorSize, setAvatarEditorSize] = useState(320);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [historyManageMode, setHistoryManageMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [bulkDeleteConfirming, setBulkDeleteConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [indiaIndexOpen, setIndiaIndexOpen] = useState(false);
  const [rewardsOpen, setRewardsOpen] = useState(false);
  const [rewardsLoading, setRewardsLoading] = useState(false);
  const [rewardError, setRewardError] = useState('');
  const [rewardConfirmingId, setRewardConfirmingId] = useState<RewardOption['id'] | ''>('');
  const [rewardRedeemingId, setRewardRedeemingId] = useState<RewardOption['id'] | ''>('');
  const [redemptionCancellingId, setRedemptionCancellingId] = useState('');
  const [redemptionCancelConfirmingId, setRedemptionCancelConfirmingId] = useState('');
  const [redemptionHistory, setRedemptionHistory] = useState<RedemptionRecord[]>([]);
  const [nameEditorOpen, setNameEditorOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(studentName);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState('');
  const [optimisticDisplayName, setOptimisticDisplayName] = useState('');
  const avatarLibraryInputRef = useRef<HTMLInputElement | null>(null);
  const avatarCameraInputRef = useRef<HTMLInputElement | null>(null);
  const avatarEditorRef = useRef<HTMLDivElement | null>(null);
  const avatarDragRef = useRef<{ pointerId: number; mode: AvatarCropMode; startX: number; startY: number; crop: AvatarCropRect; scale: number } | null>(null);

  async function saveOwnName(event: FormEvent) {
    event.preventDefault();
    const displayName = nameDraft.trim().slice(0, 40);
    if (!displayName) {
      setNameError('請輸入你的名字。');
      return;
    }
    setNameSaving(true);
    setNameError('');
    setOptimisticDisplayName(displayName);
    setNameEditorOpen(false);
    try {
      const leaderboardRef = doc(firebaseDb, 'leaderboard', userId);
      await setDoc(leaderboardRef, { displayName, updatedAt: serverTimestamp() }, { merge: true });
      setOptimisticDisplayName('');
      void onChangeName(displayName).catch(() => {});
      setNotice('名字已更新');
    } catch {
      setOptimisticDisplayName('');
      setNameEditorOpen(true);
      setNameError('未能更新名字，請稍後再試。');
    } finally {
      setNameSaving(false);
    }
  }

  const loadDashboard = useCallback(async () => {
    const [result, profileDocument, avatarDocument, topicPreferencesDocument] = await Promise.all([
      getDocs(query(collection(firebaseDb, 'users', userId, 'sessions'), orderBy('studyDate', 'desc'))),
      getDoc(doc(firebaseDb, 'leaderboard', userId)),
      getDoc(doc(firebaseDb, 'leaderboardAvatars', userId)),
      getDoc(doc(firebaseDb, 'users', userId, 'preferences', 'studyTopics')),
    ]);
    const sessions = result.docs.map((document) => {
      const values = document.data();
      return {
        id: document.id,
        studyDate: String(values.studyDate),
        minutes: Number(values.minutes),
        topic: String(values.topic),
        note: typeof values.note === 'string' && values.note ? values.note : null,
        hasImage: values.hasImage === true,
        hasStartImage: values.hasStartImage === true,
        hasEndImage: values.hasEndImage === true,
      } satisfies Session;
    });
    const today = localDate();
    const weekStart = weekStartKey(today);
    const monthKey = today.slice(0, 7);
    const dashboardData = dashboardDataFromSessions(sessions);
    setData(dashboardData);
    const separateAvatar = avatarDocument.data()?.avatarData;
    const legacyAvatar = profileDocument.data()?.avatarData;
    const storedAvatar = typeof separateAvatar === 'string' ? separateAvatar : legacyAvatar;
    if (typeof storedAvatar === 'string') setAvatarData(storedAvatar);
    if (!avatarDocument.exists() && typeof legacyAvatar === 'string' && legacyAvatar) {
      void Promise.all([
        setDoc(doc(firebaseDb, 'leaderboardAvatars', userId), { avatarData: legacyAvatar, updatedAt: serverTimestamp() }),
        setDoc(doc(firebaseDb, 'leaderboard', userId), { avatarData: deleteField() }, { merge: true }),
      ]).catch(() => {});
    }
    const storedTopics = topicPreferencesDocument.data()?.customTopics;
    if (Array.isArray(storedTopics)) {
      setCustomTopics(storedTopics.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim().slice(0, 30)).slice(0, 20));
    }
    try {
      const leaderboardRef = doc(firebaseDb, 'leaderboard', userId);
      await runTransaction(firebaseDb, async (transaction) => {
        const latestProfile = await transaction.get(leaderboardRef);
        const latestDisplayName = latestProfile.data()?.displayName;
        const studyMinuteAdjustment = Math.max(-5256000, Math.min(5256000, Math.floor(Number(latestProfile.data()?.studyMinuteAdjustment) || 0)));
        transaction.set(leaderboardRef, {
          ...(typeof latestDisplayName === 'string' && latestDisplayName.trim() ? {} : { displayName: studentName.trim().slice(0, 40) || '同學' }),
          totalMinutes: Math.max(0, Math.min(5256000, dashboardData.totalMinutes + studyMinuteAdjustment)),
          weekMinutes: dashboardData.weekMinutes,
          monthMinutes: dashboardData.monthMinutes,
          weekKey: weekStart,
          monthKey,
          isAdmin,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      });
    } catch {
      // The private dashboard remains available if leaderboard syncing is temporarily unavailable.
    }
  }, [isAdmin, studentName, userId]);

  function openLeaderboard() {
    setLeaderboardOpen(true);
    setLeaderboardLoading(!leaderboardReady && !leaderboardError);
  }

  useEffect(() => {
    const unsubscribeEntries = onSnapshot(collection(firebaseDb, 'leaderboard'), { includeMetadataChanges: true }, (result) => {
      setLeaderboardEntries(result.docs.map((document) => {
        const values = document.data();
        return {
          id: document.id,
          displayName: typeof values.displayName === 'string' && values.displayName ? values.displayName : '同學',
          totalMinutes: Number(values.totalMinutes) || 0,
          weekMinutes: Number(values.weekMinutes) || 0,
          monthMinutes: Number(values.monthMinutes) || 0,
          weekKey: typeof values.weekKey === 'string' ? values.weekKey : '',
          monthKey: typeof values.monthKey === 'string' ? values.monthKey : '',
          avatarData: typeof values.avatarData === 'string' ? values.avatarData : '',
          removedStickerCount: Math.max(0, Math.floor(Number(values.removedStickerCount) || 0)),
          stickerBonusCount: Math.max(0, Math.floor(Number(values.stickerBonusCount) || 0)),
          isAdmin: values.isAdmin === true,
        } satisfies LeaderboardEntry;
      }));
      setLeaderboardReady(true);
      setLeaderboardLoading(false);
    }, () => {
      setLeaderboardError('暫時未能載入排行榜，請稍後再試。');
      setLeaderboardLoading(false);
    });
    const unsubscribeAvatars = onSnapshot(collection(firebaseDb, 'leaderboardAvatars'), (result) => {
      setLeaderboardAvatarMap(Object.fromEntries(result.docs.map((document) => {
        const value = document.data().avatarData;
        return [document.id, typeof value === 'string' ? value : ''];
      })));
    }, () => {});
    return () => {
      unsubscribeEntries();
      unsubscribeAvatars();
    };
  }, [leaderboardReloadKey]);

  function reloadLeaderboard() {
    setLeaderboardError('');
    setLeaderboardLoading(true);
    setLeaderboardReloadKey((value) => value + 1);
  }

  async function openRewards() {
    setRewardsOpen(true);
    setRewardConfirmingId('');
    setRewardError('');
    setRewardsLoading(true);
    try {
      const snapshot = await getDocs(query(collection(firebaseDb, 'users', userId, 'redemptions'), orderBy('createdAt', 'desc')));
      setRedemptionHistory(snapshot.docs.map((entry) => {
        const values = entry.data();
        const createdAt = values.createdAt as { toMillis?: () => number } | undefined;
        return {
          id: entry.id,
          rewardLabel: typeof values.rewardLabel === 'string' ? values.rewardLabel : '獎勵',
          stickerCost: Math.max(0, Math.floor(Number(values.stickerCost) || 0)),
          status: values.status === 'approved' || values.status === 'rejected' || values.status === 'cancelled' ? values.status : 'pending',
          deducted: values.deducted !== false,
          createdAt: createdAt?.toMillis?.() ?? 0,
        } satisfies RedemptionRecord;
      }));
    } catch {
      setRewardError('暫時未能載入換領紀錄，請稍後再試。');
    } finally {
      setRewardsLoading(false);
    }
  }

  async function redeemReward(reward: RewardOption) {
    if (rewardRedeemingId) return;
    setRewardRedeemingId(reward.id);
    setRewardError('');
    const redemptionRef = doc(collection(firebaseDb, 'users', userId, 'redemptions'));
    try {
      const pendingStickerCount = redemptionHistory.filter((record) => record.status === 'pending' && !record.deducted).reduce((total, record) => total + record.stickerCost, 0);
      if (earnedStickerCount - pendingStickerCount < reward.stickerCost) throw new Error('INSUFFICIENT_STICKERS');
      await setDoc(redemptionRef, { rewardId: reward.id, rewardLabel: reward.label, stickerCost: reward.stickerCost, status: 'pending', deducted: false, createdAt: serverTimestamp() });
      setRedemptionHistory((history) => [{ id: redemptionRef.id, rewardLabel: reward.label, stickerCost: reward.stickerCost, status: 'pending', deducted: false, createdAt: Date.now() }, ...history]);
      setRewardConfirmingId('');
      setNotice(`已提交「${reward.label}」換領申請；管理員批准後才會扣除貼紙。`);
      window.setTimeout(() => setNotice(''), 4500);
    } catch (caught) {
      setRewardError((caught as Error).message === 'INSUFFICIENT_STICKERS' ? '你的貼紙數量不足，請繼續累積溫習時數。' : '未能完成換領，請稍後再試。');
    } finally {
      setRewardRedeemingId('');
    }
  }

  async function cancelRedemption(record: RedemptionRecord) {
    if (redemptionCancellingId || record.status !== 'pending' || record.deducted) return;
    setRedemptionCancellingId(record.id);
    setRewardError('');
    try {
      await updateDoc(doc(firebaseDb, 'users', userId, 'redemptions', record.id), {
        status: 'cancelled',
        cancelledAt: serverTimestamp(),
      });
      setRedemptionHistory((history) => history.map((item) => item.id === record.id ? { ...item, status: 'cancelled' } : item));
      setRedemptionCancelConfirmingId('');
      setNotice(`已取消「${record.rewardLabel}」的換領申請。`);
      window.setTimeout(() => setNotice(''), 3500);
    } catch {
      setRewardError('未能取消這項申請，可能已由管理員處理；請重新開啟換領紀錄。');
    } finally {
      setRedemptionCancellingId('');
    }
  }

  useEffect(() => {
    const loadTimer = window.setTimeout(() => { void loadDashboard(); }, 0);
    return () => window.clearTimeout(loadTimer);
  }, [loadDashboard]);

  useEffect(() => {
    const email = studentEmail.trim().toLowerCase();
    if (!email) return;
    void setDoc(doc(firebaseDb, 'profiles', userId), {
      email,
      updatedAt: serverTimestamp(),
    }, { merge: true }).catch(() => {});
  }, [studentEmail, userId]);

  useEffect(() => {
    const sessionsQuery = query(collection(firebaseDb, 'users', userId, 'sessions'), orderBy('studyDate', 'desc'));
    return onSnapshot(sessionsQuery, (result) => {
      const sessions = result.docs.map((document) => {
        const values = document.data();
        return {
          id: document.id,
          studyDate: String(values.studyDate),
          minutes: Number(values.minutes),
          topic: String(values.topic),
          note: typeof values.note === 'string' && values.note ? values.note : null,
          hasImage: values.hasImage === true,
          hasStartImage: values.hasStartImage === true,
          hasEndImage: values.hasEndImage === true,
        } satisfies Session;
      });
      const dashboardData = dashboardDataFromSessions(sessions);
      setData(dashboardData);
      setSelectedSession((current) => current && sessions.some((session) => session.id === current.id) ? current : null);
      const today = localDate();
      void runTransaction(firebaseDb, async (transaction) => {
        const leaderboardRef = doc(firebaseDb, 'leaderboard', userId);
        const leaderboardDocument = await transaction.get(leaderboardRef);
        const studyMinuteAdjustment = Math.max(-5256000, Math.min(5256000, Math.floor(Number(leaderboardDocument.data()?.studyMinuteAdjustment) || 0)));
        transaction.set(leaderboardRef, {
          totalMinutes: Math.max(0, Math.min(5256000, dashboardData.totalMinutes + studyMinuteAdjustment)),
          weekMinutes: dashboardData.weekMinutes,
          monthMinutes: dashboardData.monthMinutes,
          weekKey: weekStartKey(today),
          monthKey: today.slice(0, 7),
          isAdmin,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      }).catch(() => {});
    });
  }, [isAdmin, userId]);

  useEffect(() => {
    let cancelled = false;
    void getDoc(doc(firebaseDb, 'users', userId, 'draftImages', 'studyStart'))
      .then((draftDocument) => {
        if (cancelled) return;
        const storedImage = draftDocument.data()?.imageData;
        if (typeof storedImage === 'string' && storedImage) {
          setStartImageData(storedImage);
          setStartImageName('已自動儲存的開始相片');
        }
      })
      .catch(() => {
        if (!cancelled) setNotice('暫時未能載入已儲存的開始相片，請稍後再試。');
      })
      .finally(() => {
        if (!cancelled) setStartImageLoading(false);
      });
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    if (!leaderboardOpen && !rewardsOpen && !avatarSourcePickerOpen && !avatarCropSource && !startImagePreviewOpen) return;
    const previousOverflow = document.body.style.overflow;
    const previousOverscrollBehavior = document.body.style.overscrollBehavior;
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscrollBehavior;
    };
  }, [avatarCropSource, avatarSourcePickerOpen, leaderboardOpen, rewardsOpen, startImagePreviewOpen]);

  useEffect(() => {
    const editor = avatarEditorRef.current;
    if (!avatarCropSource || !editor) return;
    const updateSize = () => setAvatarEditorSize(Math.max(240, Math.round(editor.getBoundingClientRect().width)));
    updateSize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateSize);
    observer?.observe(editor);
    return () => observer?.disconnect();
  }, [avatarCropSource]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedSession || (!selectedSession.hasImage && !selectedSession.hasStartImage && !selectedSession.hasEndImage)) return;
    const legacyImage = selectedSession.hasImage && !selectedSession.hasStartImage && !selectedSession.hasEndImage;
    const readImage = async (imageId: string | null) => {
      if (!imageId) return '';
      const imageDocument = await getDoc(doc(firebaseDb, 'users', userId, 'sessionImages', imageId));
      const imageData = imageDocument.data()?.imageData;
      return typeof imageData === 'string' ? imageData : '';
    };
    void Promise.all([
      readImage(selectedSession.hasStartImage ? `${selectedSession.id}-start` : legacyImage ? selectedSession.id : null),
      readImage(selectedSession.hasEndImage ? `${selectedSession.id}-end` : null),
    ])
      .then(([start, end]) => {
        if (!cancelled) setSelectedImageData({ start, end });
      })
      .catch(() => { if (!cancelled) setSelectedImageData({ start: '', end: '' }); })
      .finally(() => { if (!cancelled) setImageLoading(false); });
    return () => { cancelled = true; };
  }, [selectedSession, userId]);

  function chooseQuickDuration(totalMinutes: number) {
    setManualHours(Math.floor(totalMinutes / 60));
    setManualMinutePart(totalMinutes % 60);
  }

  function openSession(session: Session) {
    setSelectedImageData({ start: '', end: '' });
    setImageLoading(session.hasImage || session.hasStartImage || session.hasEndImage);
    setDeleteConfirming(false);
    setSelectedSession(session);
  }

  async function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    if (!isImageFile(file) || file.size > 8 * 1024 * 1024) {
      setNotice(isImageFile(file) ? '頭像圖片不可超過 8 MB。' : '頭像只可使用圖片檔案。');
      event.target.value = '';
      return;
    }
    setAvatarSaving(true);
    try {
      const source = await readAvatarSource(file);
      setAvatarSourcePickerOpen(false);
      setAvatarCropSource(source);
      setAvatarCropRect(defaultAvatarCrop(source));
    } catch (caught) {
      const imageError = (caught as Error).message;
      setNotice(imageError === 'IMAGE_UNREADABLE' ? '未能讀取這張圖片，請轉用 JPG 或 PNG。' : '未能準備頭像，請稍後再試。');
    } finally {
      setAvatarSaving(false);
      if (avatarLibraryInputRef.current) avatarLibraryInputRef.current.value = '';
      if (avatarCameraInputRef.current) avatarCameraInputRef.current.value = '';
    }
  }

  function changeAvatarCropSize(value: number) {
    if (!avatarCropSource || !avatarCropRect) return;
    const nextSize = Math.min(Math.min(avatarCropSource.width, avatarCropSource.height), Math.max(1, value));
    const centerX = avatarCropRect.x + avatarCropRect.size / 2;
    const centerY = avatarCropRect.y + avatarCropRect.size / 2;
    setAvatarCropRect(clampAvatarCrop(avatarCropSource, { x: centerX - nextSize / 2, y: centerY - nextSize / 2, size: nextSize }));
  }

  function nudgeAvatar(x: number, y: number) {
    if (!avatarCropSource || !avatarCropRect) return;
    const editor = avatarEditorLayout(avatarCropSource, avatarEditorSize);
    const step = 8 / editor.scale;
    setAvatarCropRect((current) => current ? clampAvatarCrop(avatarCropSource, { ...current, x: current.x + x * step, y: current.y + y * step }) : current);
  }

  function resetAvatarCrop() {
    if (avatarCropSource) setAvatarCropRect(defaultAvatarCrop(avatarCropSource));
  }

  function handleAvatarPointerDown(event: ReactPointerEvent<HTMLElement>, mode: AvatarCropMode) {
    if (!avatarCropSource || !avatarCropRect) return;
    event.preventDefault();
    event.stopPropagation();
    avatarEditorRef.current?.setPointerCapture(event.pointerId);
    avatarDragRef.current = { pointerId: event.pointerId, mode, startX: event.clientX, startY: event.clientY, crop: avatarCropRect, scale: avatarEditorLayout(avatarCropSource, avatarEditorSize).scale };
  }

  function handleAvatarPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = avatarDragRef.current;
    if (!avatarCropSource || !drag || drag.pointerId !== event.pointerId) return;
    const dx = (event.clientX - drag.startX) / drag.scale;
    const dy = (event.clientY - drag.startY) / drag.scale;
    if (drag.mode === 'move') {
      setAvatarCropRect(clampAvatarCrop(avatarCropSource, { ...drag.crop, x: drag.crop.x + dx, y: drag.crop.y + dy }));
      return;
    }
    const outwardX = drag.mode.endsWith('east') ? dx : -dx;
    const outwardY = drag.mode.startsWith('south') ? dy : -dy;
    const delta = (outwardX + outwardY) / 2;
    let maxSize = Math.min(avatarCropSource.width, avatarCropSource.height);
    if (drag.mode === 'north-west') maxSize = Math.min(drag.crop.x + drag.crop.size, drag.crop.y + drag.crop.size);
    if (drag.mode === 'north-east') maxSize = Math.min(avatarCropSource.width - drag.crop.x, drag.crop.y + drag.crop.size);
    if (drag.mode === 'south-west') maxSize = Math.min(drag.crop.x + drag.crop.size, avatarCropSource.height - drag.crop.y);
    if (drag.mode === 'south-east') maxSize = Math.min(avatarCropSource.width - drag.crop.x, avatarCropSource.height - drag.crop.y);
    const minimum = Math.min(Math.min(avatarCropSource.width, avatarCropSource.height), Math.max(32, Math.min(avatarCropSource.width, avatarCropSource.height) * 0.15));
    const size = Math.min(maxSize, Math.max(minimum, drag.crop.size + delta));
    const anchored = {
      x: drag.mode.endsWith('west') ? drag.crop.x + drag.crop.size - size : drag.crop.x,
      y: drag.mode.startsWith('north') ? drag.crop.y + drag.crop.size - size : drag.crop.y,
      size,
    };
    setAvatarCropRect(clampAvatarCrop(avatarCropSource, anchored));
  }

  function handleAvatarPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (avatarDragRef.current?.pointerId === event.pointerId) avatarDragRef.current = null;
  }

  function cancelAvatarCrop() {
    avatarDragRef.current = null;
    setAvatarCropSource(null);
    setAvatarCropRect(null);
  }

  async function saveCroppedAvatar() {
    if (!avatarCropSource || !avatarCropRect) return;
    setAvatarSaving(true);
    try {
      const nextAvatar = await renderCroppedAvatar(avatarCropSource, avatarCropRect);
      const avatarWrites: Promise<unknown>[] = [
        setDoc(doc(firebaseDb, 'leaderboardAvatars', userId), { avatarData: nextAvatar, updatedAt: serverTimestamp() }),
      ];
      if (data) {
        avatarWrites.push(setDoc(doc(firebaseDb, 'leaderboard', userId), {
          displayName: displayStudentName.trim().slice(0, 40) || '同學',
          isAdmin,
          avatarData: deleteField(),
          updatedAt: serverTimestamp(),
        }, { merge: true }));
      }
      await Promise.all(avatarWrites);
      setAvatarData(nextAvatar);
      setLeaderboardAvatarMap((avatars) => ({ ...avatars, [userId]: nextAvatar }));
      setAvatarCropSource(null);
      setNotice('頭像已裁剪並更新。');
      window.setTimeout(() => setNotice(''), 3000);
    } catch (caught) {
      const imageError = (caught as Error).message;
      setNotice(imageError === 'IMAGE_UNREADABLE' ? '未能讀取這張圖片，請轉用 JPG 或 PNG。' : '未能更新頭像，請稍後再試。');
    } finally {
      setAvatarSaving(false);
    }
  }

  async function deleteSessions(sessionsToDelete: Session[], closeRecordModal = false) {
    if (sessionsToDelete.length === 0) return;
    setDeleting(true);
    try {
      const batch = writeBatch(firebaseDb);
      for (const session of sessionsToDelete) {
        batch.delete(doc(firebaseDb, 'users', userId, 'sessions', session.id));
        batch.delete(doc(firebaseDb, 'users', userId, 'sessionImages', session.id));
        batch.delete(doc(firebaseDb, 'users', userId, 'sessionImages', `${session.id}-start`));
        batch.delete(doc(firebaseDb, 'users', userId, 'sessionImages', `${session.id}-end`));
      }
      await batch.commit();
      if (closeRecordModal) setSelectedSession(null);
      setDeleteConfirming(false);
      setBulkDeleteConfirming(false);
      setHistoryManageMode(false);
      setSelectedSessionIds([]);
      setNotice(sessionsToDelete.length === 1 ? '打卡紀錄已刪除。' : `已刪除 ${sessionsToDelete.length} 筆打卡紀錄。`);
      await loadDashboard();
      window.setTimeout(() => setNotice(''), 3000);
    } catch {
      setNotice('未能刪除這筆紀錄，請稍後再試。');
    } finally {
      setDeleting(false);
    }
  }

  async function deleteSelectedSession() {
    if (!selectedSession) return;
    await deleteSessions([selectedSession], true);
  }

  function toggleHistorySelection(sessionId: string) {
    setSelectedSessionIds((current) => current.includes(sessionId) ? current.filter((id) => id !== sessionId) : [...current, sessionId]);
    setBulkDeleteConfirming(false);
  }

  function closeHistoryManager() {
    setHistoryManageMode(false);
    setSelectedSessionIds([]);
    setBulkDeleteConfirming(false);
  }

  async function deleteChosenSessions() {
    const chosenSessions = data?.sessions.filter((session) => selectedSessionIds.includes(session.id)) ?? [];
    await deleteSessions(chosenSessions);
  }

  async function handleImageChange(event: ChangeEvent<HTMLInputElement>, phase: 'start' | 'end') {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setNotice('只可上載圖片檔案。');
      event.target.value = '';
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setNotice('圖片不可超過 8 MB。');
      event.target.value = '';
      return;
    }
    if (phase === 'end') {
      setEndImageFile(file);
      setNotice('');
      return;
    }
    setStartImageSaving(true);
    setNotice('正在自動儲存開始相片…');
    try {
      const imageData = await compressImage(file);
      await setDoc(doc(firebaseDb, 'users', userId, 'draftImages', 'studyStart'), {
        imageData,
        updatedAt: serverTimestamp(),
      });
      setStartImageData(imageData);
      setStartImageName(file.name);
      setNotice('開始相片已自動儲存，登出後仍會保留。');
      window.setTimeout(() => setNotice(''), 3500);
    } catch (caught) {
      const imageError = (caught as Error).message;
      setNotice(imageError === 'IMAGE_TOO_LARGE' ? '圖片壓縮後仍然太大，請選擇另一張圖片。' : imageError === 'IMAGE_UNREADABLE' ? '未能讀取這張圖片，請轉用 JPG 或 PNG。' : '未能自動儲存開始相片，請稍後再試。');
    } finally {
      setStartImageSaving(false);
      if (startFileInputRef.current) startFileInputRef.current.value = '';
    }
  }

  async function deleteSavedStartImage() {
    if (!startImageData || startImageSaving) return;
    setStartImageSaving(true);
    try {
      await deleteDoc(doc(firebaseDb, 'users', userId, 'draftImages', 'studyStart'));
      setStartImageData('');
      setStartImageName('');
      setStartImagePreviewOpen(false);
      if (startFileInputRef.current) startFileInputRef.current.value = '';
      setNotice('已刪除自動儲存的開始相片。');
      window.setTimeout(() => setNotice(''), 3000);
    } catch {
      setNotice('未能刪除開始相片，請稍後再試。');
    } finally {
      setStartImageSaving(false);
    }
  }

  async function saveSession(minutes: number) {
    if (minutes < 1 || minutes > 720) {
      setNotice('每次打卡的溫習時間須為 1 分鐘至 12 小時。');
      return;
    }
    if (topic === '__custom__') {
      setNotice('請先輸入並儲存你的自訂溫習內容。');
      return;
    }
    if (!startImageData || !endImageFile) {
      setNotice(!startImageData && !endImageFile ? '請先上載學習開始及學習結束相片。' : !startImageData ? '請先上載學習開始相片。' : '請先上載學習結束相片。');
      return;
    }
    setSaving(true);
    try {
      const sessionRef = doc(collection(firebaseDb, 'users', userId, 'sessions'));
      const savedStartImageData = startImageData;
      const endImageData = await compressImage(endImageFile);
      const batch = writeBatch(firebaseDb);
      batch.set(sessionRef, {
        studyDate,
        minutes,
        topic,
        note: note.trim().slice(0, 80),
        hasImage: true,
        hasStartImage: true,
        hasEndImage: true,
        createdAt: serverTimestamp(),
      });
      batch.set(doc(firebaseDb, 'users', userId, 'sessionImages', `${sessionRef.id}-start`), { imageData: savedStartImageData, createdAt: serverTimestamp() });
      batch.set(doc(firebaseDb, 'users', userId, 'sessionImages', `${sessionRef.id}-end`), { imageData: endImageData, createdAt: serverTimestamp() });
      batch.delete(doc(firebaseDb, 'users', userId, 'draftImages', 'studyStart'));
      await batch.commit();
      setNotice(`打卡成功！已加入 ${formatDuration(minutes)}。`);
      setNote('');
      setStartImageData('');
      setStartImageName('');
      setEndImageFile(null);
      if (startFileInputRef.current) startFileInputRef.current.value = '';
      if (endFileInputRef.current) endFileInputRef.current.value = '';
      await loadDashboard();
      window.setTimeout(() => setNotice(''), 3800);
    } catch (caught) {
      const imageError = (caught as Error).message;
      setNotice(imageError === 'IMAGE_TOO_LARGE' ? '圖片壓縮後仍然太大，請選擇另一張圖片。' : imageError === 'IMAGE_UNREADABLE' ? '未能讀取這張圖片，請轉用 JPG 或 PNG。' : '未能儲存，請稍後再試。');
    } finally {
      setSaving(false);
    }
  }

  function handleManualSubmit(event: FormEvent) {
    event.preventDefault();
    void saveSession(numberValue(manualHours) * 60 + numberValue(manualMinutePart));
  }

  async function saveCustomTopic() {
    const nextTopic = customTopicDraft.trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!nextTopic) {
      setNotice('請輸入自訂溫習內容。');
      return;
    }
    const defaultMatch = defaultTopicOptions.find(([, label]) => label === nextTopic);
    if (defaultMatch) {
      setTopic(defaultMatch[0]);
      setCustomTopicDraft('');
      setNotice('這個項目已在預設選單內。');
      return;
    }
    const existingTopic = customTopics.find((value) => value.toLocaleLowerCase('zh-HK') === nextTopic.toLocaleLowerCase('zh-HK'));
    if (existingTopic) {
      setTopic(`custom:${existingTopic}`);
      setCustomTopicDraft('');
      setNotice('已選擇你先前儲存的項目。');
      return;
    }
    if (customTopics.length >= 20) {
      setNotice('個人選單最多可儲存 20 個項目。');
      return;
    }
    const nextTopics = [...customTopics, nextTopic];
    setTopicSaving(true);
    try {
      await setDoc(doc(firebaseDb, 'users', userId, 'preferences', 'studyTopics'), {
        customTopics: nextTopics,
        updatedAt: serverTimestamp(),
      });
      setCustomTopics(nextTopics);
      setTopic(`custom:${nextTopic}`);
      setCustomTopicDraft('');
      setNotice('已儲存至你的個人選單。');
      window.setTimeout(() => setNotice(''), 3000);
    } catch {
      setNotice('未能儲存個人選單，請稍後再試。');
    } finally {
      setTopicSaving(false);
    }
  }

  const lastSevenDays = useMemo(() => {
    const minutesByDate = new Map((data?.daily ?? []).map((item) => [item.date, item.minutes]));
    return Array.from({ length: 7 }, (_, index) => {
      const date = localDate(index - 6);
      return { date, minutes: minutesByDate.get(date) ?? 0 };
    });
  }, [data]);
  const maxDay = Math.max(60, ...lastSevenDays.map((day) => day.minutes));
  const selectedDay = lastSevenDays.find((day) => day.date === selectedDayDate);
  const selectedQuickMinutes = numberValue(manualHours) * 60 + numberValue(manualMinutePart);
  const currentWeekKey = weekStartKey();
  const currentMonthKey = localDate().slice(0, 7);
  const ownLeaderboardEntry = leaderboardEntries.find((entry) => entry.id === userId);
  const ownTotalMinutes = ownLeaderboardEntry?.totalMinutes ?? data?.totalMinutes ?? 0;
  const displayStudentName = optimisticDisplayName || ownLeaderboardEntry?.displayName || studentName;
  const rankableEntries = leaderboardEntries.filter((entry) => !entry.isAdmin && !(isAdmin && entry.id === userId));
  const rankedEntries = rankableEntries
    .map((entry) => ({
      ...entry,
      avatarData: leaderboardAvatarMap[entry.id] || entry.avatarData,
      score: leaderboardPeriod === 'total' ? entry.totalMinutes : leaderboardPeriod === 'month' ? (entry.monthKey === currentMonthKey ? entry.monthMinutes : 0) : (entry.weekKey === currentWeekKey ? entry.weekMinutes : 0),
    }))
    .sort((left, right) => right.score - left.score || left.displayName.localeCompare(right.displayName, 'zh-HK'));
  const weeklyChampion = rankableEntries
    .filter((entry) => entry.weekKey === currentWeekKey && entry.weekMinutes > 0)
    .map((entry) => ({ ...entry, avatarData: leaderboardAvatarMap[entry.id] || entry.avatarData }))
    .sort((left, right) => right.weekMinutes - left.weekMinutes || left.displayName.localeCompare(right.displayName, 'zh-HK'))[0] ?? null;
  const earnedStickerCount = Math.max(0, Math.floor(ownTotalMinutes / 60) + (ownLeaderboardEntry?.stickerBonusCount ?? 0) - (ownLeaderboardEntry?.removedStickerCount ?? 0));
  const pendingStickerCount = redemptionHistory.filter((record) => record.status === 'pending' && !record.deducted).reduce((total, record) => total + record.stickerCost, 0);
  const requestableStickerCount = Math.max(0, earnedStickerCount - pendingStickerCount);
  const earnedStickers = Array.from({ length: earnedStickerCount }, (_, index) => collectibleStickerIndex(userId, index));
  const avatarPreview = avatarCropSource && avatarCropRect ? (() => {
    const editor = avatarEditorLayout(avatarCropSource, avatarEditorSize);
    return {
      editor,
      crop: {
        left: editor.left + avatarCropRect.x * editor.scale,
        top: editor.top + avatarCropRect.y * editor.scale,
        size: avatarCropRect.size * editor.scale,
      },
    };
  })() : null;
  const avatarCropMinimum = avatarCropSource ? Math.min(Math.min(avatarCropSource.width, avatarCropSource.height), Math.max(32, Math.min(avatarCropSource.width, avatarCropSource.height) * 0.15)) : 1;
  const rewardOptions = appConfig.rewards;

  return (
    <main className="app-shell" style={{ '--app-bg': appConfig.backgroundColor } as CSSProperties}>
      <header className="topbar">
        <div className="brand-cluster">
          <a className="brand" href="#top" aria-label="ChemLog 首頁">
            <span className="brand-mark" aria-hidden="true">{appConfig.iconData ? <img src={appConfig.iconData} alt="" /> : '⚗'}</span>
            <span><strong>{appConfig.appName}</strong>{appConfig.subtitle && <small>{appConfig.subtitle}</small>}</span>
          </a>
          {isAdmin && <button className="admin-link" type="button" onClick={() => setAdminOpen(true)}><span aria-hidden="true">⚙</span>管理中心</button>}
        </div>
        <div className="header-actions">
          <div className="student-chip"><button className={`student-avatar ${avatarSaving ? 'is-saving' : ''}`} type="button" title="按此更換頭像" aria-label="更換及裁剪個人頭像" disabled={avatarSaving} onClick={() => setAvatarSourcePickerOpen(true)}>{avatarData ? <img src={avatarData} alt="你的頭像" /> : <span>{displayStudentName.slice(0, 1).toUpperCase()}</span>}<i aria-hidden="true">✎</i></button><p><small>正在學習</small>{displayStudentName}</p><button className="profile-name-button" type="button" aria-label="修改名字" onClick={() => { setNameDraft(displayStudentName); setNameError(''); setNameEditorOpen(true); }}><span aria-hidden="true">✎</span><em>修改名字</em></button></div>
          <button className="logout-link" type="button" onClick={onLogout}>登出</button>
        </div>
      </header>

      <div className="dashboard" id="top">
        <section className={`total-card ${indiaIndexOpen ? 'is-flipped' : ''}`} aria-label={indiaIndexOpen ? '印度指數貼紙收藏' : '累計溫習時間'}>
          <div className="total-card-inner">
            <div className="total-card-face total-card-front" aria-hidden={indiaIndexOpen}>
              <div className="molecule molecule-one" /><div className="molecule molecule-two" />
              <p>我的化學溫習總時間</p>
              <div className="total-number">
                <strong>{Math.floor(ownTotalMinutes / 60)}</strong><span>小時</span>
                <strong>{ownTotalMinutes % 60}</strong><span>分鐘</span>
              </div>
              <div className="weekly-champion-spotlight">
                <div className="weekly-champion-banner">{appConfig.championMessage}</div>
                <div className={`weekly-champion ${weeklyChampion ? '' : 'is-empty'}`}>
                  <span className="champion-hearts" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <i key={index}>♥</i>)}</span>
                  <p><span aria-hidden="true">♛</span>本週第一名</p>
                  <span className="weekly-champion-avatar" aria-hidden="true">{weeklyChampion?.avatarData ? <img src={weeklyChampion.avatarData} alt="" /> : weeklyChampion ? weeklyChampion.displayName.slice(0, 1).toUpperCase() : '？'}</span>
                  <strong>{weeklyChampion?.displayName || '本週榜首等你來'}</strong>
                </div>
              </div>
              <div className="total-card-actions">
                <button className="total-leaderboard-button" type="button" tabIndex={indiaIndexOpen ? -1 : 0} onClick={() => { void openLeaderboard(); }}><span aria-hidden="true">♛</span>查看排行榜</button>
                <button className="india-index-button" type="button" tabIndex={indiaIndexOpen ? -1 : 0} onClick={() => setIndiaIndexOpen(true)}><span aria-hidden="true">✦</span>查看印度指數</button>
                <button className="reward-button" type="button" tabIndex={indiaIndexOpen ? -1 : 0} onClick={() => { void openRewards(); }}><span aria-hidden="true">♥</span>換領獎勵</button>
              </div>
            </div>
            <div className="total-card-face total-card-back" aria-hidden={!indiaIndexOpen}>
              <div className="sticker-back-heading"><div><p>印度指數</p><h2>已收集 {earnedStickerCount} 張貼紙</h2><small>每累積溫習 1 小時，隨機解鎖 1 張原創人物貼紙。</small></div><button type="button" tabIndex={indiaIndexOpen ? 0 : -1} onClick={() => setIndiaIndexOpen(false)}>返回總時數 ↻</button></div>
              {earnedStickers.length ? <div className="sticker-collection" aria-label={`已收集 ${earnedStickerCount} 張貼紙`}>{earnedStickers.map((sticker, index) => <span className="india-sticker" role="img" aria-label={`印度人物貼紙 ${index + 1}`} title={`第 ${index + 1} 小時解鎖`} key={`${index}-${sticker}`} style={{ '--sticker-column': sticker % 7, '--sticker-row': Math.floor(sticker / 7) } as CSSProperties} />)}</div> : <div className="sticker-empty"><span>✦</span><strong>第一張貼紙正等你解鎖</strong><p>累積完成 1 小時化學溫習便可獲得。</p></div>}
            </div>
          </div>
        </section>

        <section className="manual-card" id="manual-checkin">
          <div className="section-heading"><div><span className="step-number coral">01</span><h2>加入打卡</h2></div><span className="soft-label">記錄今天的溫習成果</span></div>
          <form onSubmit={handleManualSubmit}>
            <fieldset><legend>溫習時長</legend><div className="quick-times">
              {[30, 60, 90, 120].map((value) => <button type="button" className={selectedQuickMinutes === value ? 'selected' : ''} onClick={() => chooseQuickDuration(value)} key={value}><strong>{value >= 60 ? value / 60 : value}</strong><small>{value >= 60 ? '小時' : '分鐘'}</small></button>)}
            </div></fieldset>
            <div className="custom-duration"><p>自行輸入</p><div>
              <label><input type="number" inputMode="numeric" min="0" max="12" value={manualHours} onChange={(event) => setManualHours(editableNumber(event.target.value, 0, 12))} /><span>小時</span></label>
              <label><input type="number" inputMode="numeric" min="0" max="59" value={manualMinutePart} onChange={(event) => setManualMinutePart(editableNumber(event.target.value, 0, 59))} /><span>分鐘</span></label>
            </div></div>
            <div className="form-grid">
              <label className="date-field">日期<span className="date-input-shell"><span className="date-input-value" aria-hidden="true">{new Intl.DateTimeFormat('zh-HK', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Hong_Kong' }).format(new Date(`${studyDate}T12:00:00+08:00`))}</span><input className="study-date-input" aria-label="日期" type="date" value={studyDate} max={localDate()} onChange={(event) => setStudyDate(event.target.value)} required /></span></label>
              <label>溫習內容<select value={topic} onChange={(event) => { setTopic(event.target.value); if (event.target.value !== '__custom__') setCustomTopicDraft(''); }}><optgroup label="預設選項">{defaultTopicOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</optgroup>{customTopics.length > 0 && <optgroup label="我的個人選單">{customTopics.map((label) => <option value={`custom:${label}`} key={label}>{label}</option>)}</optgroup>}<option value="__custom__">＋ 自行輸入並儲存</option></select></label>
            </div>
            {topic === '__custom__' && <div className="custom-topic-editor"><label>自訂溫習內容<input type="text" maxLength={30} value={customTopicDraft} onChange={(event) => setCustomTopicDraft(event.target.value)} placeholder="例如：溫習有機化學反應" autoFocus /></label><button type="button" disabled={topicSaving || !customTopicDraft.trim()} onClick={() => { void saveCustomTopic(); }}>{topicSaving ? '正在儲存…' : '儲存至個人選單'}</button><small>儲存後，下次登入仍可直接選用。</small></div>}
            <label className="note-label">給今天的自己一句話（選填）<input type="text" maxLength={80} value={note} onChange={(event) => setNote(event.target.value)} placeholder="例：終於弄懂電解池了！" /></label>
            <fieldset className="photo-fieldset"><legend>學習相片 <span className="required-badge">必填：開始及結束</span></legend><div className="photo-upload-grid">
              <div className="upload-label"><span>學習開始（必填）</span><label className={`upload-shell ${startImageData ? 'has-file' : ''}`}><span aria-hidden="true">▶</span><strong>{startImageLoading ? '正在載入已儲存相片…' : startImageSaving ? '正在自動儲存…' : startImageData ? startImageName : '上載開始溫習的相片'}</strong><small>{startImageData ? '已儲存至你的帳戶，按此可更換' : '必須上載；選好後自動儲存並跨登入保留'}</small><input ref={startFileInputRef} type="file" accept="image/*" aria-required="true" disabled={startImageLoading || startImageSaving} onChange={(event) => { void handleImageChange(event, 'start'); }} /></label>{startImageData && <div className="saved-start-photo"><button className="saved-start-photo-preview" type="button" aria-label="放大查看已儲存的學習開始相片" onClick={() => setStartImagePreviewOpen(true)}><img src={startImageData} alt="已自動儲存的學習開始相片" /><span aria-hidden="true">⌕</span></button><div><strong>已自動儲存</strong><small>按相片可放大查看</small></div><button className="delete-saved-start-photo" type="button" disabled={startImageSaving} onClick={() => { void deleteSavedStartImage(); }}>{startImageSaving ? '處理中…' : '刪除相片'}</button></div>}</div>
              <label className="upload-label"><span>學習結束（必填）</span><span className={`upload-shell ${endImageFile ? 'has-file' : ''}`}><span aria-hidden="true">✓</span><strong>{endImageFile ? endImageFile.name : '上載完成溫習的相片'}</strong><small>{endImageFile ? '按此更換相片' : '必須上載；常用圖片格式，最多 8 MB'}</small><input ref={endFileInputRef} type="file" accept="image/*" aria-required="true" onChange={(event) => handleImageChange(event, 'end')} /></span></label>
            </div></fieldset>
            <button className="checkin-button" disabled={saving || startImageSaving || startImageLoading || selectedQuickMinutes < 1 || !startImageData || !endImageFile} type="submit">{saving ? '正在儲存…' : startImageSaving ? '正在儲存開始相片…' : !startImageData || !endImageFile ? '上載開始及結束相片後打卡' : '完成今日打卡'}<span>＋</span></button>
          </form>
        </section>

        <section className="progress-card">
          <div className="progress-top week-summary"><div><p className="eyebrow">本週溫習時數</p><h2>{formatDuration(data?.weekMinutes ?? 0)}</h2></div><strong>近 7 天</strong></div>
          <div className="chart" aria-label="最近七天溫習時間圖表">
            {lastSevenDays.map((day) => <button type="button" className={`chart-day ${selectedDayDate === day.date ? 'selected' : ''}`} key={day.date} aria-pressed={selectedDayDate === day.date} aria-label={`查看 ${day.date} 的溫習時間`} onClick={() => setSelectedDayDate(day.date)}><span className="bar-wrap"><span title={`${day.minutes} 分鐘`} style={{ height: `${Math.max(5, (day.minutes / maxDay) * 100)}%` }} /></span><small>{new Intl.DateTimeFormat('zh-HK', { weekday: 'narrow', timeZone: 'Asia/Hong_Kong' }).format(new Date(`${day.date}T12:00:00+08:00`))}</small></button>)}
          </div>
          {selectedDay && <div className="day-insight" role="status"><span>{new Intl.DateTimeFormat('zh-HK', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Hong_Kong' }).format(new Date(`${selectedDay.date}T12:00:00+08:00`))}</span><strong>{formatDuration(selectedDay.minutes)}</strong></div>}
          <p className="encouragement">{(data?.weekMinutes ?? 0) > 0 ? `本週已累積 ${formatDuration(data?.weekMinutes ?? 0)}，繼續保持你的節奏。` : '本週的第一筆溫習紀錄，等你寫下。'}</p>
        </section>

        <section className="history-card">
          <div className="section-heading history-heading"><div><span className="step-number pale">✓</span><h2>最近打卡</h2></div><div className="history-controls"><span className="record-count">按日期可查看完整紀錄及相片</span>{data && data.sessions.length > 0 && <button className={`manage-history-button ${historyManageMode ? 'active' : ''}`} type="button" onClick={() => historyManageMode ? closeHistoryManager() : setHistoryManageMode(true)}>{historyManageMode ? '取消' : '選擇刪除'}</button>}</div></div>
          {!data ? <div className="empty-state">正在整理你的溫習紀錄…</div> : data.sessions.length === 0 ? <div className="empty-state"><span>⌁</span><strong>第一筆紀錄，等你寫下。</strong><p>今天留校溫習了多久？在上方完成你的首次打卡吧。</p></div> : (
            <><div className={`history-list ${data.sessions.length > 3 ? 'is-scrollable' : ''}`} tabIndex={data.sessions.length > 3 ? 0 : undefined} aria-label={data.sessions.length > 3 ? '最近打卡紀錄，可上下滑動查看更多' : '最近打卡紀錄'}>{data.sessions.map((session) => {
              const sessionDate = new Date(`${session.studyDate}T12:00:00+08:00`);
              const isSelected = selectedSessionIds.includes(session.id);
              return <article className={`${historyManageMode ? 'selecting' : ''} ${isSelected ? 'selected' : ''}`} key={session.id}>
                {historyManageMode && <button className="history-select-button" type="button" aria-pressed={isSelected} aria-label={`${isSelected ? '取消選擇' : '選擇'} ${session.studyDate} 的打卡紀錄`} onClick={() => toggleHistorySelection(session.id)}><span>{isSelected ? '✓' : ''}</span></button>}
                <button className="session-date-button" type="button" onClick={() => historyManageMode ? toggleHistorySelection(session.id) : openSession(session)} aria-label={historyManageMode ? `${isSelected ? '取消選擇' : '選擇'} ${session.studyDate} 的打卡紀錄` : `查看 ${session.studyDate} 的打卡詳情`}><time dateTime={session.studyDate}><strong>{sessionDate.getDate()}</strong><span>{new Intl.DateTimeFormat('zh-HK', { month: 'short', timeZone: 'Asia/Hong_Kong' }).format(sessionDate)}</span><small>{sessionDate.getFullYear()}</small></time></button>
                <div className="history-detail"><strong>{topicLabel(session.topic)}</strong><span className="duration">{formatDuration(session.minutes)}</span></div>
              </article>;
            })}{historyManageMode && <div className="history-delete-panel"><div><strong>已選 {selectedSessionIds.length} 筆</strong><small>只會刪除你選取的紀錄及相關相片</small></div>{!bulkDeleteConfirming ? <button type="button" disabled={selectedSessionIds.length === 0} onClick={() => setBulkDeleteConfirming(true)}>刪除已選紀錄</button> : <div className="bulk-delete-confirm"><span>確定刪除？</span><button type="button" onClick={() => setBulkDeleteConfirming(false)} disabled={deleting}>返回</button><button className="danger" type="button" onClick={() => { void deleteChosenSessions(); }} disabled={deleting}>{deleting ? '正在刪除…' : '確定刪除'}</button></div>}</div>}</div>{data.sessions.length > 3 && <p className="history-scroll-hint"><span aria-hidden="true">↕</span> 上下滑動查看更多打卡</p>}</>
          )}
        </section>
      </div>

      {leaderboardOpen && <div className="record-modal-backdrop leaderboard-backdrop" role="presentation" onClick={() => setLeaderboardOpen(false)}>
        <section className="leaderboard-modal" role="dialog" aria-modal="true" aria-labelledby="leaderboard-title" onClick={(event) => event.stopPropagation()}>
          <div className="leaderboard-modal-header"><div><p className="auth-kicker">CHEMLOG 同學榜</p><h2 id="leaderboard-title">溫習排行榜</h2><p className="leaderboard-copy">看看大家累積的努力，一起保持溫習節奏。</p></div><button className="modal-close" type="button" aria-label="關閉排行榜" onClick={() => setLeaderboardOpen(false)}>×</button></div>
          <div className="leaderboard-tabs" role="tablist" aria-label="排行榜時段">
            {([['week', '本週'], ['month', '本月'], ['total', '總時數']] as const).map(([value, label]) => <button type="button" role="tab" aria-selected={leaderboardPeriod === value} className={leaderboardPeriod === value ? 'selected' : ''} onClick={() => setLeaderboardPeriod(value)} key={value}>{label}</button>)}
          </div>
          <div className="leaderboard-scroll-region" tabIndex={0} aria-label="排行榜名單，可上下滑動">
            {leaderboardLoading ? <div className="leaderboard-state">正在同步最新排行榜…</div> : leaderboardError ? <div className="leaderboard-state error"><p>{leaderboardError}</p><button type="button" onClick={reloadLeaderboard}>重新載入</button></div> : rankedEntries.length === 0 ? <div className="leaderboard-state">暫時未有同學上榜。</div> : <div className="leaderboard-list">
              {rankedEntries.map((entry, index) => <article className={entry.id === userId ? 'is-me' : ''} key={entry.id}>
                <span className={`rank rank-${index + 1}`}>{index < 3 ? ['♛', '◆', '●'][index] : index + 1}</span>
                <span className="leaderboard-avatar" aria-hidden="true">{entry.avatarData ? <img src={entry.avatarData} alt="" /> : entry.displayName.slice(0, 1).toUpperCase()}</span>
                <div className="leaderboard-person"><span><strong>{entry.displayName}</strong>{entry.id === userId && <small>你</small>}</span><em><span aria-hidden="true">✦</span>印度指數 {Math.max(0, Math.floor(entry.totalMinutes / 60) + entry.stickerBonusCount - entry.removedStickerCount)}</em></div>
                <b>{formatDuration(entry.score)}</b>
              </article>)}
            </div>}
            <small className="leaderboard-note">榜單會即時同步；印度指數代表已收集的印度人貼紙數量。</small>
          </div>
        </section>
      </div>}

      {rewardsOpen && <div className="record-modal-backdrop rewards-backdrop" role="presentation" onClick={() => setRewardsOpen(false)}>
        <section className="rewards-modal" role="dialog" aria-modal="true" aria-labelledby="rewards-title" onClick={(event) => event.stopPropagation()}>
          <div className="rewards-modal-header">
            <div><p className="auth-kicker">CHEMLOG 獎勵站</p><div className="rewards-heading"><div><h2 id="rewards-title">換領獎勵</h2><p>提交申請後，管理員批准時才會扣除貼紙。</p></div><strong><span aria-hidden="true">✦</span>{requestableStickerCount} 張可申請</strong></div></div>
            <button className="modal-close" type="button" aria-label="關閉獎勵換領" onClick={() => setRewardsOpen(false)}>×</button>
          </div>
          <div className="rewards-scroll-region">
            <div className={`reward-options ${rewardOptions.length === 0 ? 'is-empty' : ''}`}>
              {rewardOptions.length === 0 ? <p className="reward-empty">目前未有可換領的獎勵，請稍後再查看。</p> : rewardOptions.map((reward) => {
                const canRedeem = !rewardsLoading && requestableStickerCount >= reward.stickerCost;
                const isConfirming = rewardConfirmingId === reward.id;
                return <article className={canRedeem ? 'is-available' : ''} key={reward.id}>
                  <span className="reward-icon" aria-hidden="true">{reward.icon}</span>
                  <div><strong>{reward.label}</strong><small>{reward.stickerCost} 個貼紙</small></div>
                  {isConfirming ? <div className="reward-confirm"><span>送出申請？</span><button type="button" onClick={() => setRewardConfirmingId('')} disabled={rewardRedeemingId === reward.id}>取消</button><button className="confirm" type="button" onClick={() => { void redeemReward(reward); }} disabled={rewardRedeemingId === reward.id}>{rewardRedeemingId === reward.id ? '處理中…' : '提交'}</button></div> : <button type="button" disabled={!canRedeem || Boolean(rewardRedeemingId)} onClick={() => setRewardConfirmingId(reward.id)}>{rewardsLoading ? '正在同步申請…' : canRedeem ? '申請換領' : `尚欠 ${reward.stickerCost - requestableStickerCount} 張`}</button>}
                </article>;
              })}
            </div>
            {rewardError && <p className="auth-error" role="alert">{rewardError}</p>}
            <section className="redemption-history"><h3>我的換領紀錄</h3>{rewardsLoading ? <p>正在載入…</p> : redemptionHistory.length ? <div>{redemptionHistory.map((record) => {
              const canCancel = record.status === 'pending' && !record.deducted;
              const isConfirmingCancellation = redemptionCancelConfirmingId === record.id;
              return <article key={record.id}><div><strong>{record.rewardLabel}</strong><small>{record.createdAt ? new Intl.DateTimeFormat('zh-HK', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Hong_Kong' }).format(new Date(record.createdAt)) : '剛剛申請'}</small></div><div className="redemption-row-actions"><span className={`redemption-status ${record.status}`}>{record.status === 'approved' ? `已批准 · 已扣 ${record.stickerCost} 張` : record.status === 'rejected' ? '未獲批准' : record.status === 'cancelled' ? '已取消申請' : record.deducted ? '等待確認 · 舊版已扣除' : `等待批准 · 預留 ${record.stickerCost} 張`}</span>{canCancel && (isConfirmingCancellation ? <span className="cancel-redemption-confirm"><button type="button" disabled={redemptionCancellingId === record.id} onClick={() => setRedemptionCancelConfirmingId('')}>返回</button><button className="confirm" type="button" disabled={redemptionCancellingId === record.id} onClick={() => { void cancelRedemption(record); }}>{redemptionCancellingId === record.id ? '取消中…' : '確認取消'}</button></span> : <button className="cancel-redemption-button" type="button" disabled={Boolean(redemptionCancellingId)} onClick={() => setRedemptionCancelConfirmingId(record.id)}>取消申請</button>)}</div></article>;
            })}</div> : <p>你尚未提交任何換領申請。</p>}</section>
            <small className="reward-note">待批申請不會扣除貼紙；總管理員批准後才會自動扣除。</small>
          </div>
        </section>
      </div>}

      {selectedSession && <div className="record-modal-backdrop" role="presentation" onClick={() => setSelectedSession(null)}>
        <section className="record-modal" role="dialog" aria-modal="true" aria-labelledby="record-modal-title" onClick={(event) => event.stopPropagation()}>
          <button className="modal-close" type="button" aria-label="關閉打卡詳情" onClick={() => setSelectedSession(null)}>×</button>
          <p className="auth-kicker">打卡詳情</p>
          <h2 id="record-modal-title">{new Intl.DateTimeFormat('zh-HK', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Hong_Kong' }).format(new Date(`${selectedSession.studyDate}T12:00:00+08:00`))}</h2>
          <div className="record-facts"><span><small>溫習內容</small><strong>{topicLabel(selectedSession.topic)}</strong></span><span><small>溫習時數</small><strong>{formatDuration(selectedSession.minutes)}</strong></span></div>
          {selectedSession.note && <div className="record-note"><small>給自己的話</small><p>{selectedSession.note}</p></div>}
          <div className="record-photo-grid">
            <section className="record-photo"><strong>學習開始</strong>{imageLoading ? <p>正在載入相片…</p> : selectedImageData.start ? <img src={selectedImageData.start} alt={`${selectedSession.studyDate} 學習開始的相片`} /> : <div className="no-photo"><span>▶</span><p>沒有上載開始相片。</p></div>}</section>
            <section className="record-photo"><strong>學習結束</strong>{imageLoading ? <p>正在載入相片…</p> : selectedImageData.end ? <img src={selectedImageData.end} alt={`${selectedSession.studyDate} 學習結束的相片`} /> : <div className="no-photo"><span>✓</span><p>沒有上載結束相片。</p></div>}</section>
          </div>
          <div className="record-delete-zone">
            {!deleteConfirming ? <button className="delete-session-button" type="button" onClick={() => setDeleteConfirming(true)}>刪除這筆打卡紀錄</button> : <div className="delete-confirm"><p>確定永久刪除這筆紀錄及相片？此操作不能復原。</p><div><button type="button" onClick={() => setDeleteConfirming(false)} disabled={deleting}>取消</button><button className="confirm-delete-button" type="button" onClick={() => { void deleteSelectedSession(); }} disabled={deleting}>{deleting ? '正在刪除…' : '確定刪除'}</button></div></div>}
          </div>
        </section>
      </div>}

      {adminOpen && <AdminPanel appConfig={appConfig} onClose={() => setAdminOpen(false)} />}

      {startImagePreviewOpen && startImageData && <div className="record-modal-backdrop start-photo-preview-backdrop" role="presentation" onClick={() => setStartImagePreviewOpen(false)}><section className="start-photo-preview-modal" role="dialog" aria-modal="true" aria-labelledby="start-photo-preview-title" onClick={(event) => event.stopPropagation()}><button className="modal-close" type="button" aria-label="關閉開始相片" onClick={() => setStartImagePreviewOpen(false)}>×</button><p className="auth-kicker">學習開始</p><h2 id="start-photo-preview-title">已儲存的開始相片</h2><img src={startImageData} alt="放大顯示已儲存的學習開始相片" /><p>這張相片會保留至你完成打卡，登出後再次登入仍可查看。</p></section></div>}

      {avatarSourcePickerOpen && !avatarCropSource && <div className="record-modal-backdrop avatar-source-backdrop" role="presentation" onClick={() => setAvatarSourcePickerOpen(false)}>
        <section className="avatar-source-modal" role="dialog" aria-modal="true" aria-labelledby="avatar-source-title" onClick={(event) => event.stopPropagation()}>
          <button className="modal-close" type="button" aria-label="關閉頭像選擇" onClick={() => setAvatarSourcePickerOpen(false)}>×</button>
          <p className="auth-kicker">個人頭像</p>
          <h2 id="avatar-source-title">選擇相片來源</h2>
          <p>選擇相片後必定會先進入裁剪畫面，你可拖動及縮放到喜歡的範圍。</p>
          <div className="avatar-source-actions">
            <label><span aria-hidden="true">▧</span><strong>從相片庫選擇</strong><small>選擇手機或電腦內的相片</small><input ref={avatarLibraryInputRef} type="file" accept="image/*" disabled={avatarSaving} aria-label="從相片庫選擇頭像" onChange={(event) => { void handleAvatarChange(event); }} /></label>
            <label><span aria-hidden="true">●</span><strong>即時拍攝照片</strong><small>開啟相機拍攝新頭像</small><input ref={avatarCameraInputRef} type="file" accept="image/*" capture="user" disabled={avatarSaving} aria-label="拍攝頭像照片" onChange={(event) => { void handleAvatarChange(event); }} /></label>
          </div>
          {avatarSaving && <p className="avatar-source-loading" role="status">正在準備裁剪畫面…</p>}
        </section>
      </div>}

      {avatarCropSource && avatarPreview && <div className="record-modal-backdrop avatar-crop-backdrop" role="presentation" onClick={cancelAvatarCrop}>
        <section className="avatar-crop-modal" role="dialog" aria-modal="true" aria-labelledby="avatar-crop-title" onClick={(event) => event.stopPropagation()}>
          <button className="modal-close" type="button" aria-label="取消調整頭像" onClick={cancelAvatarCrop}>×</button>
          <p className="auth-kicker">個人頭像</p>
          <h2 id="avatar-crop-title">裁剪頭像</h2>
          <p>拖動白色裁剪框選擇位置，拉動四角改變大小；框內部分會成為你的頭像。</p>
          <div ref={avatarEditorRef} className="avatar-crop-stage" onPointerMove={handleAvatarPointerMove} onPointerUp={handleAvatarPointerEnd} onPointerCancel={handleAvatarPointerEnd}>
            <img src={avatarCropSource.src} alt="頭像裁剪預覽" draggable={false} style={{ width: avatarPreview.editor.width, height: avatarPreview.editor.height, left: avatarPreview.editor.left, top: avatarPreview.editor.top }} />
            <div className="avatar-crop-selection" style={{ width: avatarPreview.crop.size, height: avatarPreview.crop.size, left: avatarPreview.crop.left, top: avatarPreview.crop.top }} onPointerDown={(event) => handleAvatarPointerDown(event, 'move')}>
              <span className="avatar-crop-grid" aria-hidden="true" />
              {(['north-west', 'north-east', 'south-west', 'south-east'] as const).map((corner) => <button key={corner} className={`avatar-crop-handle ${corner}`} type="button" aria-label={`調整裁剪框${corner === 'north-west' ? '左上角' : corner === 'north-east' ? '右上角' : corner === 'south-west' ? '左下角' : '右下角'}`} onPointerDown={(event) => handleAvatarPointerDown(event, corner)} />)}
            </div>
          </div>
          <div className="avatar-zoom-controls">
            <button type="button" aria-label="縮小裁剪框" onClick={() => changeAvatarCropSize(avatarCropRect.size * 0.9)} disabled={avatarCropRect.size <= avatarCropMinimum}>−</button>
            <label className="avatar-zoom-label"><span>裁剪範圍</span><input type="range" min={avatarCropMinimum} max={Math.min(avatarCropSource.width, avatarCropSource.height)} step="1" value={avatarCropRect.size} onChange={(event) => changeAvatarCropSize(Number(event.target.value))} /></label>
            <button type="button" aria-label="放大裁剪框" onClick={() => changeAvatarCropSize(avatarCropRect.size * 1.1)} disabled={avatarCropRect.size >= Math.min(avatarCropSource.width, avatarCropSource.height)}>＋</button>
          </div>
          <div className="avatar-position-controls">
            <span>微調裁剪位置</span>
            <div role="group" aria-label="微調頭像裁剪位置">
              <button type="button" aria-label="向左移動裁剪框" onClick={() => nudgeAvatar(-1, 0)}>←</button>
              <button type="button" aria-label="向上移動裁剪框" onClick={() => nudgeAvatar(0, -1)}>↑</button>
              <button type="button" aria-label="向下移動裁剪框" onClick={() => nudgeAvatar(0, 1)}>↓</button>
              <button type="button" aria-label="向右移動裁剪框" onClick={() => nudgeAvatar(1, 0)}>→</button>
              <button className="reset-avatar-crop" type="button" onClick={resetAvatarCrop}>重設</button>
            </div>
          </div>
          <div className="avatar-crop-actions"><button type="button" onClick={cancelAvatarCrop} disabled={avatarSaving}>取消</button><button className="save-avatar-button" type="button" onClick={() => { void saveCroppedAvatar(); }} disabled={avatarSaving}>{avatarSaving ? '正在儲存…' : '儲存頭像'}</button></div>
        </section>
      </div>}

      {nameEditorOpen && <div className="record-modal-backdrop" role="presentation" onClick={() => setNameEditorOpen(false)}><section className="profile-name-modal" role="dialog" aria-modal="true" aria-labelledby="profile-name-title" onClick={(event) => event.stopPropagation()}><button className="modal-close" type="button" aria-label="關閉修改名字" onClick={() => setNameEditorOpen(false)}>×</button><p className="auth-kicker">個人資料</p><h2 id="profile-name-title">修改名字</h2><p>新名字會顯示在你的帳戶及排行榜。</p><form onSubmit={saveOwnName}><label>你的名字<input autoFocus value={nameDraft} minLength={1} maxLength={40} onChange={(event) => setNameDraft(event.target.value)} /></label>{nameError && <p className="auth-error" role="alert">{nameError}</p>}<button type="submit" disabled={nameSaving || !nameDraft.trim()}>{nameSaving ? '正在儲存…' : '儲存新名字'}</button></form></section></div>}

      {notice && <div className="toast" role="status"><span>✓</span>{notice}</div>}
      <footer>
        <span>{appConfig.appName}</span>
        <p>{appConfig.footerQuote}</p>
        <small className="designer-credit">Designed by LYL</small>
      </footer>
    </main>
  );
}
