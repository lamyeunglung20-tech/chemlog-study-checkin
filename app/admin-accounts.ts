export const SUPER_ADMIN_EMAIL = 'lamyeunglung20@gmail.com';

export const ADMIN_EMAILS = [
  SUPER_ADMIN_EMAIL,
  'science_ai@fss.edu.hk',
] as const;

export function isAdminEmail(email?: string | null) {
  const normalizedEmail = email?.trim().toLowerCase() || '';
  return ADMIN_EMAILS.some((adminEmail) => adminEmail === normalizedEmail);
}

export function isSuperAdminEmail(email?: string | null) {
  return email?.trim().toLowerCase() === SUPER_ADMIN_EMAIL;
}
