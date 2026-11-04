'use strict';

/**
 * Free/low-cost logo resolution for Beaches venues.
 * Sources (in order): uploaded blob → Clearbit → Google favicon → DuckDuckGo icon.
 * No paid Google Places.
 */

const KNOWN_WEBSITES = {
  "Pete's Bar": 'https://www.petesbar.com',
  "Poe's Tavern": 'https://www.poestavern.com',
  'Southern Grounds & Co.': 'https://www.southerngroundscoffee.com',
  "Lynch's Irish Pub": 'https://www.lynchsirishpub.com',
  TacoLu: 'https://www.tacolu.com',
  "Cinotti's Bakery": 'https://www.cinottis.com',
  'North Beach Fish Camp': 'https://www.northbeachfishcamp.com',
  'Flying Iguana Taqueria & Tequila Bar': 'https://www.flyingiguana.com',
  'Marker 32': 'https://www.marker32.com',
  'Valley Smoke': 'https://www.valleysmokepv.com',
  'Aqua Grill': 'https://www.aquagrill.net',
  'The Lemon Bar': 'https://www.thelemonbar.com',
  'European Street Cafe': 'https://www.europeanstreet.com',
  'Palm Valley Fish Camp': 'https://www.palmvalleyfishcamp.com',
  "Fly's Tie Irish Pub": 'https://www.flystie.com',
  Azurea: 'https://www.oneoceanresort.com/dining/azurea',
};

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
    if (row.website) continue;
    const site = KNOWN_WEBSITES[row.name];
    if (site) {
      db.prepare('UPDATE businesses SET website = ?, updated_at = ? WHERE id = ?').run(
        site,
        new Date().toISOString(),
        row.id
      );
      db.dirty = true;
    }
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

async function resolveLogoForBusiness(db, business, { force = false } = {}) {
  ensureLogoColumns(db);
  if (!force && business.logo_source === 'upload' && business.logo_url) {
    return { logo_url: business.logo_url, logo_source: 'upload', status: 'found' };
  }
  if (!force && business.logo_url && business.logo_source && business.logo_source !== 'missing') {
    return { logo_url: business.logo_url, logo_source: business.logo_source, status: 'found' };
  }

  let website = business.website || KNOWN_WEBSITES[business.name] || '';
  if (!business.website && website) {
    db.prepare('UPDATE businesses SET website = ?, updated_at = ? WHERE id = ?').run(
      website,
      new Date().toISOString(),
      business.id
    );
    db.dirty = true;
  }
  const domain = domainFromWebsite(website);
  if (!domain) {
    db.prepare(
      `UPDATE businesses SET logo_url = NULL, logo_source = 'missing', logo_updated_at = ?, updated_at = ? WHERE id = ?`
    ).run(new Date().toISOString(), new Date().toISOString(), business.id);
    db.dirty = true;
    return { logo_url: null, logo_source: 'missing', status: 'missing' };
  }

  for (const cand of candidateUrls(domain)) {
    const ok = await probeImageUrl(cand.url);
    if (ok) {
      const ts = new Date().toISOString();
      db.prepare(
        `UPDATE businesses SET logo_url = ?, logo_source = ?, logo_updated_at = ?, updated_at = ? WHERE id = ?`
      ).run(ok, cand.source, ts, ts, business.id);
      db.dirty = true;
      return { logo_url: ok, logo_source: cand.source, status: 'found' };
    }
  }

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
    const needs =
      force ||
      !b.logo_source ||
      b.logo_source === 'missing' ||
      (!b.logo_url && b.logo_source !== 'missing');
    // Skip recently resolved missing to avoid hammering (unless force)
    if (!force && b.logo_source === 'missing' && b.logo_updated_at) {
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
  AD_PLACEMENTS,
  ensureLogoColumns,
  backfillWebsites,
  resolveLogoForBusiness,
  resolveLogosBatch,
  saveUploadedLogo,
  readUploadedLogo,
  buildCreative,
  domainFromWebsite,
};
