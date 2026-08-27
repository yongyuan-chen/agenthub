// Worker entry: auth gate + routing. All /api and /ws traffic funnels into the
// single Hub Durable Object; everything else is served from static assets.
export { Hub } from './hub.mjs';
import * as accounts from './accounts.mjs';

async function resolveUser(request, url, env) {
  const header = request.headers.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const token = bearer || url.searchParams.get('token') || '';
  if (!token) return null;
  return accounts.resolveSession(env.DB, token);
}

// Stamps the resolved user id onto the request so the Hub DO (which only
// trusts this header, never re-verifies the bearer token itself) knows who's
// calling. Without this every /api/* call reaches hub-core with userId=null.
function withUser(request, userId) {
  const headers = new Headers(request.headers);
  headers.set('x-agenthub-user', userId);
  return new Request(request, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/health') {
      return Response.json({ ok: true, ts: Date.now() });
    }

    if (pathname === '/api/register/status' && request.method === 'GET') {
      const { open, hasUsers } = await accounts.registrationStatus(env.DB);
      return Response.json({ ok: true, open, hasUsers });
    }

    if (pathname === '/api/register' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { /* empty */ }
      const { status, body: resBody } = await accounts.register(env.DB, body, Date.now());
      return Response.json(resBody, { status });
    }

    if (pathname === '/api/login' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { /* empty */ }
      const { status, body: resBody } = await accounts.login(env.DB, body, Date.now());
      return Response.json(resBody, { status });
    }

    if (pathname === '/api/logout' && request.method === 'POST') {
      const header = request.headers.get('authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const { status, body: resBody } = await accounts.logout(env.DB, token);
      return Response.json(resBody, { status });
    }

    if (pathname === '/api/vapid') {
      const userId = await resolveUser(request, url, env);
      if (!userId) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      return Response.json({ ok: true, publicKey: env.VAPID_PUBLIC_KEY || null });
    }

    const hub = () => env.HUB.get(env.HUB.idFromName('hub'));

    if (pathname === '/ws/executor') {
      // node token is verified inside the DO against the nodes table
      return hub().fetch(request);
    }

    if (pathname === '/ws/frontend') {
      const userId = await resolveUser(request, url, env);
      if (!userId) return new Response('unauthorized', { status: 401 });
      return hub().fetch(withUser(request, userId));
    }

    if (pathname.startsWith('/api/')) {
      const userId = await resolveUser(request, url, env);
      if (!userId) {
        return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
      return hub().fetch(withUser(request, userId));
    }

    return env.ASSETS.fetch(request);
  },
};
