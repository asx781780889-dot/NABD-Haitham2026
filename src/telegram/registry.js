// Process-local handle to the Telegram manager (set by the telegram worker module, read by notifier/tasks).
let mgr = null;
export const setTelegramManager = (m) => { mgr = m; };
export const getTelegramManager = () => mgr;
