// NABD AI single-page app: boot, auth gate, shell (sidebar/top bar), hash router, live notifications.
import { h, icon, clear } from './lib/dom.js';
import { t, setLang, getLang } from './lib/i18n.js';
import { api, get, patch, post, state } from './lib/api.js';
import * as ws from './lib/ws.js';
import { toast, showError, errorBox, skeletons, can, statusDot, confirmBox, btn } from './lib/ui.js';
import { browserNotify, beep, isMuted, setMuted } from './lib/notify.js';

const NAV = [
  ['Operations', [['/', 'Dashboard', 'home'], ['/feed', 'Live Feed', 'activity'], ['/accounts', 'Telegram Accounts', 'users'], ['/sources', 'Sources', 'layers']]],
  ['Intelligence', [['/radar', 'Smart Radar', 'radar'], ['/keywords', 'Keywords', 'tag'], ['/rules', 'Rules', 'sliders'], ['/automations', 'Automation', 'zap'], ['/ai', 'AI Settings', 'cpu', 'operator']]],
  ['Insights', [['/search', 'Search', 'search'], ['/saved', 'Saved', 'bookmark'], ['/analytics', 'Analytics', 'chart'], ['/reports', 'Reports', 'file'], ['/alerts', 'Alerts', 'bell'], ['/blocks', 'Blocks', 'ban']]],
  ['Administration', [['/tasks', 'Tasks', 'list'], ['/system', 'System', 'server'], ['/logs', 'Logs', 'terminal', 'operator'], ['/settings', 'Settings', 'settings']]],
];
const PAGES = {
  '/': () => import('./pages/dashboard.js'), '/feed': () => import('./pages/feed.js'), '/accounts': () => import('./pages/accounts.js'), '/sources': () => import('./pages/sources.js'),
  '/radar': () => import('./pages/radar.js'), '/keywords': () => import('./pages/keywords.js'), '/rules': () => import('./pages/rules.js'), '/automations': () => import('./pages/automations.js'),
  '/ai': () => import('./pages/ai.js'), '/search': () => import('./pages/search.js'), '/saved': () => import('./pages/saved.js'), '/analytics': () => import('./pages/analytics.js'),
  '/reports': () => import('./pages/reports.js'), '/alerts': () => import('./pages/alerts.js'), '/blocks': () => import('./pages/blocks.js'), '/tasks': () => import('./pages/tasks.js'),
  '/system': () => import('./pages/system.js'), '/logs': () => import('./pages/logs.js'), '/settings': () => import('./pages/settings.js'), '/setup': () => import('./pages/setup.js'),
};
const root = document.getElementById('app');
let shell = null; let leaves = []; let unread = 0; let statusCache = null; let systemPaused = false; let pauseTimer = null; const unsubs = [];

export function applyPrefs({ lang, theme }) {
  if (lang) { setLang(lang); localStorage.setItem('nabd.lang', lang); }
  if (theme) { document.documentElement.dataset.theme = theme; localStorage.setItem('nabd.theme', theme); document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'light' ? '#f2f5f8' : '#0a0f15'); }
}
applyPrefs({ lang: localStorage.getItem('nabd.lang') || 'ar', theme: localStorage.getItem('nabd.theme') || 'dark' });
export const go = (path) => { location.hash = `#${path}`; };
export const route = () => { const raw = location.hash.slice(1) || '/'; const [path, q] = raw.split('?'); return { path, query: Object.fromEntries(new URLSearchParams(q ?? '')) }; };

async function boot() {
  state.onUnauth = () => { shell = null; showLogin(t('Session expired. Please sign in again.')); };
  try {
    const st = await get('/setup/status');
    if (st.needs_admin) return showSetup();
    const me = await get('/auth/me'); return start(me);
  } catch (e) {
    if (e.status === 401) return showLogin();
    clear(root).append(h('div', { class: 'login' }, h('div', { class: 'card' }, errorBox(e, boot))));
  }
}
async function showLogin(msg) {
  ws.disconnect(); clear(root); const m = await import('./pages/login.js');
  m.renderLogin(root, { message: msg, onLoggedIn: async (r) => { applyPrefs({ lang: r.user.language, theme: r.user.theme }); start({ user: r.user, csrf: r.csrf, setup_complete: true }); } });
}
async function showSetup() { clear(root); const m = await import('./pages/setup.js'); m.renderWizard(root, { fresh: true, onDone: () => boot() }); }

async function refreshPause() {
  try { systemPaused = !!(await get('/system/pause')).paused; paintPause(); } catch { /* status is best effort */ }
}
async function togglePause() {
  if (!systemPaused && !(await confirmBox(t('Pausing will stop Telegram connections, workers and scheduled tasks until resumed.'), { danger: true, ok: t('Pause system') }))) return;
  try {
    const r = await post('/system/pause', { paused: !systemPaused });
    systemPaused = !!r.paused; paintPause(); toast(t(systemPaused ? 'System paused' : 'System resumed'), systemPaused ? 'warn' : 'info');
    if (!systemPaused) render();
  } catch (e) { showError(e); }
}
function paintPause() {
  const b = document.getElementById('system-pause-btn');
  if (b) { clear(b).append(icon(systemPaused ? 'play' : 'pause'), h('span', { class: 'hidem' }, t(systemPaused ? 'Resume system' : 'Pause system'))); b.title = t(systemPaused ? 'Resume system' : 'Pause system'); }
  const overlay = document.getElementById('system-paused-overlay');
  if (overlay) { overlay.classList.toggle('hide', !systemPaused); clear(overlay.querySelector('.pause-copy')).append(h('h2', null, t('System paused')), h('p', null, t('All Telegram connections, workers and scheduled tasks are stopped.'))); }
}
async function start(me) {
  state.csrf = me.csrf; state.user = me.user; applyPrefs({ lang: me.user.language, theme: me.user.theme });
  await refreshPause(); buildShell(); ws.connect(); wireLive(); refreshUnread(); window.onhashchange = render; render();
  clearInterval(pauseTimer); pauseTimer = setInterval(refreshPause, 10000);
  if (!me.setup_complete && me.user.role === 'admin' && route().path !== '/setup') toast(t('Setup is not finished yet.'), 'warn', 9000, h('button', { class: 'btn sm', onClick: () => go('/setup') }, t('Continue setup')));
}
async function refreshUnread() { try { unread = (await get('/alerts', { limit: 1 })).meta.unread; paintBell(); } catch { /* ignore */ } }
function paintBell() { const b = document.getElementById('bell-count'); if (b) { b.textContent = unread > 99 ? '99+' : unread; b.classList.toggle('hide', !unread); } }

function wireLive() {
  unsubs.splice(0).forEach((u) => u());
  unsubs.push(ws.on('match.new', (m) => { if (m.ui?.browser) browserNotify(m.card); if (m.ui?.sound) beep(m.card.priority); }));
  // toasts only for critical / system alerts: match alerts are already visible as cards and in the bell counter
  unsubs.push(ws.on('alert.new', (m) => { unread++; paintBell(); if (m.alert.severity === 'critical' || (m.alert.kind !== 'match' && m.alert.severity === 'high')) toast(`${m.alert.title}`, 'warn', 6000); }));
  unsubs.push(ws.on('system.status', (m) => { if (m.status) { statusCache = m.status; paintStatus(); } }));
  unsubs.push(ws.on('ws:open', paintLive)); unsubs.push(ws.on('ws:close', paintLive));
}
function paintLive() { const el = document.getElementById('live-chip'); if (!el) return; clear(el).append(h('span', { class: `dot ${ws.live.open ? 'online' : 'warning'}` }), h('span', { class: 'hidem' }, ws.live.open ? t('Live') : t('Reconnecting…'))); }
function paintStatus() {
  const el = document.getElementById('status-chip'); if (!el || !statusCache) return;
  const keys = ['database', 'redis', 'workers', 'telegram', 'ai']; const worst = keys.map((k) => statusCache[k]?.status).reduce((a, s) => (['error', 'offline'].includes(s) ? 'error' : s === 'warning' && a !== 'error' ? 'warning' : a), 'online');
  clear(el).append(h('span', { class: `dot ${worst === 'error' ? 'error' : worst}` }), h('span', { class: 'hidem' }, t('System')));
  el.title = keys.map((k) => `${t(({ database: 'Database', redis: 'Redis', workers: 'Workers', telegram: 'Telegram', ai: 'AI Provider' })[k])}: ${statusCache[k]?.status} ${statusCache[k]?.detail ?? ''}`).join('\n');
}

function buildShell() {
  const side = h('aside', { class: 'side', id: 'side' }, h('div', { class: 'brand' }, icon('pulse'), h('div', null, 'NABD AI', h('small', null, 'TELEGRAM · AI · MONITORING'))),
    NAV.map(([g, items]) => [h('div', { class: 'navgrp' }, t(g)), items.filter(([, , , role]) => !role || can(role)).map(([p, label, ic]) => h('a', { class: 'nav', href: `#${p}`, 'data-path': p, onClick: closeSide }, icon(ic), t(label), p === '/alerts' && h('span', { class: 'pill hide', id: 'nav-alerts' })))]));
  const scrim = h('div', { class: 'scrim', id: 'scrim', onClick: closeSide });
  const q = h('input', { type: 'search', placeholder: t('Search in messages, users, intents…'), 'aria-label': t('Search'), onKeydown: (e) => { if (e.key === 'Enter' && q.value.trim()) { go(`/search?q=${encodeURIComponent(q.value.trim())}`); q.value = ''; } } });
  const muteBtn = h('button', { class: 'btn icon ghost', title: t(isMuted() ? 'Unmute alerts' : 'Mute alerts'), onClick: () => { setMuted(!isMuted()); muteBtn.replaceChildren(icon(isMuted() ? 'bellOff' : 'bell')); muteBtn.title = t(isMuted() ? 'Unmute alerts' : 'Mute alerts'); } }, icon(isMuted() ? 'bellOff' : 'bell'));
  const top = h('header', { class: 'top' },
    h('button', { class: 'btn icon ghost burger', 'aria-label': 'Menu', onClick: () => { side.classList.add('open'); scrim.classList.add('open'); } }, icon('menu')),
    h('div', { class: 'search' }, icon('search'), q), h('div', { class: 'end row tight' },
      h('a', { class: 'livechip', id: 'status-chip', href: '#/' }, h('span', { class: 'dot' })), h('span', { class: 'livechip', id: 'live-chip' }),
      muteBtn, can('admin') && h('button', { class: 'btn ghost', id: 'system-pause-btn', onClick: togglePause }, icon('pause'), h('span', { class: 'hidem' }, t('Pause system'))), h('a', { class: 'btn icon ghost', href: '#/alerts', title: t('Alerts'), style: { position: 'relative' } }, icon('bell'), h('span', { class: 'pill hide', id: 'bell-count', style: { position: 'absolute', insetBlockStart: '-4px', insetInlineEnd: '-4px' } })),
      h('button', { class: 'btn icon ghost', title: 'العربية / English', onClick: async () => { const l = getLang() === 'ar' ? 'en' : 'ar'; applyPrefs({ lang: l }); patch('/auth/preferences', { language: l }).catch(() => {}); buildShell(); wireLive(); paintLive(); paintStatus(); paintBell(); render(); } }, icon('globe')),
      h('button', { class: 'btn icon ghost', title: t('Theme'), onClick: () => { const th = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; applyPrefs({ theme: th }); patch('/auth/preferences', { theme: th }).catch(() => {}); render(); } }, icon('sun')),
      h('button', { class: 'btn ghost', title: t('Profile'), onClick: () => go('/settings?tab=profile') }, icon('user'), h('span', { class: 'hidem' }, state.user.display_name || state.user.username)),
      h('button', { class: 'btn icon ghost', title: t('Sign out'), onClick: async () => { try { await post('/auth/logout'); } catch { /* ignore */ } location.hash = ''; location.reload(); } }, icon('logout'))));
  const main = h('div', { class: 'main' }, top, h('main', { class: 'page', id: 'page' }));
  const overlay = h('div', { class: 'system-paused-overlay hide', id: 'system-paused-overlay' }, h('div', { class: 'pause-copy' }), can('admin') && btn(t('Resume system'), togglePause, { kind: 'primary', ic: 'play' }));
  clear(root).append(h('div', { class: 'app' }, side, main), scrim, overlay);
  shell = { page: main.querySelector('#page') };
  paintPause();
}
function closeSide() { document.getElementById('side')?.classList.remove('open'); document.getElementById('scrim')?.classList.remove('open'); }

async function render() {
  if (!shell) return;
  const { path, query } = route(); const loader = PAGES[path];
  leaves.splice(0).forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  document.querySelectorAll('.nav').forEach((a) => a.classList.toggle('on', a.dataset.path === path));
  const label = NAV.flatMap(([, i]) => i).find(([p]) => p === path)?.[1]; document.title = `${label ? t(label) : 'NABD AI'} · NABD AI`;
  const page = shell.page; clear(page).append(skeletons(3));
  if (!loader) return clear(page).append(h('div', { class: 'empty' }, t('Page not found')));
  const token = Symbol(); render.token = token;
  try {
    const mod = await loader(); if (render.token !== token) return;
    const ctx = { root: page, query, user: state.user, go, onLeave: (fn) => leaves.push(fn), reload: render, status: () => statusCache };
    clear(page); await mod.default(ctx);
  } catch (e) { if (render.token === token) { clear(page).append(errorBox(e, render)); } }
}
paintLive;
boot();
