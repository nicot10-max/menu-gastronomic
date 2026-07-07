const SECRET = '159';
const KV_KEY  = 'pb_data';

function getEnv() {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env vars missing');
  return { url, token };
}

async function dbGet(key) {
  const { url, token } = getEnv();
  const res = await fetch(`${url}/get/${key}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`GET ${res.status}`);
  const { result } = await res.json();
  if (result == null) return null;
  try { return JSON.parse(result); } catch { return result; }
}

async function dbSet(key, value) {
  const { url, token } = getEnv();
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([['SET', key, JSON.stringify(value)]])
  });
  if (!res.ok) throw new Error(`SET ${res.status}`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const data = (await dbGet(KV_KEY)) || {};
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }

  if (!body || body.key !== SECRET) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const action = body.action || 'save';

  try {
    if (action === 'save') {
      await dbSet(KV_KEY, body.data || {});
      return res.status(200).json({ ok: true });
    }

    if (action === 'upload_photo') {
      const id   = (body.id || 'photo').replace(/[^a-z0-9\-_]/g, '');
      const data = (await dbGet(KV_KEY)) || {};
      if (!data.photos) data.photos = {};
      data.photos[id] = body.imageData || '';
      await dbSet(KV_KEY, data);
      return res.status(200).json({ url: body.imageData });
    }

    if (action === 'delete_photo') {
      const id   = (body.id || '').replace(/[^a-z0-9\-_]/g, '');
      const data = (await dbGet(KV_KEY)) || {};
      if (data.photos) delete data.photos[id];
      await dbSet(KV_KEY, data);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
