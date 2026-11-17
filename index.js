// 阿基米德 FM (ajmide.com) — a MyGo Music source plugin.
//
// 阿基米德 is the audio platform of Shanghai Media Group (SMG / 上海广播电视台).
// Its web front end lives at m.ajmide.com (H5) and www.ajmide.com (brochure),
// while every JSON endpoint sits on a.ajmide.com behind a path-versioned
// gateway: /v10/…, /v14/…, /v17/…, /v27/…, /v28/… all still answer, and the
// H5 front end still calls v14 while the Android app (org.ajmd) uses v17.
//
// There is no signature and no token: a plain GET with a mobile User-Agent and
// a Referer from m.ajmide.com is enough. But the WAF in front of a.ajmide.com
// counts requests per IP and starts answering 405 once you hammer it, so the
// helpers below keep a slow, serial pace and retry once after a short pause.
//
// What plays here:
//   * audio detail (音频详情) — liveUrl / shareInfo.aacUrl returns
//     https://short-audio-qn.ajmide.com/image/… which is really an m4a
//     (content-type audio/mp4, ftypM4A) and supports Range requests.
//
// What does not:
//   * 电台直播 (live radio) — brand pages hand back rscdn.ajmide.com/…m3u8
//     HLS only, and mygo's player takes mp3/flac/ogg/wav/m4a/aac.
//     Stations here therefore list their programme/audio cards, not the live
//     stream.

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const API = "https://a.ajmide.com";
const REFERER = "https://m.ajmide.com/";

// The gateway is versioned per endpoint and the versions do not line up, so
// each call carries its own.
const EP = {
  stations: "/v28/get_radio_station_all.php",
  station: "/v28/get_radio_station.php",
  brandNow: "/v27/getBrandPlayList.php",
  audio: "/v17/get_audio_detail.php",
  programAudios: "/v10/get_program_music.php",
  weekPrograms: "/v28/get_program_list_by_week.php",
  recommend: "/v17/get_audio_detail.php",
  hotRadios: "/v17/getHotRadioList.php",
  audioInfo: "/v14/getAudioInfoById.php",
};

const pageCache = new Map(); // key -> rows, keeps lists stable between calls
const mediaCache = new Map(); // phId -> stream info
const MEDIA_LIMIT = 500;

let lastCall = 0;
const MIN_GAP = 2500; // ms between gateway calls; the WAF starts answering 405 when pushed harder

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pick() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function stripTags(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// One gateway request. Retries once after the WAF's 405.
async function once(fn, tries) {
  const n = tries || 2;
  let last;
  for (let i = 0; i < n; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i + 1 < n) await sleep(1500);
    }
  }
  throw last;
}

async function call(path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const url = API + path + (q.toString() ? "?" + q.toString() : "");

  const wait = MIN_GAP - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      Referer: REFERER,
      Accept: "application/json",
    },
  });

  const body = await res.text();
  if (!res.ok) {
    if (res.status === 405) throw fail("blocked", "阿基米德网关限流（405），稍后再试");
    throw fail("http", `HTTP ${res.status}`);
  }
  if (body.trim().startsWith("<")) throw fail("blocked", "阿基米德网关返回了拦截页");

  let d;
  try {
    d = JSON.parse(body);
  } catch (e) {
    throw fail("parse", "接口返回的不是 JSON");
  }
  if (d && d.code !== undefined && String(d.code) !== "0") {
    const msg = d.message || "阿基米德接口报错";
    throw fail("api", String(msg));
  }
  return d && d.data !== undefined ? d.data : d;
}

// ---------------------------------------------------------------- shapes

function imgOf(x) {
  return pick(
    x.imgPath,
    x.img_path,
    x.programImgpath,
    x.brandImg,
    x.cover,
    x.imgUrl,
    x.image
  );
}

function toStation(x) {
  const id = pick(x.brandId, x.brand_id, x.id);
  return {
    id: "b:" + id,
    name: pick(x.name, x.brandName, x.subject),
    imageUrl: imgOf(x),
    description: stripTags(pick(x.intro, x.description, x.desc)),
    artists: [{ name: stripTags(pick(x.name, "电台")) }],
    saved: false,
  };
}

function toTrack(x, album) {
  const phId = pick(x.phId, x.phid, x.audioId, x.id);
  const name = stripTags(pick(x.subject, x.name, x.title, x.audioName));
  if (!phId || !name) return null;
  const seconds = num(pick(x.audioTime, x.duration, x.time));
  const pairing = pick(x.programName, x.producer, "");
  return {
    id: "p:" + phId,
    name,
    artists: [
      { name: stripTags(pick(x.programPresenter, x.producer, x.publisher, pairing, "阿基米德")) },
    ],
    duration: seconds * 1000,
    album: album || {
      id: "pr:" + pick(x.programId, x.programid),
      name: stripTags(pick(x.programName, pairing, "阿基米德")),
      imageUrl: imgOf(x),
    },
    unavailable: false,
  };
}

function toAlbum(x) {
  const id = pick(x.programId, x.programid, x.brandId, x.id);
  const name = stripTags(pick(x.programName, x.name, x.subject, x.brandName));
  if (!id || !name) return null;
  return {
    id: String(id).startsWith("st:") || String(id).startsWith("pr:") ? String(id) : "pr:" + id,
    name,
    imageUrl: imgOf(x),
    description: stripTags(pick(x.intro, x.description, x.desc)),
    artists: [{ name: stripTags(pick(x.producer, x.programPresenter, "阿基米德")) }],
    saved: false,
  };
}

function remember(phId, info) {
  if (!phId) return;
  mediaCache.set(String(phId), info);
  if (mediaCache.size > MEDIA_LIMIT) {
    const first = mediaCache.keys().next().value;
    mediaCache.delete(first);
  }
}

// ---------------------------------------------------------------- storage

async function load(key, fallback) {
  try {
    const v = await host.storage.get(key);
    if (v === undefined || v === null) return fallback;
    return typeof v === "string" ? JSON.parse(v) : v;
  } catch (e) {
    return fallback;
  }
}

async function save(key, value) {
  try {
    await host.storage.set(key, JSON.stringify(value));
  } catch (e) {}
}

function t(key, fallback) {
  try {
    const v = host.t(key);
    return v && v !== key ? v : fallback || key;
  } catch (e) {
    return fallback || key;
  }
}

// ---------------------------------------------------------------- gateway calls

async function stationAll() {
  const rows = await once(() => call(EP.stations, {}));
  return Array.isArray(rows) ? rows : [];
}

async function stationDetail(brandId) {
  return once(() => call(EP.station, { brandId }));
}

async function brandNow(brandId) {
  try {
    return await once(() => call(EP.brandNow, { brandId }));
  } catch (e) {
    return null;
  }
}

async function audioDetail(phId) {
  return once(() => call(EP.audio, { phId, topicType: 8, o: "" }));
}

async function programAudios(programId, pageNo) {
  const d = await once(() =>
    call(EP.programAudios, {
      programId,
      pageNo: pageNo || 1,
      pageSize: 30,
    })
  );
  return d;
}

async function weekPrograms(brandId) {
  try {
    return await once(() => call(EP.weekPrograms, { brandId }));
  } catch (e) {
    return null;
  }
}

async function recommendAudios() {
  // No phId: the app hands back its recommendation block.
  try {
    const d = await once(() => call(EP.recommend, {}));
    if (d && d.recommendAudios && Array.isArray(d.recommendAudios.list)) {
      return d.recommendAudios.list;
    }
    if (Array.isArray(d)) return d;
  } catch (e) {}
  return [];
}

async function hotRadios() {
  try {
    const d = await once(() => call(EP.hotRadios, {}));
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.list)) return d.list;
    if (d && Array.isArray(d.hotRadioList)) return d.hotRadioList;
  } catch (e) {}
  return [];
}

// Walk any response and pull out every object that looks like an audio card.
// The gateway has no stable schema across versions, so field names are matched
// loosely instead of trusted.
function deepCards(root, out, depth) {
  const acc = out || [];
  if (acc.length > 400 || (depth || 0) > 8) return acc;
  if (Array.isArray(root)) {
    for (const x of root) deepCards(x, acc, (depth || 0) + 1);
    return acc;
  }
  if (!root || typeof root !== "object") return acc;

  const phId = pick(root.phId, root.phid, root.audioId);
  const title = stripTags(pick(root.subject, root.audioName, root.name, root.title));
  if (phId && title) {
    acc.push(root);
    return acc; // a card's own children are not cards
  }
  for (const key of ["list", "data", "rows", "items", "audioList", "audio_list", "programList", "listData"]) {
    if (root[key]) deepCards(root[key], acc, (depth || 0) + 1);
  }
  return acc;
}

// Collect audio cards out of whatever shape a listing answers with.
function cardsOf(d) {
  if (!d) return [];
  if (Array.isArray(d)) return d;
  for (const key of ["list", "audioList", "data", "rows", "items"]) {
    if (Array.isArray(d[key])) return d[key];
  }
  if (Array.isArray(d.audio_list)) return d.audio_list;
  return [];
}

// ---------------------------------------------------------------- exported surface

export async function home() {
  const [stations, recs] = await Promise.all([
    stationAll().catch(() => []),
    recommendAudios().catch(() => []),
  ]);

  const sections = [];

  const recTracks = recs.map((x) => toTrack(x)).filter(Boolean).slice(0, 12);
  if (recTracks.length) {
    sections.push({ title: t("Recommended", "推荐声音"), items: recTracks });
  }

  const hot = stations.slice(0, 24).map(toStation);
  if (hot.length) {
    sections.push({ title: t("Stations", "电台"), items: hot });
  }

  return { title: "阿基米德", sections };
}

export async function browse({ page } = {}) {
  if (page === "stations" || !page) return stations();

  if (page && page.startsWith("b:")) {
    const id = page.slice(2);
    const detail = await album({ id: "b:" + id });
    return { title: detail.album.name, sections: [{ title: "节目", items: detail.tracks }] };
  }

  return stations();
}

export async function stations() {
  const rows = await stationAll();
  const albums = rows.map(toStation).filter((x) => x.name);
  return { albums, more: false };
}

export async function search({ query, kind, offset } = {}) {
  const q = String(query || "").trim();
  if (!q) return { albums: [], tracks: [], artists: [], more: false };
  const skip = Number(offset) || 0;

  // A bare number is a brand id: open it directly.
  if (/^\d{5,}$/.test(q)) {
    const a = toAlbum(await stationDetail(q).catch(() => null));
    return { albums: a ? [{ ...a, id: "b:" + q }] : [], tracks: [], artists: [], more: false };
  }

  const rows = await stationAll();
  const hitStations = rows
    .map(toStation)
    .filter((x) => x.name.includes(q) || x.description.includes(q))
    .slice(skip, skip + 30);

  return { albums: hitStations, tracks: [], artists: [], more: false };
}

export async function suggest({ query } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const rows = await stationAll();
  return rows
    .map((x) => pick(x.name))
    .filter((n) => n && n.includes(q))
    .slice(0, 8);
}

export async function album({ id } = {}) {
  const key = String(id || "");

  if (key.startsWith("b:")) {
    const brandId = key.slice(2);
    const [detail, now] = await Promise.all([
      stationDetail(brandId).catch(() => null),
      brandNow(brandId).catch(() => null),
    ]);

    const all = await stationAll().catch(() => []);
    const meta = all.find((x) => String(x.brandId) === String(brandId)) || {};
    const brandName = stripTags(pick(meta.name, detail && detail.brand && detail.brand.name, "电台"));
    const brandImg = pick(meta.img_path, detail && detail.brand && detail.brand.imgPath, imgOf(detail || {}));
    const brandIntro = stripTags(pick(meta.intro, detail && detail.brand && detail.brand.intro, ""));

    const tracks = [];

    const nowCards = cardsOf(now);
    for (const x of nowCards) {
      // The card that is currently on air only has an HLS url; keep it as a
      // programme entry but mark it unplayable.
      const phId = pick(x.phId);
      const name = stripTags(pick(x.subject, x.programName, x.name));
      if (!name) continue;
      if (phId) {
        const tr = toTrack(x, { id: "b:" + brandId, name: name, imageUrl: imgOf(x) });
        if (tr) {
          remember(phId, { url: pick(x.liveUrl), type: "hls" });
          tracks.push(tr);
        }
      } else {
        const pid = pick(x.programId, x.programid);
        if (!pid) continue;
        tracks.push({
          id: "pr:" + pid,
          name,
          artists: [{ name: stripTags(pick(x.programName, "直播")) }],
          album: { id: "b:" + brandId, name: name, imageUrl: imgOf(x) },
          unavailable: true,
        });
      }
    }

    // The weekly programme sheet is the station's audio shelf: every card in
    // it carries a phId and therefore plays.
    const week = await weekPrograms(brandId).catch(() => null);
    for (const x of deepCards(week)) {
      const phId = pick(x.phId, x.phid);
      const tr = toTrack(x, { id: "b:" + brandId, name: brandName, imageUrl: imgOf(x) });
      if (!tr || !phId) continue;
      if (tracks.some((tr2) => tr2.id === tr.id)) continue;
      remember(phId, { url: pick(x.liveUrl, x.shareInfo && x.shareInfo.aacUrl), type: "m4a" });
      tracks.push(tr);
    }

    // radioList / programClassification give the station's programme shelf.
    const shelf = (detail && (detail.radioList || detail.programClassification)) || [];
    for (const x of shelf) {
      const pid = pick(x.id, x.programId, x.pid);
      const name = stripTags(pick(x.name, x.subject));
      if (!pid || !name) continue;
      if (tracks.some((tr) => tr.name === name)) continue;
      tracks.push({
        id: "pr:" + pid,
        name,
        artists: [{ name: brandName }],
        album: { id: "b:" + brandId, name: brandName, imageUrl: imgOf(x) },
        unavailable: false,
      });
    }

    return {
      album: {
        id: key,
        name: brandName,
        imageUrl: brandImg,
        description: brandIntro,
        artists: [{ name: "阿基米德" }],
        saved: false,
      },
      tracks,
    };
  }

  if (key.startsWith("p:")) {
    const phId = key.slice(2);
    const d = await audioDetail(phId);
    const tr = toTrack(d);
    if (!tr) throw fail("unavailable", "这条音频已经不在了");
    remember(phId, { url: pick(d.liveUrl, d.shareInfo && d.shareInfo.aacUrl), type: "m4a" });
    return { album: tr.album, tracks: [tr] };
  }

  const pid = key.startsWith("pr:") ? key.slice(3) : key;

  // No single endpoint owns "the audios of one programme", so try the ones the
  // app and the H5 page use and take the first that yields cards.
  let cards = [];
  for (const probe of [
    () => call(EP.programAudios, { programId: pid, pageNo: 1, pageSize: 30 }),
    () => call("/v28/get_program_list_by_week.php", { programId: pid }),
    () => call("/v14/getRelateAudioList.php", { phId: pid }),
  ]) {
    try {
      const d = await once(probe, 1);
      cards = deepCards(d);
      if (cards.length) break;
    } catch (e) {}
  }

  const tracks = cards.map((x) => toTrack(x)).filter(Boolean);

  if (tracks.length) {
    return {
      album: {
        id: "pr:" + pid,
        name: tracks[0].album && tracks[0].album.name ? tracks[0].album.name : "节目",
        imageUrl: tracks[0].album && tracks[0].album.imageUrl ? tracks[0].album.imageUrl : "",
        artists: [{ name: tracks[0].artists[0].name }],
        saved: false,
      },
      tracks,
    };
  }

  throw fail("notFound", "没有找到这个节目");
}

export async function artist({ id } = {}) {
  const key = String(id || "");
  const brandId = key.startsWith("b:") ? key.slice(2) : key;
  const d = await album({ id: "b:" + brandId });
  return {
    artist: {
      id: "b:" + brandId,
      name: d.album.name,
      imageUrl: d.album.imageUrl,
      description: d.album.description,
    },
    albums: [{ ...d.album, trackCount: d.tracks.length }],
    tracks: d.tracks.slice(0, 6),
  };
}

export async function stream({ id } = {}) {
  const key = String(id || "");
  if (!key.startsWith("p:")) throw fail("unavailable", "只有单集可以播放");
  const phId = key.slice(2);

  let info = mediaCache.get(phId);
  if (!info || !info.url) {
    const d = await audioDetail(phId);
    info = {
      url: pick(d.liveUrl, d.shareInfo && d.shareInfo.aacUrl),
      type: "m4a",
      name: pick(d.subject),
    };
    remember(phId, info);
  }

  if (!info.url) throw fail("unavailable", t("unavailable", "这一条没有可播放的音频"));
  if (info.type === "hls" || /\.m3u8/.test(info.url)) {
    throw fail("unavailable", t("unavailable", "这一条只有 HLS 直播流，播放器接不了"));
  }

  return {
    url: info.url,
    type: "m4a",
    headers: { Referer: REFERER, "User-Agent": UA },
  };
}

export async function stationNext({ id, index } = {}) {
  // A station has no queue of its own; hand back its programme shelf so "next"
  // on a station jumps to the following programme card.
  const d = await album({ id: String(id || "b:") });
  const i = Number(index) || 0;
  const next = d.tracks[i + 1];
  return { track: next || null, more: !!next };
}

// ---------------------------------------------------------------- liked / saved

const LIKE_KEY = "ajmide.liked";
const SAVED_KEY = "ajmide.savedAlbums";

export async function liked() {
  const rows = await load(LIKE_KEY, []);
  return { tracks: rows };
}

export async function isLiked({ id } = {}) {
  const rows = await load(LIKE_KEY, []);
  return rows.some((x) => x.id === String(id));
}

export async function like({ track } = {}) {
  const rows = await load(LIKE_KEY, []);
  const key = String((track && track.id) || "");
  if (!key) return false;
  const hit = rows.findIndex((x) => x.id === key);
  if (hit >= 0) rows.splice(hit, 1);
  else rows.unshift(track);
  await save(LIKE_KEY, rows.slice(0, 200));
  return hit < 0;
}

export async function savedAlbums() {
  return { albums: await load(SAVED_KEY, []) };
}

export async function saveAlbum({ album } = {}) {
  const rows = await load(SAVED_KEY, []);
  const key = String((album && album.id) || "");
  if (!key) return false;
  const hit = rows.findIndex((x) => x.id === key);
  if (hit >= 0) rows.splice(hit, 1);
  else rows.unshift(album);
  await save(SAVED_KEY, rows.slice(0, 200));
  return hit < 0;
}

export async function recent() {
  return { tracks: [] };
}

export async function played() {
  return { tracks: [] };
}

export async function lyrics() {
  return null;
}

export async function playlist() {
  return { tracks: [] };
}

export async function playlists() {
  return { playlists: [] };
}

export async function savePlaylist() {
  return false;
}

export async function followArtist() {
  return false;
}
