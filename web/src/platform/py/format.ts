import { PyError } from "./value";

// Python's round() and format specs used in stored evaluation text. Both round the exact binary value
// half-to-even; JS toFixed/toExponential round ties away, so they cannot be used here.

/** Exact decimal expansion of a finite double: value = digits × 10^-scale (digits without sign). */
function exact(x: number): { neg: boolean; digits: bigint; scale: number } {
  const neg = x < 0 || Object.is(x, -0);
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Math.abs(x));
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number;
  if (expBits === 0) exp = -1074;
  else { mant |= 1n << 52n; exp = expBits - 1075; }
  if (exp >= 0) return { neg, digits: mant << BigInt(exp), scale: 0 };
  return { neg, digits: mant * 5n ** BigInt(-exp), scale: -exp };
}

/** Round digits×10^-scale to `places` decimals, half-even. Returns the integer count of 10^-places units. */
function roundAt(digits: bigint, scale: number, places: number): bigint {
  if (places >= scale) return digits * 10n ** BigInt(places - scale);
  const div = 10n ** BigInt(scale - places);
  const q = digits / div, r = digits % div, twice = r * 2n;
  if (twice > div || (twice === div && q % 2n === 1n)) return q + 1n;
  return q;
}

const unitsToString = (units: bigint, places: number) => {
  const s = units.toString().padStart(places + 1, "0");
  return places ? s.slice(0, -places) + "." + s.slice(-places) : s;
};

/** round(x) for a float: an int. */
export function roundToInt(x: number): bigint {
  if (!Number.isFinite(x)) throw new PyError(Number.isNaN(x) ? "ValueError" : "OverflowError", "cannot convert float to integer");
  const e = exact(x), units = roundAt(e.digits, e.scale, 0);
  return e.neg ? -units : units;
}

/** round(x, places) for a float: a float. */
export function roundFloat(x: number, places: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const e = exact(x);
  const v = Number(unitsToString(roundAt(e.digits, e.scale, places), places));
  return e.neg ? -v : v;
}

/** format(x, ',.0f') */
export function formatThousands0f(x: number): string {
  const e = exact(x);
  const s = roundAt(e.digits, e.scale, 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (e.neg ? "-" : "") + s; // Python keeps the sign of a value that rounds to zero
}

/** format(x, 'g'): six significant digits, trailing zeros removed. */
export function formatG(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  if (x === 0) return sign + "0";
  const e = exact(x), P = 6;
  // Decimal exponent of the leading digit, then round to P significant digits.
  let lead = e.digits.toString().length - 1 - e.scale;
  let units = roundAt(e.digits, e.scale, P - 1 - lead);
  if (units.toString().length > P) { lead += 1; units = roundAt(e.digits, e.scale, P - 1 - lead); }
  const mant = units.toString();
  if (lead >= -4 && lead < P) {
    const places = P - 1 - lead;
    let s = places > 0 ? unitsToString(units, places) : (units * 10n ** BigInt(-places)).toString();
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return sign + s;
  }
  let m = mant[0] + (mant.length > 1 ? "." + mant.slice(1) : "");
  if (m.includes(".")) m = m.replace(/0+$/, "").replace(/\.$/, "");
  return sign + m + "e" + (lead < 0 ? "-" : "+") + String(Math.abs(lead)).padStart(2, "0");
}
