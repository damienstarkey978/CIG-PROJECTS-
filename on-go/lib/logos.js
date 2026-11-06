'use strict';

/**
 * Logo resolution for Beaches venues.
 * Sources (in order): user upload → hand-verified official asset under public/assets/venues/.
 * Do NOT use Clearbit / Google favicon / DuckDuckGo guesses — Damien requires real brand marks.
 */

const KNOWN_WEBSITES = {
  "Pete's Bar": 'https://www.petesbar.com',
  "Poe's Tavern": 'https://www.poestavern.com',
  'Southern Grounds & Co.': 'https://www.southerngrounds.com',
  "Lynch's Irish Pub": 'https://www.lynchsirishpub.com',
  TacoLu: 'https://www.tacolu.com',
  "Cinotti's Bakery": 'https://cinottisbakery.com',
  'North Beach Fish Camp': 'https://www.northbeachfishcamp.com',
  'Flying Iguana Taqueria & Tequila Bar': 'https://www.flyingiguana.com',
  'Marker 32': 'https://www.marker32.com',
  'Valley Smoke': 'https://www.valleysmoke.com',
  'Aqua Grill': 'https://www.aquagrill.net',
  'The Lemon Bar': 'https://www.lemonbarjax.com',
  'European Street Cafe': 'https://www.europeanstreet.com',
  'Palm Valley Fish Camp': 'https://www.palmvalleyfishcamp.com',
  Azurea: 'https://www.oneoceanresort.com/dining/azurea',
  'The Local': 'https://www.thelocaljax.com',
  'Island Girl Cigar Bar (Neptune Beach)': 'https://islandgirlcigarbar.com/neptune-beach/',
  'Island Girl Cigar Bar (Mayport)': 'https://islandgirlcigarbar.com/mayport/',
  "Mr. Chubby's Wings": 'https://mrchubbyswings.com/ponte-vedra-beach-location',
  "Surfer the Bar": "https://surferthebar.com/",
  "Mango's Beach Bar & Grille": "https://www.mangosjaxbeach.com/",
  "Ginger's Place": "https://www.gingers-place.net/",
  "Wreck Tiki Lounge": "https://wrecktikilounge.com/",
  "Sandbar Jax Beach": "https://www.jaxbeachsandbar.com/",
  "The Ritz Lounge": "https://www.the-ritz-lounge.com/",
  "Flask & Cannon": "https://www.vpizza.com/locations/jacksonville-beach-fl/",
  "Brix Taphouse & Bar": "https://jacksonvillebeachbar.com/",
  "Pusser's Bar and Grille": "https://pusserspvb.com/",
  "Jax Beach Bar & Grill": "https://www.jaxbeachbarandgrill.com/",
  "Kava & Co": "https://kavaandcompany.com/",
  "LandShark Bar & Grill": "https://www.margaritavilleresorts.com/margaritaville-hotel-jacksonville-beach/eat-drink/landshark-bar-grill",
  "Monkey's Uncle Tavern": "https://monkeysuncletavern.com/",
  "1912 Ocean Bar & Rooftop": "https://www.1912oceanbarandrooftop.com/",
  "Sneakers Sports Grille": "https://sneakerssportsgrille.com/",
  "Green Room Brewing": "https://greenroombrewing.com/",
  "Dragonfly Lounge": "https://dragonflylounge-beaches.com/",
  "Culhane's Irish Pub": "https://www.culhanesirishpub.com/",
  "Mojo's Blues Bar and BBQ": "https://mojobbq.com/mojo-kitchen/",
};

/**
 * Hand-verified brand marks shipped in public/assets/venues/.
 * Source: venue website header/logo asset (or Damien-provided official file).
 * Never favicons, Google Photos, hero photos, or Clearbit guesses.
 */
const KNOWN_OFFICIAL_LOGOS = {
  // Damien-provided official marks
  "Cinotti's Bakery": '/assets/venues/cinottis-bakery.jpg',
  "Lynch's Irish Pub": '/assets/venues/lynchs-irish-pub.jpg',
  "Poe's Tavern": '/assets/venues/poes-tavern.jpg',
  'Valley Smoke': '/assets/venues/valley-smoke.jpg',
  'Green Room Brewing': '/assets/venues/green-room-brewing.jpg',
  "Lucky's Bar": '/assets/venues/luckys-bar.jpg',
  'Tavern on 1st': '/assets/venues/tavern-on-1st.jpg',
  // Social / brand-mark pulls (FB profile / official LandShark mark)
  "Ginger's Place": '/assets/venues/gingers-place.png',
  'Salt Beachside Bar': '/assets/venues/salt-beachside.png',
  'LandShark Bar & Grill': '/assets/venues/landshark-bar-grill.png',
  'Factory After Dark': '/assets/venues/factory-after-dark.png',
  // Official site brand marks
  "Pete's Bar": '/assets/venues/petes-bar.jpg',
  'Southern Grounds & Co.': '/assets/venues/southern-grounds.png',
  TacoLu: '/assets/venues/tacolu.png',
  'North Beach Fish Camp': '/assets/venues/north-beach-fish-camp.png',
  'Flying Iguana Taqueria & Tequila Bar': '/assets/venues/flying-iguana.png',
  'Marker 32': '/assets/venues/marker-32.png',
  'Aqua Grill': '/assets/venues/aqua-grill.png',
  'The Lemon Bar': '/assets/venues/the-lemon-bar.png',
  'European Street Cafe': '/assets/venues/european-street.png',
  'Palm Valley Fish Camp': '/assets/venues/palm-valley-fish-camp.png',
  Azurea: '/assets/venues/coastal-farmer.png',
  'The Local': '/assets/venues/the-local.png',
  'Island Girl Cigar Bar (Neptune Beach)': '/assets/venues/island-girl.png',
  'Island Girl Cigar Bar (Mayport)': '/assets/venues/island-girl.png',
  "Mr. Chubby's Wings": '/assets/venues/mr-chubbys-wings.png',
  'Surfer the Bar': '/assets/venues/surfer-the-bar.jpg',
  "Mango's Beach Bar & Grille": '/assets/venues/mangos-beach-bar.jpg',
  'Wreck Tiki Lounge': '/assets/venues/wreck-tiki-lounge.png',
  'Sandbar Jax Beach': '/assets/venues/sandbar-jax-beach.png',
  'The Ritz Lounge': '/assets/venues/the-ritz-lounge.png',
  'Flask & Cannon': '/assets/venues/flask-and-cannon.png',
  'Brix Taphouse & Bar': '/assets/venues/brix-taphouse.png',
  "Pusser's Bar and Grille": '/assets/venues/pussers-bar-grille.png',
  'Jax Beach Bar & Grill': '/assets/venues/jax-beach-bar-grill.png',
  'Kava & Co': '/assets/venues/kava-and-co.png',
  "Monkey's Uncle Tavern": '/assets/venues/monkeys-uncle-tavern.png',
  '1912 Ocean Bar & Rooftop': '/assets/venues/1912-ocean-bar.png',
  'Sneakers Sports Grille': '/assets/venues/sneakers-sports-grille.png',
  'Dragonfly Lounge': '/assets/venues/dragonfly-lounge.png',
  "Culhane's Irish Pub": '/assets/venues/culhanes-irish-pub.png',
  "Mojo's Blues Bar and BBQ": '/assets/venues/mojos-blues-bar-bbq.png',
};

const WEAK_LOGO_SOURCES = new Set(['missing', 'google_favicon', 'duckduckgo', 'clearbit', null, '']);

function domainFromWebsite(website) {
  if (!website) return null;
  try {
    const u = new URL(website.startsWith('http') ? website : `https://${website}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function ensureLogoColumns(db) {
  const cols = db.prepare('PRAGMA table_info(businesses)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE businesses ADD COLUMN ${ddl}`);
  };
  add('logo_url', 'logo_url TEXT');
  add('logo_source', 'logo_source TEXT');
  add('logo_updated_at', 'logo_updated_at TEXT');
}

function backfillWebsites(db) {
  const rows = db.prepare('SELECT id, name, website FROM businesses').all();
  for (const row of rows) {
    const site = KNOWN_WEBSITES[row.name];
    if (!site) continue;
    const wrongLegacy =
      (row.name === "Cinotti's Bakery" &&
        row.website &&
        /cinottis\.com/i.test(row.website) &&
        !/cinottisbakery\.com/i.test(row.website)) ||
      (row.name === 'The Lemon Bar' &&
        row.website &&
        /thelemonbar\.com/i.test(row.website) &&
        !/lemonbarjax\.com/i.test(row.website));
    if (row.website && !wrongLegacy) continue;
    db.prepare('UPDATE businesses SET website = ?, updated_at = ? WHERE id = ?').run(
      site,
      new Date().toISOString(),
      row.id
    );
    db.dirty = true;
  }
}

async function probeImageUrl(url, timeoutMs = 3500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'ON-GO-LogoBot/1.0' },
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.includes('image') && !ct.includes('icon') && !ct.includes('octet-stream')) {
      // Clearbit sometimes returns HTML error pages
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) return null;
      // still accept if it looks like image magic
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
      const isGif = buf[0] === 0x47 && buf[1] === 0x49;
      const isIco = buf[0] === 0x00 && buf[1] === 0x00;
      const isSvg = buf.slice(0, 200).toString('utf8').includes('<svg');
      if (!(isPng || isJpg || isGif || isIco || isSvg)) return null;
    }
    return url;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function candidateUrls(domain) {
  if (!domain) return [];
  return [
    { source: 'clearbit', url: `https://logo.clearbit.com/${domain}` },
    { source: 'google_favicon', url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128` },
    { source: 'duckduckgo', url: `https://icons.duckduckgo.com/ip3/${domain}.ico` },
  ];
}

function applyOfficialLogos(db) {
  ensureLogoColumns(db);
  const ts = new Date().toISOString();
  let applied = 0;
  for (const [name, url] of Object.entries(KNOWN_OFFICIAL_LOGOS)) {
    const row = db.prepare('SELECT id, logo_url, logo_source FROM businesses WHERE name = ?').get(name);
    if (!row) continue;
    // Keep a real user upload served via API; otherwise force official asset
    const keepUpload =
      row.logo_source === 'upload' &&
      row.logo_url &&
      String(row.logo_url).includes('/logo/file');
    if (keepUpload) continue;
    if (row.logo_url === url && row.logo_source === 'official') continue;
    db.prepare(
      `UPDATE businesses SET logo_url = ?, logo_source = 'official', logo_updated_at = ?, updated_at = ? WHERE id = ?`
    ).run(url, ts, ts, row.id);
    db.dirty = true;
    applied += 1;
  }
  // Clear favicon / Clearbit / removed-asset guesses when we have no verified mark
  const rows = db.prepare('SELECT id, name, logo_url, logo_source FROM businesses').all();
  for (const row of rows) {
    const keepUpload =
      row.logo_source === 'upload' &&
      row.logo_url &&
      String(row.logo_url).includes('/logo/file');
    if (keepUpload) continue;
    if (KNOWN_OFFICIAL_LOGOS[row.name]) continue;
    const staleAsset = row.logo_url && String(row.logo_url).startsWith('/assets/venues/');
    const guess =
      WEAK_LOGO_SOURCES.has(row.logo_source) ||
      (row.logo_url &&
        /favicon|clearbit|duckduckgo|gstatic|googleusercontent|logo\.clearbit/i.test(row.logo_url));
    if (staleAsset || guess || row.logo_source === 'official') {
      db.prepare(
        `UPDATE businesses SET logo_url = NULL, logo_source = 'missing', logo_updated_at = ?, updated_at = ? WHERE id = ?`
      ).run(ts, ts, row.id);
      db.dirty = true;
    }
  }
  return applied;
}

async function resolveLogoForBusiness(db, business, { force = false } = {}) {
  ensureLogoColumns(db);

  const official = KNOWN_OFFICIAL_LOGOS[business.name];
  const keepUpload =
    business.logo_source === 'upload' &&
    business.logo_url &&
    String(business.logo_url).includes('/logo/file');

  // Official static logos beat WordPress/Google favicon defaults
  if (official && !keepUpload) {
    const weak = force || WEAK_LOGO_SOURCES.has(business.logo_source) || business.logo_url !== official;
    if (weak || business.logo_source === 'official') {
      if (business.logo_url !== official || business.logo_source !== 'official') {
        const ts = new Date().toISOString();
        db.prepare(
          `UPDATE businesses SET logo_url = ?, logo_source = 'official', logo_updated_at = ?, updated_at = ? WHERE id = ?`
        ).run(official, ts, ts, business.id);
        db.dirty = true;
      }
      return { logo_url: official, logo_source: 'official', status: 'found' };
    }
  }

  if (!force && business.logo_source === 'upload' && business.logo_url) {
    return { logo_url: business.logo_url, logo_source: 'upload', status: 'found' };
  }
  // Keep a previously verified official mark; never keep favicon/Clearbit guesses
  if (
    !force &&
    business.logo_url &&
    business.logo_source === 'official' &&
    String(business.logo_url).startsWith('/assets/venues/')
  ) {
    return { logo_url: business.logo_url, logo_source: 'official', status: 'found' };
  }

  // No verified brand mark — leave missing (do not scrape favicons / Clearbit)
  const ts = new Date().toISOString();
  db.prepare(
    `UPDATE businesses SET logo_url = NULL, logo_source = 'missing', logo_updated_at = ?, updated_at = ? WHERE id = ?`
  ).run(ts, ts, business.id);
  db.dirty = true;
  return { logo_url: null, logo_source: 'missing', status: 'missing' };
}

async function resolveLogosBatch(db, businesses, { limit = 6, force = false, concurrency = 3 } = {}) {
  const queue = [];
  for (const b of businesses) {
    if (queue.length >= limit) break;
    const official = KNOWN_OFFICIAL_LOGOS[b.name];
    const keepUpload =
      b.logo_source === 'upload' &&
      b.logo_url &&
      String(b.logo_url).includes('/logo/file');
    const needsOfficial =
      Boolean(official) &&
      !keepUpload &&
      (b.logo_source !== 'official' || b.logo_url !== official);
    const needs =
      force ||
      needsOfficial ||
      !b.logo_source ||
      b.logo_source === 'missing' ||
      (!b.logo_url && b.logo_source !== 'missing');
    // Skip recently resolved missing to avoid hammering — but never leave Explore
    // on a letter placeholder while the venue page can still resolve a logo.
    if (!force && !needsOfficial && b.logo_source === 'missing' && b.logo_url && b.logo_updated_at) {
      const age = Date.now() - Date.parse(b.logo_updated_at);
      if (age < 1000 * 60 * 60 * 12) continue; // 12h
    }
    if (!needs && b.logo_url) continue;
    queue.push(b);
  }

  const out = [];
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const idx = i;
      i += 1;
      const b = queue[idx];
      out.push({ id: b.id, ...(await resolveLogoForBusiness(db, b, { force })) });
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, () => worker());
  await Promise.all(workers);
  return out;
}

async function saveUploadedLogo(db, businessId, { buffer, contentType }) {
  ensureLogoColumns(db);
  const key = `logos/${businessId}`;
  let stored = false;
  if (process.env.NETLIFY || process.env.USE_NETLIFY_BLOBS === '1') {
    try {
      const { getStore } = require('@netlify/blobs');
      const store = getStore('on-go-logos');
      await store.set(key, buffer, { metadata: { contentType: contentType || 'image/png' } });
      stored = true;
    } catch (err) {
      console.warn('logo blob save failed', err.message);
    }
  }
  // Always keep a local fallback for node/dev
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'data', 'logos');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ext = (contentType || '').includes('jpeg') || (contentType || '').includes('jpg') ? 'jpg' : 'png';
    fs.writeFileSync(path.join(dir, `${businessId}.${ext}`), buffer);
    stored = true;
  } catch (err) {
    console.warn('logo file save failed', err.message);
  }
  if (!stored) throw new Error('Could not persist logo');

  const url = `/api/businesses/${businessId}/logo/file`;
  const ts = new Date().toISOString();
  db.prepare(
    `UPDATE businesses SET logo_url = ?, logo_source = 'upload', logo_updated_at = ?, updated_at = ? WHERE id = ?`
  ).run(url, ts, ts, businessId);
  db.dirty = true;
  return { logo_url: url, logo_source: 'upload', status: 'found' };
}

async function readUploadedLogo(businessId) {
  if (process.env.NETLIFY || process.env.USE_NETLIFY_BLOBS === '1') {
    try {
      const { getStore } = require('@netlify/blobs');
      const store = getStore('on-go-logos');
      const entry = await store.getWithMetadata(`logos/${businessId}`, { type: 'arrayBuffer' });
      if (entry && entry.data) {
        return {
          buffer: Buffer.from(entry.data),
          contentType: (entry.metadata && entry.metadata.contentType) || 'image/png',
        };
      }
    } catch {
      /* fall through */
    }
  }
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'data', 'logos');
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const p = path.join(dir, `${businessId}.${ext}`);
    if (fs.existsSync(p)) {
      const ct = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
      return { buffer: fs.readFileSync(p), contentType: ct };
    }
  }
  return null;
}

const AD_PLACEMENTS = [
  {
    id: 'map_banner',
    label: 'Map featured banner',
    width: 320,
    height: 100,
    note: 'Pinned under the live map on Explore',
  },
  {
    id: 'directory_strip',
    label: 'Directory strip',
    width: 360,
    height: 72,
    note: 'Sponsored row at the top of the venue feed',
  },
];

function buildCreative(business, slot, logo) {
  return {
    business_id: business.id,
    business_name: business.name,
    area: business.area,
    category: business.category,
    website: business.website || null,
    slot_label: slot ? slot.slot_label : null,
    inventory_id: slot ? slot.id : null,
    logo_url: logo.logo_url || null,
    logo_source: logo.logo_source || null,
    logo_status: logo.status || (logo.logo_url ? 'found' : 'missing'),
    placements: AD_PLACEMENTS,
    brand: { product: 'ON GO', theme: 'Signal Night', accent: '#1aff5a' },
  };
}

module.exports = {
  KNOWN_WEBSITES,
  KNOWN_OFFICIAL_LOGOS,
  AD_PLACEMENTS,
  ensureLogoColumns,
  backfillWebsites,
  applyOfficialLogos,
  resolveLogoForBusiness,
  resolveLogosBatch,
  saveUploadedLogo,
  readUploadedLogo,
  buildCreative,
  domainFromWebsite,
};
