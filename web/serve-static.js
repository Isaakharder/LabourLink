// Serves the Vite build output in production. Reads PORT directly from
// process.env rather than relying on shell variable expansion in the start
// command, which behaves inconsistently across platforms/shells.
import { createServer, request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { URL } from "url";
import handler from "serve-handler";

const port = process.env.PORT || 4173;

// Runtime-only (not VITE_-prefixed, so it's invisible to the browser bundle)
// pointer to the API Railway service. When set, /api/* requests are proxied
// server-side instead of being served as static files, so the browser only
// ever talks to this same origin — see web/src/lib/api.ts's resolveApiUrl()
// for why: the API lives on a different *.up.railway.app subdomain, which is
// cross-site (up.railway.app is on the public suffix list), and Safari's
// cross-site cookie blocking (ITP) silently refuses to store the session
// cookie in that case. Proxying keeps the browser's view same-origin, so the
// cookie set by POST /api/auth/login is never cross-site to begin with.
const apiTarget = process.env.API_URL;

function proxyApi(request, response) {
  const target = new URL(request.url, apiTarget);
  const doRequest = target.protocol === "https:" ? httpsRequest : httpRequest;
  const proxyReq = doRequest(
    target,
    { method: request.method, headers: { ...request.headers, host: target.host } },
    (proxyRes) => {
      response.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(response);
    }
  );
  proxyReq.on("error", (err) => {
    console.error("[proxy] API request failed:", err.message);
    if (!response.headersSent) {
      response.writeHead(502, { "Content-Type": "application/json" });
    }
    response.end(JSON.stringify({ error: "API unreachable" }));
  });
  request.pipe(proxyReq);
}

const server = createServer((request, response) => {
  if (apiTarget && request.url.startsWith("/api/")) {
    return proxyApi(request, response);
  }
  handler(request, response, {
    public: "dist",
    rewrites: [{ source: "**", destination: "/index.html" }],
    // Without explicit Cache-Control, serve-handler sends none at all (no
    // ETag/Last-Modified either — etag defaults to false), leaving every
    // browser's own heuristic caching to decide how long to hold onto a
    // response. iOS Safari's standalone "Add to Home Screen" PWA mode in
    // particular can hang onto that heuristic cache far longer than a
    // normal tab reload would re-check it, which is what actually causes
    // "a new deploy doesn't show up until you delete and reinstall the
    // PWA": index.html was never explicitly marked stale, so nothing ever
    // forced a re-fetch of it. index.html/sw.js/manifest.json must always
    // be revalidated (index.html is what points at the current build's
    // hashed asset filenames — swapping to no-cache instead of leaving it
    // ambiguous is what actually plugs the gap here); the hashed asset
    // files under /assets/ are safe to cache forever since Vite gives a
    // build with any changed content a new filename (see the dist/assets
    // output in build:android's own log), never reusing an old one.
    headers: [
      {
        source: "index.html",
        headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }],
      },
      {
        source: "sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }],
      },
      {
        source: "manifest.json",
        headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }],
      },
      {
        source: "assets/**",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ],
  });
});

server.listen(port, () => {
  console.log(`LabourLink web listening on port ${port}`);
});
