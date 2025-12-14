require('dotenv').config();
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const path = require('path');
const querystring = require('querystring');
const multer = require("multer");

const app = express();

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const PORT = process.env.PORT || 3000;

// Middleware estático
app.use(express.static(path.join(__dirname, 'public')));
const PLAYLIST_DIR = path.join(__dirname, 'playlists');
// Sesiones para guardar tokens por usuario
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: true,
  })
);

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 }, // 200 KB máximo
});
function timestamp() {
  const d = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-` +
    `${pad(d.getMonth() + 1)}-` +
    `${pad(d.getDate())}_` +
    `${pad(d.getHours())}-` +
    `${pad(d.getMinutes())}-` +
    `${pad(d.getSeconds())}`
  );
}

function validateTsvContent(content) {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return "El archivo está vacío.";
  }

  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length < 4) {
      return `Línea ${i + 1} no tiene 4 columnas.`;
    }

    const [artist, title, year, url] = cols;

    if (!artist || !title) {
      return `Línea ${i + 1}: artista o título vacío.`;
    }

    if (!/^[0-9]{4}$/.test(year)) {
      return `Línea ${i + 1}: el año debe ser un número de 4 dígitos.`;
    }

    if (!url.includes("spotify.com/track/")) {
      return `Línea ${i + 1}: URL Spotify inválida.`;
    }
  }

  return null; // válido
}
// Helper: genera string aleatorio para "state"
function generateRandomString(length) {
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// Scopes necesarios para controlar reproducción
const scopes = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
];

// ---- Rutas OAuth ----

// 1) /login -> redirige a Spotify
app.get('/login', (req, res) => {
  const state = generateRandomString(16);
  req.session.spotifyState = state;

  const params = querystring.stringify({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: scopes.join(' '),
    redirect_uri: REDIRECT_URI,
    state: state,
  });

  res.redirect('https://accounts.spotify.com/authorize?' + params);
});

// 2) /callback -> Spotify viene aquí con ?code=...
app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  const state = req.query.state || null;
  const storedState = req.session.spotifyState || null;

  if (!state || state !== storedState) {
    return res.status(400).send('State mismatch');
  }

  // Ya no lo necesitamos
  req.session.spotifyState = null;

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' +
          Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
      },
      body: querystring.stringify({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('Error token:', body);
      return res.status(500).send('Error fetching token from Spotify');
    }

    const tokenData = await tokenRes.json();

    // Guardamos tokens en la sesión
    req.session.spotifyAccessToken = tokenData.access_token;
    req.session.spotifyRefreshToken = tokenData.refresh_token;
    req.session.spotifyTokenExpiresAt =
      Date.now() + (tokenData.expires_in - 60) * 1000; // un pelín antes

    res.redirect('/'); // vuelve a la web
  } catch (err) {
    console.error(err);
    res.status(500).send('Error during token exchange');
  }
});

// Helper: refresca token si hace falta
async function getValidAccessToken(req) {
  let accessToken = req.session.spotifyAccessToken;
  const refreshToken = req.session.spotifyRefreshToken;
  const expiresAt = req.session.spotifyTokenExpiresAt;

  if (!accessToken || !refreshToken) {
    return null;
  }

  if (Date.now() < expiresAt) {
    return accessToken;
  }

  // Token caducado -> refrescar
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:
        'Basic ' +
        Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
    },
    body: querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!tokenRes.ok) {
    console.error('Error refreshing token', await tokenRes.text());
    return null;
  }

  const tokenData = await tokenRes.json();
  accessToken = tokenData.access_token;
  req.session.spotifyAccessToken = accessToken;
  req.session.spotifyTokenExpiresAt =
    Date.now() + (tokenData.expires_in - 60) * 1000;

  return accessToken;
}

// 3) Endpoint para que el frontend obtenga el accessToken
app.get('/api/spotify-token', async (req, res) => {
  try {
    const token = await getValidAccessToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Not logged in to Spotify' });
    }
    res.json({ accessToken: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error getting token' });
  }
});

// 4) Endpoint para que el frontend obtenga las playlists
app.get('/api/playlists', (req, res) => {
  try {
    const files = fs
      .readdirSync(PLAYLIST_DIR)
      .filter(f => f.toLowerCase().endsWith('.tsv'));

    res.json({ playlists: files });
  } catch (err) {
    console.error("Error leyendo carpeta playlists:", err);
    res.status(500).json({ error: "No se pudieron listar las playlists" });
  }
});

// 5) Endpoint para que el frontend obtenga el contenido de una playlist concreta
app.get('/api/load-playlist', (req, res) => {
  const name = req.query.name;

  if (!name || !name.endsWith(".tsv")) {
    return res.status(400).json({ error: "Nombre inválido" });
  }

  const filePath = path.join(PLAYLIST_DIR, name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Playlist no encontrada" });
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ content });
  } catch (err) {
    console.error("Error leyendo playlist:", err);
    res.status(500).json({ error: "Error leyendo el archivo" });
  }
});
//6) Endpoint para que el frontend envíe playlists
app.post("/api/upload-playlist", upload.single("playlist"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No se envió ningún archivo.");
    }

    const original = req.file.originalname;

    if (!original.toLowerCase().endsWith(".tsv")) {
      return res.status(400).send("El archivo debe ser .tsv");
    }

    const safeBase = sanitizeFilename(original.replace(".tsv", ""));
    const finalName = `${safeBase}_${timestamp()}.tsv`;
    const finalPath = path.join(PLAYLIST_DIR, finalName);

    const content = req.file.buffer.toString("utf8");

    // VALIDACIÓN TSV
    const invalidReason = validateTsvContent(content);
    if (invalidReason) {
      return res.status(400).send(`Archivo inválido: ${invalidReason}`);
    }

    fs.writeFileSync(finalPath, req.file.buffer);

    res.status(200).send("OK");
  } catch (err) {
    console.error("Error subiendo playlist:", err);
    res.status(500).send("Error interno del servidor.");
  }
});
// 7) Cualquier otra ruta sirve index.html (para SPA simple)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
app.listen(PORT, () => {
  console.log(`Servidor escuchando en https://gilderr.nementium.ai/:${PORT}`);
});


