// One way to call the JSON API from every page: JSON in, JSON out, and the
// CSRF token Rails expects on anything that is not a GET.
const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || "";
async function api(url, opts = {}) {
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
