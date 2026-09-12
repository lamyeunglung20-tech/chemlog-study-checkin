import { env } from 'cloudflare:workers';
import { getVerifiedFirebaseUser } from '@/db/runtime';

export const dynamic = 'force-dynamic';

function hongKongDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export async function GET(request: Request) {
  const user = await getVerifiedFirebaseUser(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = user.id;
  const today = hongKongDate();
  const startOfWeek = new Date(`${today}T12:00:00+08:00`);
  const day = startOfWeek.getDay() || 7;
  startOfWeek.setDate(startOfWeek.getDate() - day + 1);
  const weekStart = hongKongDate(startOfWeek);

  const [totals, recent, daily] = await Promise.all([
    env.DB.prepare(`SELECT COALESCE(SUM(minutes), 0) AS total_minutes, COALESCE(SUM(CASE WHEN study_date >= ? THEN minutes ELSE 0 END), 0) AS week_minutes FROM study_sessions WHERE user_id = ?`).bind(weekStart, userId).first<{ total_minutes: number; week_minutes: number }>(),
    env.DB.prepare(`SELECT id, study_date AS studyDate, minutes, topic, note FROM study_sessions WHERE user_id = ? ORDER BY study_date DESC, created_at DESC LIMIT 8`).bind(userId).all(),
    env.DB.prepare(`SELECT study_date AS date, SUM(minutes) AS minutes FROM study_sessions WHERE user_id = ? GROUP BY study_date ORDER BY study_date DESC LIMIT 60`).bind(userId).all<{ date: string; minutes: number }>(),
  ]);

  return Response.json({ totalMinutes: Number(totals?.total_minutes ?? 0), weekMinutes: Number(totals?.week_minutes ?? 0), sessions: recent.results, daily: daily.results });
}

export async function POST(request: Request) {
  const user = await getVerifiedFirebaseUser(request);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = user.id;
  const body = await request.json() as { minutes?: number; studyDate?: string; topic?: string; note?: string };
  const minutes = Math.round(Number(body.minutes));
  const allowedTopics = new Set(['concepts', 'mc', 'structured', 'experiment', 'pastpaper']);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720) return Response.json({ error: 'Invalid minutes' }, { status: 400 });
  if (!body.studyDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.studyDate) || body.studyDate > hongKongDate()) return Response.json({ error: 'Invalid date' }, { status: 400 });
  if (!body.topic || !allowedTopics.has(body.topic)) return Response.json({ error: 'Invalid topic' }, { status: 400 });

  await env.DB.prepare(`INSERT INTO study_sessions (id, user_id, study_date, minutes, topic, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), userId, body.studyDate, minutes, body.topic, body.note?.trim().slice(0, 80) || null, Date.now()).run();
  return Response.json({ ok: true }, { status: 201 });
}
