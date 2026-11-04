// Sav Stanfield widgets for Scriptable (https://scriptable.app)
//
// One script, two widgets: add it twice and set each widget's Parameter to
//   upcoming  — the next releases coming out in your library
//   today     — albums released on this date in past years (or this week, if none today)
// Run it once in the Scriptable app first to sign in (your email and Sav Stanfield password, kept in the iPhone Keychain).
// Running it in the app again lets you preview both widgets or sign in again.

const SITE = 'https://sav-stanfield.vercel.app';
const K = { email: 'savstanfield.email', password: 'savstanfield.password', token: 'savstanfield.token', config: 'savstanfield.config' };

const C = {
  bg: new Color('#1a1c22'), ink: new Color('#ecedea'), muted: new Color('#a0a5b3'),
  accent: new Color('#7f8cff'), today: new Color('#f5c451'), placeholder: new Color('#353946'),
};

// ——— Dates (in your phone's time zone) ———
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const short = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
function whenLabel(s) {
  const d = parse(s); const t = new Date(); t.setHours(0, 0, 0, 0);
  const days = Math.round((d - t) / 864e5);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `${DAYS[d.getDay()]} ${short(d)}`;
  return d.getFullYear() === t.getFullYear() ? short(d) : `${short(d)} ${d.getFullYear()}`;
}

// ——— Sign-in and data ———
async function dbConfig() {
  if (Keychain.contains(K.config)) return JSON.parse(Keychain.get(K.config));
  const c = await new Request(`${SITE}/api/config`).loadJSON();
  if (!c.supabaseUrl || !c.anonKey) throw new Error('The site isn’t set up for widgets yet');
  Keychain.set(K.config, JSON.stringify(c));
  return c;
}

async function askSignIn() {
  const a = new Alert();
  a.title = 'Sign in to Sav Stanfield';
  a.message = 'Your email and the password you set in Import & settings. Kept in this iPhone’s Keychain.';
  a.addTextField('Email', Keychain.contains(K.email) ? Keychain.get(K.email) : '');
  a.addSecureTextField('Password', '');
  a.addAction('Sign in'); a.addCancelAction('Cancel');
  if ((await a.present()) === -1) return false;
  Keychain.set(K.email, a.textFieldValue(0).trim());
  Keychain.set(K.password, a.textFieldValue(1));
  if (Keychain.contains(K.token)) Keychain.remove(K.token);
  await token(); // throws if wrong
  return true;
}

async function token() {
  if (Keychain.contains(K.token)) {
    const t = JSON.parse(Keychain.get(K.token));
    if (t.exp > Date.now() + 60e3) return t.access;
  }
  if (!Keychain.contains(K.email) || !Keychain.contains(K.password)) throw new Error('NOT_SIGNED_IN');
  const c = await dbConfig();
  const r = new Request(`${c.supabaseUrl}/auth/v1/token?grant_type=password`);
  r.method = 'POST';
  r.headers = { apikey: c.anonKey, 'Content-Type': 'application/json' };
  r.body = JSON.stringify({ email: Keychain.get(K.email), password: Keychain.get(K.password) });
  const j = await r.loadJSON();
  if (!j.access_token) throw new Error(r.response && r.response.statusCode === 400 ? 'WRONG_PASSWORD' : (j.msg || j.error_description || 'Sign-in failed'));
  Keychain.set(K.token, JSON.stringify({ access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }));
  return j.access_token;
}

async function releases(query) {
  const c = await dbConfig();
  const r = new Request(`${c.supabaseUrl}/rest/v1/releases?select=id,title,artist_credit,date,artwork_url,type&${query}`);
  r.headers = { apikey: c.anonKey, Authorization: `Bearer ${await token()}` };
  const j = await r.loadJSON();
  if (!Array.isArray(j)) throw new Error(j.message || 'Couldn’t read your library');
  return j;
}

async function upcoming(n) {
  return releases(`date=gte.${iso(new Date())}&order=date.asc,title.asc&limit=${n}`);
}

/** Released on this date in past years; if nothing, the rest of this week. Albums before singles; round anniversaries first. */
async function onThisDay(n) {
  const now = new Date(); const today = iso(now);
  const md = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const rank = (rows) => {
    const thisYear = now.getFullYear();
    const minor = (r) => /^(single|guest appearance|leak)$/i.test(r.type || '');
    return rows.map((r) => ({ ...r, ago: thisYear - Number(r.date.slice(0, 4)) }))
      .filter((r) => r.ago > 0)
      .sort((a, b) => Number(minor(a)) - Number(minor(b)) || Number(b.ago % 5 === 0) - Number(a.ago % 5 === 0) || b.ago - a.ago);
  };
  let rows = rank(await releases(`date=like.${encodeURIComponent(`*-${md(now)}`)}&date=lt.${today}&limit=200`));
  if (rows.length) return { rows: rows.slice(0, n), week: false };
  const days = []; for (let i = 1; i <= 6; i++) { const d = new Date(now); d.setDate(d.getDate() + i); days.push(`date.like.*-${md(d)}`); }
  rows = rank(await releases(`or=${encodeURIComponent(`(${days.join(',')})`)}&date=lt.${today}&limit=200`))
    .sort((a, b) => a.date.slice(5).localeCompare(b.date.slice(5)));
  return { rows: rows.slice(0, n), week: true };
}

// ——— Covers ———
async function cover(url) {
  if (!url) return null;
  try {
    if (url.startsWith('data:')) return Image.fromData(Data.fromBase64String(url.split(',')[1]));
    const small = url.replace(/\/\d+x\d+bb\./, '/200x200bb.').replace(/\/\d+x\d+-000000-80-0-0\./, '/250x250-000000-80-0-0.');
    return await new Request(small).loadImage();
  } catch (e) { return null; }
}
function addCover(stack, img, size) {
  if (img) { const i = stack.addImage(img); i.imageSize = new Size(size, size); i.cornerRadius = 4; return; }
  const box = stack.addStack(); box.size = new Size(size, size); box.backgroundColor = C.placeholder; box.cornerRadius = 4;
}

// ——— Widgets ———
function header(w, text, sub) {
  const h = w.addStack(); h.centerAlignContent();
  const t = h.addText(text.toUpperCase()); t.font = Font.heavySystemFont(11); t.textColor = C.accent;
  if (sub) { h.addSpacer(6); const s = h.addText(sub); s.font = Font.mediumSystemFont(11); s.textColor = C.muted; }
  w.addSpacer(8);
}

async function row(w, r, size, right, rightColor) {
  const s = w.addStack(); s.centerAlignContent(); s.url = `${SITE}/release/${r.id}`;
  addCover(s, await cover(r.artwork_url), size);
  s.addSpacer(8);
  const col = s.addStack(); col.layoutVertically();
  const t = col.addText(r.title); t.font = Font.semiboldSystemFont(13); t.textColor = C.ink; t.lineLimit = 1;
  const a = col.addText(r.artist_credit || ''); a.font = Font.systemFont(11); a.textColor = C.muted; a.lineLimit = 1;
  s.addSpacer();
  const d = s.addText(right); d.font = Font.mediumSystemFont(11); d.textColor = rightColor || C.muted; d.lineLimit = 1;
}

async function small(w, r, label, labelColor) {
  w.url = `${SITE}/release/${r.id}`;
  addCover(w, await cover(r.artwork_url), 62);
  w.addSpacer(6);
  const t = w.addText(r.title); t.font = Font.semiboldSystemFont(13); t.textColor = C.ink; t.lineLimit = 2;
  const a = w.addText(r.artist_credit || ''); a.font = Font.systemFont(11); a.textColor = C.muted; a.lineLimit = 1;
  w.addSpacer(2);
  const d = w.addText(label); d.font = Font.mediumSystemFont(11); d.textColor = labelColor || C.muted;
}

function message(w, text) {
  w.addSpacer();
  const t = w.addText(text); t.font = Font.systemFont(12); t.textColor = C.muted;
  w.addSpacer();
}

async function build(kind, family) {
  const w = new ListWidget(); w.backgroundColor = C.bg;
  w.setPadding(12, 14, 12, 14);
  const n = family === 'small' ? 1 : family === 'medium' ? 3 : 7;
  const size = family === 'large' ? 40 : 36;
  try {
    if (kind === 'today') {
      const { rows, week } = await onThisDay(n);
      header(w, week ? 'This week in' : 'On this day', week ? 'past years' : short(new Date()));
      w.url = SITE;
      if (!rows.length) message(w, 'Nothing in your library was released this week in past years.');
      else if (family === 'small') await small(w, rows[0], `${rows[0].ago} year${rows[0].ago === 1 ? '' : 's'} ago`, C.today);
      else for (const r of rows) {
        await row(w, r, size, week ? `${short(parse(r.date))} · ${r.ago}y` : `${r.ago} yr${r.ago === 1 ? '' : 's'} ago`, r.ago % 5 === 0 ? C.today : C.muted);
        w.addSpacer(6);
      }
    } else {
      const rows = await upcoming(n);
      header(w, 'Upcoming');
      w.url = `${SITE}/library?when=upcoming`;
      if (!rows.length) message(w, 'No upcoming releases in your library.');
      else if (family === 'small') await small(w, rows[0], whenLabel(rows[0].date), whenLabel(rows[0].date) === 'Today' ? C.today : C.muted);
      else for (const r of rows) {
        const lab = whenLabel(r.date);
        await row(w, r, size, lab, lab === 'Today' || lab === 'Tomorrow' ? C.today : C.muted);
        w.addSpacer(6);
      }
    }
  } catch (e) {
    header(w, kind === 'today' ? 'On this day' : 'Upcoming');
    const m = String(e && e.message || e);
    message(w, m === 'NOT_SIGNED_IN' ? 'Open this script in Scriptable to sign in.' : m === 'WRONG_PASSWORD' ? 'Password didn’t work — open the script in Scriptable to sign in again.' : `Couldn’t load: ${m}`);
  }
  w.addSpacer();
  // Upcoming changes at midnight; on-this-day changes daily too — a few hours is plenty
  w.refreshAfterDate = new Date(Date.now() + 3 * 3600e3);
  return w;
}

// ——— Run ———
const kind = /today|day|anniv/i.test(String(args.widgetParameter || '')) ? 'today' : 'upcoming';
if (config.runsInWidget) {
  Script.setWidget(await build(kind, config.widgetFamily || 'medium'));
} else {
  let signedIn = Keychain.contains(K.email) && Keychain.contains(K.password);
  if (!signedIn) {
    try { signedIn = await askSignIn(); } catch (e) { const a = new Alert(); a.title = 'Couldn’t sign in'; a.message = String(e.message === 'WRONG_PASSWORD' ? 'Wrong email or password.' : e.message); a.addAction('OK'); await a.present(); }
  }
  if (signedIn) {
    const m = new Alert(); m.title = 'Sav Stanfield widgets';
    m.addAction('Preview Upcoming'); m.addAction('Preview On this day'); m.addAction('Sign in again'); m.addCancelAction('Done');
    const i = await m.present();
    if (i === 0) (await build('upcoming', 'large')).presentLarge();
    else if (i === 1) (await build('today', 'large')).presentLarge();
    else if (i === 2) { try { await askSignIn(); } catch (e) { const a = new Alert(); a.title = 'Couldn’t sign in'; a.message = String(e.message === 'WRONG_PASSWORD' ? 'Wrong email or password.' : e.message); a.addAction('OK'); await a.present(); } }
  }
}
Script.complete();
