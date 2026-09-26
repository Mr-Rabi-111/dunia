import fs from 'node:fs';
import path from 'node:path';

/**
 * Text moderation for chat messages and usernames.
 *
 *  - Contact-sharing protection: URLs, e-mail addresses, phone numbers and
 *    @handles are masked. Moving a stranger to another app is the #1 vector for
 *    scams, sextortion and grooming on random-chat platforms, so this is on by
 *    default (BLOCK_CONTACT_SHARING=false turns it off).
 *  - Blocked words: operator-maintained list in data/blocked-words.txt, matched
 *    as whole words, case-insensitively, in any script.
 *  - Usernames: Unicode letters/marks/digits (so "राहुल", "Анна", "明" work),
 *    2–20 chars, no reserved staff-like names, no phone-number-like names.
 */

const MASK = '•••';

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(?:com|net|org|io|me|co|app|link|ly|gg|tv|xyz|ru|in|info|biz|site|online|live|club|top|vip|cc)\b(?:\/\S*)?/giu;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu;
// 7–15 digits, allowing spaces, dots, dashes, parentheses and a leading +;
// starts and ends on a digit so surrounding spaces are kept.
const PHONE_RE = /(?:\+|\b)\d(?:[\s().-]{0,2}\d){6,14}\b/gu;
const HANDLE_RE = /(^|[\s(])@[\p{L}\p{N}_.]{3,30}/gu;

const RESERVED = ['admin', 'administrator', 'moderator', 'mod', 'support', 'staff', 'official', 'dunia', 'system', 'root'];

let blockedWords = [];
let blockedRe = null;

export function loadBlockedWords(dataDir) {
  const file = path.join(dataDir, 'blocked-words.txt');
  try {
    const words = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith('#'));
    setBlockedWords(words);
  } catch {
    setBlockedWords([]);
  }
  return blockedWords.length;
}

export function setBlockedWords(words) {
  blockedWords = [...new Set(words.map((w) => w.toLowerCase()))];
  if (!blockedWords.length) {
    blockedRe = null;
    return;
  }
  const escaped = blockedWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Unicode-aware "whole word": not preceded/followed by a letter or number.
  blockedRe = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

function stripControl(s) {
  // Remove control chars and bidi overrides (used to disguise text), keep newlines out.
  return s.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ');
}

/**
 * @returns {{ text: string, filtered: boolean }}
 */
export function cleanChat(input, { blockContacts = true, maxLen = 500 } = {}) {
  if (typeof input !== 'string') return { text: '', filtered: false };
  let text = stripControl(input.normalize('NFC')).replace(/\s+/g, ' ').trim().slice(0, maxLen);
  const before = text;
  if (blockContacts) {
    // Order matters: e-mails before URLs, or "name@gmail.com" would leave "name@" behind.
    text = text
      .replace(EMAIL_RE, MASK)
      .replace(URL_RE, MASK)
      .replace(HANDLE_RE, (m, lead) => `${lead}${MASK}`)
      .replace(PHONE_RE, MASK);
  }
  if (blockedRe) text = text.replace(blockedRe, MASK);
  return { text, filtered: text !== before };
}

/**
 * @returns {{ ok: true, name: string } | { ok: false, error: 'name_invalid'|'name_blocked' }}
 */
export function validateUsername(input) {
  if (typeof input !== 'string') return { ok: false, error: 'name_invalid' };
  const name = stripControl(input.normalize('NFKC')).replace(/\s+/g, ' ').trim();
  if (!/^[\p{L}\p{M}\p{N}_. -]{2,20}$/u.test(name)) return { ok: false, error: 'name_invalid' };
  if (!/[\p{L}]/u.test(name)) return { ok: false, error: 'name_invalid' };
  if ((name.match(/\p{N}/gu) || []).length >= 6) return { ok: false, error: 'name_blocked' };
  const lower = name.toLowerCase();
  const compact = lower.replace(/[\s_.-]/g, '');
  // Exact match for short words ("mod" must not block "Modi"); prefix match
  // with a small suffix for longer ones ("admin123", "support_team").
  if (RESERVED.some((r) => compact === r || (r.length >= 5 && compact.startsWith(r) && compact.length <= r.length + 4))) {
    return { ok: false, error: 'name_blocked' };
  }
  if (blockedRe) {
    blockedRe.lastIndex = 0;
    if (blockedRe.test(lower) || blockedWords.some((w) => w.length >= 4 && compact.includes(w))) {
      return { ok: false, error: 'name_blocked' };
    }
  }
  return { ok: true, name };
}
