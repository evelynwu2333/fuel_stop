const BASE = "https://api.onegov.nsw.gov.au";
const FUELS = new Set([
  "E10",
  "U91",
  "P95",
  "P98",
  "DL",
  "PDL",
  "LPG",
  "E85",
  "B20",
]);
const PRICE_TTL_S = 300;

let token = { value: null, expires: 0 };
async function getToken(env) {
  if (token.value && Date.now() < token.expires - 60_000) return token.value;
  const endpoint = `${BASE}/oauth/client_credential/accesstoken?grant_type=client_credentials`;
  // console.log(endpoint);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(`${env.NSW_API_KEY}:${env.NSW_API_SECRET}`);
  const r = await fetch(endpoint, {
    method: "GET",
    headers: {
      authorization: "Basic " + bytes.toBase64(),
    },
  });
  if (!r.ok) {
    console.error(r.status);
    throw new Error(`token request failed: ${r.status} ${await r.text()}`);
  }
  const j = await r.json();
  token = {
    value: j.access_token,
    expires: Date.now() + Number(j.expires_in) * 1000,
  };
  return token.value;
}

// Format required by the API: dd/MM/yyyy hh:mm:ss AM/PM (UTC)
function requestTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 || 12;
  return (
    `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ` +
    `${p(h12)}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${h24 >= 12 ? "PM" : "AM"}`
  );
}

async function getAllPrices(env, ctx) {
  const cache = caches.default;
  const key = new Request("https://fuel-cache.invalid/nsw/prices");
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const t = await getToken(env);
  const r = await fetch(`${BASE}/FuelPriceCheck/v1/fuel/prices`, {
    headers: {
      authorization: `Bearer ${t}`,
      apikey: env.NSW_API_KEY,
      transactionid: crypto.randomUUID(),
      requesttimestamp: requestTimestamp(),
      "content-type": "application/json; charset=utf-8",
    },
  });
  if (!r.ok)
    throw new Error(`prices request failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  ctx.waitUntil(
    cache.put(
      key,
      new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${PRICE_TTL_S}`,
        },
      }),
    ),
  );
  return data;
}

function pricesForFuel(raw, fuel) {
  const byCode = new Map();
  for (const s of raw.stations || []) byCode.set(String(s.code), s);
  const out = [];
  for (const p of raw.prices || []) {
    if (p.fueltype !== fuel) continue;
    const s = byCode.get(String(p.stationcode));
    if (!s || !s.location) continue;
    out.push({
      id: String(s.code),
      brand: s.brand,
      name: s.name,
      address: s.address,
      lat: s.location.latitude,
      lon: s.location.longitude,
      price: p.price, // cents per litre
      updated: p.lastupdated,
    });
  }
  return out;
}

export default {
  async fetch(req, env, ctx) {
    // Browsers only: keeps casual cross-site use out. Not authentication; the price data is public anyway.
    const allowed = (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const origin = req.headers.get("Origin");
    if (origin && !allowed.includes(origin))
      return new Response("forbidden", { status: 403 });
    const cors = origin
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};
    const json = (body, status = 200, extra = {}) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...cors, ...extra },
      });

    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/api/config") {
      const tok = env.MAPBOX_TOKEN || "";
      // Refuse to serve anything but a public token: this endpoint hands the value to every visitor.
      if (!tok.startsWith("pk."))
        return json({ error: "MAPBOX_TOKEN not available" }, 500);
      return json({ mapboxToken: tok }, 200, {
        "Cache-Control": "private, max-age=300",
      });
    }
    if (req.method !== "GET" || url.pathname !== "/api/prices")
      return json({ error: "not found" }, 404);
    const fuel = url.searchParams.get("fuel");
    if (!FUELS.has(fuel)) return json({ error: "bad fuel type" }, 400);
    try {
      const raw = await getAllPrices(env, ctx);
      return json(pricesForFuel(raw, fuel), 200, {
        "Cache-Control": "public, max-age=120",
      });
    } catch (e) {
      console.error(e);
      return json({ error: String(e.message || e) }, 502);
    }
  },
};
