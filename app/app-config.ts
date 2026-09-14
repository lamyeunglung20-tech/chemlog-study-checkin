export type AppConfig = {
  appName: string;
  subtitle: string;
  loginHeading: string;
  loginCopy: string;
  championMessage: string;
  footerQuote: string;
  iconData: string;
  backgroundColor: string;
};

export const defaultAppConfig: AppConfig = {
  appName: 'CHEMLOG',
  subtitle: '化學科留校溫習打卡',
  loginHeading: '歡迎回來',
  loginCopy: '今天也一起把努力累積下來。',
  championMessage: '藍老師愛你💌',
  footerQuote: '微小的進步，經過時間也會成為巨大的改變。',
  iconData: '',
  backgroundColor: '#f4faf7',
};

export function readAppConfig(value: Record<string, unknown> | undefined): AppConfig {
  if (!value) return defaultAppConfig;
  return {
    appName: typeof value.appName === 'string' && value.appName.trim() ? value.appName.trim().slice(0, 30) : defaultAppConfig.appName,
    subtitle: typeof value.subtitle === 'string' ? value.subtitle.trim().slice(0, 60) : defaultAppConfig.subtitle,
    loginHeading: typeof value.loginHeading === 'string' && value.loginHeading.trim() ? value.loginHeading.trim().slice(0, 40) : defaultAppConfig.loginHeading,
    loginCopy: typeof value.loginCopy === 'string' && value.loginCopy.trim() ? value.loginCopy.trim().slice(0, 100) : defaultAppConfig.loginCopy,
    championMessage: typeof value.championMessage === 'string' && value.championMessage.trim() ? value.championMessage.trim().slice(0, 80) : defaultAppConfig.championMessage,
    footerQuote: typeof value.footerQuote === 'string' && value.footerQuote.trim() ? value.footerQuote.trim().slice(0, 120) : defaultAppConfig.footerQuote,
    iconData: typeof value.iconData === 'string' && /^data:image\/(?:jpeg|png|webp);base64,/.test(value.iconData) ? value.iconData.slice(0, 180000) : '',
    backgroundColor: typeof value.backgroundColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.backgroundColor) ? value.backgroundColor : defaultAppConfig.backgroundColor,
  };
}

export async function fetchLatestAppConfig(): Promise<AppConfig> {
  const response = await fetch('https://firestore.googleapis.com/v1/projects/chemlog-study-check-in/databases/chemlog/documents/appConfig/public?key=AIzaSyDreQjvNuGgCJ_XfRM2UOTiADmbLD8SANI', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('APP_CONFIG_UNAVAILABLE');

  const payload = await response.json() as { fields?: Record<string, { stringValue?: string }> };
  const values = Object.fromEntries(Object.entries(payload.fields ?? {}).map(([key, value]) => [key, value.stringValue]));
  return readAppConfig(values);
}
