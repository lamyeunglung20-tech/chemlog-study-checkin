import { env } from 'cloudflare:workers';
import { getVerifiedFirebaseUser } from '@/db/runtime';

export const dynamic = 'force-dynamic';

const PROJECT_ID = 'chemlog-study-check-in';
const ADMIN_EMAIL = 'lamyeunglung20@gmail.com';
const ALLOWED_ORIGINS = new Set([
  'https://chemlog-studycheckin.locthanghai3.chatgpt.site',
  'https://chemlog-study-checkin.locthanghai3.chatgpt.site',
  'https://chemlog-study-check-in.web.app',
  'https://lamyeunglung20-tech.github.io',
  'http://localhost:3000',
  'http://localhost:3001',
]);

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type IdentityUser = {
  localId?: string;
  email?: string;
  displayName?: string;
  disabled?: boolean;
  emailVerified?: boolean;
  createdAt?: string;
  lastLoginAt?: string;
};

let cachedToken = '';
let tokenExpiresAt = 0;

function base64Url(input: Uint8Array | string) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemBytes(pem: string) {
  const binary = atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const account = JSON.parse(env.FIREBASE_ADMIN_SERVICE_ACCOUNT) as ServiceAccount;
  if (!account.client_email || !account.private_key) throw new Error('ADMIN_SERVICE_ACCOUNT_MISSING');
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: account.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBytes(account.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const response = await fetch(account.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${base64Url(new Uint8Array(signature))}`,
    }),
  });
  const result = await response.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !result.access_token) throw new Error(result.error_description || 'ADMIN_TOKEN_FAILED');
  cachedToken = result.access_token;
  tokenExpiresAt = Date.now() + (result.expires_in || 3600) * 1000;
  return cachedToken;
}

async function identityRequest(path: string, body: Record<string, unknown>) {
  const token = await getAccessToken();
  const response = await fetch(`https://identitytoolkit.googleapis.com${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'IDENTITY_API_FAILED');
  return result;
}

function corsHeaders(origin: string | null) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return headers;
}

function json(origin: string | null, value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: corsHeaders(origin) });
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return json(origin, { error: 'ORIGIN_NOT_ALLOWED' }, 403);
  const headers = corsHeaders(origin);
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(origin, { error: 'ORIGIN_NOT_ALLOWED' }, 403);
  const user = await getVerifiedFirebaseUser(request);
  if (!user || user.email !== ADMIN_EMAIL) return json(origin, { error: 'ADMIN_ONLY' }, 403);

  try {
    const body = await request.json() as { action?: string; uid?: string; displayName?: string };
    if (body.action === 'listUsers') {
      const users: IdentityUser[] = [];
      let offset = 0;
      while (users.length < 5000) {
        const result = await identityRequest(`/v1/projects/${PROJECT_ID}/accounts:query`, { offset: String(offset), limit: '500' });
        const page = (result.userInfo || []) as IdentityUser[];
        users.push(...page);
        const count = Number(result.recordsCount || page.length);
        if (!count || count < 500) break;
        offset += count;
      }
      return json(origin, { users: users.map((account) => ({
        uid: account.localId || '',
        email: account.email || '',
        displayName: account.displayName || '',
        disabled: account.disabled === true,
        emailVerified: account.emailVerified === true,
        createdAt: account.createdAt ? new Date(Number(account.createdAt)).toISOString() : '',
        lastSignInTime: account.lastLoginAt ? new Date(Number(account.lastLoginAt)).toISOString() : '',
      })) });
    }

    if (body.action === 'deleteUser') {
      if (!body.uid || body.uid === user.id) return json(origin, { error: 'CANNOT_DELETE_ADMIN' }, 400);
      await identityRequest(`/v1/projects/${PROJECT_ID}/accounts:delete`, { localId: body.uid });
      return json(origin, { ok: true });
    }

    if (body.action === 'updateUserName') {
      const displayName = body.displayName?.trim().slice(0, 40) || '';
      if (!body.uid || !displayName) return json(origin, { error: 'INVALID_DISPLAY_NAME' }, 400);
      await identityRequest(`/v1/projects/${PROJECT_ID}/accounts:update`, { localId: body.uid, displayName });
      return json(origin, { ok: true, displayName });
    }

    return json(origin, { error: 'UNKNOWN_ACTION' }, 400);
  } catch (error) {
    console.error('CHEMLOG admin API error', error);
    return json(origin, { error: 'ADMIN_OPERATION_FAILED' }, 500);
  }
}
