import { Inter, Space_Grotesk } from 'next/font/google';
import { preload } from 'react-dom';
import { DuckProvider } from '@/components/duck/DuckContext';
import DuckStage from '@/components/duck/DuckStage';
import './globals.css';

const display = Space_Grotesk({ subsets: ['latin'], weight: ['500', '700'], variable: '--font-display' });
const body = Inter({ subsets: ['latin'], variable: '--font-body' });

export const metadata = {
  title: 'Duck Mommy',
  description: 'Your desk duck: posture, pats, signs and sentry, live.',
};

// The duck stage lives here, above the routes, so it never unmounts:
// login -> dashboard is one continuous animation.
export default function RootLayout({ children }) {
  // The default scene's 6 MB panorama starts downloading with the page, not after the JS boots.
  preload('/scenes/pool_2k.hdr', { as: 'fetch', crossOrigin: 'anonymous' });
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <DuckProvider>
          <DuckStage />
          <div className="ui">{children}</div>
        </DuckProvider>
      </body>
    </html>
  );
}
