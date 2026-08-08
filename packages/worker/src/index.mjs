// Worker entry: auth gate + routing. All /api and /ws traffic funnels into the
// single Hub Durable Object; everything else is served from static assets.
export { Hub } from './hub.mjs';

function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function userAuthed(request, url, env) {
  if (!env.ACCESS_TOKEN) return false;
  const header = request.headers.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const token = bearer || url.searchParams.get('token') || '';
  return token.length > 0 && timingSafeEqual(token, env.ACCESS_TOKEN);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/health') {
      return Response.json({ ok: true, ts: Date.now() });
    }

    if (pathname === '/api/login') {
      let body = {};
      try { body = await request.json(); } catch { /* empty */ }
      const good = body.token && timingSafeEqual(body.token, env.ACCESS_TOKEN || '');
      return Response.json({ ok: !!good }, { status: good ? 200 : 401 });
    }

    if (pathname === '/api/vapid') {
      if (!userAuthed(request, url, env)) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      return Response.json({ ok: true, publicKey: env.VAPID_PUBLIC_KEY || null });
    }

    const hub = () => env.HUB.get(env.HUB.idFromName('hub'));

    if (pathname === '/ws/executor') {
      // node token is verified inside the DO against the nodes table
      return hub().fetch(request);
    }

    if (pathname === '/ws/frontend') {
      if (!userAuthed(request, url, env)) return new Response('unauthorized', { status: 401 });
      return hub().fetch(request);
    }

    if (pathname.startsWith('/api/')) {
      if (!userAuthed(request, url, env)) {
        return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
      return hub().fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
