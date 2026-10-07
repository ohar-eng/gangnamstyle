// poll.js - 24/7 PR + PR-comment + link watcher for GitHub Actions.
//
// Runs on GitHub's own runners (public repo = free, unlimited minutes).
// Polls a GitHub repo's PRs and PR comments every POLL_SECONDS - the target
// repo lives in the WATCH_REPO secret and is never named in code, logs, or
// state. Pushes to ntfy the moment anything lands. A fresh (<55 min)
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
const PRS_API = `https://api.github.com/repos/${REPO}/pulls?sort=created&direction=desc&per_page=10`;
const FRESH_MS = 55 * 60 * 1000;      // pairing links are short-TTL - only scream on fresh ones
const RECENT_MS = 6 * 60 * 60 * 1000; // pushes only for recent items
const HEARTBEAT_MS = 12 * 60 * 60 * 1000;
// generic single-use pairing-link pattern; the watched host is never named here
const LINK_RE = /https:\/\/\d+\.\d+\.\d+\.\d+:\d+\/pair#token=[A-Z0-9]+/g;

function log(m) { console.log(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' ' + m); }
const tokHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 32);

// ---------- state ----------
let state = { seen: [], alerted: [], prs: [], lastHeartbeat: 0 };
let baseline = false;
try {
  state = { ...state, ...JSON.parse(fs.readFileSync('state.json', 'utf8')) };
} catch (e) {
  baseline = true; // no state file yet: mark everything known, alert only fresh items
}
const seen = new Set(state.seen);
const alerted = new Set(state.alerted);
const prsSeen = new Set(state.prs);
let dirty = false;

function saveState() {
  if (!dirty) return;
  state.seen = [...seen].slice(-200);
  state.alerted =
