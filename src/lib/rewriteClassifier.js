// Rewrite classifier. Given a cancellation record, the current batch's
// NBS rows, and an optional sales log, returns a rewrite tier or null.
//
// Tiers (ordered strongest → weakest):
//   STRONG     — explicit r/w/rewrite/prog-trav in sales policy# or source
//                OR sales row is from CARRIERS_IMPLICIT_REWRITE (e.g. Foremost
//                Premier / MetLife — rewrites bound there never carry the tag)
//   LIKELY     — same customer, different policy, close bind date in sales
//   NBS_ONLY   — IVANS NBS fallback (no sales confirmation)
//
// Battle-tested against the 2026-10-09 data by scripts/exportDiffV5.mjs.

export const CARRIERS_IMPLICIT_REWRITE = new Set(['Foremost Premier']);

const SALES_WINDOW_DAYS = 90;
const NBS_WINDOW_DAYS = 45;

const normPolicy = s => String(s || '').replace(/\s+/g, '').toUpperCase();

export function nameTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[,.()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length >= 2);  // drop middle initials
}

// True if token sets overlap enough. One side's tokens must be a subset
// of the other's. Handles joint-named policies and missing middle names.
export function fuzzyNameMatch(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return false;
  const [small, big] = aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  const bigSet = new Set(big);
  return small.every(t => bigSet.has(t));
}

function daysBetween(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

// Reference date for the cancel-side of the window check. PTD records
// often don't carry Change Date (cancel-effective date); fall back to
// downloadDate (when EZLynx got the message — within days of the actual
// cancel) and finally to effectiveDate.
function cxlRefDate(cxl) {
  return cxl.cancelDate || cxl.downloadDate || cxl.effectiveDate || '';
}

// Shape expected on a sales row:
//   { customer, carrier, policyNum, source, agent, bindDate }
// Internally we also tag isExplicitRewrite + tokens.
export function prepareSalesIndex(salesLog) {
  if (!Array.isArray(salesLog)) return [];
  return salesLog.map(s => ({
    ...s,
    tokens: nameTokens(s.customer),
    isExplicitRewrite: /r\/w|rewrite|prog-trav/i.test(`${s.policyNum || ''} ${s.source || ''}`),
  }));
}

// Shape expected on an NBS row: { policyNumber, carrier, insured, date }
export function prepareNbsIndex(nbsRows) {
  if (!Array.isArray(nbsRows)) return [];
  return nbsRows.map(n => ({ ...n, tokens: nameTokens(n.insured) }));
}

// Shared-token fallback. Catches first-name typos (Derek/David Exner) and
// joint-named policies ("Derek & Melanie Exner" vs "David Exner") where the
// last name is stable but subset-match fails. Returns any token (len >= 3)
// that appears on BOTH sides.
function sharedNonTrivialToken(aTokens, bTokens) {
  const bSet = new Set(bTokens);
  for (const t of aTokens) if (t.length >= 3 && bSet.has(t)) return t;
  return '';
}

const SHARED_TOKEN_WINDOW_DAYS = 30;  // strict window for the typo fallback

export function classifyRewrite(cxl, { salesIndex = [], nbsIndex = [] } = {}) {
  const cxlTokens = nameTokens(cxl.customerName);
  if (!cxlTokens.length) return null;

  // 1) STRONG via explicit r/w tag + fuzzy name
  for (const s of salesIndex) {
    if (!s.isExplicitRewrite) continue;
    if (!fuzzyNameMatch(cxlTokens, s.tokens)) continue;
    const d = daysBetween(cxlRefDate(cxl), s.bindDate);
    if (d <= SALES_WINDOW_DAYS) return mk('STRONG', s, d);
  }
  // 1b) STRONG via implicit-rewrite carrier (Foremost Premier) + fuzzy name
  for (const s of salesIndex) {
    if (!CARRIERS_IMPLICIT_REWRITE.has(s.carrier)) continue;
    if (normPolicy(s.policyNum) === normPolicy(cxl.policyNumber)) continue;
    if (!fuzzyNameMatch(cxlTokens, s.tokens)) continue;
    const d = daysBetween(cxlRefDate(cxl), s.bindDate);
    if (d <= SALES_WINDOW_DAYS) return mk('STRONG', s, d);
  }
  // 1c) STRONG via policy-number exact match (catches CSR-typo'd rewrite
  // entries where the OLD policy number was mistakenly used in the sales row).
  for (const s of salesIndex) {
    if (!s.isExplicitRewrite) continue;
    if (normPolicy(s.policyNum) !== normPolicy(cxl.policyNumber)) continue;
    const d = daysBetween(cxlRefDate(cxl), s.bindDate);
    if (d <= SALES_WINDOW_DAYS) return mk('STRONG', s, d);
  }
  // 1d) STRONG via shared-token match + explicit rewrite tag + strict
  // window. Catches first-name typos (Derek/David Exner) and joint-named
  // policies where any single token (likely the last name) is shared.
  for (const s of salesIndex) {
    if (!s.isExplicitRewrite) continue;
    if (!sharedNonTrivialToken(cxlTokens, s.tokens)) continue;
    const d = daysBetween(cxlRefDate(cxl), s.bindDate);
    if (d <= SHARED_TOKEN_WINDOW_DAYS) return mk('STRONG', s, d);
  }
  // 2) LIKELY: any other sales match, different policy, within window
  for (const s of salesIndex) {
    if (normPolicy(s.policyNum) === normPolicy(cxl.policyNumber)) continue;
    if (!fuzzyNameMatch(cxlTokens, s.tokens)) continue;
    const d = daysBetween(cxlRefDate(cxl), s.bindDate);
    if (d <= SALES_WINDOW_DAYS) return mk('LIKELY', s, d);
  }
  // 3) NBS_ONLY: IVANS NBS fallback
  for (const n of nbsIndex) {
    if (n.policyNumber === cxl.policyNumber) continue;
    if (!fuzzyNameMatch(cxlTokens, n.tokens)) continue;
    const d = daysBetween(cxlRefDate(cxl), n.date);
    if (d <= NBS_WINDOW_DAYS) return {
      level: 'NBS_ONLY', newPolicy: n.policyNumber, newCarrier: n.carrier,
      newBindDate: n.date, deltaDays: Math.round(d), rewriteAgent: '',
    };
  }
  return null;
}

function mk(level, s, d) {
  return {
    level, newPolicy: s.policyNum, newCarrier: s.carrier,
    newBindDate: s.bindDate, deltaDays: Math.round(d), rewriteAgent: s.agent || '',
  };
}
