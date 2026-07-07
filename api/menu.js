import { kv }      from '@vercel/kv';
import { put, del } from '@vercel/blob';

const SECRET   = '159';
const KV_KEY   = 'pb_data';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: devuelve todos los datos ─────────────────────────────────────────
  if (req.method === 'GET') {
    const data = await kv.get(KV_KEY) || {};
    return res.status(200).json(data);
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  if (!body || body.key !== SECRET) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const action = body.action || 'save';

  // Guardar datos
  if (action === 'save') {
    await kv.set(KV_KEY, body.data || {});
    return res.status(200).json({ ok: true });
  }

  // Subir foto (base64 → Vercel Blob)
  if (action === 'upload_photo') {
    const base64 = (body.imageData || '').replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const blob   = await put(`photos/${body.id}.jpg`, buffer, {
      access:          'public',
      contentType:     'image/jpeg',
      addRandomSuffix: false,
    });

    // Guardar URL en KV
    const data = await kv.get(KV_KEY) || {};
    if (!data.photos) data.photos = {};
    data.photos[body.id] = blob.url;
    await kv.set(KV_KEY, data);

    return res.status(200).json({ url: blob.url });
  }

  // Eliminar foto
  if (action === 'delete_photo') {
    const data     = await kv.get(KV_KEY) || {};
    const photoUrl = data.photos?.[body.id];
    if (photoUrl) {
      try { await del(photoUrl); } catch (e) {}
      delete data.photos[body.id];
      await kv.set(KV_KEY, data);
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Acción no reconocida' });
}
