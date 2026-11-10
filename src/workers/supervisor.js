// Supervises worker modules: independent start/stop/pause, heartbeats to the `workers` table, control commands over NOTIFY.
import crypto from 'node:crypto';
import os from 'node:os';
import { query } from '../lib/db.js';
import { CONTROL, subscribe, publish } from '../lib/bus.js';
import { getSetting, invalidateSettings } from '../lib/settings.js';
import { invalidateCompiled } from '../services/config-cache.js';
import { invalidateBlocks } from '../services/blocks.js';
import { invalidateAutomations } from '../services/automation.js';
import { invalidateAi } from '../ai/manager.js';
import { TaskRunner } from './task-runner.js';
import { logger } from '../lib/logger.js';

const log = logger('supervisor');

export class Supervisor {
  constructor(modules) {
    this.instanceId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(2).toString('hex')}`;
    this.modules = new Map(modules.map((m) => [m.name, { mod: m, status: 'stopped', startedAt: null, lastError: null }]));
    this.activeNames = null;
    this.runner = new TaskRunner({ instanceId: this.instanceId, handlers: () => this.handlers() });
  }
  handlers() {
    const h = new Map();
    for (const { mod, status } of this.modules.values()) if (status === 'running' || status === 'paused') for (const [n, fn] of Object.entries(mod.tasks ?? {})) h.set(n, fn);
    return h;
  }
  async startModule(name) {
    const e = this.modules.get(name); if (!e || e.status === 'running') return;
    try { await e.mod.start(); e.status = 'running'; e.startedAt = new Date(); e.lastError = null; log.info('module started', { name }); }
    catch (err) { e.status = 'error'; e.lastError = err.message; log.error('module failed to start', { name, err: err.message }); }
    await this.heartbeat(); await publish('worker.status', { id: name });
  }
  async stopModule(name) {
    const e = this.modules.get(name); if (!e || e.status === 'stopped') return;
    try { await e.mod.stop(); } catch (err) { log.warn('module stop error', { name, err: err.message }); }
    e.status = 'stopped'; log.info('module stopped', { name });
    await this.heartbeat(); await publish('worker.status', { id: name });
  }
  async control({ action, name }) {
    if (action === 'pause' || action === 'resume') {
      if (action === 'pause') {
        for (const n of this.activeNames ?? this.modules.keys()) await this.stopModule(n);
      } else if (!await getSetting('system.paused')) {
        for (const n of this.activeNames ?? this.modules.keys()) await this.startModule(n);
      }
      return;
    }
    const names = !name || name === 'all' ? [...this.modules.keys()] : [name];
    for (const n of names) {
      const e = this.modules.get(n); if (!e) continue;
      if (action === 'start') await this.startModule(n);
      else if (action === 'stop') await this.stopModule(n);
      else if (action === 'restart') { await this.stopModule(n); await this.startModule(n); }
      else if (action === 'pause' && e.mod.pause && e.status === 'running') { await e.mod.pause(); e.status = 'paused'; await this.heartbeat(); }
      else if (action === 'resume' && e.mod.resume && e.status === 'paused') { await e.mod.resume(); e.status = 'running'; await this.heartbeat(); }
    }
  }
  async heartbeat() {
    const rows = [...this.modules.entries()].map(([name, e]) => ({ name, e, s: e.mod.stats?.() ?? {} }));
    try {
      await query(
        `INSERT INTO workers (name, instance_id, status, pid, host, started_at, last_heartbeat, processed, failed, last_error, meta)
         SELECT v.name, $1, v.status, $2, $3, COALESCE(v.started_at, now()), now(), v.processed, v.failed, v.last_error, v.meta::jsonb
           FROM unnest($4::text[], $5::text[], $6::timestamptz[], $7::bigint[], $8::bigint[], $9::text[], $10::text[]) AS v(name, status, started_at, processed, failed, last_error, meta)
         ON CONFLICT (name, instance_id) DO UPDATE SET status = EXCLUDED.status, last_heartbeat = now(), processed = EXCLUDED.processed, failed = EXCLUDED.failed,
           last_error = EXCLUDED.last_error, meta = EXCLUDED.meta, started_at = COALESCE(EXCLUDED.started_at, workers.started_at)`,
        [this.instanceId, process.pid, os.hostname(), rows.map((r) => r.name), rows.map((r) => (r.e.status === 'error' ? 'error' : r.e.status)), rows.map((r) => r.e.startedAt),
          rows.map((r) => r.s.processed ?? 0), rows.map((r) => r.s.failed ?? 0), rows.map((r) => r.e.lastError ?? r.s.lastError ?? null), rows.map((r) => JSON.stringify(r.s.meta ?? {}))]);
    } catch (e) { log.debug('heartbeat failed', { err: e.message }); }
  }
  async start(only) {
    const names = only?.length ? only : [...this.modules.keys()];
    this.activeNames = names;
    this.sub = subscribe((m) => {
      if (m.t === 'worker') void this.control(m);
      else if (m.t === 'task') this.runner.poke();
      else if (m.t === 'account') for (const { mod, status } of this.modules.values()) if (mod.onCommand && status === 'running') void Promise.resolve(mod.onCommand(m)).catch((e) => log.warn('command failed', { err: e.message }));
      else if (m.t === 'cache') { invalidateSettings(); invalidateCompiled(); invalidateBlocks(); invalidateAutomations(); invalidateAi(); }
    }, CONTROL);
    for (const n of this.modules.keys()) if (!names.includes(n)) this.modules.get(n).status = 'stopped';
    if (!await getSetting('system.paused')) for (const n of names) await this.startModule(n);
    this.runner.start();
    const every = Math.max(2, await getSetting('workers.heartbeat_s')) * 1000;
    this.hb = setInterval(() => void this.heartbeat(), every);
    await this.heartbeat();
  }
  async stop() {
    clearInterval(this.hb); this.sub?.close();
    await this.runner.stop();
    for (const n of [...this.modules.keys()].reverse()) await this.stopModule(n);
    await query("UPDATE workers SET status = 'stopped', last_heartbeat = now() - interval '1 hour' WHERE instance_id = $1", [this.instanceId]).catch(() => {}); // graceful exit => immediately offline
  }
}
