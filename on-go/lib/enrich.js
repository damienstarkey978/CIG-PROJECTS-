'use strict';

/**
 * Free/low-cost venue enrichment from public venue websites + OSM tags.
 * No Google Places. Cache results on the business row; never invent hours/menus.
 */

const { nowIso } = require('./db');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function ensureEnrichColumns(db) {
  const cols = db.prepare('PRAGMA table_info(businesses)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE businesses ADD COLUMN ${ddl}`);
  };
  add('about_text', 'about_text TEXT');
  add('about_source', 'about_source TEXT');
  add('hours_display', 'hours_display TEXT');
  add('hours_source', 'hours_source TEXT');
  add('menu_url', 'menu_url TEXT');
  add('menu_notes', 'menu_notes TEXT');
  add('happy_hour_notes', 'happy_hour_notes TEXT');
  add('happy_hour_menu_url', 'happy_hour_menu_url TEXT');
  add('specials_notes', 'specials_notes TEXT');
  add('enrichment_status', 'enrichment_status TEXT');
  add('enrichment_updated_at', 'enrichment_updated_at TEXT');
  add('enrichment_sources_json', 'enrichment_sources_json TEXT');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

function metaContent(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`,
      'i'
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`,
      'i'
    );
    const m = html.match(re) || html.match(re2);
    if (m && m[1]) return decodeEntities(m[1]);
  }
  return null;
}

function findPhone(text) {
  const m = String(text || '').match(
    /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/
  );
  return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}

function absolutize(base, href) {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function findMenuUrl(html, baseUrl) {
  const re =
    /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{0,80})<\/a>/gi;
  let m;
  const scored = [];
  while ((m = re.exec(html))) {
    const href = m[1];
    const label = (m[2] || '').toLowerCase();
    const h = href.toLowerCase();
    if (/menu|food|drink|happy.?hour|specials|brunch/.test(label + ' ' + h)) {
      const url = absolutize(baseUrl, href);
      if (url && !/instagram|facebook|twitter|tiktok|mailto:|tel:/.test(url)) {
        scored.push({ url, score: /menu/.test(label + h) ? 2 : 1 });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.url || null;
}

function extractHoursSnippet(text) {
  const t = String(text || '');
  // Look for common hours patterns near "hours" / "open"
  const windowRe =
    /(?:hours|open(?:ing)?(?:\s+hours)?|we(?:'| a)?re open)[:\s]{0,20}([^\n.]{8,120})/i;
  const m = t.match(windowRe);
  if (m) {
    const snip = m[1].replace(/\s+/g, ' ').trim();
    if (/\d/.test(snip) && /(am|pm|–|-|:)/i.test(snip)) return snip.slice(0, 160);
  }
  const dayHours = t.match(
    /(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*[-–:]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–to]+\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i
  );
  if (dayHours) return dayHours[0].replace(/\s+/g, ' ').trim().slice(0, 160);
  return null;
}

function extractHappyHour(text) {
  const t = String(text || '');
  const m = t.match(/happy\s*hours?[:\s]{0,30}([^\n.]{6,140})/i);
  if (m) {
    const snip = `Happy hour ${m[1]}`.replace(/\s+/g, ' ').trim();
    return snip.slice(0, 180);
  }
  if (/happy\s*hour/i.test(t)) {
    const idx = t.toLowerCase().indexOf('happy hour');
    return t.slice(idx, idx + 120).replace(/\s+/g, ' ').trim();
  }
  return null;
}

function extractSpecials(text) {
  const t = String(text || '');
  const m = t.match(
    /(?:daily\s+specials?|today'?s\s+specials?|weekly\s+specials?|bogo|buy\s+one\s+get\s+one)[:\s]{0,20}([^\n.]{6,140})/i
  );
  if (!m) return null;
  const snip = `${m[0]}`.replace(/\s+/g, ' ').trim().slice(0, 180);
  if (/<|>|class=|sqs-|wordpress/i.test(snip)) return null;
  return snip;
}

function sanitizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 11) return null;
  return String(phone).replace(/\s+/g, ' ').trim();
}

function extractAbout(html, text, businessName) {
  const og = metaContent(html, ['og:description', 'twitter:description', 'description']);
  if (og && og.length > 40 && !/wordpress|shopify|squarespace/i.test(og)) {
    return og.slice(0, 420);
  }
  // First substantial paragraph mentioning the venue or "we"
  const paras = text
    .split(/\n+|(?<=\.)\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 60 && p.length < 400);
  const nameBits = String(businessName || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  for (const p of paras) {
    const low = p.toLowerCase();
    if (nameBits.some((b) => low.includes(b)) || /\bwe\b|\bour\b|\bsince\b/.test(low)) {
      if (!/cookie|privacy|copyright|all rights/i.test(p)) return p.slice(0, 420);
    }
  }
  return og ? og.slice(0, 420) : null;
}

async function fetchHtml(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return { ok: false, status: res.status, html: '', finalUrl: url };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.includes('text/html') && !ct.includes('xhtml')) {
      return { ok: false, status: res.status, html: '', finalUrl: res.url || url };
    }
    const html = await res.text();
    return { ok: true, status: res.status, html: html.slice(0, 500_000), finalUrl: res.url || url };
  } catch (err) {
    return { ok: false, status: 0, html: '', finalUrl: url, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

function parseOsmHours(hoursJson) {
  if (!hoursJson) return null;
  try {
    const o = typeof hoursJson === 'string' ? JSON.parse(hoursJson) : hoursJson;
    if (o.osm_opening_hours) return String(o.osm_opening_hours).slice(0, 160);
    if (o.daily) return `Daily ${o.daily}`;
    if (o.tue_sun) return `Tue–Sun ${o.tue_sun}`;
    const parts = Object.entries(o)
      .filter(([k]) => !['source', 'osm_opening_hours'].includes(k))
      .map(([k, v]) => `${k}: ${v}`);
    return parts.length ? parts.join(' · ').slice(0, 160) : null;
  } catch {
    return null;
  }
}

/**
 * Enrich one business from its website (and OSM hours_json if present).
 * Does not invent data — missing fields stay null / "not listed yet" at render time.
 */
async function enrichBusiness(db, business, { force = false } = {}) {
  ensureEnrichColumns(db);
  if (
    !force &&
    business.enrichment_status === 'ok' &&
    business.enrichment_updated_at &&
    Date.now() - Date.parse(business.enrichment_updated_at) < 7 * 24 * 3600 * 1000
  ) {
    return { skipped: true, business };
  }

  const sources = [];
  let about = null;
  let aboutSource = null;
  let phone = business.phone || null;
  let hoursDisplay = null;
  let hoursSource = null;
  let menuUrl = null;
  let menuNotes = null;
  let happy = null;
  let specials = null;
  let status = 'partial';

  const osmHours = parseOsmHours(business.hours_json);
  if (osmHours) {
    hoursDisplay = osmHours;
    hoursSource = 'osm_seed';
    sources.push('osm_seed');
  }

  const website = business.website;
  if (website) {
    let fetched = await fetchHtml(website);
    // Retry alternate www / bare host when the first hop is blocked or empty
    if (!fetched.ok || !fetched.html) {
      try {
        const u = new URL(website.startsWith('http') ? website : `https://${website}`);
        const altHost = u.hostname.startsWith('www.')
          ? u.hostname.slice(4)
          : `www.${u.hostname}`;
        const alt = `${u.protocol}//${altHost}${u.pathname}${u.search}`;
        if (alt !== fetched.finalUrl) fetched = await fetchHtml(alt);
      } catch {
        /* keep first result */
      }
    }
    if (fetched.ok && fetched.html) {
      sources.push('venue_website');
      const text = stripTags(fetched.html).slice(0, 40_000);
      about = extractAbout(fetched.html, text, business.name);
      if (about) aboutSource = 'venue_website';
      if (!phone) {
        const found = sanitizePhone(findPhone(fetched.html) || findPhone(text));
        if (found) phone = found;
      }
      const webHours = extractHoursSnippet(text);
      if (webHours) {
        hoursDisplay = webHours;
        hoursSource = 'venue_website';
      }
      menuUrl = findMenuUrl(fetched.html, fetched.finalUrl);
      if (menuUrl) menuNotes = 'Menu link found on venue website';
      happy = extractHappyHour(text);
      specials = extractSpecials(text);
      status = about || hoursDisplay || menuUrl || phone ? 'ok' : 'thin';
    } else {
      sources.push(`website_fetch_failed:${fetched.status || fetched.error || 'error'}`);
      status = website ? 'fetch_failed' : 'no_website';
    }
  } else {
    status = osmHours ? 'partial' : 'no_website';
  }

  const ts = nowIso();
  db.prepare(`
    UPDATE businesses SET
      about_text = ?,
      about_source = ?,
      phone = COALESCE(NULLIF(?, ''), phone),
      hours_display = ?,
      hours_source = ?,
      menu_url = ?,
      menu_notes = ?,
      happy_hour_notes = ?,
      specials_notes = ?,
      enrichment_status = ?,
      enrichment_updated_at = ?,
      enrichment_sources_json = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    about,
    aboutSource,
    phone || '',
    hoursDisplay,
    hoursSource,
    menuUrl,
    menuNotes,
    happy,
    specials,
    status,
    ts,
    JSON.stringify(sources),
    ts,
    business.id
  );
  db.dirty = true;

  const fresh = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business.id);
  return {
    skipped: false,
    status,
    sources,
    fields: {
      about: Boolean(about),
      phone: Boolean(phone),
      hours: Boolean(hoursDisplay),
      menu: Boolean(menuUrl),
      happy_hour: Boolean(happy),
      specials: Boolean(specials),
    },
    business: fresh,
  };
}

async function enrichAllBusinesses(db, { force = false, limit = 50, concurrency = 3 } = {}) {
  ensureEnrichColumns(db);
  const rows = db.prepare('SELECT * FROM businesses ORDER BY name ASC').all().slice(0, limit);
  const results = [];
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const idx = i++;
      const row = rows[idx];
      try {
        const r = await enrichBusiness(db, row, { force });
        results.push({
          id: row.id,
          name: row.name,
          skipped: r.skipped,
          status: r.status || row.enrichment_status,
          fields: r.fields || null,
        });
      } catch (err) {
        results.push({ id: row.id, name: row.name, error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));
  return {
    total: rows.length,
    enriched: results.filter((r) => !r.skipped && !r.error).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => r.error).length,
    results,
  };
}

function publicEnrichment(business) {
  const notListed = 'Not listed yet';
  return {
    about: business.about_text || null,
    about_source: business.about_source || null,
    about_display: business.about_text || notListed,
    phone: business.phone || null,
    phone_display: business.phone || notListed,
    hours: business.hours_display || null,
    hours_source: business.hours_source || null,
    hours_display: business.hours_display || notListed,
    menu_url: business.menu_url || null,
    menu_notes: business.menu_notes || null,
    menu_display: business.menu_url
      ? business.menu_notes || 'View menu'
      : notListed,
    happy_hour: business.happy_hour_notes || null,
    happy_hour_display: business.happy_hour_notes || notListed,
    happy_hour_menu_url: business.happy_hour_menu_url || null,
    specials: business.specials_notes || null,
    specials_display: business.specials_notes || notListed,
    enrichment_status: business.enrichment_status || 'pending',
    enrichment_updated_at: business.enrichment_updated_at || null,
    enrichment_sources: (() => {
      try {
        return JSON.parse(business.enrichment_sources_json || '[]');
      } catch {
        return [];
      }
    })(),
  };
}

/**
 * Apply checked-in enrichment-cache.json so Netlify boots with venue briefs
 * without re-scraping (Cloudflare often blocks serverless fetches).
 */
function applyEnrichmentCache(db) {
  ensureEnrichColumns(db);
  let cache;
  try {
    // require() so Netlify's bundler includes the JSON in the function zip
    cache = require('../data/enrichment-cache.json');
  } catch {
    return { applied: 0 };
  }
  const venues = cache.venues || [];
  const ts = nowIso();
  let applied = 0;
  for (const v of venues) {
    const row = db.prepare('SELECT * FROM businesses WHERE name = ? OR slug = ?').get(v.name, v.slug);
    if (!row) continue;

    // Always refresh HH schedule + menu URL from cache when present (research pass wins).
    const hasHhUpdate =
      Object.prototype.hasOwnProperty.call(v, 'happy_hour_notes') ||
      Object.prototype.hasOwnProperty.call(v, 'happy_hour_menu_url');
    if (hasHhUpdate) {
      db.prepare(`
        UPDATE businesses SET
          happy_hour_notes = ?,
          happy_hour_menu_url = ?,
          enrichment_sources_json = COALESCE(?, enrichment_sources_json),
          enrichment_status = COALESCE(?, enrichment_status),
          enrichment_updated_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        v.happy_hour_notes || null,
        v.happy_hour_menu_url || null,
        v.enrichment_sources_json || null,
        v.enrichment_status || 'ok',
        ts,
        ts,
        row.id
      );
      db.dirty = true;
      applied += 1;
    }

    // Don't overwrite fresher live enrichment for other fields
    if (
      row.enrichment_status === 'ok' &&
      row.about_text &&
      row.enrichment_updated_at &&
      cache.updated_at &&
      Date.parse(row.enrichment_updated_at) >= Date.parse(cache.updated_at)
    ) {
      continue;
    }
    if (row.about_text && row.enrichment_status === 'ok' && !v.about_text) continue;
    db.prepare(`
      UPDATE businesses SET
        website = COALESCE(NULLIF(?, ''), website),
        phone = COALESCE(NULLIF(?, ''), phone),
        address = CASE WHEN ? IS NOT NULL AND ? != '' AND (address IS NULL OR address = '') THEN ? ELSE address END,
        about_text = COALESCE(?, about_text),
        about_source = COALESCE(?, about_source),
        hours_display = COALESCE(?, hours_display),
        hours_source = COALESCE(?, hours_source),
        menu_url = COALESCE(?, menu_url),
        menu_notes = COALESCE(?, menu_notes),
        specials_notes = COALESCE(?, specials_notes),
        enrichment_status = COALESCE(?, enrichment_status),
        enrichment_sources_json = COALESCE(?, enrichment_sources_json),
        enrichment_updated_at = COALESCE(enrichment_updated_at, ?),
        updated_at = ?
      WHERE id = ?
    `).run(
      v.website || '',
      v.phone || '',
      v.address || null,
      v.address || null,
      v.address || null,
      v.about_text || null,
      v.about_source || null,
      v.hours_display || null,
      v.hours_source || null,
      v.menu_url || null,
      v.menu_notes || null,
      v.specials_notes || null,
      v.enrichment_status || null,
      v.enrichment_sources_json || null,
      ts,
      ts,
      row.id
    );
    db.dirty = true;
    applied += 1;
  }
  return { applied, total: venues.length };
}

module.exports = {
  ensureEnrichColumns,
  enrichBusiness,
  enrichAllBusinesses,
  publicEnrichment,
  parseOsmHours,
  applyEnrichmentCache,
};
