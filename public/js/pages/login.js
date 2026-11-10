import { h, icon, clear } from '../lib/dom.js';
import { t, getLang, setLang } from '../lib/i18n.js';
import { api, post } from '../lib/api.js';
import { form, showError, toast } from '../lib/ui.js';

export function renderLogin(root, { message, onLoggedIn }) {
  const f = form([{ key: 'username', label: t('Username'), placeholder: 'admin' }, { key: 'password', label: t('Password'), type: 'password' }]);
  f.ctl.username.autocomplete = 'username'; f.ctl.password.autocomplete = 'current-password';
  const err = h('div', { class: 'callout bad hide' });
  const go = async () => {
    const v = f.get(); if (!v.username || !v.password) return; err.classList.add('hide');
    try { onLoggedIn(await post('/auth/login', v)); } catch (e) { err.textContent = `${e.message}${e.errorId ? ` (${e.errorId})` : ''}`; err.classList.remove('hide'); }
  };
  f.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const toggleLang = h('button', { class: 'btn ghost sm', onClick: () => { const l = getLang() === 'ar' ? 'en' : 'ar'; setLang(l); localStorage.setItem('nabd.lang', l); renderLogin(root, { message, onLoggedIn }); } }, icon('globe'), getLang() === 'ar' ? 'English' : 'العربية');
  clear(root).append(h('div', { class: 'login' }, h('div', { class: 'card stack' }, h('div', { class: 'brand' }, icon('pulse'), 'NABD AI'), h('p', { class: 'muted', style: { textAlign: 'center', margin: 0 } }, t('Welcome back')),
    message && h('div', { class: 'callout warn' }, message), err, f.el, h('button', { class: 'btn primary', onClick: go }, t('Sign in')), h('div', { class: 'row', style: { justifyContent: 'center' } }, toggleLang))));
  f.ctl.username.focus();
}
