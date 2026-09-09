// One way to call the JSON API from every page: JSON in, JSON out, and the
// CSRF token Rails expects on anything that is not a GET.
const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || "";

// Served from "/" directly, or from a sub-path behind a reverse proxy. The
// layout knows which, so no page has to work it out from its own address.
const APP_BASE = document.querySelector('meta[name="app-base"]')?.content || "/";

// A path the app serves, made absolute from wherever the app is mounted.
// Anything already absolute, an image on another host say, is left alone.
function appUrl(path) {
  return path.startsWith("/") ? APP_BASE + path.slice(1) : path;
}

async function api(url, opts = {}) {
  url = appUrl(url);
  const headers = { Accept: "application/json", ...(opts.headers || {}) };
  const method = (opts.method || "GET").toUpperCase();
  if (method !== "GET") headers["X-CSRF-Token"] = CSRF_TOKEN;
  let body = opts.body;
  if (body != null && typeof body !== "string") body = JSON.stringify(body);
  if (body != null && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { ...opts, method, headers, body, credentials: "same-origin" });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || res.statusText }; }
  if (!res.ok && data && data.error === undefined) data.error = res.statusText;
  return data;
}
