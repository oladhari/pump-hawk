/**
 * logger.js — timestamped console output, also written to bot-history.log
 */

import fs from 'fs';

const HISTORY_FILE = 'bot-history.log';

function _write(line) {
  try { fs.appendFileSync(HISTORY_FILE, line + '\n'); } catch { /* non-fatal */ }
}

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

export function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  _write(line);
}

export function log_warn(msg) {
  const line = `[${ts()}] WARN  ${msg}`;
  console.warn(line);
  _write(line);
}

export function log_error(msg) {
  const line = `[${ts()}] ERROR ${msg}`;
  console.error(line);
  _write(line);
}
