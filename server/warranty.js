// Special-period warranty rules and the coverage computation shared by the
// admin vehicle data and the VIN warranty-check endpoint. All dates are
// handled as plain "YYYY-MM-DD" calendar dates at UTC midnight — this is a
// warranty coverage decision, not a timestamp, so time-of-day and the
// server's local timezone should never change the answer.

function parseDateOnly(str) {
  if (!str) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str).trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  // Reject e.g. "2026-02-30" — Date normalizes it to March 2nd, which would
  // silently accept a bad date.
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return d;
}

function fmt(date) {
  if (!date) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Guard against month-length overflow (Jan 31 + 1 month should land on
  // the last day of February, not roll over into March).
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d;
}

function todayDateOnly() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// The 14 "special period" wear-and-tear parts and their coverage windows,
// each covered for `months` from the warranty start date. `km` is shown for
// reference only — this system has no odometer input, so mileage is never
// itself enforced, only surfaced as a note for the person checking coverage
// to confirm at the vehicle.
const PARTS = [
  { key: 'oil_filter', label: 'Oil filter', months: 3, km: 5000 },
  { key: 'spark_plugs', label: 'Spark plugs', months: 3, km: 5000 },
  { key: 'remote_battery', label: 'Remote handset battery', months: 3, km: 5000 },
  { key: 'wiper_blades', label: 'Wiper blades', months: 3, km: 5000 },
  { key: 'light_bulbs', label: 'Light bulbs', months: 3, km: 5000 },
  { key: 'pollen_filter', label: 'Particle/pollen filter', months: 3, km: 10000 },
  { key: 'air_filter', label: 'Air filter', months: 3, km: 10000 },
  { key: 'fuel_filter', label: 'Fuel filter', months: 6, km: 10000 },
  { key: 'clutch_disc', label: 'Clutch disc', months: 6, km: 10000 },
  { key: 'tires', label: 'Tires', months: 6, km: 10000, ataWindowDays: 180 },
  { key: 'brake_pads', label: 'Brake pads', months: 6, km: 10000 },
  { key: 'brake_disks', label: 'Brake disks', months: 6, km: 10000 },
  { key: 'wheel_balance_alignment', label: 'Wheel balance and wheel alignment', months: 6, km: 10000 },
  { key: 'battery', label: 'Battery', months: 12, km: 20000, minDaysAfterPurchase: 30, minKm: 500 },
];

// The purchase (invoice) date is what normally starts the warranty clock,
// but a dealer can't sit on a car indefinitely and keep the warranty
// dormant: if the sale happens more than a year after ATA, the warranty
// starts automatically the day after that one-year mark, regardless of when
// the car actually sold.
function computeWarrantyStart(ataDate, purchaseDate) {
  const oneYearFromAta = addMonths(ataDate, 12);
  const autoTriggered = purchaseDate.getTime() > oneYearFromAta.getTime();
  const date = autoTriggered ? addDays(oneYearFromAta, 1) : purchaseDate;
  return { date, autoTriggered, oneYearFromAta };
}

// ata / purchaseDate / asOf are "YYYY-MM-DD" strings; asOf defaults to today.
// Assumes ata and purchaseDate have already been validated by the caller.
function checkCoverage({ ata, purchaseDate, asOf }) {
  const ataDate = parseDateOnly(ata);
  const purchase = parseDateOnly(purchaseDate);
  const today = asOf ? parseDateOnly(asOf) : todayDateOnly();
  const { date: warrantyStart, autoTriggered } = computeWarrantyStart(ataDate, purchase);

  const parts = PARTS.map(p => {
    const coverageEndsAt = addMonths(warrantyStart, p.months);
    let covered = today.getTime() <= coverageEndsAt.getTime();
    // A reason is recorded for every condition that applies to this part,
    // whether it passed or failed — so the "why" column always justifies
    // the status shown, not just the not-covered ones.
    const reasons = [];
    if (covered) {
      reasons.push(`Within the ${p.months}-month special period window from the warranty start date of ${fmt(warrantyStart)}; coverage ends ${fmt(coverageEndsAt)}.`);
    } else {
      reasons.push(`Special period warranty ended ${fmt(coverageEndsAt)} (${p.months} months from the warranty start date of ${fmt(warrantyStart)}).`);
    }
    if (p.ataWindowDays) {
      const ataDeadline = addDays(ataDate, p.ataWindowDays);
      if (today.getTime() > ataDeadline.getTime()) {
        covered = false;
        reasons.push(`Also requires the claim within ${p.ataWindowDays} days of the ATA date (${fmt(ataDate)}); that window ended ${fmt(ataDeadline)}.`);
      } else {
        reasons.push(`Also within the required ${p.ataWindowDays}-day claim window from the ATA date (${fmt(ataDate)}); that window ends ${fmt(ataDeadline)}.`);
      }
    }
    if (p.minDaysAfterPurchase) {
      const earliestClaim = addDays(purchase, p.minDaysAfterPurchase);
      if (today.getTime() < earliestClaim.getTime()) {
        covered = false;
        reasons.push(`Also requires at least ${p.minDaysAfterPurchase} days since the purchase/invoice date; eligible from ${fmt(earliestClaim)}.`);
      } else {
        reasons.push(`Also meets the minimum ${p.minDaysAfterPurchase} days since the purchase/invoice date, required since ${fmt(earliestClaim)}.`);
      }
    }
    return {
      key: p.key,
      label: p.label,
      months: p.months,
      km: p.km,
      minKm: p.minKm || null,
      ataWindowDays: p.ataWindowDays || null,
      minDaysAfterPurchase: p.minDaysAfterPurchase || null,
      coverageEndsAt: fmt(coverageEndsAt),
      covered,
      reasons,
    };
  });

  return {
    warrantyStartDate: fmt(warrantyStart),
    warrantyStartAutoTriggered: autoTriggered,
    asOfDate: fmt(today),
    parts,
  };
}

module.exports = {
  PARTS,
  parseDateOnly,
  fmt,
  addDays,
  addMonths,
  todayDateOnly,
  computeWarrantyStart,
  checkCoverage,
};
