const crypto = require('crypto');

const DATA_KEY = 'pb_data';
const AUTH_KEY = 'pb_auth';          // separado: nunca se expone en el GET público
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

const MAX_PHOTO_BYTES = 900 * 1024;  // base64 de una foto comprimida
const MAX_DATA_BYTES  = 2 * 1024 * 1024;

// ── Upstash REST ──────────────────────────────────────────────────────────────

function kvEnv() {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Base de datos no configurada');
  return { url, token };
}

async function pipeline(commands) {
  const { url, token } = kvEnv();
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return (await res.json()).map(r => r.result);
}

async function dbGet(key) {
  const [raw] = await pipeline([['GET', key]]);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function dbSet(key, value) {
  await pipeline([['SET', key, JSON.stringify(value)]]);
}

// ── Rate limiting por IP ──────────────────────────────────────────────────────

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : '') || 'desconocida';
}

async function rateLimit(key, max, windowSec) {
  try {
    const [count, ttl] = await pipeline([['INCR', key], ['TTL', key]]);
    if (ttl < 0) await pipeline([['EXPIRE', key, windowSec]]);
    return count <= max;
  } catch {
    return true; // si falla la infra, no bloqueamos al dueño
  }
}

// ── Autenticación ─────────────────────────────────────────────────────────────

function masterPassword() {
  const p = process.env.ADMIN_PASSWORD;
  if (!p) throw new Error('ADMIN_PASSWORD no está configurada en el servidor');
  return p;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function signToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', masterPassword()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function validToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', masterPassword()).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

// Valida el PIN guardado en la base; si no hay ninguno, usa la contraseña maestra.
async function checkPassword(pin) {
  const auth = await dbGet(AUTH_KEY);
  if (auth && auth.salt && auth.hash) {
    return safeEqual(hashPin(pin, auth.salt), auth.hash);
  }
  return safeEqual(pin, masterPassword());
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Sin CORS: admin y menú se sirven desde el mismo dominio. Esto impide que
  // otro sitio haga peticiones de escritura desde el navegador de la víctima.
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    try {
      const data = (await dbGet(DATA_KEY)) || {};
      delete data.auth; // por si quedó algo de versiones viejas
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Petición inválida' });
  }

  const ip = clientIp(req);

  try {
    // ── Login: única acción que no requiere token ─────────────────────────────
    if (body.action === 'login') {
      if (!(await rateLimit(`rl:login:${ip}`, 8, 900))) {
        return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' });
      }
      const pin = String(body.password ?? '');
      if (!pin || !(await checkPassword(pin))) {
        return res.status(401).json({ error: 'PIN incorrecto' });
      }
      return res.status(200).json({ token: signToken() });
    }

    // ── A partir de acá hace falta un token válido ────────────────────────────
    if (!validToken(bearer(req))) {
      return res.status(401).json({ error: 'Sesión expirada. Volvé a ingresar el PIN.' });
    }

    if (!(await rateLimit(`rl:write:${ip}`, 120, 60))) {
      return res.status(429).json({ error: 'Demasiadas peticiones. Esperá un minuto.' });
    }

    const action = body.action || 'save';

    if (action === 'save') {
      const data = body.data && typeof body.data === 'object' ? body.data : {};
      delete data.auth;
      if (JSON.stringify(data).length > MAX_DATA_BYTES) {
        return res.status(413).json({ error: 'Los datos superan el tamaño permitido' });
      }
      await dbSet(DATA_KEY, data);
      return res.status(200).json({ ok: true });
    }

    if (action === 'upload_photo') {
      const id = String(body.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) return res.status(400).json({ error: 'Producto inválido' });

      const imageData = String(body.imageData || '');
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imageData)) {
        return res.status(400).json({ error: 'Formato de imagen no permitido' });
      }
      if (imageData.length > MAX_PHOTO_BYTES) {
        return res.status(413).json({ error: 'La foto es demasiado grande' });
      }

      const data = (await dbGet(DATA_KEY)) || {};
      if (!data.photos) data.photos = {};
      data.photos[id] = imageData;
      await dbSet(DATA_KEY, data);
      return res.status(200).json({ url: imageData });
    }

    if (action === 'delete_photo') {
      const id = String(body.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const data = (await dbGet(DATA_KEY)) || {};
      if (data.photos) delete data.photos[id];
      await dbSet(DATA_KEY, data);
      return res.status(200).json({ ok: true });
    }

    if (action === 'change_pin') {
      const current = String(body.current ?? '');
      const nuevo   = String(body.nuevo ?? '');
      if (!(await checkPassword(current))) {
        return res.status(401).json({ error: 'El PIN actual es incorrecto' });
      }
      if (!/^\d{4,12}$/.test(nuevo)) {
        return res.status(400).json({ error: 'El PIN debe tener entre 4 y 12 dígitos' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      await dbSet(AUTH_KEY, { salt, hash: hashPin(nuevo, salt) });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
