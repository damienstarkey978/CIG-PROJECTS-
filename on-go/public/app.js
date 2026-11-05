/* ON GO — Signal Night client */
(() => {
  const state = {
    user: null,
    businessesOwned: [],
    map: null,
    markers: [],
    userMarker: null,
    userAccuracy: null,
    geo: null,
    geoStatus: 'pending', // pending | ready | denied | error | unsupported
    meta: { areas: [], categories: [] },
    venue: null,
    venueSlug: null,
  };

  const BEACHES_FALLBACK = { lat: 30.324, lng: -81.3965 };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
    return data;
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Per-logo pad: light wordmarks → dark plate; dark wordmarks → light plate */
  const LOGO_PAD_BY_URL = {"/assets/venues/1912-ocean-bar.png":"dark","/assets/venues/aqua-grill.png":"light","/assets/venues/brix-taphouse.png":"dark","/assets/venues/cinottis-bakery.jpg":"dark","/assets/venues/coastal-farmer.png":"dark","/assets/venues/culhanes-irish-pub.png":"dark","/assets/venues/dragonfly-lounge.png":"dark","/assets/venues/european-street.png":"dark","/assets/venues/factory-after-dark.png":"dark","/assets/venues/flask-and-cannon.png":"none","/assets/venues/flying-iguana.png":"dark","/assets/venues/gingers-place.png":"light","/assets/venues/green-room-brewing.jpg":"none","/assets/venues/island-girl.png":"light","/assets/venues/jax-beach-bar-grill.png":"dark","/assets/venues/kava-and-co.png":"dark","/assets/venues/landshark-bar-grill.png":"light","/assets/venues/luckys-bar.jpg":"dark","/assets/venues/lynchs-irish-pub.jpg":"light","/assets/venues/mangos-beach-bar.jpg":"none","/assets/venues/marker-32.png":"light","/assets/venues/monkeys-uncle-tavern.png":"dark","/assets/venues/mr-chubbys-wings.png":"light","/assets/venues/north-beach-fish-camp.png":"dark","/assets/venues/palm-valley-fish-camp.png":"dark","/assets/venues/petes-bar.jpg":"none","/assets/venues/poes-tavern.jpg":"light","/assets/venues/pussers-bar-grille.png":"light","/assets/venues/salt-beachside.png":"light","/assets/venues/sandbar-jax-beach.png":"light","/assets/venues/sneakers-sports-grille.png":"dark","/assets/venues/southern-grounds.png":"light","/assets/venues/surfer-the-bar.jpg":"light","/assets/venues/tacolu.png":"dark","/assets/venues/tavern-on-1st.jpg":"dark","/assets/venues/the-lemon-bar.png":"dark","/assets/venues/the-local.png":"dark","/assets/venues/the-ritz-lounge.png":"dark","/assets/venues/valley-smoke.jpg":"dark","/assets/venues/wreck-tiki-lounge.png":"dark","/assets/venues/mojos-blues-bar-bbq.png":"dark"};

  function logoPadClass(logoUrl) {
    if (!logoUrl) return 'logo-pad-none';
    const key = String(logoUrl).split('?')[0];
    const pad = LOGO_PAD_BY_URL[key] || 'dark';
    return `logo-pad-${pad}`;
  }

  function logoPadBg(logoUrl) {
    const pad = (LOGO_PAD_BY_URL[String(logoUrl || '').split('?')[0]] || 'dark');
    if (pad === 'light') return '#eef1ef';
    if (pad === 'none') return 'transparent';
    return '#121816';
  }

  /** Shared logo markup — Explore list + venue page stay consistent */
  function logoHtml(b, { className = 'listing-logo', size = 48 } = {}) {
    const initial = escapeHtml((b.name || '?').slice(0, 1));
    if (b.logo_url) {
      const pad = logoPadClass(b.logo_url);
      return `<img class="${className} ${pad}" src="${escapeHtml(b.logo_url)}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer" />`;
    }
    return `<div class="${className} placeholder" aria-hidden="true">${initial}</div>`;
  }

  function formatEnds(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  function minutesLeft(iso) {
    const ms = new Date(iso) - Date.now();
    if (ms <= 0) return 'expired';
    const m = Math.ceil(ms / 60000);
    return m < 60 ? `${m} min left` : `${Math.floor(m / 60)}h ${m % 60}m left`;
  }

  function countdownHtml(iso) {
    const label = minutesLeft(iso);
    return `<span class="countdown-live" data-ends="${escapeHtml(iso)}">${escapeHtml(label)}</span>`;
  }

  function runLaunchSplash() {
    const splash = $('#launch-splash');
    if (!splash) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hold = reduced ? 350 : 1100;
    const fade = reduced ? 150 : 450;
    setTimeout(() => {
      splash.classList.add('is-done');
      setTimeout(() => splash.remove(), fade + 50);
    }, hold);
  }

  function setSessionChip() {
    const chip = $('#session-chip');
    if (!state.user) {
      chip.textContent = 'Not signed in';
      chip.setAttribute('aria-label', 'Open account — sign in or create account');
      return;
    }
    chip.textContent = `${state.user.display_name} · ${state.user.role} · ${state.user.points_balance} pts`;
    chip.setAttribute('aria-label', `Open account — ${state.user.display_name}`);
  }

  function showView(name) {
    const navName = name === 'venue' ? 'explore' : name;
    $$('.view').forEach((el) => {
      el.hidden = el.id !== `view-${name}`;
    });
    $$('.sw').forEach((btn) => {
      const on = btn.dataset.view === navName;
      btn.classList.toggle('active', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    if ((name === 'explore' || name === 'venue') && state.map) {
      setTimeout(() => state.map.invalidateSize(), 80);
    }
    if (name === 'scan') refreshScan();
    if (name === 'rewards') refreshRewards();
    if (name === 'business') refreshBusiness();
    if (name === 'account') refreshAccount();
    if (name !== 'venue' && location.hash.startsWith('#/b/')) {
      history.replaceState({}, '', location.pathname + location.search);
    }
  }

  function venuePath(b) {
    return `#/b/${encodeURIComponent(b.slug || b.id)}`;
  }

  async function openVenue(slugOrId, { pushHash = true } = {}) {
    if (!slugOrId) return;
    showView('venue');
    const root = $('#venue-page');
    root.innerHTML = '<p class="meta">Loading venue…</p>';
    try {
      const data = await api(
        `/api/businesses/${encodeURIComponent(slugOrId)}?resolve_logo=1`
      );
      state.venue = data;
      state.venueSlug = data.slug || data.id;
      if (pushHash) {
        history.replaceState({}, '', venuePath(data));
      }
      renderVenuePage(data);
      if (state.map && data.lat != null && data.lng != null) {
        state.map.setView([data.lat, data.lng], Math.max(state.map.getZoom(), 15), {
          animate: true,
        });
      }
    } catch (err) {
      root.innerHTML = `<p class="meta">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderVenuePage(b) {
    const e = b.enrichment || {};
    const logo = logoHtml(b, { className: 'venue-logo', size: 72 });
    const liveOffers = b.live_offers || (b.live_offer ? [b.live_offer] : []);
    const offersHtml = liveOffers.length
      ? liveOffers
          .map(
            (o) => `<div class="venue-offer">
              <span class="badge live">Live</span>
              <strong>${escapeHtml(o.title)}</strong>
              <p class="meta">${escapeHtml(o.product_label || '')} · ${countdownHtml(o.ends_at)} · ${o.points_reward || 50} pts/visit</p>
              ${o.terms ? `<p class="meta">${escapeHtml(o.terms)}</p>` : ''}
              <div class="listing-actions">
                <button type="button" class="btn primary" data-goto="scan">Scan at venue</button>
                <button type="button" class="btn ghost" data-next="${b.id}">Next Stop</button>
              </div>
            </div>`
          )
          .join('')
      : `<p class="empty-live">No live campaigns right now. When it’s ON, Scan at the venue for points.</p>`;

    const phone = e.phone
      ? `<a href="tel:${escapeHtml(e.phone.replace(/[^\d+]/g, ''))}">${escapeHtml(e.phone)}</a>`
      : `<span class="empty">${escapeHtml(e.phone_display || 'Not listed yet')}</span>`;
    const menu = e.menu_url
      ? `<a href="${escapeHtml(e.menu_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          e.menu_display || 'View menu'
        )}</a>`
      : `<span class="empty">${escapeHtml(e.menu_display || 'Not listed yet')}</span>`;
    const website = b.website
      ? `<a href="${escapeHtml(b.website)}" target="_blank" rel="noopener noreferrer">Website</a>`
      : '';

    $('#venue-page').innerHTML = `
      <header class="venue-hero">
        <div class="venue-hero-top">
          ${logo}
          <div>
            <h2>${escapeHtml(b.name)}</h2>
            <p class="meta">${escapeHtml(b.area)} · ${escapeHtml(b.category)} · ${escapeHtml(
              b.status_label || b.status
            )}</p>
            ${b.is_featured ? '<span class="badge featured">Featured</span>' : ''}
            ${liveOffers.length ? '<span class="badge live">Live boost</span>' : ''}
          </div>
        </div>
      </header>

      <section class="venue-section">
        <h3>About</h3>
        <p class="${b.about_text || e.about ? '' : 'empty'}">${escapeHtml(
          e.about_display || e.about || 'Not listed yet'
        )}</p>
        ${
          e.about_source
            ? `<p class="meta">Source: ${escapeHtml(e.about_source)}</p>`
            : ''
        }
      </section>

      <section class="venue-section venue-facts">
        <h3>Details</h3>
        <p class="venue-fact"><strong>Address</strong> — ${
          b.address
            ? escapeHtml(b.address)
            : '<span class="empty">Not listed yet</span>'
        }</p>
        <p class="venue-fact"><strong>Phone</strong> — ${phone}</p>
        <p class="venue-fact"><strong>Hours</strong> — ${
          e.hours
            ? escapeHtml(e.hours)
            : `<span class="empty">${escapeHtml(e.hours_display || 'Not listed yet')}</span>`
        }</p>
        <p class="venue-fact"><strong>Menu</strong> — ${menu}</p>
        ${website ? `<p class="venue-fact">${website}</p>` : ''}
      </section>

      <section class="venue-section">
        <h3>Happy hour</h3>
        ${
          e.happy_hour
            ? `<ul class="venue-hh-list">${String(e.happy_hour)
                .split(/\n+/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => `<li>${escapeHtml(line)}</li>`)
                .join('')}</ul>`
            : `<p class="empty">Not listed yet</p>`
        }
        ${
          e.happy_hour_menu_url
            ? `<p class="venue-hh-link"><a class="venue-hh-menu-link" href="${escapeHtml(
                e.happy_hour_menu_url
              )}" target="_blank" rel="noopener noreferrer">Happy Hour Menu</a></p>`
            : ''
        }
        ${
          e.specials
            ? `<p class="meta">${escapeHtml(e.specials)}</p>`
            : ''
        }
      </section>

      <section class="venue-section">
        <h3>Active BOGOs &amp; boosts</h3>
        ${offersHtml}
        ${
          b.can_boost
            ? `<p class="meta">Venue can flip a boost ON anytime from the Business tab.</p>`
            : `<p class="meta">Unclaimed directory listing — claim to run live boosts.</p>`
        }
      </section>
    `;
  }

  function initMap() {
    if (!window.L) {
      $('#map').textContent = 'Map unavailable. Browse listings below.';
      return;
    }
    state.map = L.map('map', { scrollWheelZoom: false, zoomControl: false }).setView([30.287, -81.397], 11);
    L.control.zoom({ position: 'topright' }).addTo(state.map);
    // Free OSM tiles only — no Carto/API key. Night look comes from CSS filter on .leaflet-tile-pane.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(state.map);
  }

  function setGeoHud(status, message) {
    state.geoStatus = status;
    const hud = $('#geo-hud');
    const text = $('#geo-hud-text');
    const retry = $('#geo-retry');
    if (!hud || !text || !retry) return;
    hud.dataset.state = status;
    text.textContent = message;
    const showRetry = status === 'denied' || status === 'error' || status === 'unsupported';
    retry.hidden = !showRetry;
    retry.textContent = status === 'unsupported' ? 'Location unavailable' : 'Use my location';
    retry.disabled = status === 'unsupported';
  }

  function clearUserLocationLayers() {
    if (!state.map) return;
    if (state.userMarker) {
      state.map.removeLayer(state.userMarker);
      state.userMarker = null;
    }
    if (state.userAccuracy) {
      state.map.removeLayer(state.userAccuracy);
      state.userAccuracy = null;
    }
  }

  function showUserOnMap(lat, lng, accuracy, { pan = true } = {}) {
    if (!state.map || !window.L) return;
    clearUserLocationLayers();

    if (accuracy && accuracy > 0 && accuracy < 5000) {
      state.userAccuracy = L.circle([lat, lng], {
        radius: accuracy,
        color: '#4aa3ff',
        weight: 1,
        fillColor: '#4aa3ff',
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(state.map);
    }

    const halo = L.divIcon({
      className: '',
      html: '<div class="user-here-halo" aria-hidden="true"></div>',
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });
    const core = L.divIcon({
      className: '',
      html: '<div class="user-here-dot" title="You are here"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });

    // Group as a layer group so venue refresh never wipes “you are here”
    const group = L.layerGroup([
      L.marker([lat, lng], { icon: halo, interactive: false, keyboard: false }),
      L.marker([lat, lng], { icon: core, keyboard: false }).bindPopup('<strong>You are here</strong>'),
    ]);
    group.addTo(state.map);
    state.userMarker = group;

    if (pan) {
      const zoom = Math.max(state.map.getZoom(), 14);
      state.map.setView([lat, lng], zoom, { animate: true });
    }
  }

  function venueMarkerIcon(live) {
    // Solid neon DivIcons — large enough to read when zoomed out on Beaches.
    const size = live ? 34 : 28;
    return L.divIcon({
      className: 'venue-marker-wrap',
      html: `<div class="venue-marker ${live ? 'is-live' : 'is-directory'}" title="${
        live ? 'Live offer' : 'Venue'
      }"><span class="venue-marker-core" aria-hidden="true"></span></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    });
  }

  function updateMarkers(businesses) {
    if (!state.map) return;
    state.markers.forEach((m) => state.map.removeLayer(m));
    state.markers = businesses.map((b) => {
      const live = Boolean(b.live_offer);
      const marker = L.marker([b.lat, b.lng], {
        icon: venueMarkerIcon(live),
        keyboard: true,
        riseOnHover: true,
        zIndexOffset: live ? 400 : 200,
      }).addTo(state.map);
      const offerLine = live
        ? `<br><strong style="color:#1aff5a">LIVE:</strong> ${escapeHtml(b.live_offer.title)}`
        : '<br><em>Directory</em>';
      const logo = b.logo_url
        ? `<img src="${escapeHtml(b.logo_url)}" alt="" width="36" height="36" style="border-radius:8px;object-fit:contain;object-position:center;background:${logoPadBg(b.logo_url)};padding:2px;box-sizing:border-box;vertical-align:middle;margin-right:6px" referrerpolicy="no-referrer" />`
        : '';
      marker.bindPopup(
        `<div style="display:flex;gap:8px;align-items:flex-start">${logo}<div><strong>${escapeHtml(b.name)}</strong><br>${escapeHtml(b.area)} · ${escapeHtml(b.category)}${offerLine}<br><button type="button" class="btn primary" data-open-venue="${escapeHtml(
          b.slug || b.id
        )}" style="margin-top:6px">Open page</button></div></div>`
      );
      marker.on('popupopen', () => {
        const btn = document.querySelector(`[data-open-venue="${CSS.escape(b.slug || b.id)}"]`);
        if (btn) {
          btn.onclick = (ev) => {
            ev.preventDefault();
            openVenue(b.slug || b.id);
          };
        }
      });
      return marker;
    });
    // Venue refresh must not drop the user marker
    if (state.geo) {
      showUserOnMap(state.geo.lat, state.geo.lng, state.geo.accuracy, { pan: false });
    }
  }

  function renderTicker(businesses) {
    const live = businesses.filter((b) => b.live_offer);
    const root = $('#signal-ticker');
    $('#live-hud-text').textContent = live.length
      ? `${live.length} live signal${live.length === 1 ? '' : 's'} on the Beaches`
      : 'No live offers — browse the directory';

    if (!live.length) {
      const geoNote =
        state.geoStatus === 'denied' || state.geoStatus === 'unsupported'
          ? ' Location unavailable — distances use Beaches center.'
          : '';
      root.innerHTML = `<p class="empty-live">No offers are live right now. Check back soon or browse the directory.${geoNote}</p>`;
      return;
    }

    root.innerHTML = live
      .map((b, i) => {
        const o = b.live_offer;
        return `<article class="tick" style="animation-delay:${i * 0.08}s">
          <span class="badge live">Live</span>
          <h3>${escapeHtml(o.title)}</h3>
          <p class="meta">${escapeHtml(b.name)} · ${escapeHtml(b.area)} · ${minutesLeft(o.ends_at)}</p>
          <div class="actions">
            <button type="button" class="btn primary" data-goto="scan">Scan at venue</button>
            <button type="button" class="btn ghost" data-next="${b.id}">Next Stop</button>
          </div>
        </article>`;
      })
      .join('');
  }

  async function loadDirectory() {
    const params = new URLSearchParams();
    const area = $('#filter-area').value;
    const category = $('#filter-category').value;
    const live = $('#filter-live').checked;
    const q = $('#filter-q').value.trim();
    const radius = $('#filter-radius').value;
    if (area) params.set('area', area);
    if (category) params.set('category', category);
    if (live) params.set('live', '1');
    if (q) params.set('q', q);
    const origin = state.geo || BEACHES_FALLBACK;
    params.set('lat', String(origin.lat));
    params.set('lng', String(origin.lng));
    if (radius) params.set('radius_mi', radius);

    const data = await api(`/api/businesses?${params}`);
    $('#listing-count').textContent = `${data.count} listings · ${data.live_count} live`;
    updateMarkers(data.businesses);
    renderTicker(data.businesses);
    renderList(data.businesses);
    return data.businesses;
  }

  function renderList(businesses) {
    const root = $('#business-list');
    if (!businesses.length) {
      root.innerHTML = '<p class="meta">No listings match these filters.</p>';
      return;
    }
    root.innerHTML = businesses
      .map((b) => {
        const live = b.live_offer;
        const badges = [
          live ? '<span class="badge live">Live</span>' : `<span class="badge">${escapeHtml(b.status_label)}</span>`,
          b.is_featured ? '<span class="badge featured">Featured</span>' : '',
        ].join(' ');
        const note =
          b.endorsement_note && !live
            ? `<p class="meta">${escapeHtml(b.endorsement_note)}</p>`
            : '';
        const dist = b.distance_mi != null ? `<p class="meta">${b.distance_mi} mi</p>` : '';
        const favLabel = b.is_favorite ? '★ Favorited' : '☆ Favorite';
        const offer = live
          ? `<div class="offer-block">
              <strong>${escapeHtml(live.title)}</strong>
              <p class="meta">${escapeHtml(live.product_label || '')} · ${minutesLeft(live.ends_at)}</p>
              <div class="listing-actions">
                <button type="button" class="btn primary" data-goto="scan">Scan at venue</button>
                <button type="button" class="btn ghost" data-next="${b.id}">Next Stop</button>
              </div>
            </div>`
          : `<div class="listing-actions">
              <button type="button" class="btn ghost" data-fav="${b.id}" data-on="${b.is_favorite ? '1' : '0'}">${favLabel}</button>
            </div>`;
        const logo = logoHtml(b, { className: 'listing-logo', size: 48 });
        return `<article class="listing is-link" data-id="${b.id}" data-open-venue="${escapeHtml(
          b.slug || b.id
        )}" tabindex="0" role="link" aria-label="Open ${escapeHtml(b.name)}">
          <div class="listing-head">
            ${logo}
            <div class="listing-copy">
              <h3>${escapeHtml(b.name)}</h3>
              <p class="meta">${escapeHtml(b.area)} · ${escapeHtml(b.category)}</p>
            </div>
          </div>
          ${b.address ? `<p class="meta">${escapeHtml(b.address)}</p>` : ''}
          ${dist}
          ${badges}
          ${note}
          ${offer}
          <p class="meta listing-open">Tap for full venue page →</p>
        </article>`;
      })
      .join('');
  }

  async function claimOffer(offerId) {
    if (!state.user || state.user.role !== 'customer') {
      alert('Sign in as a customer to claim offers.');
      showView('account');
      return;
    }
    try {
      const data = await api(`/api/offers/${offerId}/claim`, { method: 'POST', body: '{}' });
      $('#claim-qr').src = data.qr_data_url;
      $('#claim-token').textContent = `ongo:${data.token}`;
      $('#claim-dialog').showModal();
      await refreshMe();
      await refreshRewards();
    } catch (err) {
      alert(err.message);
    }
  }

  async function loadNextStop(businessId) {
    const data = await api(`/api/next-stop?business_id=${encodeURIComponent(businessId)}&limit=4`);
    const strip = $('#next-stop-strip');
    if (!data.next_stops.length) {
      strip.hidden = false;
      strip.innerHTML = '<h3>Next Stop</h3><p class="meta">No other live offers nearby right now.</p>';
      return;
    }
    strip.hidden = false;
    strip.innerHTML = `<h3>Next Stop</h3>
      <p class="meta">Nearby live offers after this stop.</p>
      ${data.next_stops
        .map(
          (n) => `<div class="listing">
            <strong>${escapeHtml(n.name)}</strong>
            <p class="meta">${escapeHtml(n.title)} · ${n.distance_mi} mi · ${minutesLeft(n.ends_at)}</p>
          </div>`
        )
        .join('')}`;
    strip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function toggleFavorite(businessId, on) {
    if (!state.user) {
      showView('account');
      return;
    }
    if (on) await api(`/api/favorites/${businessId}`, { method: 'DELETE' });
    else await api(`/api/favorites/${businessId}`, { method: 'POST', body: '{}' });
    await loadDirectory();
    if (!$('#view-rewards').hidden) refreshRewards();
  }

  async function refreshMe() {
    const data = await api('/api/me');
    state.user = data.user;
    state.businessesOwned = data.businesses || [];
    setSessionChip();
    $('#points-value').textContent = String(data.user?.points_balance ?? 0);
  }

  async function refreshScan() {
    const status = $('#scan-geo-status');
    if (!status) return;
    if (!state.user) {
      status.textContent = 'Sign in as a member to earn visit points. Browse Explore free anytime.';
      return;
    }
    if (state.user.role !== 'customer') {
      status.textContent = 'Visit points are for member accounts. Businesses confirm reward codes instead.';
      return;
    }
    if (state.geoStatus === 'ready' && state.geo) {
      const acc = state.geo.accuracy != null ? ` · ±${Math.round(state.geo.accuracy)}m` : '';
      status.textContent = `Location ready${acc}. Scan the venue QR, then Check in.`;
    } else if (state.geoStatus === 'denied') {
      status.textContent = 'Location denied — enable it and retry. Points cannot award without GPS.';
    } else {
      status.textContent = 'Waiting for a fresh GPS reading…';
    }
  }

  async function refreshRewards() {
    const catalog = $('#rewards-catalog');
    const codes = $('#reward-codes');
    try {
      const catalogData = await api('/api/rewards');
      if (catalog) {
        const windowDays = catalogData.redeem_window_days || 30;
        catalog.innerHTML = (catalogData.rewards || []).length
          ? catalogData.rewards
              .map(
                (r) => `<div class="listing">
                  <strong>${escapeHtml(r.title)}</strong>
                  <p class="meta">${escapeHtml(r.business_name)} · ${r.points_cost} pts · ${r.quantity_remaining} left · listing ends ${formatEnds(r.expires_at)}</p>
                  ${r.terms ? `<p class="meta">${escapeHtml(r.terms)}</p>` : ''}
                  <p class="meta points-disclaimer">Before you claim: points ≠ cash; points do not expire in beta; after claiming you have ${windowDays} days to redeem at the venue.</p>
                  <button type="button" class="btn primary" data-claim-reward="${r.id}" ${
                    state.user?.role === 'customer' ? '' : 'disabled'
                  }>${state.user ? 'Claim with points' : 'Sign in to redeem'}</button>
                </div>`
              )
              .join('')
          : '<p class="meta">No vendor rewards listed yet.</p>';
        if (catalogData.notice) {
          catalog.innerHTML += `<p class="meta">${escapeHtml(catalogData.notice)}</p>`;
        }
      }
    } catch (err) {
      if (catalog) catalog.innerHTML = `<p class="meta">${escapeHtml(err.message)}</p>`;
    }

    if (!state.user) {
      $('#loyalty-history').innerHTML =
        '<p class="meta">Sign in as a customer to earn &amp; redeem. Demo: customer@ongo.demo / demo1234</p>';
      $('#favorites-list').innerHTML = '';
      $('#active-claim').hidden = true;
      if (codes) codes.innerHTML = '';
      return;
    }
    try {
      const hist = await api('/api/loyalty/history');
      $('#points-value').textContent = String(hist.points_balance);
      $('#loyalty-history').innerHTML = hist.history.length
        ? hist.history
            .map(
              (h) => `<div class="listing">
                <strong>${h.delta > 0 ? '+' : ''}${h.delta} pts</strong>
                <p class="meta">${escapeHtml(h.reason)}${h.business_name ? ' · ' + escapeHtml(h.business_name) : ''} · ${formatEnds(h.created_at)}</p>
              </div>`
            )
            .join('')
        : '<p class="meta">No ledger activity yet — scan at a live venue to earn.</p>';

      const favs = await api('/api/favorites');
      $('#favorites-list').innerHTML = favs.favorites.length
        ? favs.favorites
            .map(
              (b) => `<div class="listing">
                <strong>${escapeHtml(b.name)}</strong>
                <p class="meta">${escapeHtml(b.area)} · ${escapeHtml(b.category)}</p>
              </div>`
            )
            .join('')
        : '<p class="meta">No favorites yet.</p>';

      if (state.user.role === 'customer' && codes) {
        const rr = await api('/api/customer/reward-redemptions');
        codes.innerHTML = (rr.redemptions || []).length
          ? rr.redemptions
              .map(
                (r) => `<div class="listing">
                  <strong>${escapeHtml(r.reward_title)}</strong>
                  <p class="meta">${escapeHtml(r.business_name)} · ${escapeHtml(r.status)}${
                    r.redeem_by && r.status === 'claimed' ? ' · redeem by ' + formatEnds(r.redeem_by) : ''
                  }</p>
                  <p class="mono">${escapeHtml(r.code)}</p>
                  <p class="meta points-disclaimer">Points ≠ cash. 30-day window from claim.</p>
                </div>`
              )
              .join('')
          : '<p class="meta">No reward codes yet.</p>';
        $('#active-claim').hidden = true;
      }
    } catch (err) {
      $('#loyalty-history').innerHTML = `<p class="meta">${escapeHtml(err.message)}</p>`;
    }
  }

  function fillOwnedSelects() {
    const opts = state.businessesOwned
      .map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`)
      .join('');
    $('#offer-business').innerHTML = opts;
    $('#bid-business').innerHTML = opts;
    const qrSel = $('#venue-qr-business');
    const rewardSel = $('#reward-business');
    if (qrSel) qrSel.innerHTML = opts;
    if (rewardSel) rewardSel.innerHTML = opts;
  }

  async function syncBoostToggle() {
    const toggle = $('#boost-toggle');
    const label = $('#boost-label');
    const businessId = $('#offer-business')?.value;
    if (!toggle || !businessId) return;
    try {
      const data = await api(`/api/businesses/${encodeURIComponent(businessId)}`);
      const on = Boolean(data.live_offer || (data.live_offers && data.live_offers.length));
      toggle.checked = on;
      if (label) label.textContent = on ? 'Boost ON' : 'Boost OFF';
      if (on) $('#power-btn')?.classList.add('armed');
      else $('#power-btn')?.classList.remove('armed');
    } catch {
      /* ignore */
    }
  }

  async function refreshBusiness() {
    const gate = $('#biz-gate');
    const dash = $('#biz-dashboard');
    if (!state.user || state.user.role !== 'business') {
      gate.hidden = false;
      dash.hidden = true;
      return;
    }
    gate.hidden = true;
    dash.hidden = false;
    fillOwnedSelects();
    await syncBoostToggle();

    try {
      const offers = await api('/api/business/offers');
      $('#biz-offers').innerHTML = offers.offers.length
        ? offers.offers
            .map((o) => {
              const active = o.status === 'live' || o.status === 'scheduled' || o.status === 'paused';
              const visits = o.visits_count != null ? o.visits_count : o.redemption_count;
              return `<div class="listing">
                <strong>${escapeHtml(o.title)}</strong>
                <p class="meta">${escapeHtml(o.business_name)} · ${escapeHtml(o.status)} · ${countdownHtml(o.ends_at)} · ${visits}${o.redemption_limit != null ? '/' + o.redemption_limit : ''} visits · ${o.points_reward || 50} pts</p>
                <div class="listing-actions">
                  ${o.status === 'live' || o.status === 'scheduled' ? `<button type="button" class="btn ghost" data-pause="${o.id}">Pause</button>` : ''}
                  ${o.status === 'paused' ? `<button type="button" class="btn ghost" data-resume="${o.id}">Resume</button>` : ''}
                  ${active ? `<button type="button" class="btn ghost" data-deactivate="${o.id}">End</button>` : ''}
                </div>
              </div>`;
            })
            .join('')
        : '<p class="meta">No campaigns yet — tap the power switch.</p>';

      const analytics = await api('/api/business/analytics');
      $('#biz-analytics').innerHTML = analytics.analytics
        .map(
          (a) => `<div class="listing">
            <strong>${escapeHtml(a.name)}</strong>
            <p class="meta">${a.views || 0} views · ${a.qualifying_visits || 0} visits · ${a.points_awarded || 0} pts awarded · ${a.rewards_redeemed || 0} rewards · ${a.live_offers} live</p>
          </div>`
        )
        .join('') || '<p class="meta">No venues yet.</p>';
      if (analytics.notice) {
        $('#biz-analytics').innerHTML += `<p class="meta">${escapeHtml(analytics.notice)}</p>`;
      }
      try {
        const results = await api('/api/business/results');
        const box = $('#biz-results');
        if (box) {
          box.innerHTML = (results.results || [])
            .map(
              (r) => `<div class="listing">
                <strong>${escapeHtml(r.title)}</strong>
                <p class="meta">${escapeHtml(r.business_name)} · ${escapeHtml(r.status)} · views ${r.views_count || 0} · visits ${r.visits_count || 0} · pts ${r.points_awarded_total || 0} · rewards ${r.rewards_redeemed || 0}</p>
              </div>`
            )
            .join('') || '<p class="meta">No campaign history yet.</p>';
        }
      } catch {
        /* optional */
      }

      const subs = await api('/api/subscriptions');
      $('#biz-plans').innerHTML = `
        ${(subs.subscriptions || [])
          .map((s) => {
            const label = s.label || s.plan;
            const ends = s.ends_at ? ` · ends ${new Date(s.ends_at).toLocaleDateString()}` : '';
            const badge = s.entitled_pro
              ? '<span class="badge featured">Pro unlocked</span>'
              : '';
            return `<div class="listing">
              <strong>${escapeHtml(s.business_name)}</strong>
              ${badge}
              <p class="meta">${escapeHtml(label)}${ends}</p>
            </div>`;
          })
          .join('')}
        <p class="meta">${escapeHtml(subs.notice || '')}</p>
        <p class="meta">Catalog (after trial): ${(subs.plans || [])
          .map((p) => `${p.label} $${(p.price_monthly_cents / 100).toFixed(0)}/mo`)
          .join(' · ')}</p>`;

      const ads = await api('/api/ads/inventory');
      $('#bid-slot').innerHTML = ads.inventory
        .map(
          (s) =>
            `<option value="${s.id}">${escapeHtml(s.slot_label)} · min $${(s.min_bid_cents / 100).toFixed(0)}</option>`
        )
        .join('');
      // Prefetch logos for owned venues + show preview for current selection
      const ownedIds = state.businessesOwned.map((b) => b.id).filter(Boolean);
      if (ownedIds.length) {
        api('/api/logos/resolve', {
          method: 'POST',
          body: JSON.stringify({ business_ids: ownedIds }),
        }).catch(() => {});
      }
      await refreshAdPreview();
    } catch (err) {
      $('#biz-offers').innerHTML = `<p class="meta">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderAdCreative(creative) {
    const panel = $('#ad-preview');
    const creatives = $('#ad-creatives');
    const empty = $('#ad-logo-empty');
    const meta = $('#ad-preview-meta');
    if (!panel || !creative) return;
    panel.hidden = false;
    const missing = creative.logo_status === 'missing' || !creative.logo_url;
    empty.hidden = !missing;
    meta.textContent = [
      creative.business_name,
      creative.slot_label,
      creative.logo_source ? `logo: ${creative.logo_source}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const logoHtml = missing
      ? '<div class="ad-unit-logo placeholder" aria-hidden="true">NO LOGO</div>'
      : `<img class="ad-unit-logo" src="${escapeHtml(creative.logo_url)}" alt="" width="48" height="48" loading="lazy" referrerpolicy="no-referrer" />`;

    creatives.innerHTML = (creative.placements || [])
      .map(
        (p) => `
        <div class="ad-unit-wrap">
          <div class="ad-unit-label">${escapeHtml(p.label)} · ${p.width}×${p.height}</div>
          <div class="ad-unit ${escapeHtml(p.id)}" role="img" aria-label="${escapeHtml(p.label)} preview">
            ${logoHtml}
            <div class="ad-unit-copy">
              <strong>${escapeHtml(creative.business_name)}</strong>
              <span>${escapeHtml(creative.slot_label || 'Featured slot')} · ${escapeHtml(creative.area || '')}</span>
            </div>
            <div class="ad-unit-mark">
              <span class="badge featured">Featured</span>
              <span class="ad-unit-brand">ON GO</span>
            </div>
          </div>
        </div>`
      )
      .join('');
  }

  async function refreshAdPreview() {
    const businessId = $('#bid-business')?.value;
    const inventoryId = $('#bid-slot')?.value;
    if (!businessId) {
      if ($('#ad-preview')) $('#ad-preview').hidden = true;
      return;
    }
    try {
      const q = new URLSearchParams({ business_id: businessId });
      if (inventoryId) q.set('inventory_id', inventoryId);
      const data = await api(`/api/ads/preview?${q}`);
      renderAdCreative(data.creative);
    } catch (err) {
      if ($('#bid-result')) $('#bid-result').textContent = err.message;
    }
  }

  function setAuthFlash(msg, { show = true } = {}) {
    const el = $('#auth-flash');
    if (!el) return;
    if (!show || !msg) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  async function refreshAccount() {
    const signed = $('#account-signed-in');
    const forms = $('#account-forms');
    const banner = $('#account-verify-banner');
    const resend = $('#resend-verify-btn');
    const adminPanel = $('#admin-panel');
    if (state.user) {
      signed.hidden = false;
      forms.hidden = true;
      const verified = state.user.email_verified;
      $('#account-summary').textContent = `${state.user.display_name} (${state.user.email}) — ${state.user.role}${
        verified ? '' : ' · email not verified'
      } · ${state.user.points_balance} pts`;
      if ($('#settings-name')) $('#settings-name').value = state.user.display_name || '';
      if (banner && resend) {
        if (!verified) {
          banner.hidden = false;
          banner.textContent = 'Verify your email to earn visit points. Check your inbox or resend the link.';
          resend.hidden = false;
        } else {
          banner.hidden = true;
          resend.hidden = true;
        }
      }
      if (adminPanel) {
        if (state.user.role === 'admin') {
          adminPanel.hidden = false;
          try {
            const data = await api('/api/admin/overview');
            const pending = (data.pending_venues || [])
              .map(
                (v) => `<div class="listing">
                  <strong>${escapeHtml(v.name)}</strong>
                  <p class="meta">${escapeHtml(v.area)} · ${escapeHtml(v.status)}</p>
                  <button type="button" class="btn primary" data-approve-venue="${v.id}">Approve</button>
                  <button type="button" class="btn ghost" data-suspend-venue="${v.id}">Suspend</button>
                </div>`
              )
              .join('') || '<p class="meta">No pending venue approvals.</p>';
            const audit = (data.audit || [])
              .slice(0, 12)
              .map(
                (a) => `<div class="listing"><p class="meta">${escapeHtml(a.action)} · ${escapeHtml(a.entity_type)} · ${formatEnds(a.created_at)}${a.reason ? ' · ' + escapeHtml(a.reason) : ''}</p></div>`
              )
              .join('');
            $('#admin-content').innerHTML = `
              <h4 class="label">Pending venues</h4>${pending}
              <h4 class="label">Recent audit</h4>${audit || '<p class="meta">No audit yet.</p>'}
              <p class="meta">Defaults: ${data.beta?.points_per_visit || 50} pts/visit · ${data.beta?.visit_radius_meters || 150}m radius</p>`;
          } catch (err) {
            $('#admin-content').innerHTML = `<p class="meta">${escapeHtml(err.message)}</p>`;
          }
        } else {
          adminPanel.hidden = true;
        }
      }
    } else {
      signed.hidden = true;
      forms.hidden = false;
      if (banner) banner.hidden = true;
      if (resend) resend.hidden = true;
      if (adminPanel) adminPanel.hidden = true;
    }
  }

  async function handleAuthQueryParams() {
    const params = new URLSearchParams(window.location.search);
    const verify = params.get('verify');
    const reset = params.get('reset');
    if (!verify && !reset) return;

    showView('account');
    if (verify) {
      let verified = false;
      for (let attempt = 0; attempt < 4 && !verified; attempt += 1) {
        try {
          if (attempt) await new Promise((r) => setTimeout(r, 800 * attempt));
          const data = await api('/api/auth/verify', {
            method: 'POST',
            body: JSON.stringify({ token: verify }),
          });
          state.user = data.user;
          setSessionChip();
          refreshAccount();
          setAuthFlash(data.message || 'Email verified — you are signed in.');
          verified = true;
        } catch (err) {
          if (attempt === 3 || !/syncing|sync_pending|Invalid or expired/i.test(err.message || '')) {
            setAuthFlash(err.message || 'Verification failed');
            break;
          }
        }
      }
      params.delete('verify');
    }

    if (reset) {
      $('#login-form').hidden = true;
      $('#register-form').hidden = true;
      $('#forgot-form').hidden = true;
      $('#reset-form').hidden = false;
      $('#reset-token').value = reset;
      setAuthFlash('Choose a new password for your account.');
      params.delete('reset');
    }

    const next = params.toString();
    const url = next ? `${window.location.pathname}?${next}` : window.location.pathname;
    window.history.replaceState({}, '', url);
  }

  async function loadMetaAndClaimOptions() {
    state.meta = await api('/api/meta/areas');
    const areaSel = $('#filter-area');
    areaSel.innerHTML = '<option value="">All Beaches</option>';
    state.meta.areas.forEach((a) => {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      areaSel.appendChild(opt);
    });
    const catSel = $('#filter-category');
    catSel.innerHTML = '<option value="">All food & drink</option>';
    state.meta.categories.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      catSel.appendChild(opt);
    });

    const all = await api('/api/businesses');
    const unclaimed = all.businesses.filter((b) => b.status === 'unclaimed');
    $('#register-business').innerHTML = unclaimed
      .map((b) => `<option value="${b.id}">${escapeHtml(b.name)} · ${escapeHtml(b.area)}</option>`)
      .join('');
  }

  function onGeoSuccess(pos, { pan = true } = {}) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const accuracy = pos.coords.accuracy;
    state.geo = { lat, lng, accuracy };
    setGeoHud('ready', 'You are here · distances from your location');
    showUserOnMap(lat, lng, accuracy, { pan });
    loadDirectory().catch(console.error);
  }

  function onGeoError(err) {
    const denied = err && (err.code === 1 || /denied/i.test(String(err.message || '')));
    if (denied) {
      setGeoHud('denied', 'Location blocked — distances use Beaches center');
    } else {
      setGeoHud('error', 'Couldn’t get location — try again');
    }
  }

  function requestGeo({ userGesture = false } = {}) {
    if (!navigator.geolocation) {
      setGeoHud('unsupported', 'Location not supported on this device');
      return;
    }

    setGeoHud('pending', userGesture ? 'Updating your location…' : 'Finding your location…');

    const opts = {
      enableHighAccuracy: false,
      timeout: 12000,
      // Reuse a fresh-enough fix so we don’t nag when permission is already granted
      maximumAge: userGesture ? 0 : 60_000,
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => onGeoSuccess(pos, { pan: true }),
      onGeoError,
      opts
    );
  }

  /** If permission already granted, fetch quietly; if prompt, still ask once on boot. */
  function bootstrapGeo() {
    if (!navigator.geolocation) {
      setGeoHud('unsupported', 'Location not supported on this device');
      return;
    }
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions
        .query({ name: 'geolocation' })
        .then((result) => {
          if (result.state === 'denied') {
            setGeoHud('denied', 'Location blocked — distances use Beaches center');
            return;
          }
          // granted or prompt — getCurrentPosition; browser won’t re-prompt if granted
          requestGeo({ userGesture: false });
          result.onchange = () => {
            if (result.state === 'granted') requestGeo({ userGesture: false });
            if (result.state === 'denied') {
              clearUserLocationLayers();
              state.geo = null;
              setGeoHud('denied', 'Location blocked — distances use Beaches center');
              loadDirectory().catch(console.error);
            }
          };
        })
        .catch(() => requestGeo({ userGesture: false }));
      return;
    }
    requestGeo({ userGesture: false });
  }

  function bindEvents() {
    $$('.sw').forEach((btn) => {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    });

    $('#session-chip')?.addEventListener('click', () => showView('account'));

    document.body.addEventListener('click', (e) => {
      const goto = e.target.closest('[data-goto]');
      if (goto) showView(goto.dataset.goto);
    });

    $('#geo-retry')?.addEventListener('click', () => {
      requestGeo({ userGesture: true });
    });

    const power = $('#power-btn');
    if (power) {
      power.addEventListener('click', () => {
        power.classList.toggle('armed');
        $('#offer-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
        $('#offer-title').focus();
      });
    }

    ['filter-area', 'filter-category', 'filter-live', 'filter-radius'].forEach((id) => {
      $(`#${id}`).addEventListener('change', () => loadDirectory().catch(console.error));
    });
    let qTimer;
    $('#filter-q').addEventListener('input', () => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => loadDirectory().catch(console.error), 250);
    });

    const claimHandler = (e) => {
      const claim = e.target.closest('[data-claim]');
      if (claim) {
        e.stopPropagation();
        return claimOffer(claim.dataset.claim);
      }
      const next = e.target.closest('[data-next]');
      if (next) {
        e.stopPropagation();
        return loadNextStop(next.dataset.next).catch((err) => alert(err.message));
      }
      const fav = e.target.closest('[data-fav]');
      if (fav) {
        e.stopPropagation();
        return toggleFavorite(fav.dataset.fav, fav.dataset.on === '1').catch((err) => alert(err.message));
      }
      const open = e.target.closest('[data-open-venue]');
      if (open) return openVenue(open.dataset.openVenue);
    };
    $('#business-list').addEventListener('click', claimHandler);
    $('#business-list').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const open = e.target.closest('[data-open-venue]');
      if (!open) return;
      e.preventDefault();
      openVenue(open.dataset.openVenue);
    });
    $('#signal-ticker').addEventListener('click', claimHandler);
    $('#venue-page')?.addEventListener('click', claimHandler);

    $('#venue-back')?.addEventListener('click', () => {
      state.venue = null;
      showView('explore');
    });

    $('#boost-toggle')?.addEventListener('change', async (e) => {
      const businessId = $('#offer-business')?.value;
      const result = $('#boost-result');
      const label = $('#boost-label');
      if (!businessId) {
        e.target.checked = false;
        if (result) result.textContent = 'Select a venue first.';
        return;
      }
      try {
        const data = await api(`/api/businesses/${encodeURIComponent(businessId)}/boost`, {
          method: 'POST',
          body: JSON.stringify({
            active: e.target.checked,
            title: $('#offer-title')?.value || 'BOGO — ON GO boost',
            product_label: $('#offer-product')?.value || 'Ask your server',
            duration_minutes: Number($('#offer-duration')?.value) || 120,
            redemption_limit: $('#offer-limit')?.value || null,
          }),
        });
        if (label) label.textContent = data.active ? 'Boost ON' : 'Boost OFF';
        if (result) result.textContent = data.message || (data.active ? 'Live now' : 'Turned off');
        if (data.active) $('#power-btn')?.classList.add('armed');
        else $('#power-btn')?.classList.remove('armed');
        await refreshBusiness();
        await loadDirectory();
      } catch (err) {
        e.target.checked = !e.target.checked;
        if (result) result.textContent = err.message;
      }
    });

    $('#offer-business')?.addEventListener('change', () => syncBoostToggle());

    $('#biz-offers').addEventListener('click', async (e) => {
      const endBtn = e.target.closest('[data-deactivate]');
      const pauseBtn = e.target.closest('[data-pause]');
      const resumeBtn = e.target.closest('[data-resume]');
      try {
        if (endBtn) {
          await api(`/api/offers/${endBtn.dataset.deactivate}/deactivate`, { method: 'POST', body: '{}' });
        } else if (pauseBtn) {
          await api(`/api/offers/${pauseBtn.dataset.pause}/pause`, { method: 'POST', body: '{}' });
        } else if (resumeBtn) {
          await api(`/api/offers/${resumeBtn.dataset.resume}/resume`, { method: 'POST', body: '{}' });
        } else return;
        await refreshBusiness();
        await loadDirectory();
      } catch (err) {
        alert(err.message);
      }
    });

    $$('[data-duration]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mins = Number(btn.dataset.duration);
        if ($('#offer-duration')) $('#offer-duration').value = String(mins === 120 ? 120 : 60);
      });
    });

    function offerPayload(extra = {}) {
      return {
        business_id: $('#offer-business').value,
        title: $('#offer-title').value,
        description: $('#offer-description')?.value || '',
        terms: $('#offer-terms')?.value || '',
        photo_url: $('#offer-photo')?.value || '',
        product_label: $('#offer-product').value,
        duration_minutes: Number($('#offer-duration').value) || 60,
        redemption_limit: $('#offer-limit').value || 100,
        points_reward: Number($('#offer-points')?.value) || 50,
        ...extra,
      };
    }

    $('#offer-preview-btn')?.addEventListener('click', async () => {
      const panel = $('#offer-preview');
      try {
        const data = await api('/api/offers', {
          method: 'POST',
          body: JSON.stringify(offerPayload({ preview_only: true })),
        });
        const p = data.preview;
        panel.hidden = false;
        panel.innerHTML = `
          <h4 class="label">Customer preview</h4>
          <strong>${escapeHtml(p.title)}</strong>
          <p class="meta">${escapeHtml(p.business_name)} · ${countdownHtml(p.ends_at)} · ${p.points_reward} pts/visit · limit ${p.redemption_limit}</p>
          ${p.description ? `<p>${escapeHtml(p.description)}</p>` : ''}
          ${p.terms ? `<p class="meta">Terms: ${escapeHtml(p.terms)}</p>` : ''}
          <p class="meta">${escapeHtml(p.notice)}</p>`;
      } catch (err) {
        panel.hidden = false;
        panel.innerHTML = `<p class="meta">${escapeHtml(err.message)}</p>`;
      }
    });

    $('#offer-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/offers', {
          method: 'POST',
          body: JSON.stringify(offerPayload()),
        });
        $('#power-btn')?.classList.add('armed');
        alert('Campaign live — members scan your venue QR in ON GO for qualifying visits.');
        await refreshBusiness();
        await loadDirectory();
        showView('explore');
      } catch (err) {
        alert(err.message);
      }
    });

    $('#verify-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await api('/api/redemptions/verify', {
          method: 'POST',
          body: JSON.stringify({ token: $('#verify-token').value }),
        });
        $('#verify-result').textContent = `Simulated verify. Awarded ${data.points_awarded} pts to ${data.customer.display_name} (balance ${data.customer.points_balance}). Outside live beta.`;
        $('#verify-token').value = '';
        $('#verify-next').innerHTML = (data.next_stops || [])
          .map(
            (n) =>
              `<div class="listing"><strong>Next: ${escapeHtml(n.name)}</strong><p class="meta">${escapeHtml(n.title)} · ${n.distance_mi} mi</p></div>`
          )
          .join('');
        await refreshBusiness();
      } catch (err) {
        $('#verify-result').textContent = err.message;
      }
    });

    async function showVenueQr() {
      const id = $('#venue-qr-business')?.value;
      if (!id) return alert('Select a venue');
      const data = await api(`/api/businesses/${encodeURIComponent(id)}/venue-qr`);
      const panel = $('#venue-qr-panel');
      panel.hidden = false;
      $('#venue-qr-img').src = data.qr_data_url;
      $('#venue-qr-payload').textContent = data.payload;
      const dl = $('#venue-qr-download');
      dl.href = data.qr_data_url;
      dl.download = `ongo-${(data.name || 'venue').replace(/\s+/g, '-').toLowerCase()}-qr.png`;
    }

    $('#venue-qr-btn')?.addEventListener('click', () => {
      showVenueQr().catch((err) => alert(err.message));
    });
    $('#venue-print-cling')?.addEventListener('click', () => {
      const id = $('#venue-qr-business')?.value;
      if (!id) return alert('Select a venue');
      window.open(`/api/businesses/${encodeURIComponent(id)}/print?layout=cling`, '_blank');
    });
    $('#venue-print-counter')?.addEventListener('click', () => {
      const id = $('#venue-qr-business')?.value;
      if (!id) return alert('Select a venue');
      window.open(`/api/businesses/${encodeURIComponent(id)}/print?layout=counter`, '_blank');
    });

    $('#reward-create-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const expires = $('#reward-expires')?.value;
        if (!expires) {
          alert('Listing end date is required.');
          return;
        }
        await api('/api/rewards', {
          method: 'POST',
          body: JSON.stringify({
            business_id: $('#reward-business').value,
            title: $('#reward-title').value,
            terms: $('#reward-terms').value,
            points_cost: Number($('#reward-cost').value),
            quantity: Number($('#reward-qty').value),
            expires_at: new Date(expires).toISOString(),
          }),
        });
        alert('Reward listed. You fund and fulfill. Claimed codes: 30-day window. Points ≠ cash.');
        e.target.reset();
        await refreshRewards();
      } catch (err) {
        alert(err.message);
      }
    });

    $('#reward-fulfill-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await api('/api/rewards/fulfill', {
          method: 'POST',
          body: JSON.stringify({ code: $('#reward-fulfill-code').value }),
        });
        $('#reward-fulfill-result').textContent = data.message || 'Fulfilled';
        $('#reward-fulfill-code').value = '';
      } catch (err) {
        $('#reward-fulfill-result').textContent = err.message;
      }
    });

    $('#rewards-catalog')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-claim-reward]');
      if (!btn) return;
      if (!state.user || state.user.role !== 'customer') {
        alert('Sign in as a member to redeem rewards.');
        return showView('account');
      }
      const ok = confirm(
        'Claim this reward?\n\n• Points are not cash\n• Points do not expire during beta\n• After claiming you have 30 days to redeem the code at the venue\n• Single-use code — vendor fulfills'
      );
      if (!ok) return;
      try {
        const data = await api(`/api/rewards/${btn.dataset.claimReward}/claim`, {
          method: 'POST',
          body: '{}',
        });
        alert(`${data.message}\nCode: ${data.code}\nRedeem by: ${data.redeem_by ? new Date(data.redeem_by).toLocaleString() : '30 days'}`);
        await refreshMe();
        await refreshRewards();
      } catch (err) {
        alert(err.message);
      }
    });

    $('#scan-geo-btn')?.addEventListener('click', () => {
      requestGeo({ userGesture: true });
      setTimeout(() => refreshScan(), 400);
    });

    $('#scan-submit')?.addEventListener('click', async () => {
      const result = $('#scan-result');
      if (!state.user || state.user.role !== 'customer') {
        result.textContent = 'Sign in as a member to earn visit points.';
        return showView('account');
      }
      if (!state.geo || state.geo.lat == null) {
        result.textContent = 'Location required — tap Refresh location and allow GPS.';
        return;
      }
      try {
        const data = await api('/api/visits/check-in', {
          method: 'POST',
          body: JSON.stringify({
            qr: $('#scan-payload').value,
            lat: state.geo.lat,
            lng: state.geo.lng,
            accuracy_m: state.geo.accuracy,
          }),
        });
        result.textContent = `${data.message} +${data.points_awarded} pts (balance ${data.points_balance}). ${data.distance_m}m from venue.`;
        await refreshMe();
        showView('rewards');
      } catch (err) {
        result.textContent = err.message;
      }
    });

    $('#account-settings-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = $('#settings-result');
      try {
        const body = { display_name: $('#settings-name').value };
        const pw = $('#settings-password').value;
        if (pw) {
          body.password = pw;
          body.current_password = $('#settings-current').value;
        }
        const data = await api('/api/me', { method: 'PATCH', body: JSON.stringify(body) });
        state.user = data.user;
        setSessionChip();
        out.textContent = 'Saved.';
        $('#settings-password').value = '';
        $('#settings-current').value = '';
      } catch (err) {
        out.textContent = err.message;
      }
    });

    $('#admin-adjust-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = $('#admin-adjust-result');
      try {
        const data = await api('/api/admin/points/adjust', {
          method: 'POST',
          body: JSON.stringify({
            user_id: $('#admin-user-id').value,
            delta: Number($('#admin-delta').value),
            reason: $('#admin-reason').value,
          }),
        });
        out.textContent = `Adjusted. New balance: ${data.points_balance}`;
      } catch (err) {
        out.textContent = err.message;
      }
    });

    $('#admin-content')?.addEventListener('click', async (e) => {
      const approve = e.target.closest('[data-approve-venue]');
      const suspend = e.target.closest('[data-suspend-venue]');
      try {
        if (approve) {
          await api(`/api/admin/venues/${approve.dataset.approveVenue}/approve`, {
            method: 'POST',
            body: '{}',
          });
        } else if (suspend) {
          const reason = prompt('Suspend reason?');
          if (!reason) return;
          await api(`/api/admin/venues/${suspend.dataset.suspendVenue}/suspend`, {
            method: 'POST',
            body: JSON.stringify({ reason }),
          });
        } else return;
        await refreshAccount();
      } catch (err) {
        alert(err.message);
      }
    });

    $('#bid-slot')?.addEventListener('change', () => {
      refreshAdPreview();
    });
    $('#bid-business')?.addEventListener('change', () => {
      refreshAdPreview();
    });

    $('#bid-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const dollars = Number($('#bid-amount').value) || 0;
        const data = await api('/api/ads/bids', {
          method: 'POST',
          body: JSON.stringify({
            inventory_id: $('#bid-slot').value,
            business_id: $('#bid-business').value,
            amount_cents: Math.round(dollars * 100),
          }),
        });
        $('#bid-result').textContent = `${data.notice}`;
        if (data.creative) renderAdCreative(data.creative);
        await loadDirectory();
      } catch (err) {
        $('#bid-result').textContent = err.message;
      }
    });

    let addBizLogo = { logo_url: null, logo_source: null, image_base64: null };

    const showAddBizLogo = (result) => {
      const preview = $('#add-biz-logo-preview');
      const empty = $('#add-biz-logo-empty');
      const img = $('#add-biz-logo-img');
      const meta = $('#add-biz-logo-meta');
      if (!preview) return;
      if (result?.logo_url || addBizLogo.image_base64) {
        preview.hidden = false;
        empty.hidden = true;
        img.src = addBizLogo.image_base64 || result.logo_url;
        meta.textContent = addBizLogo.image_base64
          ? 'Uploaded logo (will save with venue)'
          : `Found via ${result.logo_source || 'web'}`;
      } else {
        preview.hidden = true;
        empty.hidden = false;
      }
    };

    const lookupAddBizLogo = async () => {
      const name = $('#add-biz-name')?.value?.trim();
      const website = $('#add-biz-website')?.value?.trim();
      if (!name && !website) return;
      $('#add-biz-result').textContent = 'Searching for logo…';
      try {
        const data = await api('/api/logos/lookup', {
          method: 'POST',
          body: JSON.stringify({ name, website }),
        });
        addBizLogo = {
          logo_url: data.logo_url,
          logo_source: data.logo_source,
          image_base64: addBizLogo.image_base64,
        };
        showAddBizLogo(data);
        $('#add-biz-result').textContent =
          data.status === 'found' ? 'Logo found — save venue or replace with upload.' : data.hint || 'No logo found.';
      } catch (err) {
        $('#add-biz-result').textContent = err.message;
      }
    };

    let lookupTimer = null;
    const scheduleLogoLookup = () => {
      clearTimeout(lookupTimer);
      lookupTimer = setTimeout(lookupAddBizLogo, 500);
    };
    $('#add-biz-name')?.addEventListener('input', scheduleLogoLookup);
    $('#add-biz-website')?.addEventListener('input', scheduleLogoLookup);
    $('#add-biz-address')?.addEventListener('change', scheduleLogoLookup);
    $('#add-biz-lookup')?.addEventListener('click', lookupAddBizLogo);

    $('#add-biz-logo-file')?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
      });
      addBizLogo.image_base64 = dataUrl;
      showAddBizLogo({ logo_url: dataUrl, logo_source: 'upload' });
      e.target.value = '';
    });

    $('#add-business-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const body = {
          name: $('#add-biz-name').value.trim(),
          website: $('#add-biz-website').value.trim(),
          address: $('#add-biz-address').value.trim(),
          area: $('#add-biz-area').value,
          category: $('#add-biz-category').value,
        };
        if (addBizLogo.logo_url && !addBizLogo.image_base64) {
          body.logo_url = addBizLogo.logo_url;
          body.logo_source = addBizLogo.logo_source;
        }
        if (addBizLogo.image_base64) body.image_base64 = addBizLogo.image_base64;
        const data = await api('/api/businesses', { method: 'POST', body: JSON.stringify(body) });
        $('#add-biz-result').textContent = data.notice || 'Venue saved.';
        e.target.reset();
        addBizLogo = { logo_url: null, logo_source: null, image_base64: null };
        $('#add-biz-logo-preview').hidden = true;
        $('#add-biz-logo-empty').hidden = true;
        await refreshMe();
        await refreshBusiness();
        await loadDirectory();
      } catch (err) {
        $('#add-biz-result').textContent = err.message;
      }
    });

    $('#ad-logo-upload')?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      const businessId = $('#bid-business')?.value;
      if (!file || !businessId) return;
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read file'));
          reader.readAsDataURL(file);
        });
        await api(`/api/businesses/${encodeURIComponent(businessId)}/logo`, {
          method: 'POST',
          body: JSON.stringify({ image_base64: dataUrl }),
        });
        $('#bid-result').textContent = 'Logo uploaded — refreshing ad preview.';
        await refreshAdPreview();
      } catch (err) {
        $('#bid-result').textContent = err.message;
      } finally {
        e.target.value = '';
      }
    });

    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const data = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }),
        });
        await refreshMe();
        refreshAccount();
        await loadDirectory();
        if (data.needs_verification) {
          setAuthFlash('Signed in — verify your email to claim offers.');
          showView('account');
        } else {
          setAuthFlash('');
          showView(state.user.role === 'business' ? 'business' : 'explore');
        }
      } catch (err) {
        alert(err.message);
      }
    });

    $('#forgot-toggle')?.addEventListener('click', () => {
      $('#login-form').hidden = true;
      $('#register-form').hidden = true;
      $('#reset-form').hidden = true;
      $('#forgot-form').hidden = false;
      setAuthFlash('Enter your email and we will send a reset link.');
    });

    $('#forgot-cancel')?.addEventListener('click', () => {
      $('#forgot-form').hidden = true;
      $('#reset-form').hidden = true;
      $('#login-form').hidden = false;
      $('#register-form').hidden = false;
      setAuthFlash('');
    });

    $('#forgot-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const result = $('#forgot-result');
      try {
        const data = await api('/api/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email: fd.get('email') }),
        });
        if (data.reset_link) {
          result.textContent = `${data.message} Open reset: ${data.reset_link}`;
        } else {
          result.textContent = data.message || 'Check your email for a reset link.';
        }
      } catch (err) {
        result.textContent = err.message;
      }
    });

    $('#reset-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const result = $('#reset-result');
      try {
        const data = await api('/api/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({
            token: fd.get('token') || $('#reset-token').value,
            password: fd.get('password'),
          }),
        });
        state.user = data.user;
        setSessionChip();
        refreshAccount();
        $('#reset-form').hidden = true;
        $('#forgot-form').hidden = true;
        $('#login-form').hidden = false;
        $('#register-form').hidden = false;
        setAuthFlash(data.message || 'Password updated — you are signed in.');
        showView('account');
      } catch (err) {
        result.textContent = err.message;
      }
    });

    $('#resend-verify-btn')?.addEventListener('click', async () => {
      try {
        const data = await api('/api/auth/resend-verification', {
          method: 'POST',
          body: JSON.stringify({ email: state.user?.email }),
        });
        if (data.verify_link) {
          setAuthFlash(`${data.message} Open: ${data.verify_link}`);
        } else {
          setAuthFlash(data.message || 'Verification email sent.');
        }
      } catch (err) {
        setAuthFlash(err.message);
      }
    });

    const syncClaimListing = () => {
      $('#claim-business-wrap').hidden = $('#register-role').value !== 'business';
    };
    syncClaimListing();
    $('#register-role').addEventListener('change', syncClaimListing);

    $('#register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const role = fd.get('role');
      const body = {
        display_name: fd.get('display_name'),
        email: fd.get('email'),
        password: fd.get('password'),
        role,
      };
      if (role === 'business') body.business_id = fd.get('business_id');
      try {
        const data = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
        await refreshMe();
        refreshAccount();
        await loadMetaAndClaimOptions();
        await loadDirectory();
        if (data.verify_link) {
          setAuthFlash(`${data.message || 'Registered.'} Verify: ${data.verify_link}`);
          showView('account');
        } else if (data.user && !data.user.email_verified) {
          setAuthFlash(data.message || 'Check your email to verify your account.');
          showView('account');
        } else {
          setAuthFlash('');
          showView(role === 'business' ? 'business' : 'explore');
        }
      } catch (err) {
        alert(err.message);
      }
    });

    $('#logout-btn').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
      state.user = null;
      state.businessesOwned = [];
      setSessionChip();
      refreshAccount();
      setAuthFlash('');
      await loadDirectory();
    });
  }

  function routeFromHash() {
    const m = location.hash.match(/^#\/b\/([^/?#]+)/);
    if (m) {
      openVenue(decodeURIComponent(m[1]), { pushHash: false });
      return true;
    }
    return false;
  }

  function consumeScanQuery() {
    const params = new URLSearchParams(location.search);
    const scan = params.get('scan');
    if (!scan) return;
    const input = $('#scan-payload');
    if (input) input.value = scan.startsWith('ongo:') ? scan : `ongo:venue:${scan}`;
    params.delete('scan');
    const next = `${location.pathname}${params.toString() ? '?' + params : ''}${location.hash}`;
    history.replaceState({}, '', next);
    showView('scan');
  }

  async function boot() {
    runLaunchSplash();
    bindEvents();
    initMap();
    bootstrapGeo();
    window.addEventListener('hashchange', () => {
      if (location.hash.startsWith('#/b/')) {
        routeFromHash();
      } else if (!$('#view-venue').hidden) {
        showView('explore');
      }
    });
    setInterval(() => {
      $$('[data-ends]').forEach((el) => {
        el.textContent = minutesLeft(el.dataset.ends);
      });
    }, 30000);
    try {
      await refreshMe();
      await handleAuthQueryParams();
      await loadMetaAndClaimOptions();
      await loadDirectory();
      routeFromHash();
      consumeScanQuery();
    } catch (err) {
      $('#listing-count').textContent = `Could not load directory: ${err.message}`;
      $('#live-hud-text').textContent = 'Directory offline';
    }
  }

  boot();
})();
