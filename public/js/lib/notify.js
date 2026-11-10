// Browser notifications + synthesized alert sounds (WebAudio, no assets). Both honour a local mute switch.
import { t } from './i18n.js';
import { toast } from './ui.js';
const KEY = 'nabd.muted'; let ctx = null;
export const isMuted = () => localStorage.getItem(KEY) === '1';
export const setMuted = (v) => localStorage.setItem(KEY, v ? '1' : '0');
export const browserSupported = () => 'Notification' in window;
export async function enableBrowser() {
  if (!browserSupported()) return toast(t('Browser notifications are blocked'), 'warn');
  const p = await Notification.requestPermission(); toast(p === 'granted' ? t('Notifications enabled') : t('Browser notifications are blocked'), p === 'granted' ? 'info' : 'warn');
}
export function browserNotify(card) {
  if (isMuted() || !browserSupported() || Notification.permission !== 'granted') return;
  try { const n = new Notification(`${card.priority.toUpperCase()} ${Math.round(card.score)}%${card.intent ? ` — ${card.intent}` : ''}`, { body: String(card.text).slice(0, 160), tag: `nabd-${card.id}`, dir: document.documentElement.dir }); n.onclick = () => { window.focus(); location.hash = '#/feed'; n.close(); }; } catch { /* some mobile browsers need a service worker */ }
}
export function beep(priority = 'high', force = false) {
  if (isMuted() && !force) return;
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume();
    const seq = priority === 'critical' ? [880, 660, 880] : [740, 988]; let at = ctx.currentTime;
    for (const f of seq) { const o = ctx.createOscillator(); const g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.18, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16); o.connect(g).connect(ctx.destination); o.start(at); o.stop(at + 0.18); at += 0.19; }
  } catch { /* autoplay blocked until first user gesture */ }
}
