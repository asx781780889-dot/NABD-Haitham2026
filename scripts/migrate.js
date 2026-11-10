import { migrate, closeDb } from '../src/lib/db.js';
try { const a = await migrate(); console.log(a.length ? `Applied: ${a.join(', ')}` : 'Database is up to date.'); }
catch (e) { console.error('Migration failed:', e.message); process.exitCode = 1; }
finally { await closeDb(); }
