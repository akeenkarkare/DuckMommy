'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useDuck } from '@/components/duck/DuckContext';
import ScenePicker from '@/components/ScenePicker';

export default function AuthForm({ mode }) {
  const router = useRouter();
  const { bridge } = useDuck();
  const isRegister = mode === 'register';
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');

    const { data, error } = isRegister
      ? await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName.trim() || null } } })
      : await supabase.auth.signInWithPassword({ email, password });

    setBusy(false);
    if (error) {
      bridge.current.react({ type: 'posture', value: { state: 'slouch' }, message: 'Hmm, that didn’t work' });
      return setError(error.message);
    }
    if (!data.session) return setNotice('Check your email to confirm your account, then log in.');

    // The card slides away, the duck says hi, then spins and shrinks into the dashboard.
    const who = displayName.trim() || data.session.user.user_metadata?.display_name;
    bridge.current.react({ type: 'presence', value: { present: true }, message: who ? `Hi ${who}!` : 'Welcome!' });
    setLeaving(true);
    setTimeout(() => router.replace('/'), 650);
  }

  return (
    <main className={`auth ${leaving ? 'leaving' : ''}`}>
      <div className="auth-brand"><span aria-hidden>🦆</span> Duck Mommy</div>
      <div className="auth-scene"><ScenePicker /></div>

      <form className="auth-card glass" onSubmit={onSubmit}>
        <h1 className="auth-title">{isRegister ? 'Register' : 'Log in'}</h1>
        <p className="auth-sub">
          {isRegister ? 'Meet your desk duck. It watches your posture, reads your signs and guards your desk.' : 'Welcome back. Your duck missed you.'}
        </p>

        {isRegister && (
          <div className="field">
            <label htmlFor="name">Display name</label>
            <input id="name" type="text" maxLength={50} autoComplete="nickname" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <div className="pw">
            <input id="password" type={showPassword ? 'text' : 'password'} required minLength={6}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="pw-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword} title={showPassword ? 'Hide password' : 'Show password'}
              onClick={() => setShowPassword((v) => !v)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                <circle cx="12" cy="12" r="3" />
                {showPassword && <path d="M3 3l18 18" />}
              </svg>
            </button>
          </div>
        </div>

        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="hint">{notice}</p>}

        <button className="btn primary" type="submit" disabled={busy || leaving} style={{ width: '100%', padding: '13px', marginTop: 6, fontSize: 15 }}>
          {busy ? 'One sec…' : isRegister ? 'Create account' : 'Log in'}
        </button>

        <p className="auth-switch">
          {isRegister
            ? <>Already have an account? <Link href="/login">Log in</Link></>
            : <>New here? <Link href="/register">Register</Link></>}
        </p>
      </form>
    </main>
  );
}
