import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const FIREBASE_PROJECT_ID = 'chemlog-study-check-in';
const firebaseKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

const statements = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email)`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_expiry ON auth_sessions(user_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS study_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    study_date TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    topic TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_study_sessions_user_date ON study_sessions(user_id, study_date DESC)`,
];

export async function ensureDatabase() {
  await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
}

export async function getVerifiedFirebaseUser(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  try {
    const { payload } = await jwtVerify(authorization.slice(7), firebaseKeys, {
      algorithms: ['RS256'],
      audience: FIREBASE_PROJECT_ID,
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    });
    if (!payload.sub || payload.email_verified !== true) return null;
    await ensureDatabase();
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (email) {
      const previousAccount = await env.DB.prepare('SELECT id FROM accounts WHERE email = ?').bind(email).first<{ id: string }>();
      if (previousAccount && previousAccount.id !== payload.sub) {
        await env.DB.prepare('UPDATE study_sessions SET user_id = ? WHERE user_id = ?').bind(payload.sub, previousAccount.id).run();
      }
    }
    return { id: payload.sub, email };
  } catch {
    return null;
  }
}
