'use client';

import { firebaseAuth } from './firebase-client';

const ADMIN_API = 'https://chemlog-study-checkin.locthanghai3.chatgpt.site/api/admin';

export async function callAdminApi<T>(action: string, payload: Record<string, unknown> = {}) {
  const token = await firebaseAuth.currentUser?.getIdToken();
  if (!token) throw new Error('NOT_AUTHENTICATED');
  const response = await fetch(ADMIN_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || 'ADMIN_API_FAILED');
  return result;
}
