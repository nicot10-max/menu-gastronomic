import { Redis } from '@upstash/redis';

const SECRET = '159';
const KV_KEY = 'pb_data';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const data = (await redis.get(KV_KEY)) || {};
    return res.status(200).json(data);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  if (!body || body.key !== SECRET) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const action = body.action || 'save';

  if (action === 'save') {
    await redis.set(KV_KEY, body.data || {});
    return res.status(200).json({ ok: true });
  }

  if (action === 'upload_photo') {
    const id = (body.id || 'photo').replace(/[^a-z0-9\-_]/g, '');
    const imageData = body.imageData || '';
    const data = (await redis.get(KV_KEY)) || {};
    if (!data.photos) data.photos = {};
    data.photos[id] = imageData;
    await redis.set(KV_KEY, data);
    return res.status(200).json({ url: imageData });
  }

  if (action === 'delete_photo') {
    const id = (body.id || '').replace(/[^a-z0-9\-_]/g, '');
    const data = (await redis.get(KV_KEY)) || {};
    if (data.photos) delete data.photos[id];
    await redis.set(KV_KEY, data);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Acción no reconocida' });
}
