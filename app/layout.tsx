import type { Metadata } from 'next';
import { Noto_Sans_TC, Noto_Serif_TC } from 'next/font/google';
import './globals.css';

const sans = Noto_Sans_TC({ variable: '--font-sans', subsets: ['latin'], weight: ['400', '500', '600', '700', '800'] });
const serif = Noto_Serif_TC({ variable: '--font-serif', subsets: ['latin'], weight: ['600', '700', '900'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://chemlog-study-checkin.locthanghai3.chatgpt.site'),
  title: 'CHEMLOG 化學研習誌｜每日溫習打卡',
  description: '記錄每天留校溫習化學的時間，累積總時數與連續打卡，讓努力清楚可見。',
  openGraph: {
    title: 'CHEMLOG 化學研習誌',
    description: '讓每一分鐘的努力，都看得見。',
    images: [{ url: '/og.png', width: 1536, height: 1024, alt: 'CHEMLOG 化學研習誌' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CHEMLOG 化學研習誌',
    description: '讓每一分鐘的努力，都看得見。',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-HK"><body className={`${sans.variable} ${serif.variable}`}>{children}</body></html>;
}
