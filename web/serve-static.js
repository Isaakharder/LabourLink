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
  });
});

server.listen(port, () => {
  console.log(`LabourLink web listening on port ${port}`);
});
