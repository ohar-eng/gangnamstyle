// poll.js - 24/7 PR-comment + link watcher for GitHub Actions.
//
// Runs on GitHub's own runners (public repo = free, unlimited minutes).
// Polls a GitHub repo's PR comments every POLL_SECONDS - the target repo
// lives in the WATCH_REPO secret and is never named in code, logs, or
// state. Pushes to ntfy the moment a comment lands. A fresh (<55 min)
// single-use pairing link triggers an URGENT push carrying the full link;
// tapping the notification opens it directly (ntfy "Click" header).
//
// Chain mode (CHAIN=true): watch for RUN_MINUTES (~5.5h), then exit - the
// workflow dispatches the next run, giving seamless 24/7 coverage. The
// daily cron in the workflow is a safety net that restarts the chain.
//
// state.json is committed back to the repo so alerts never duplicate across
// runs/restarts. Link tokens are stored only as SHA-256 hashes, so the
// public state file reveals nothing.

const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const REPO = process.env.WATCH_REPO;
const TOPIC = process.env.NTFY_TOPIC;
const CHAIN = process.env.CHAIN === 'true';
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 0);
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);
const TEST_PUSH = process.env.TEST_PUSH === 'true';

if (!REPO) {
  console.error('WATCH_REPO secret missing - refusing to run with nothing to watch.');
  process.exit(1);
}

const API = `https://api.github.com/repos/${REPO}/issues/comments?sort=created&direction=desc&per_page=20`;
const FRESH_MS = 55 * 60 * 1000;      // pairing links are short-TTL - only scream on fresh ones
const RECENT_MS = 6 * 60 * 60 * 1000; // comment pushes only for recent comments
const HEARTBEAT_MS = 12 * 60 * 60 * 1000;
// generic single-use pairing-link pattern; the watched host is never named here
const LINK_RE = /https:\/\/\d+\.\d+\.\d+\.\d+:\d+\/pair#token=[A-Z0-9]+/g;

function log(m) { console.log(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' ' + m); }
const tokHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 32);

// ---------- state ----------
let state = { seen: [], alerted: [], lastHeartbeat: 0 };
let baseline = false;
try {
  state = { ...state, ...JSON.parse(fs.readFileSync('state.json', 'utf8')) };
} catch (e) {
  baseline = true; // no state file yet: mark everything known, alert only fresh links
}
const seen = new Set(state.seen);
const alerted = new Set(state.alerted);
let dirty = false;

function saveState() {
  if (!dirty) return;
  state.seen = [...seen].slice(-200);
  state.alerted = [...alerted].slice(-50);
  fs.writeFileSync('state.json', JSON.stringify(state));
}

// Commit state back to the repo (idempotent add/commit/push). Runs every
// ~10 min in chain mode so a cancelled run loses at most 10 min of state.
function gitPersist() {
  try {
    if (!fs.existsSync('state.json')) return;
    execSync('git add state.json', { stdio: 'ignore' });
    try { execSync('git commit -q -m "state update"', { stdio: 'ignore' }); } catch (e) {} // no-op if unchanged
    try {
      execSync('git push -q', { stdio: 'ignore' });
      dirty = false;
      log('state committed');
    } catch (e) {
      try {
        execSync('git pull -q --rebase', { stdio: 'ignore' });
        execSync('git push -q', { stdio: 'ignore' });
        dirty = false;
        log('state committed');
      } catch (e2) { log('state push deferred: ' + String(e2.message).split('\n')[0]); }
    }
  } catch (e) {
    log('state commit deferred: ' + String(e.message).split('\n')[0]);
  }
}

// ---------- ntfy ----------
async function ntfy({ title, body, priority, tags, click }) {
  if (!TOPIC) { log('NTFY_TOPIC not set - push skipped: ' + title); return false; }
  const headers = { Title: title, Priority: priority, Tags: tags };
  if (click) headers.Click = click;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://ntfy.sh/${TOPIC}`, { method: 'POST', headers, body });
      if (res.ok) return true;
      log(`ntfy HTTP ${res.status}`);
    } catch (e) { log('ntfy failed: ' + e.message); }
    await new Promise(r => setTimeout(r, 10_000));
  }
  return false;
}

// ---------- poll ----------
async function poll() {
  const headers = { 'User-Agent': 'status-checks', Accept: 'application/vnd.github+json' };
  if (process.env.GH_TOKEN) headers.Authorization = 'Bearer ' + process.env.GH_TOKEN;

  const res = await fetch(API, { headers });
  if (res.status === 403 || res.status === 429) {
    log('rate limited - waiting 60s');
    await new Promise(r => setTimeout(r, 60_000));
    return;
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const comments = await res.json();
  if (!Array.isArray(comments) || !comments.length) return;

  for (const c of comments.slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const age = Date.now() - Date.parse(c.created_at);
    const body = c.body || '';
    const links = body.match(LINK_RE) || [];
    let fired = false;

    for (const link of links) {
      const h = tokHash(link.split('token=')[1]);
      if (alerted.has(h)) continue;
      alerted.add(h);
      dirty = true;
      if (age < FRESH_MS) {
        const minsLeft = Math.max(1, Math.round((FRESH_MS - age) / 60000));
        log('*** fresh pairing link detected - urgent push sent');
        await ntfy({
          title: `FRESH PAIR LINK - GO NOW (~${minsLeft} min left)`,
          body: link,
          priority: 'urgent',
          tags: 'rotating_light',
          click: link,
        });
        fired = true;
      } else {
        log(`pair link seen, already expired (${Math.round(age / 60000)} min old)`);
      }
    }

    if (!seen.has(c.id)) {
      seen.add(c.id);
      dirty = true;
      if (!baseline && !fired && age < RECENT_MS) {
        const snippet = body.replace(/\s+/g, ' ').slice(0, 200);
        const deploy = /test (deployment|instance)/i.test(body);
        log('comment push sent');
        await ntfy({
          title: deploy ? 'test-deploy comment (link often follows)'
                        : `new comment by ${c.user ? c.user.login : '?'}`,
          body: snippet + '\n\n' + (c.html_url || ''),
          priority: deploy ? 'high' : 'default',
          tags: deploy ? 'rocket' : 'speech_balloon',
          click: c.html_url,
        });
      }
    }
  }

  if (!baseline && Date.now() - (state.lastHeartbeat || 0) > HEARTBEAT_MS) {
    state.lastHeartbeat = Date.now();
    dirty = true;
    log('heartbeat push');
    await ntfy({
      title: 'watcher alive',
      body: 'still watching - ' + new Date().toISOString(),
      priority: 'min',
      tags: 'white_check_mark',
    });
  }
  saveState();
}

// ---------- main ----------
async function main() {
  log(`watch started - chain=${CHAIN} run=${RUN_MINUTES}min poll=${POLL_SECONDS}s (target kept secret)`);
  if (!TOPIC) log('WARNING: NTFY_TOPIC secret missing - all pushes will be skipped!');

  if (TEST_PUSH) {
    await ntfy({
      title: 'TEST - watcher is live',
      body: 'Pushes work. A fresh pairing link will arrive here with the full link - tap it immediately.',
      priority: 'high',
      tags: 'tada',
    });
    return;
  }

  if (RUN_MINUTES === 0) { // single-poll mode (cron-driven)
    for (let i = 1; i <= 3; i++) {
      try { await poll(); break; }
      catch (e) { log(`poll attempt ${i} failed: ` + e.message); await new Promise(r => setTimeout(r, 30_000)); }
    }
    saveState();
    gitPersist();
    log('run complete');
    return;
  }

  const deadline = Date.now() + RUN_MINUTES * 60_000;
  let lastPersist = Date.now();
  for (;;) {
    try { await poll(); }
    catch (e) { log('poll failed: ' + e.message + ' - will retry'); }
    const remaining = deadline - Date.now();
    if (remaining <= 5_000) break;
    if (dirty && Date.now() - lastPersist > 10 * 60_000) { gitPersist(); lastPersist = Date.now(); }
    await new Promise(r => setTimeout(r, Math.min(POLL_SECONDS * 1000, remaining)));
  }
  saveState();
  gitPersist();
  log('run complete - workflow will chain the next run');
}

main().catch(e => { log('fatal: ' + e.message); process.exit(1); });
