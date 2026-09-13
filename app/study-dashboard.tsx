'use client';
/* eslint-disable @next/next/no-img-element -- User uploads use authenticated Firebase Storage URLs. */

import { type CSSProperties, ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, getDoc, getDocs, orderBy, query, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import AdminPanel from './admin-panel';
import { type AppConfig } from './app-config';
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
};

type LeaderboardPeriod = 'week' | 'month' | 'total';

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

function formatTimer(seconds: number) {
  const values = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return values.map((value) => String(value).padStart(2, '0')).join(':');
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
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

async function compressAvatar(file: File) {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('IMAGE_UNREADABLE'));
      image.src = sourceUrl;
    });
    const size = 256;
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = Math.max(0, (image.naturalWidth - sourceSize) / 2);
    const sourceY = Math.max(0, (image.naturalHeight - sourceSize) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('IMAGE_UNREADABLE');
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
    let quality = 0.82;
    let result = canvas.toDataURL('image/jpeg', quality);
    while (result.length > 120000 && quality > 0.45) {
      quality -= 0.08;
      result = canvas.toDataURL('image/jpeg', quality);
    }
    if (result.length > 120000) throw new Error('IMAGE_TOO_LARGE');
    return result;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export default function StudyDashboard({ appConfig, isAdmin, studentName, userId, onLogout }: { appConfig: AppConfig; isAdmin: boolean; studentName: string; userId: string; onLogout: () => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [countdownHours, setCountdownHours] = useState(1);
  const [countdownMinutes, setCountdownMinutes] = useState(0);
  const [secondsRemaining, setSecondsRemaining] = useState(3600);
  const [timerStarted, setTimerStarted] = useState(false);
  const [timerCompleted, setTimerCompleted] = useState(false);
  const [running, setRunning] = useState(false);
  const [manualHours, setManualHours] = useState(1);
  const [manualMinutePart, setManualMinutePart] = useState(0);
  const [studyDate, setStudyDate] = useState(localDate());
  const [topic, setTopic] = useState('mistakes');
  const [customTopics, setCustomTopics] = useState<string[]>([]);
  const [customTopicDraft, setCustomTopicDraft] = useState('');
  const [topicSaving, setTopicSaving] = useState(false);
  const [note, setNote] = useState('');
  const [startImageFile, setStartImageFile] = useState<File | null>(null);
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
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState('');
  const [avatarData, setAvatarData] = useState('');
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [historyManageMode, setHistoryManageMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [bulkDeleteConfirming, setBulkDeleteConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  const loadDashboard = useCallback(async () => {
    const [result, profileDocument, topicPreferencesDocument] = await Promise.all([
      getDocs(query(collection(firebaseDb, 'users', userId, 'sessions'), orderBy('studyDate', 'desc'))),
      getDoc(doc(firebaseDb, 'leaderboard', userId)),
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
    const dailyMap = new Map<string, number>();
    for (const session of sessions) dailyMap.set(session.studyDate, (dailyMap.get(session.studyDate) ?? 0) + session.minutes);
    const dashboardData = {
      totalMinutes: sessions.reduce((total, session) => total + session.minutes, 0),
      weekMinutes: sessions.filter((session) => session.studyDate >= weekStart).reduce((total, session) => total + session.minutes, 0),
      monthMinutes: sessions.filter((session) => session.studyDate.startsWith(monthKey)).reduce((total, session) => total + session.minutes, 0),
      sessions: sessions.slice(0, 8),
      daily: Array.from(dailyMap, ([date, minutes]) => ({ date, minutes })),
    } satisfies DashboardData;
    setData(dashboardData);
    const storedAvatar = profileDocument.data()?.avatarData;
    if (typeof storedAvatar === 'string') setAvatarData(storedAvatar);
    const storedTopics = topicPreferencesDocument.data()?.customTopics;
    if (Array.isArray(storedTopics)) {
      setCustomTopics(storedTopics.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim().slice(0, 30)).slice(0, 20));
    }
    try {
      await setDoc(doc(firebaseDb, 'leaderboard', userId), {
        displayName: studentName.trim().slice(0, 40) || '同學',
        totalMinutes: dashboardData.totalMinutes,
        weekMinutes: dashboardData.weekMinutes,
        monthMinutes: dashboardData.monthMinutes,
        weekKey: weekStart,
        monthKey,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } catch {
      // The private dashboard remains available if leaderboard syncing is temporarily unavailable.
    }
  }, [studentName, userId]);

  const openLeaderboard = useCallback(async () => {
    setLeaderboardOpen(true);
    setLeaderboardLoading(true);
    setLeaderboardError('');
    try {
      const result = await getDocs(collection(firebaseDb, 'leaderboard'));
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
        } satisfies LeaderboardEntry;
      }));
    } catch {
      setLeaderboardError('暫時未能載入排行榜，請稍後再試。');
    } finally {
      setLeaderboardLoading(false);
    }
  }, []);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => { void loadDashboard(); }, 0);
    return () => window.clearTimeout(loadTimer);
  }, [loadDashboard]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setSecondsRemaining((value) => {
      const nextValue = Math.max(0, value - 1);
      if (nextValue === 0) {
        setRunning(false);
        setTimerCompleted(true);
      }
      return nextValue;
    }), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

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

  function updateCountdown(hours: number, minutes: number) {
    const nextHours = clampNumber(hours, 0, 12);
    const nextMinutes = clampNumber(minutes, 0, 59);
    setCountdownHours(nextHours);
    setCountdownMinutes(nextMinutes);
    if (!timerStarted) setSecondsRemaining((nextHours * 60 + nextMinutes) * 60);
  }

  function startCountdown() {
    const duration = countdownHours * 60 + countdownMinutes;
    if (duration < 1) {
      setNotice('請先設定最少 1 分鐘的倒數時間。');
      return;
    }
    if (!timerStarted || secondsRemaining === 0) setSecondsRemaining(duration * 60);
    setTimerStarted(true);
    setTimerCompleted(false);
    setRunning(true);
  }

  function resetCountdown() {
    setRunning(false);
    setTimerStarted(false);
    setTimerCompleted(false);
    setSecondsRemaining((countdownHours * 60 + countdownMinutes) * 60);
  }

  function prepareCountdownCheckin() {
    setManualHours(countdownHours);
    setManualMinutePart(countdownMinutes);
    setStudyDate(localDate());
    setNotice('倒數完成！請確認溫習內容及相片，再加入打卡紀錄。');
    window.setTimeout(() => document.getElementById('manual-checkin')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

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
    if (!file.type.startsWith('image/') || file.size > 8 * 1024 * 1024) {
      setNotice(file.type.startsWith('image/') ? '頭像圖片不可超過 8 MB。' : '頭像只可使用圖片檔案。');
      event.target.value = '';
      return;
    }
    if (!data) {
      setNotice('正在整理你的資料，請稍後再選擇頭像。');
      event.target.value = '';
      return;
    }
    setAvatarSaving(true);
    try {
      const nextAvatar = await compressAvatar(file);
      await setDoc(doc(firebaseDb, 'leaderboard', userId), {
        displayName: studentName.trim().slice(0, 40) || '同學',
        totalMinutes: data.totalMinutes,
        weekMinutes: data.weekMinutes,
        monthMinutes: data.monthMinutes,
        weekKey: weekStartKey(),
        monthKey: localDate().slice(0, 7),
        avatarData: nextAvatar,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setAvatarData(nextAvatar);
      setLeaderboardEntries((entries) => entries.map((entry) => entry.id === userId ? { ...entry, avatarData: nextAvatar } : entry));
      setNotice('頭像已更新。');
      window.setTimeout(() => setNotice(''), 3000);
    } catch (caught) {
      const imageError = (caught as Error).message;
      setNotice(imageError === 'IMAGE_UNREADABLE' ? '未能讀取這張圖片，請轉用 JPG 或 PNG。' : '未能更新頭像，請稍後再試。');
    } finally {
      setAvatarSaving(false);
      if (avatarInputRef.current) avatarInputRef.current.value = '';
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

  function handleImageChange(event: ChangeEvent<HTMLInputElement>, phase: 'start' | 'end') {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      if (phase === 'start') setStartImageFile(null);
      else setEndImageFile(null);
      return;
    }
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
    if (phase === 'start') setStartImageFile(file);
    else setEndImageFile(file);
    setNotice('');
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
    setSaving(true);
    try {
      const sessionRef = doc(collection(firebaseDb, 'users', userId, 'sessions'));
      const [startImageData, endImageData] = await Promise.all([
        startImageFile ? compressImage(startImageFile) : Promise.resolve(''),
        endImageFile ? compressImage(endImageFile) : Promise.resolve(''),
      ]);
      const batch = writeBatch(firebaseDb);
      batch.set(sessionRef, {
        studyDate,
        minutes,
        topic,
        note: note.trim().slice(0, 80),
        hasImage: Boolean(startImageData || endImageData),
        hasStartImage: Boolean(startImageData),
        hasEndImage: Boolean(endImageData),
        createdAt: serverTimestamp(),
      });
      if (startImageData) batch.set(doc(firebaseDb, 'users', userId, 'sessionImages', `${sessionRef.id}-start`), { imageData: startImageData, createdAt: serverTimestamp() });
      if (endImageData) batch.set(doc(firebaseDb, 'users', userId, 'sessionImages', `${sessionRef.id}-end`), { imageData: endImageData, createdAt: serverTimestamp() });
      await batch.commit();
      setNotice(`打卡成功！已加入 ${formatDuration(minutes)}。`);
      setNote('');
      setStartImageFile(null);
      setEndImageFile(null);
      if (startFileInputRef.current) startFileInputRef.current.value = '';
      if (endFileInputRef.current) endFileInputRef.current.value = '';
      if (timerCompleted) resetCountdown();
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
    void saveSession(manualHours * 60 + manualMinutePart);
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
  const selectedQuickMinutes = manualHours * 60 + manualMinutePart;
  const currentWeekKey = weekStartKey();
  const currentMonthKey = localDate().slice(0, 7);
  const rankedEntries = leaderboardEntries
    .map((entry) => ({
      ...entry,
      score: leaderboardPeriod === 'total' ? entry.totalMinutes : leaderboardPeriod === 'month' ? (entry.monthKey === currentMonthKey ? entry.monthMinutes : 0) : (entry.weekKey === currentWeekKey ? entry.weekMinutes : 0),
    }))
    .sort((left, right) => right.score - left.score || left.displayName.localeCompare(right.displayName, 'zh-HK'));

  return (
    <main className="app-shell" style={{ '--app-bg': appConfig.backgroundColor } as CSSProperties}>
      <header className="topbar">
        <div className="brand-cluster">
          <a className="brand" href="#top" aria-label="ChemLog 首頁">
            <span className="brand-mark" aria-hidden="true">{appConfig.iconData ? <img src={appConfig.iconData} alt="" /> : '⚗'}</span>
            <span><strong>{appConfig.appName}</strong><small>{appConfig.subtitle}</small></span>
          </a>
          <button className="leaderboard-link" type="button" onClick={() => { void openLeaderboard(); }}><span aria-hidden="true">♛</span>查看排行榜</button>
          {isAdmin && <button className="admin-link" type="button" onClick={() => setAdminOpen(true)}><span aria-hidden="true">⚙</span>管理中心</button>}
        </div>
        <div className="header-actions">
          <div className="student-chip"><label className={`student-avatar ${avatarSaving ? 'is-saving' : ''}`} title="按此更換頭像">{avatarData ? <img src={avatarData} alt="你的頭像" /> : <span>{studentName.slice(0, 1).toUpperCase()}</span>}<i aria-hidden="true">✎</i><input ref={avatarInputRef} type="file" accept="image/*" disabled={avatarSaving} aria-label="上載個人頭像" onChange={(event) => { void handleAvatarChange(event); }} /></label><p><small>正在學習</small>{studentName}</p></div>
          <button className="logout-link" type="button" onClick={onLogout}>登出</button>
        </div>
      </header>

      <div className="dashboard" id="top">
        <section className="total-card" aria-label="累計溫習時間">
          <div className="molecule molecule-one" /><div className="molecule molecule-two" />
          <p>我的化學溫習總時間</p>
          <div className="total-number">
            <strong>{Math.floor((data?.totalMinutes ?? 0) / 60)}</strong><span>小時</span>
            <strong>{(data?.totalMinutes ?? 0) % 60}</strong><span>分鐘</span>
          </div>
        </section>

        <section className="timer-card">
          <div className="section-heading"><div><span className="step-number">01</span><h2>倒數計時</h2></div><span className={`live-dot ${running ? 'is-running' : ''}`}>{timerCompleted ? '倒數完成' : running ? '專注中' : timerStarted ? '已暫停' : '準備開始'}</span></div>
          {!timerStarted && <div className="countdown-setting" aria-label="設定倒數時間">
            <label><input type="number" min="0" max="12" value={countdownHours} onChange={(event) => updateCountdown(Number(event.target.value), countdownMinutes)} /><span>小時</span></label>
            <span className="duration-colon">:</span>
            <label><input type="number" min="0" max="59" value={countdownMinutes} onChange={(event) => updateCountdown(countdownHours, Number(event.target.value))} /><span>分鐘</span></label>
          </div>}
          <div className={`timer-display ${timerCompleted ? 'is-complete' : ''}`} aria-live="polite">{formatTimer(secondsRemaining)}</div>
          <p className="timer-hint">{timerCompleted ? '做得好！現在可以把這次溫習加入打卡紀錄。' : running ? '倒數進行中，保持專注。' : timerStarted ? '倒數已暫停，準備好便繼續。' : '設定時長後開始倒數，完成後加入今天的紀錄。'}</p>
          <div className="timer-actions">
            {!timerCompleted && <button className={running ? 'pause-button' : 'start-button'} onClick={() => running ? setRunning(false) : startCountdown()}><span>{running ? 'Ⅱ' : '▶'}</span>{running ? '暫停' : timerStarted ? '繼續倒數' : '開始倒數'}</button>}
            {timerCompleted && <button className="finish-button complete-button" type="button" onClick={prepareCountdownCheckin}>填寫資料並加入紀錄</button>}
            {timerStarted && <button className="text-button" type="button" onClick={resetCountdown}>重設</button>}
          </div>
        </section>

        <section className="manual-card" id="manual-checkin">
          <div className="section-heading"><div><span className="step-number coral">02</span><h2>加入打卡</h2></div><span className="soft-label">可補登或記錄倒數成果</span></div>
          <form onSubmit={handleManualSubmit}>
            <fieldset><legend>溫習時長</legend><div className="quick-times">
              {[30, 60, 90, 120].map((value) => <button type="button" className={selectedQuickMinutes === value ? 'selected' : ''} onClick={() => chooseQuickDuration(value)} key={value}><strong>{value >= 60 ? value / 60 : value}</strong><small>{value >= 60 ? '小時' : '分鐘'}</small></button>)}
            </div></fieldset>
            <div className="custom-duration"><p>自行輸入</p><div>
              <label><input type="number" min="0" max="12" value={manualHours} onChange={(event) => setManualHours(clampNumber(Number(event.target.value), 0, 12))} /><span>小時</span></label>
              <label><input type="number" min="0" max="59" value={manualMinutePart} onChange={(event) => setManualMinutePart(clampNumber(Number(event.target.value), 0, 59))} /><span>分鐘</span></label>
            </div></div>
            <div className="form-grid">
              <label>日期<input className="study-date-input" type="date" value={studyDate} max={localDate()} onChange={(event) => setStudyDate(event.target.value)} required /></label>
              <label>溫習內容<select value={topic} onChange={(event) => { setTopic(event.target.value); if (event.target.value !== '__custom__') setCustomTopicDraft(''); }}><optgroup label="預設選項">{defaultTopicOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</optgroup>{customTopics.length > 0 && <optgroup label="我的個人選單">{customTopics.map((label) => <option value={`custom:${label}`} key={label}>{label}</option>)}</optgroup>}<option value="__custom__">＋ 自行輸入並儲存</option></select></label>
            </div>
            {topic === '__custom__' && <div className="custom-topic-editor"><label>自訂溫習內容<input type="text" maxLength={30} value={customTopicDraft} onChange={(event) => setCustomTopicDraft(event.target.value)} placeholder="例如：溫習有機化學反應" autoFocus /></label><button type="button" disabled={topicSaving || !customTopicDraft.trim()} onClick={() => { void saveCustomTopic(); }}>{topicSaving ? '正在儲存…' : '儲存至個人選單'}</button><small>儲存後，下次登入仍可直接選用。</small></div>}
            <label className="note-label">給今天的自己一句話（選填）<input type="text" maxLength={80} value={note} onChange={(event) => setNote(event.target.value)} placeholder="例：終於弄懂電解池了！" /></label>
            <fieldset className="photo-fieldset"><legend>學習相片（選填）</legend><div className="photo-upload-grid">
              <label className="upload-label"><span>學習開始</span><span className={`upload-shell ${startImageFile ? 'has-file' : ''}`}><span aria-hidden="true">▶</span><strong>{startImageFile ? startImageFile.name : '上載開始溫習的相片'}</strong><small>{startImageFile ? '按此更換相片' : '常用圖片格式，最多 8 MB'}</small><input ref={startFileInputRef} type="file" accept="image/*" onChange={(event) => handleImageChange(event, 'start')} /></span></label>
              <label className="upload-label"><span>學習結束</span><span className={`upload-shell ${endImageFile ? 'has-file' : ''}`}><span aria-hidden="true">✓</span><strong>{endImageFile ? endImageFile.name : '上載完成溫習的相片'}</strong><small>{endImageFile ? '按此更換相片' : '常用圖片格式，最多 8 MB'}</small><input ref={endFileInputRef} type="file" accept="image/*" onChange={(event) => handleImageChange(event, 'end')} /></span></label>
            </div></fieldset>
            <button className="checkin-button" disabled={saving || selectedQuickMinutes < 1} type="submit">{saving ? '正在儲存…' : '完成今日打卡'}<span>＋</span></button>
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
            <div className="history-list">{data.sessions.map((session) => {
              const sessionDate = new Date(`${session.studyDate}T12:00:00+08:00`);
              const isSelected = selectedSessionIds.includes(session.id);
              return <article className={`${historyManageMode ? 'selecting' : ''} ${isSelected ? 'selected' : ''}`} key={session.id}>
                {historyManageMode && <button className="history-select-button" type="button" aria-pressed={isSelected} aria-label={`${isSelected ? '取消選擇' : '選擇'} ${session.studyDate} 的打卡紀錄`} onClick={() => toggleHistorySelection(session.id)}><span>{isSelected ? '✓' : ''}</span></button>}
                <button className="session-date-button" type="button" onClick={() => historyManageMode ? toggleHistorySelection(session.id) : openSession(session)} aria-label={historyManageMode ? `${isSelected ? '取消選擇' : '選擇'} ${session.studyDate} 的打卡紀錄` : `查看 ${session.studyDate} 的打卡詳情`}><time dateTime={session.studyDate}><strong>{sessionDate.getDate()}</strong><span>{new Intl.DateTimeFormat('zh-HK', { month: 'short', timeZone: 'Asia/Hong_Kong' }).format(sessionDate)}</span><small>{sessionDate.getFullYear()}</small></time></button>
                <div className="history-detail"><strong>{topicLabel(session.topic)}</strong><span className="duration">{formatDuration(session.minutes)}</span></div>
              </article>;
            })}{historyManageMode && <div className="history-delete-panel"><div><strong>已選 {selectedSessionIds.length} 筆</strong><small>只會刪除你選取的紀錄及相關相片</small></div>{!bulkDeleteConfirming ? <button type="button" disabled={selectedSessionIds.length === 0} onClick={() => setBulkDeleteConfirming(true)}>刪除已選紀錄</button> : <div className="bulk-delete-confirm"><span>確定刪除？</span><button type="button" onClick={() => setBulkDeleteConfirming(false)} disabled={deleting}>返回</button><button className="danger" type="button" onClick={() => { void deleteChosenSessions(); }} disabled={deleting}>{deleting ? '正在刪除…' : '確定刪除'}</button></div>}</div>}</div>
          )}
        </section>
      </div>

      {leaderboardOpen && <div className="record-modal-backdrop" role="presentation" onClick={() => setLeaderboardOpen(false)}>
        <section className="leaderboard-modal" role="dialog" aria-modal="true" aria-labelledby="leaderboard-title" onClick={(event) => event.stopPropagation()}>
          <button className="modal-close" type="button" aria-label="關閉排行榜" onClick={() => setLeaderboardOpen(false)}>×</button>
          <p className="auth-kicker">CHEMLOG 同學榜</p>
          <h2 id="leaderboard-title">溫習排行榜</h2>
          <p className="leaderboard-copy">看看大家累積的努力，一起保持溫習節奏。</p>
          <div className="leaderboard-tabs" role="tablist" aria-label="排行榜時段">
            {([['week', '本週'], ['month', '本月'], ['total', '總時數']] as const).map(([value, label]) => <button type="button" role="tab" aria-selected={leaderboardPeriod === value} className={leaderboardPeriod === value ? 'selected' : ''} onClick={() => setLeaderboardPeriod(value)} key={value}>{label}</button>)}
          </div>
          {leaderboardLoading ? <div className="leaderboard-state">正在整理排行榜…</div> : leaderboardError ? <div className="leaderboard-state error"><p>{leaderboardError}</p><button type="button" onClick={() => { void openLeaderboard(); }}>重新載入</button></div> : rankedEntries.length === 0 ? <div className="leaderboard-state">暫時未有同學上榜。</div> : <div className="leaderboard-list">
            {rankedEntries.map((entry, index) => <article className={entry.id === userId ? 'is-me' : ''} key={entry.id}>
              <span className={`rank rank-${index + 1}`}>{index < 3 ? ['♛', '◆', '●'][index] : index + 1}</span>
              <span className="leaderboard-avatar" aria-hidden="true">{entry.avatarData ? <img src={entry.avatarData} alt="" /> : entry.displayName.slice(0, 1).toUpperCase()}</span>
              <div><strong>{entry.displayName}</strong>{entry.id === userId && <small>你</small>}</div>
              <b>{formatDuration(entry.score)}</b>
            </article>)}
          </div>}
          <small className="leaderboard-note">榜單會在同學登入或新增打卡後自動更新。</small>
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

      {notice && <div className="toast" role="status"><span>✓</span>{notice}</div>}
      <footer>
        <span>{appConfig.appName}</span>
        <p>{appConfig.footerQuote}</p>
        <small className="designer-credit">Designed by LYL</small>
      </footer>
    </main>
  );
}
