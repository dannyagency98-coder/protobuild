function publicError(json, fallback) {
  const raw = String(json?.msg || json?.error_description || json?.message || json?.error || '');
  if (/invalid login|invalid credentials/i.test(raw)) return 'That email or password is wrong.';
  if (/email not confirmed/i.test(raw)) return 'Confirm that email, then sign in.';
  if (/already registered|already been registered/i.test(raw)) return 'That email already has an account. Sign in instead.';
  if (/password/i.test(raw) && /short|least|weak/i.test(raw)) return 'Use a password of at least 6 characters.';
  if (/unable to validate email|invalid email/i.test(raw)) return 'Enter a valid email address.';
  return fallback;
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

async function supabaseAuth(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

export async function passwordAuth(env, kind, email, password) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return { error: 'Sign-in is not configured on this deploy.', status: 503 };
  }
  if (kind === 'refresh') {
    const { ok, json } = await supabaseAuth(env, 'token?grant_type=refresh_token', { refresh_token: password });
    const session = sessionOf(json);
    if (!ok || !session) return { error: 'Sign in again.', status: 401 };
    return { session };
  }
  if (kind === 'signup') {
    const { ok, json } = await supabaseAuth(env, 'signup', { email, password });
    const session = sessionOf(json.session || json);
    if (session) return { session };
    if (ok && json?.user?.id) return { confirm: true, email };
    return { error: publicError(json, 'That account could not be created.'), status: 400 };
  }
  const { ok, json } = await supabaseAuth(env, 'token?grant_type=password', { email, password });
  const session = sessionOf(json);
  if (!ok || !session) return { error: publicError(json, 'Sign-in did not go through.'), status: 401 };
  return { session };
}

export async function updatePassword(env, accessToken, password) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { error: publicError(json, 'That password was not saved.'), status: 400 };
  return { ok: true };
}
