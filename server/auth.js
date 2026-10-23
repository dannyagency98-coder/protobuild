const env = require('./env');

function authOn() {
  return !!(env.supabaseUrl && env.supabaseAnonKey);
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function publicError(json, fallback) {
  const raw = String(json?.msg || json?.error_description || json?.message || json?.error || '');
  if (/invalid login|invalid credentials/i.test(raw)) return 'That email or password is wrong.';
  if (/email not confirmed/i.test(raw)) return 'Confirm that email, then sign in.';
  if (/already registered|already been registered/i.test(raw)) return 'That email already has an account. Sign in instead.';
  if (/password/i.test(raw) && /short|least|weak/i.test(raw)) return 'Use a password of at least 6 characters.';
  if (/unable to validate email|invalid email/i.test(raw)) return 'Enter a valid email address.';
  return fallback;
}

async function supabaseAuth(path, body) {
  const res = await fetch(`${env.supabaseUrl}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.supabaseAnonKey,
      Authorization: `Bearer ${env.supabaseAnonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

function sessionOf(json) {
  if (!json?.access_token || !json?.user?.id) return null;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || '',
    expires_at: json.expires_at || 0,
    user: { id: json.user.id, email: json.user.email || '' },
  };
}

async function signIn(email, password) {
  const { ok, json } = await supabaseAuth('token?grant_type=password', { email, password });
  const session = sessionOf(json);
  if (!ok || !session) {
    const error = new Error(publicError(json, 'Sign-in did not go through.'));
    error.status = 401;
    throw error;
  }
  return session;
}

async function refresh(refreshToken) {
  const { ok, json } = await supabaseAuth('token?grant_type=refresh_token', { refresh_token: refreshToken });
  const session = sessionOf(json);
  if (!ok || !session) {
    const error = new Error('Sign in again.');
    error.status = 401;
    throw error;
  }
  return session;
}

async function changePassword(email, current, next) {
  const session = await signIn(email, current);
  const res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: env.supabaseAnonKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: next }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(publicError(json, 'That password was not saved.'));
    error.status = 400;
    throw error;
  }
  return signIn(email, next);
}

async function userFromToken(token) {
  if (!authOn() || !token) return null;
  const res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: env.supabaseAnonKey, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  if (!user?.id) return null;
  return { id: user.id, email: user.email || '' };
}

module.exports = { authOn, cleanEmail, signIn, refresh, changePassword, userFromToken };
