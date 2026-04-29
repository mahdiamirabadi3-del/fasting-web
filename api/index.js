export const config = { runtime: "edge" };

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
]);

export default async function handler(req) {
  if (!TARGET_BASE) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  // ✅ وقتی client قطع شه، connection به VPS هم kill میشه → کاهش CPU/RAM
  const ac = new AbortController();
  req.signal?.addEventListener("abort", () => ac.abort(), { once: true });

  try {
    const url = new URL(req.url);
    const targetUrl = TARGET_BASE + url.pathname + url.search;

    // ✅ قبل از loop با O(1) بگیر، نه داخل loop با O(n)
    const clientIp =
      req.headers.get("x-real-ip") ||
      req.headers.get("x-forwarded-for") ||
      null;

    const out = new Headers();
    for (const [k, v] of req.headers) {
      if (
        STRIP_HEADERS.has(k) ||
        k === "x-real-ip" ||
        k === "x-forwarded-for" ||
        k.startsWith("x-vercel-")
      ) continue;
      out.set(k, v);
    }
    if (clientIp) out.set("x-forwarded-for", clientIp);

    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const upstream = await fetch(targetUrl, {
      method,
      headers: out,
      body: hasBody ? req.body : undefined,
      duplex: "half",
      redirect: "manual",
      signal: ac.signal, // ✅ abort propagation
    });

    // ✅ صریحاً body رو stream کن — از buffer شدن توی Vercel جلوگیری میکنه
    // ✅ این باعث میشه ترافیک از Fast Data Transfer رد بشه نه Fast Origin Transfer
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });

  } catch (err) {
    if (err.name === "AbortError") {
      return new Response(null, { status: 499 }); // Client Closed Request
    }
    console.error("relay error:", err);
    return new Response("Bad Gateway", { status: 502 });
  }
}
