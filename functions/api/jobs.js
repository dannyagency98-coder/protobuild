import { currentUser, json, queueCapture } from '../lib/edge.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    if (request.method === 'GET') return json({ jobs: [] });
    return json({ error: 'This hosted copy can chat. Scanning a new site still runs in Protobuild on your computer.' }, 503);
  }
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Sign in first.' }, 401);

  if (request.method === 'GET') {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/jobs?user_id=eq.${user.id}&select=*&order=created_at.desc&limit=40`, {
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
    });
    const jobs = await res.json().catch(() => []);
    return json({ jobs: Array.isArray(jobs) ? jobs : [] });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (!body.rights_confirmed) return json({ error: 'Rights confirmation required' }, 400);
    return queueCapture(env, user, body);
  }

  return json({ error: 'Not found' }, 404);
}
