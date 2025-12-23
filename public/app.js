let accessToken = null;
let player = null;
let deviceId = null;
let isPlayerReady = false;
let previewTimeoutId = null;
let playlist = [];
let currentIndex = 0;

/* ELEMENTOS UI */
const statusEl = document.getElementById("status");
const notLoggedEl = document.getElementById("not-logged");
const playerUiEl = document.getElementById("player-ui");
const playlistMetaEl = document.getElementById("playlist-meta");

const playlistPicker = document.getElementById("playlist-picker");
const btnLoadPlaylist = document.getElementById("btn-load-playlist");

const btnPlay = document.getElementById("btn-play");
const btnStop = document.getElementById("btn-stop");
const btnNext = document.getElementById("btn-next");
const btnPrev = document.getElementById("btn-prev");
const btnReveal = document.getElementById("btn-reveal");

const infoTotal = document.getElementById("info-total");
const infoIndex = document.getElementById("info-index");
const infoUriTop = document.getElementById("info-uri-top");

const infoTitle = document.getElementById("info-title");
const infoArtist = document.getElementById("info-artist");
const infoYear = document.getElementById("info-year");

const deviceStatusEl = document.getElementById("device-status");
const btnUpload = document.getElementById("btn-upload-playlist");
const fileInput = document.getElementById("playlist-file");
const btnCreatePlaylist = document.getElementById("btn-create-playlist");
const createOverlay = document.getElementById("create-playlist-overlay");
const btnGeneratePlaylist = document.getElementById("btn-generate-playlist");
const btnCancelCreate = document.getElementById("btn-cancel-create");
const playlistInstructionsInput = document.getElementById("playlist-instructions");

btnUpload.onclick = () => fileInput.click();

// Mostrar overlay de creación
btnCreatePlaylist.onclick = () => {
  createOverlay.classList.remove("hidden");
  playlistInstructionsInput.focus();
};

// Ocultar overlay
btnCancelCreate.onclick = () => {
  createOverlay.classList.add("hidden");
  playlistInstructionsInput.value = "";
};

// Cerrar overlay al hacer clic fuera
createOverlay.onclick = (e) => {
  if (e.target === createOverlay) {
    createOverlay.classList.add("hidden");
    playlistInstructionsInput.value = "";
  }
};

// Generar playlist
btnGeneratePlaylist.onclick = async () => {
  const instructions = playlistInstructionsInput.value.trim();
  if (!instructions) {
    showToast("Por favor, escribe las instrucciones para la playlist", "error");
    return;
  }

  createOverlay.classList.add("hidden");
  showProgressModal(true);
  updateProgressModal("Generando playlist con IA...", 0, 100);

  try {
    const res = await fetch("/api/generate-playlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ instructions }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(error || "Error generando playlist");
    }

    const data = await res.json();
    updateProgressModal("Buscando canciones en Spotify...", 0, 100);
    
    // Parsear la playlist generada
    let lines = parseTsv(data.playlist);
    
    // Completar URLs de Spotify
    lines = await fillMissingSpotifyUrls(lines, accessToken, (done, total) => {
      updateProgressModal(`Buscando ${done}/${total}…`, done, total);
    });
    
    // Construir TSV final
    const finalTsv = buildTsv(lines);
    
    // Guardar la playlist en el servidor
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const filename = `playlist_generada_${timestamp}.tsv`;
    await uploadFinalPlaylist(finalTsv, filename);
    
    // Cargar la playlist en el reproductor
    await loadPlaylistString(finalTsv);
    
    await loadAvailablePlaylists();
    showToast("✅ Playlist generada y cargada correctamente");
  } catch (err) {
    console.error("Error generando playlist:", err);
    showToast("Error generando playlist: " + err.message, "error");
  } finally {
    showProgressModal(false);
    playlistInstructionsInput.value = "";
  }
};

fileInput.onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (!file.name.endsWith(".tsv")) {
    showToast("El archivo debe ser .tsv", "error");
    return;
  }

  const text = await file.text();
  let lines = parseTsv(text);

  showProgressModal(true);
  updateProgressModal("Buscando canciones...", 0, lines.length);

  lines = await fillMissingSpotifyUrls(lines, accessToken, (done, total) => {
    updateProgressModal(`Buscando ${done}/${total}…`, done, total);
  });

  showProgressModal(false);

  const finalTsv = buildTsv(lines);

  await uploadFinalPlaylist(finalTsv, file.name);

  await loadAvailablePlaylists();
};


const playlistSelector = document.getElementById("playlist-selector");
const playlistHeader = document.getElementById("playlist-header");

function collapsePlaylistSelector() {
  playlistSelector.classList.add("collapsed");
}

function expandPlaylistSelector() {
  playlistSelector.classList.remove("collapsed");
}

playlistHeader.addEventListener("click", () => {
  playlistSelector.classList.toggle("collapsed");
});

/* -------------------------------------------------------
   LISTAR PLAYLISTS DISPONIBLES (BACKEND)
---------------------------------------------------------*/
async function loadAvailablePlaylists() {
  const res = await fetch("/api/playlists");
  const data = await res.json();

  playlistPicker.innerHTML = "";

  data.playlists.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    playlistPicker.appendChild(opt);
  });
}

/* -------------------------------------------------------
   CARGAR PLAYLIST SELECCIONADA DEL BACKEND
---------------------------------------------------------*/
async function loadPlaylistFromBackend() {
  const name = playlistPicker.value;
  if (!name) return;

  statusEl.classList.remove("hidden");
  statusEl.textContent = `Cargando playlist "${name}"…`;

  const res = await fetch(`/api/load-playlist?name=${encodeURIComponent(name)}`);
  if (!res.ok) {
    showToast("No se pudo cargar la playlist desde el servidor: ", "error");
    return;
  }

  const data = await res.json();
  await loadPlaylistString(data.content);

  statusEl.textContent = `Playlist "${name}" cargada correctamente.`;
}

/* -------------------------------------------------------
   CARGAR PLAYLIST A PARTIR DE TEXTO TSV
---------------------------------------------------------*/
async function loadPlaylistString(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  playlist = lines.map((line) => {
    const cols = line.split("\t").map((c) => c.trim());
    const artist = cols[0] || "";
    const title = cols[1] || "";
    const year = cols[2] || "";
    const url = cols[3] || "";

    let trackId = "";
    const m = url.match(/track\/([A-Za-z0-9]+)(\?|$)/);
    if (m) trackId = m[1];

    const uri = trackId ? `spotify:track:${trackId}` : "";
    return { uri, title, artist, year, trackId };
  });

  playlist = playlist.filter((s) => s.uri);
  shuffleArray(playlist);

  currentIndex = 0;
  updateMetaInfo();

  playlistMetaEl.classList.remove("hidden");
  collapsePlaylistSelector();
  playerUiEl.classList.remove("hidden");

}

/* -------------------------------------------------------
   UTILIDADES
---------------------------------------------------------*/
function showToast(message, type = "success") {
  console.log(message);
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = "toast " + (type === "error" ? "error" : "");
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3500);
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function updateMetaInfo() {
  const song = playlist[currentIndex];
  if (!song) return;

  infoTotal.textContent = playlist.length;
  infoIndex.textContent = `${currentIndex + 1} / ${playlist.length}`;
  infoUriTop.textContent = song.uri;

  statusEl.textContent = `Lista para reproducir: ${song.title} — ${song.artist}`;
}

function showProgressModal(show) {
  document.getElementById("progress-modal").classList.toggle("hidden", !show);
}

function updateProgressModal(text, done, total) {
  document.getElementById("progress-title").textContent = text;
  const pct = Math.floor((done / total) * 100);
  document.getElementById("progress-value").style.width = pct + "%";
  document.getElementById("progress-text").textContent = `${pct}% completado`;
}

/* -------------------------------------------------------
   SPOTIFY AUTH + PLAYER
---------------------------------------------------------*/
async function fetchSpotifyToken() {
  const res = await fetch("/api/spotify-token");
  if (!res.ok) throw new Error("No token");
  return (await res.json()).accessToken;
}

async function init() {
  try {
    accessToken = await fetchSpotifyToken();

    statusEl.classList.remove("hidden");
    statusEl.textContent = "Conectado a Spotify.";

    notLoggedEl.classList.add("hidden");
    playerUiEl.classList.remove("hidden");

    // 👉 Ahora sí mostramos el selector playlist
    document.getElementById("playlist-selector").classList.remove("hidden");
    expandPlaylistSelector();

    setupSpotifyPlayer();

    await loadAvailablePlaylists();
  } catch {
    // No conectado a Spotify
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Inicia sesión con Spotify Premium.";

    notLoggedEl.classList.remove("hidden");

    // Escondemos selector playlist
    document.getElementById("playlist-selector").classList.add("hidden");
  }
}

window.onSpotifyWebPlaybackSDKReady = () => {
  if (accessToken) setupSpotifyPlayer();
};

function setupSpotifyPlayer() {
  if (player || !accessToken || typeof Spotify === "undefined") return;

  player = new Spotify.Player({
    name: "Gilderr Preview Web",
    getOAuthToken: (cb) => cb(accessToken),
    volume: 0.8,
  });

  player.addListener("ready", ({ device_id }) => {
    deviceId = device_id;
    isPlayerReady = true;
    deviceStatusEl.textContent = "🟢 Player: listo";
  });

  player.addListener("not_ready", () => {
    deviceStatusEl.textContent = "🔴 Player: no disponible";
  });

  player.connect();
}

// ---- helpers de normalización ----
function normalizeText(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[^a-z0-9\s]/g, "")     // quita símbolos
    .replace(/\s+/g, " ")
    .trim();
}

function isBadVersion(name) {
  return /(live|en vivo|karaoke|instrumental|remaster|edit|version)/i.test(name);
}

// similitud simple tipo Jaccard
function titleSimilarity(a, b) {
  const A = new Set(a.split(" "));
  const B = new Set(b.split(" "));
  const inter = new Set([...A].filter(x => B.has(x)));
  return inter.size / Math.max(A.size, B.size);
}

/* -------------------------------------------------------
   search track + complete tsv
---------------------------------------------------------*/
function normalizeText(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[^a-z0-9\s]/g, "")     // quita símbolos
    .replace(/\s+/g, " ")
    .trim();
}

function isBadVersion(name) {
  return /(live|en vivo|karaoke|instrumental|remaster|edit|version)/i.test(name);
}

// similitud simple tipo Jaccard
function titleSimilarity(a, b) {
  const A = new Set(a.split(" "));
  const B = new Set(b.split(" "));
  const inter = new Set([...A].filter(x => B.has(x)));
  return inter.size / Math.max(A.size, B.size);
}

// ---- FUNCIÓN PRINCIPAL ----
async function searchSpotifyTrackSmart({ artist, title, year }, accessToken) {
  const query = `track:${title} artist:${artist}`;
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(
    query
  )}&type=track&limit=10`;

  console.group("🎧 Spotify search");
  console.log("Query:", query);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    console.warn("Spotify search error", res.status);
    console.groupEnd();
    return null;
  }

  const data = await res.json();
  const items = data.tracks?.items || [];

  if (items.length === 0) {
    console.warn("Sin resultados Spotify");
    console.groupEnd();
    return null;
  }

  const nArtist = normalizeText(artist);
  const nTitle = normalizeText(title);
  const yearNum = parseInt(year, 10);

  console.table(
    items.map(i => ({
      name: i.name,
      artist: i.artists[0]?.name,
      year: i.album.release_date?.slice(0, 4),
      id: i.id
    }))
  );

  let best = null;
  let bestScore = -1;

  for (const track of items) {
    const tArtist = normalizeText(track.artists[0]?.name || "");
    const tTitleRaw = track.name;
    const tTitle = normalizeText(tTitleRaw);
    const tYear = parseInt(track.album.release_date?.slice(0, 4), 10);

    let score = 0;

    // 1️⃣ artista exacto
    if (tArtist === nArtist) score += 5;
    else if (tArtist.includes(nArtist) || nArtist.includes(tArtist)) score += 3;

    // 2️⃣ título exacto / flexible
    if (tTitle === nTitle) score += 5;
    else score += titleSimilarity(tTitle, nTitle) * 4;

    // 3️⃣ penalizar versiones malas
    if (isBadVersion(tTitleRaw)) score -= 4;

    // 4️⃣ coincidencia de año
    if (!isNaN(yearNum) && !isNaN(tYear)) {
      if (tYear === yearNum) score += 2;
      else if (Math.abs(tYear - yearNum) === 1) score += 1;
      else score -= 1;
    }

    console.log("Evaluado:", {
      track: track.name,
      artist: track.artists[0]?.name,
      year: tYear,
      score
    });

    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }

  if (!best || bestScore < 3) {
    console.warn("⚠️ No se encontró coincidencia fiable");
    console.groupEnd();
    return null;
  }

  console.log("✅ Seleccionado:", {
    name: best.name,
    artist: best.artists[0].name,
    uri: best.uri,
    score: bestScore
  });

  console.groupEnd();

  return {
    uri: best.uri,
    url: best.external_urls.spotify,
    trackId: best.id,
    matchedName: best.name
  };
}

function parseTsv(text) {
  let lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  // Detectar cabecera automáticamente y saltarla
  const first = lines[0].toLowerCase();
  const hasHeader =
    first.includes("artista") ||
    first.includes("titulo") ||
    first.includes("título") ||
    first.includes("año") ||
    first.includes("url");

  if (hasHeader) {
    lines = lines.slice(1); // eliminar la primera línea
  }

  return lines.map(line => {
    const cols = line.split("\t").map(c => c.trim());
    return {
      artist: cols[0] || "",
      title: cols[1] || "",
      year: cols[2] || "",
      url: cols[3] || "" // puede estar vacío
    };
  });
}

function buildTsv(lines) {
  return lines
    .map(l => `${l.artist}\t${l.title}\t${l.year}\t${l.url}`)
    .join("\n");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fillMissingSpotifyUrls(lines, accessToken, updateProgress) {
  const total = lines.length;
  const notFoundTracks = [];
  const resolvedLines = [];

  for (let i = 0; i < total; i++) {
    const line = lines[i];

    updateProgress(i + 1, total);

    // Si ya tiene URL válida, se queda
    if (line.url && line.url.includes("spotify.com/track/")) {
      resolvedLines.push(line);
      continue;
    }

    const result = await searchSpotifyTrackSmart(
      {
        artist: line.artist,
        title: line.title,
        year: line.year
      },
      accessToken
    );

    if (result) {
      resolvedLines.push({
        ...line,
        url: result.url,
        trackId: result.trackId
      });
    } else {
      notFoundTracks.push(`${line.artist} – ${line.title}`);
      console.warn("❌ No encontrada:", line.title, "-", line.artist);
    }

    // evitar 429
    await sleep(80);
  }

  // Toast resumen
  if (notFoundTracks.length > 0) {
    showToast(
      `⚠️ ${notFoundTracks.length} canciones eliminadas (no encontradas en Spotify)`,
      "warning"
    );
  } else {
    showToast("✅ Playlist completada correctamente", "success");
  }

  return resolvedLines;
}


async function uploadFinalPlaylist(tsvText, originalName) {
  const blob = new Blob([tsvText], { type: "text/tab-separated-values" });
  const file = new File([blob], originalName, { type: blob.type });

  const formData = new FormData();
  formData.append("playlist", file);

  const res = await fetch("/api/upload-playlist", {
    method: "POST",
    body: formData
  });

  if (!res.ok) {
    const msg = await res.text();
    showToast("Error subiendo playlist: " + msg, "error");
    return false;
  }

  showToast("Playlist subida correctamente ✔");
  return true;
}

/* -------------------------------------------------------
   PLAY / STOP / NEXT / PREV
---------------------------------------------------------*/
async function playPreview30s() {
  if (!isPlayerReady) return showToast("El player no está listo: ", "error");
  const song = playlist[currentIndex];
  if (!song) return;

  // Obtener duración y calcular inicio aleatorio
  let startMs = 0;
  try {
    const trackResp = await fetch(
      `https://api.spotify.com/v1/tracks/${song.trackId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const info = await trackResp.json();
    const maxStart = Math.max(info.duration_ms - 30000, 0);
    startMs = Math.floor(Math.random() * maxStart);
  } catch {}

  statusEl.textContent = `Reproduciendo canción ${currentIndex + 1}/${playlist.length}`;

  await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uris: [song.uri],
        position_ms: startMs,
      }),
    }
  );

  if (previewTimeoutId) clearTimeout(previewTimeoutId);
  previewTimeoutId = setTimeout(stopPlayback, 30000);
}

async function stopPlayback() {
  await fetch("https://api.spotify.com/v1/me/player/pause", {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  statusEl.textContent = "Reproducción detenida.";
}

btnPlay.onclick = playPreview30s;
btnStop.onclick = stopPlayback;

btnNext.onclick = () => {
  if (currentIndex < playlist.length - 1) {
    currentIndex++;
    stopPlayback();
    updateMetaInfo();
    document.getElementById("song-info").classList.add("hidden");
  } else showToast("Final de la playlist: ");
};

btnPrev.onclick = () => {
  if (currentIndex > 0) {
    currentIndex--;
    stopPlayback();
    updateMetaInfo();
    document.getElementById("song-info").classList.add("hidden");
  } else showToast("Inicio de la playlist: ");
};

btnReveal.onclick = () => {
  const song = playlist[currentIndex];
  if (!song) return;

  infoTitle.textContent = song.title;
  infoArtist.textContent = song.artist;
  infoYear.textContent = song.year;

  document.getElementById("song-info").classList.remove("hidden");
};

btnLoadPlaylist.onclick = loadPlaylistFromBackend;

/* Start */
document.addEventListener("DOMContentLoaded", init);