import type { Register, ThemeSetArgs } from 'claude-code'

import { makeColors } from './make-colors.js'

const { theme, problems } = makeColors({
  label: 'CIG Tech',
  only: 'dark',
  roles: { accent: '#22d3ee', danger: '#f0566a', success: '#34d399', warning: '#f5b83d', pro: '#a78bfa' },
  dark: {
    gray: {
      anchors: {
        'surface-0': '#060b16',
        'surface-1': '#0a1326',
        'surface-2': '#0e1a33',
        'surface-3': '#0a1428',
        'text-primary': '#e8f2ff',
        'text-secondary': '#bccde6',
        'text-muted': '#93a8c8',
      },
    },
  },
  codeTheme: { dark: 'tokyo-night' },
})

const LOOK: ThemeSetArgs = {
  colors: theme,
  backdrop: { scene: 'cig-circuit', glass: { blur: 2, tint: '#060b16', opacity: 0.35 } },
}

// Background traces: [path, pulse seconds, delay seconds, color]
const TRACES: [string, number, number, string][] = [
  ['M0 140 H220 L260 180 H520 L560 140 H900', 5, 0, '#22d3ee'],
  ['M0 330 H140 L190 380 H480 L520 420 H760', 6.5, 1.2, '#3b82f6'],
  ['M0 560 H300 L350 510 H640 L690 560 H1000 L1040 600 H1300', 8, 0.6, '#22d3ee'],
  ['M0 760 H180 L230 810 H600 L650 760 H980', 7, 2.4, '#6366f1'],
  ['M1600 220 H1380 L1340 260 H1150 L1110 300 H900', 6, 0.9, '#22d3ee'],
  ['M1600 470 H1420 L1380 430 H1200 L1160 470 H980', 7.5, 2, '#3b82f6'],
  ['M1600 700 H1330 L1290 740 H1100 L1060 700 H820', 9, 0.3, '#22d3ee'],
  ['M1600 850 H1250 L1210 810 H1000', 6, 3, '#6366f1'],
  ['M420 0 V120 L460 160 V300', 5.5, 1.7, '#22d3ee'],
  ['M1000 900 V780 L960 740 V620', 6.8, 0.4, '#3b82f6'],
]

const NODES: [number, number][] = [
  [900, 140], [760, 420], [1300, 600], [980, 760], [900, 300], [980, 470], [820, 700], [1000, 810], [460, 300], [960, 620],
  [520, 180], [190, 380], [350, 510], [1150, 260],
]

const traceMarkup = TRACES.map(
  ([d, dur, delay, c]) =>
    `<path d="${d}" class="t"/><path d="${d}" class="p" stroke="${c}" style="animation-duration:${dur}s;animation-delay:-${delay}s"/>`,
).join('')

const nodeMarkup = NODES.map(
  ([x, y], i) =>
    `<circle cx="${x}" cy="${y}" r="5" class="n" style="animation-delay:-${(i * 0.7).toFixed(1)}s"/>`,
).join('')

// Rising data bits
const bitMarkup = Array.from({ length: 28 }, (_, i) => {
  const x = (i * 59 + 23) % 1600
  const dur = 14 + (i % 7) * 2.5
  const delay = (i * 1.3) % dur
  const h = 6 + (i % 4) * 5
  return `<rect x="${x}" y="900" width="2" height="${h}" class="b" style="animation-duration:${dur}s;animation-delay:-${delay.toFixed(1)}s"/>`
}).join('')

const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
<style>
.t{fill:none;stroke:#1d3a66;stroke-width:2;opacity:.7}
.p{fill:none;stroke-width:3;stroke-linecap:round;stroke-dasharray:14 260;stroke-dashoffset:0;opacity:.85;animation-name:flow;animation-iteration-count:infinite;animation-timing-function:linear}
@keyframes flow{to{stroke-dashoffset:-274}}
.n{fill:#22d3ee;opacity:.6;animation:ping 4s ease-in-out infinite}
@keyframes ping{0%,100%{opacity:.25}50%{opacity:.95}}
.grid{animation:drift 14s linear infinite}
@keyframes drift{to{transform:translate(60px,60px)}}
.scan{animation:sweep 9s linear infinite}
@keyframes sweep{from{transform:translateY(-200px)}to{transform:translateY(1100px)}}
.b{fill:#22d3ee;opacity:0;animation-name:rise;animation-iteration-count:infinite;animation-timing-function:linear}
@keyframes rise{0%{transform:translateY(0);opacity:0}10%{opacity:.5}90%{opacity:.35}100%{transform:translateY(-980px);opacity:0}}
.logo{opacity:.32;animation:glow 6s ease-in-out infinite}
@keyframes glow{0%,100%{opacity:.22}50%{opacity:.4}}
.lp{fill:none;stroke:#22d3ee;stroke-width:3;stroke-linecap:round;stroke-dasharray:10 90;animation:flow 2.4s linear infinite}
.halo{animation:spin 60s linear infinite;transform-origin:1180px 135px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#050a14"/><stop offset=".55" stop-color="#08122a"/><stop offset="1" stop-color="#060d1f"/></linearGradient>
<pattern id="g" width="60" height="60" patternUnits="userSpaceOnUse"><path d="M60 0H0V60" fill="none" stroke="#12305a" stroke-width="1" opacity=".55"/></pattern>
<linearGradient id="sc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22d3ee" stop-opacity="0"/><stop offset=".5" stop-color="#22d3ee" stop-opacity=".07"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></linearGradient>
<radialGradient id="vg" cx=".5" cy=".5" r=".75"><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>
</defs>
<rect width="1600" height="900" fill="url(#bg)"/>
<g class="grid"><rect x="-120" y="-120" width="1840" height="1100" fill="url(#g)"/></g>
${traceMarkup}
${nodeMarkup}
${bitMarkup}
<rect class="scan" x="0" y="0" width="1600" height="200" fill="url(#sc)"/>
<g class="halo" opacity=".18" fill="none" stroke="#22d3ee"><circle cx="1180" cy="135" r="150" stroke-dasharray="4 14"/><circle cx="1180" cy="135" r="185" stroke-dasharray="60 30 6 30" stroke="#3b82f6"/></g>
<g class="logo" transform="translate(1010 50)">
<g fill="none" stroke="#9fb4d6" stroke-width="3">
<path d="M-95 55 H-60 L-40 38 H14"/><path d="M-85 80 H-30 L-14 66 H14"/><path d="M-100 112 H-30 L-10 100 H14" stroke="#22d3ee"/><path d="M-80 140 H-40 L-20 125 H14"/>
<path d="M200 70 H225 L240 58 H300"/><path d="M200 92 H228 L242 80 H300"/>
</g>
<g fill="#22d3ee"><circle cx="-95" cy="55" r="5"/><circle cx="-100" cy="112" r="5"/><circle cx="-80" cy="140" r="5"/><circle cx="300" cy="58" r="5"/><circle cx="300" cy="80" r="5"/></g>
<g fill="none" stroke="#2d5ca8" stroke-width="22" stroke-linejoin="round">
<path d="M105 20 H55 Q18 20 18 60 V110 Q18 150 55 150 H105"/>
<path d="M290 20 H215 Q178 20 178 60 V110 Q178 150 215 150 H290 V95 H255"/>
</g>
<rect x="128" y="9" width="20" height="152" fill="#6b7a94"/>
<g class="lp"><path d="M-100 112 H-30 L-10 100 H14" pathLength="100"/></g>
</g>
<rect width="1600" height="900" fill="url(#vg)"/>
</svg>`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const unpainted = problems.find(line => line.startsWith("Desktop won't paint"))
    if (unpainted !== undefined) {
      $.ui.toast(unpainted)
    }
    const set = await $.theme.set(LOOK)
    $.ui.toast(set.isDrawn ? 'CIG theme sent: drawn by this client' : 'CIG theme not drawn: ' + set.reason)
    $.ui.status(set.isDrawn ? 'CIG theme on' : set.reason)
    return next(e)
  })

  on('ui.render', { component: 'Backdrop' }, ($, e, next) => {
    if (e.surface !== 'desktop' && e.surface !== 'mobile') {
      return next(e)
    }
    const { Svg } = $.ui.resolve(e)
    return <Svg source={SCENE} alt="Animated circuit board with the CIG logo" isInteractive />
  })
}
