// Tiny WHERE builder: every value is bound as a parameter (no string interpolation of user input).
export function where(...initial) {
  const w = [...initial]; const v = [];
  return {
    add(sql, val) { v.push(val); w.push(sql.split('$#').join(`$${v.length}`)); return this; },
    raw(sql) { w.push(sql); return this; },
    get sql() { return w.length ? w.join(' AND ') : 'TRUE'; },
    get v() { return v; },
  };
}
export const like = (s) => `%${String(s).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
export const asDate = (s) => { const d = new Date(String(s)); return Number.isNaN(+d) ? null : d; };
/** Arabic-insensitive substring match: nabd_norm(column) ILIKE '%' || nabd_norm(value) || '%'. Several columns are OR-ed. */
export const esc = (s) => String(s).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`);
export const nlike = (w, cols, val) => w.add(`(${[].concat(cols).map((c) => `nabd_norm(${c}) ILIKE '%' || nabd_norm($#) || '%'`).join(' OR ')})`, esc(val));
