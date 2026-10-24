'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';

export default function AuthForm({ mode }) {
  const router = useRouter();
  const isRegister = mode === 'register';
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');

    const { data, error } = isRegister
      ? await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName.trim() || null } },
        })
      : await supabase.auth.signInWithPassword({ email, password });

    setBusy(false);
    if (error) return setError(error.message);
    if (data.session) return router.replace('/');
    setNotice('Check your email to confirm your account, then log in.');
  }

  return (
    <main className="auth">
      <h1>🦆 Duck Daddy</h1>
      <p>{isRegister ? 'Create an account to take the duck.' : 'Log in to take the duck.'}</p>

      <form className="card" onSubmit={onSubmit}>
        {isRegister && (
          <div className="field">
            <label htmlFor="name">Display name</label>
            <input id="name" type="text" maxLength={50} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password" type="password" required minLength={6}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="error">{error}</p>}
        {notice && <p className="hint">{notice}</p>}
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? '…' : isRegister ? 'Register' : 'Log in'}
        </button>
      </form>

      <p style={{ marginTop: 16, fontSize: 14 }}>
        {isRegister
          ? <>Already have an account? <Link href="/login">Log in</Link></>
          : <>New here? <Link href="/register">Register</Link></>}
      </p>
    </main>
  );
}
