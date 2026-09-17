export type RewardId = string;

export type RewardOption = {
  id: RewardId;
  stickerCost: number;
  label: string;
  icon: string;
};

export type AppConfig = {
  appName: string;
  subtitle: string;
  loginHeading: string;
  loginCopy: string;
  championMessage: string;
  footerQuote: string;
  iconData: string;
  backgroundColor: string;
  rewards: RewardOption[];
};

export const MAX_REWARD_OPTIONS = 12;

export const defaultRewardOptions: RewardOption[] = [
  { id: 'milk-tea', stickerCost: 10, label: '$40 元以下的奶茶一杯', icon: '🧋' },
  { id: 'lunch', stickerCost: 15, label: '$60 元內的午餐', icon: '🍱' },
  { id: 'signature', stickerCost: 20, label: '藍老師的親筆簽名', icon: '✍' },
  { id: 'photo', stickerCost: 30, label: '與藍老師合照一張', icon: '📸' },
];

export const defaultAppConfig: AppConfig = {
  appName: 'CHEMLOG',
  subtitle: '化學科留校溫習打卡',
  loginHeading: '歡迎回來',
  loginCopy: '今天也一起把努力累積下來。',
  championMessage: '藍老師愛你💌',
  footerQuote: '微小的進步，經過時間也會成為巨大的改變。',
  iconData: '',
  backgroundColor: '#f4faf7',
  rewards: defaultRewardOptions,
};

function readRewards(value: unknown): RewardOption[] {
  if (!Array.isArray(value)) return defaultRewardOptions.map((reward) => ({ ...reward }));
  const seenIds = new Set<string>();
  return value.slice(0, MAX_REWARD_OPTIONS).flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return [];
    const item = candidate as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || seenIds.has(id)) return [];
    seenIds.add(id);
    const fallback = defaultRewardOptions.find((reward) => reward.id === id);
    const stickerCost = Math.floor(Number(item.stickerCost));
    return [{
      id,
      stickerCost: Number.isFinite(stickerCost) && stickerCost >= 1 && stickerCost <= 999 ? stickerCost : (fallback?.stickerCost ?? 1),
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 80) : (fallback?.label ?? '新獎勵'),
      icon: typeof item.icon === 'string' && item.icon.trim() ? Array.from(item.icon.trim()).slice(0, 4).join('') : (fallback?.icon ?? '🎁'),
    }];
  });
}

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
    rewards: readRewards(value.rewards),
  };
}

type FirestoreRestValue = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  arrayValue?: { values?: FirestoreRestValue[] };
  mapValue?: { fields?: Record<string, FirestoreRestValue> };
};

function decodeFirestoreValue(value: FirestoreRestValue): unknown {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('arrayValue' in value) return (value.arrayValue?.values ?? []).map(decodeFirestoreValue);
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue?.fields ?? {}).map(([key, nested]) => [key, decodeFirestoreValue(nested)]));
  return undefined;
}

export async function fetchLatestAppConfig(): Promise<AppConfig> {
  const response = await fetch('https://firestore.googleapis.com/v1/projects/chemlog-study-check-in/databases/chemlog/documents/appConfig/public?key=AIzaSyDreQjvNuGgCJ_XfRM2UOTiADmbLD8SANI', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('APP_CONFIG_UNAVAILABLE');

  const payload = await response.json() as { fields?: Record<string, FirestoreRestValue> };
  const values = Object.fromEntries(Object.entries(payload.fields ?? {}).map(([key, value]) => [key, decodeFirestoreValue(value)]));
  return readAppConfig(values);
}
