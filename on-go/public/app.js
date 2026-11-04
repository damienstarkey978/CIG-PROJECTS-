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

  function setSessionChip() {
    const chip = $('#session-chip');
    if (!state.user) {
      chip.textContent = 'Not signed in';
      return;
    }
    chip.textContent = `${state.user.display_name} · ${state.user.role} · ${state.user.points_balance} pts`;
  }

  function showView(name) {
    $$('.view').forEach((el) => {
      el.hidden = el.id !== `view-${name}`;
    });
    $$('.sw').forEach((btn) => {
      const on = btn.dataset.view === name;
      btn.classList.toggle('active', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    if (name === 'explore' && state.map) setTimeout(() => state.map.invalidateSize(), 80);
    if (name === 'rewards') refreshRewards();
    if (name === 'business') refreshBusiness();
    if (name === 'account') refreshAccount();
  }

  function initMap() {
    if (!window.L) {
      $('#map').textContent = 'Map unavailable. Browse listings below.';
      return;
    }
    state.map = L.map('map', { scrollWheelZoom: false, zoomControl: false }).setView([30.287, -81.397], 11);
    L.control.zoom({ position: 'topright' }).addTo(state.map);
    // Free OSM tiles + CSS night filter (no third-party map API keys)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18,
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

  function updateMarkers(businesses) {
    if (!state.map) return;
    state.markers.forEach((m) => state.map.removeLayer(m));
    state.markers = businesses.map((b) => {
      const live = Boolean(b.live_offer);
      const marker = L.circleMarker([b.lat, b.lng], {
        radius: live ? 10 : 6,
        color: live ? '#1aff5a' : '#5a7a64',
        weight: 2,
        fillColor: live ? '#1aff5a' : '#162019',
        fillOpacity: live ? 0.95 : 0.85,
      }).addTo(state.map);
      const offerLine = live
        ? `<br><strong style="color:#1aff5a">LIVE:</strong> ${escapeHtml(b.live_offer.title)}`
        : '<br><em>Directory</em>';
      marker.bindPopup(
        `<strong>${escapeHtml(b.name)}</strong><br>${escapeHtml(b.area)} · ${escapeHtml(b.category)}${offerLine}`
      );
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
      root.innerHTML = '';
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
            <button type="button" class="btn primary" data-claim="${o.id}" ${state.user?.role === 'customer' ? '' : 'disabled'}>Claim QR</button>
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
                <button type="button" class="btn primary" data-claim="${live.id}" ${state.user?.role === 'customer' ? '' : 'disabled'}>Claim QR</button>
                <button type="button" class="btn ghost" data-next="${b.id}">Next Stop</button>
              </div>
            </div>`
          : `<div class="listing-actions">
              <button type="button" class="btn ghost" data-fav="${b.id}" data-on="${b.is_favorite ? '1' : '0'}">${favLabel}</button>
            </div>`;
        return `<article class="listing" data-id="${b.id}">
          <h3>${escapeHtml(b.name)}</h3>
          <p class="meta">${escapeHtml(b.area)} · ${escapeHtml(b.category)}</p>
          ${b.address ? `<p class="meta">${escapeHtml(b.address)}</p>` : ''}
          ${dist}
          ${badges}
          ${note}
          ${offer}
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

  async function refreshRewards() {
    if (!state.user) {
      $('#loyalty-history').innerHTML =
        '<p class="meta">Sign in as a customer. Demo: customer@ongo.demo / demo1234</p>';
      $('#favorites-list').innerHTML = '';
      $('#active-claim').hidden = true;
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
        : '<p class="meta">No verified redemptions yet.</p>';

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

      if (state.user.role === 'customer') {
        const claims = await api('/api/customer/claims');
        const open = (claims.claims || []).find((c) => c.status === 'claimed');
        if (open) {
          $('#active-claim').hidden = false;
          $('#active-claim').innerHTML = `
            <h3 class="label">Open claim</h3>
            <p><strong>${escapeHtml(open.offer_title)}</strong> at ${escapeHtml(open.business_name)}</p>
            <p class="mono">ongo:${escapeHtml(open.token)}</p>`;
        } else {
          $('#active-claim').hidden = true;
        }
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

    try {
      const offers = await api('/api/business/offers');
      $('#biz-offers').innerHTML = offers.offers.length
        ? offers.offers
            .map((o) => {
              const active = o.status === 'live' || o.status === 'scheduled';
              return `<div class="listing">
                <strong>${escapeHtml(o.title)}</strong>
                <p class="meta">${escapeHtml(o.business_name)} · ${escapeHtml(o.status)} · ${minutesLeft(o.ends_at)} · ${o.redemption_count}${o.redemption_limit != null ? '/' + o.redemption_limit : ''} redeemed</p>
                ${active ? `<button type="button" class="btn ghost" data-deactivate="${o.id}">Deactivate</button>` : ''}
              </div>`;
            })
            .join('')
        : '<p class="meta">No offers yet — tap the power switch.</p>';

      const analytics = await api('/api/business/analytics');
      $('#biz-analytics').innerHTML = analytics.analytics
        .map(
          (a) => `<div class="listing">
            <strong>${escapeHtml(a.name)}</strong>
            <p class="meta">${a.claims} claims · ${a.redeemed} redeemed · ${a.conversion_pct}% · ${a.live_offers} live</p>
          </div>`
        )
        .join('') || '<p class="meta">No venues yet.</p>';

      const subs = await api('/api/subscriptions');
      $('#biz-plans').innerHTML = `
        ${(subs.subscriptions || [])
          .map(
            (s) =>
              `<div class="listing"><strong>${escapeHtml(s.business_name)}</strong><p class="meta">Current: ${escapeHtml(s.plan)} (${escapeHtml(s.status)})</p></div>`
          )
          .join('')}
        ${(subs.plans || [])
          .map(
            (p) =>
              `<div class="listing"><strong>${escapeHtml(p.label)}</strong><p class="meta">$${(p.price_monthly_cents / 100).toFixed(0)}/mo · ${escapeHtml((p.perks || []).join(' · '))}</p></div>`
          )
          .join('')}
        <p class="meta">${escapeHtml(subs.notice || '')}</p>`;

      const ads = await api('/api/ads/inventory');
      $('#bid-slot').innerHTML = ads.inventory
        .map(
          (s) =>
            `<option value="${s.id}">${escapeHtml(s.slot_label)} · min $${(s.min_bid_cents / 100).toFixed(0)}</option>`
        )
        .join('');
    } catch (err) {
      $('#biz-offers').innerHTML = `<p class="meta">${escapeHtml(err.message)}</p>`;
    }
  }

  function refreshAccount() {
    const signed = $('#account-signed-in');
    const forms = $('#account-forms');
    if (state.user) {
      signed.hidden = false;
      forms.hidden = true;
      $('#account-summary').textContent = `${state.user.display_name} (${state.user.email}) — ${state.user.role}`;
    } else {
      signed.hidden = true;
      forms.hidden = false;
    }
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
      if (claim) return claimOffer(claim.dataset.claim);
      const next = e.target.closest('[data-next]');
      if (next) return loadNextStop(next.dataset.next).catch((err) => alert(err.message));
      const fav = e.target.closest('[data-fav]');
      if (fav) return toggleFavorite(fav.dataset.fav, fav.dataset.on === '1').catch((err) => alert(err.message));
    };
    $('#business-list').addEventListener('click', claimHandler);
    $('#signal-ticker').addEventListener('click', claimHandler);

    $('#biz-offers').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-deactivate]');
      if (!btn) return;
      try {
        await api(`/api/offers/${btn.dataset.deactivate}/deactivate`, { method: 'POST', body: '{}' });
        await refreshBusiness();
        await loadDirectory();
      } catch (err) {
        alert(err.message);
      }
    });

    $('#offer-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/offers', {
          method: 'POST',
          body: JSON.stringify({
            business_id: $('#offer-business').value,
            title: $('#offer-title').value,
            product_label: $('#offer-product').value,
            duration_minutes: Number($('#offer-duration').value) || 60,
            redemption_limit: $('#offer-limit').value || null,
          }),
        });
        $('#power-btn')?.classList.add('armed');
        alert('Signal ON — visible on Explore until it expires.');
        await refreshBusiness();
        await loadDirectory();
        showView('explore');
      } catch (err) {
        alert(err.message);
      }
    });

    $('#verify-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await api('/api/redemptions/verify', {
          method: 'POST',
          body: JSON.stringify({ token: $('#verify-token').value }),
        });
        $('#verify-result').textContent = `Verified. Awarded ${data.points_awarded} pts to ${data.customer.display_name} (balance ${data.customer.points_balance}).`;
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
        await loadDirectory();
      } catch (err) {
        $('#bid-result').textContent = err.message;
      }
    });

    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }),
        });
        await refreshMe();
        refreshAccount();
        await loadDirectory();
        showView(state.user.role === 'business' ? 'business' : 'explore');
      } catch (err) {
        alert(err.message);
      }
    });

    $('#register-role').addEventListener('change', (e) => {
      $('#claim-business-wrap').hidden = e.target.value !== 'business';
    });

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
        await api('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
        await refreshMe();
        refreshAccount();
        await loadMetaAndClaimOptions();
        await loadDirectory();
        showView(role === 'business' ? 'business' : 'explore');
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
      await loadDirectory();
    });
  }

  async function boot() {
    bindEvents();
    initMap();
    bootstrapGeo();
    try {
      await refreshMe();
      await loadMetaAndClaimOptions();
      await loadDirectory();
    } catch (err) {
      $('#listing-count').textContent = `Could not load directory: ${err.message}`;
      $('#live-hud-text').textContent = 'Directory offline';
    }
  }

  boot();
})();
