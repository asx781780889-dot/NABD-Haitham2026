// Chart.js helpers themed from CSS variables; every chart is registered for cleanup when the page is left.
import { t, getLang } from './i18n.js';
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export function theme() { return { text: css('--muted'), grid: css('--line'), accent: css('--accent'), low: css('--low'), medium: css('--medium'), high: css('--high'), critical: css('--critical'), ok: css('--ok'), warn: css('--warn'), bad: css('--bad') }; }
export const PALETTE = () => { const c = theme(); return [c.accent, c.medium, c.high, c.critical, '#a78bfa', '#38bdf8', '#f472b6', '#84cc16', '#fb923c', '#22d3ee']; };
export class ChartSet {
  constructor() { this.list = []; }
  make(canvas, cfg) {
    if (!window.Chart) { canvas.replaceWith(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Chart.js missing' })); return null; }
    const c = theme(); const Chart = window.Chart;
    Chart.defaults.locale = 'en-US'; Chart.defaults.color = c.text; Chart.defaults.font.family = getComputedStyle(document.body).fontFamily; Chart.defaults.borderColor = c.grid;
    const ch = new Chart(canvas, { ...cfg, options: { responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, plugins: { legend: { rtl: getLang() === 'ar', labels: { boxWidth: 10, usePointStyle: true } }, tooltip: { rtl: getLang() === 'ar', titleAlign: 'start', bodyAlign: 'start' }, ...(cfg.options?.plugins ?? {}) }, ...(cfg.options ?? {}) } });
    this.list.push(ch); return ch;
  }
  line(canvas, labels, series) { const c = theme(); const cols = [c.accent, c.medium, c.high, c.bad]; return this.make(canvas, { type: 'line', data: { labels, datasets: series.map((s, i) => ({ label: s.label, data: s.data, borderColor: s.color ?? cols[i % 4], backgroundColor: `${s.color ?? cols[i % 4]}22`, fill: s.fill ?? false, tension: 0.3, pointRadius: 0, borderWidth: 2 })) }, options: { scales: { y: { beginAtZero: true, grid: { color: c.grid } }, x: { grid: { display: false }, reverse: getLang() === 'ar' } }, interaction: { mode: 'index', intersect: false } } }); }
  bars(canvas, labels, data, { horizontal = false, colors, label = '' } = {}) { const c = theme(); return this.make(canvas, { type: 'bar', data: { labels, datasets: [{ label, data, backgroundColor: colors ?? c.accent, borderRadius: 5 }] }, options: { indexAxis: horizontal ? 'y' : 'x', plugins: { legend: { display: false } }, scales: { x: { grid: { display: horizontal }, beginAtZero: true, reverse: !horizontal && getLang() === 'ar' }, y: { grid: { display: !horizontal }, beginAtZero: true, position: horizontal && getLang() === 'ar' ? 'right' : 'left' } } } }); }
  doughnut(canvas, labels, data, colors) { return this.make(canvas, { type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: colors ?? PALETTE(), borderWidth: 0 }] }, options: { cutout: '64%' } }); }
  destroy() { for (const c of this.list) c.destroy(); this.list = []; }
}
export const canvas = (cls = '') => { const w = document.createElement('div'); w.className = `chartbox ${cls}`; const c = document.createElement('canvas'); w.append(c); return { box: w, canvas: c }; };
export { t };
