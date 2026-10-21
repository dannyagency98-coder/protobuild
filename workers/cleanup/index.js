const DAYS = 30;

async function deletePrefix(env, prefix) {
  let cursor;
  do {
    const listed = await env.R2.list({ prefix, cursor });
    await Promise.all((listed.objects || []).map((item) => env.R2.delete(item.key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export default {
  async scheduled(_event, env) {
    if (!env.R2) return;
    const cutoff = Date.now() - DAYS * 86400000;
    let cursor;
    do {
      const listed = await env.R2.list({ prefix: 'sites/', cursor });
      for (const item of listed.objects || []) {
        if (!item.key.endsWith('/job.json')) continue;
        const obj = await env.R2.get(item.key);
        const job = obj ? await obj.json().catch(() => null) : null;
        const when = Date.parse(job?.finished_at || job?.created_at || '');
        if (!job?.id || !Number.isFinite(when) || when >= cutoff) continue;
        if (job.share_token) await env.R2.delete(`shares/${job.share_token}.json`);
        await deletePrefix(env, `sites/${job.id}/`);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    cursor = undefined;
    do {
      const listed = await env.R2.list({ prefix: 'shares/', cursor });
      for (const item of listed.objects || []) {
        const obj = await env.R2.get(item.key);
        const meta = obj ? await obj.json().catch(() => null) : null;
        if (meta?.expiresAt && Date.parse(meta.expiresAt) <= Date.now()) await env.R2.delete(item.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  },
};
