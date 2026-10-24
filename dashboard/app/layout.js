import './globals.css';

export const metadata = {
  title: 'Duck Daddy',
  description: 'Your desk duck: posture, pats and sentry, live.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
