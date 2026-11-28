/**
 * The time of a platform administrator's last input, shared by their tabs (localStorage): input in
 * any of them keeps all of them signed in (components/AdminIdleSignOut.tsx). Written at every
 * fresh sign-in too, so a new session starts the clock and an old value cannot sign it out; a page
 * that merely restores a session (a reload, a reopened browser) reads it first and signs out at
 * once when it is too old.
 */
const STORAGE_KEY = 'pacient.admin.lastInput';

/** When the administrator last used Pacient in this browser, or 0 when nothing is stored. */
export const readLastInput = () => {
  try {
    return Number(localStorage.getItem(STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
};

export const writeLastInput = (at: number) => {
  try {
    localStorage.setItem(STORAGE_KEY, String(at));
  } catch {
    /* storage unavailable: each tab counts on its own */
  }
};
