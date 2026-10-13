/**
 * Cloudflare Worker for ThinQ Washer
 * Acts as a secure CORS proxy and API gateway for the LG ThinQ Connect API,
 * and serves static assets if configured.
 */

const LG_HOSTS = Object.freeze({
  aic: 'https://api-aic.lgthinq.com',
  eic: 'https://api-eic.lgthinq.com',
  kic: 'https://api-kic.lgthinq.com',
});

const ALLOWED_TARGET_HOSTS = new Set([
  'api-aic.lgthinq.com',
  'api-eic.lgthinq.com',
  'api-kic.lgthinq.com',
]);

const ALLOWED_HEADERS = new Set([
  'authorization',
  'x-country',
  'x-client-id',
  'x-message-id',
  'x-api-key',
  'x-service-phase',
  'content-type',
  'accept',
  'accept-language',
  'user-agent',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Accept, x-country, x-client-id, x-message-id, x-api-key, x-service-phase, x-target-url, x-lg-region',
  'Access-Control-Max-Age': '86400',
};

function handleOptions(request) {
  const reqHeaders = request.headers.get('Access-Control-Request-Headers');
  const headers = {
    ...CORS_HEADERS,
    ...(reqHeaders ? { 'Access-Control-Allow-Headers': reqHeaders } : {}),
  };
  return new Response(null, {
    status: 204,
    headers,
  });
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function resolveFromPath(pathname, search) {
  const regionMatch = pathname.match(/^(?:\/api)?\/(aic|eic|kic)(\/.*)?$/i);
  if (regionMatch) {
    const region = regionMatch[1].toLowerCase();
    const subpath = regionMatch[2] || '/';
    return `${LG_HOSTS[region]}${subpath}${search}`;
  }
  return null;
}

function resolveFromQuery(url) {
  if (url.pathname !== '/proxy' && url.pathname !== '/api/proxy') return null;
  const targetParam = url.searchParams.get('url');
  if (!targetParam) return null;
  try {
    const parsed = new URL(targetParam);
    return ALLOWED_TARGET_HOSTS.has(parsed.hostname) ? targetParam : null;
  } catch {
    return null;
  }
}

function resolveFromHeaders(request, pathname, search) {
  const targetHeader = request.headers.get('x-target-url');
  if (targetHeader) {
    try {
      const parsed = new URL(targetHeader);
      if (ALLOWED_TARGET_HOSTS.has(parsed.hostname)) {
        return targetHeader;
      }
    } catch {
      return null;
    }
  }

  const regionHeader = request.headers.get('x-lg-region');
  if (regionHeader && LG_HOSTS[regionHeader.toLowerCase()]) {
    const region = regionHeader.toLowerCase();
    return `${LG_HOSTS[region]}${pathname}${search}`;
  }

  return null;
}

/**
 * Resolve target URL from the incoming request.
 * Supported patterns:
 * 1. /:region/* (e.g. /aic/devices, /eic/devices/123/state)
 * 2. /api/:region/* (e.g. /api/aic/devices)
 * 3. /proxy?url=<encoded_url>
 * 4. Header x-target-url or x-lg-region
 */
function resolveTargetUrl(request, url) {
  return (
    resolveFromPath(url.pathname, url.search) ||
    resolveFromQuery(url) ||
    resolveFromHeaders(request, url.pathname, url.search)
  );
}

/**
 * Proxy request to LG ThinQ API with full CORS support.
 */
async function proxyRequest(request, targetUrl) {
  const method = request.method.toUpperCase();

  // Pick headers to forward to LG API
  const forwardHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (ALLOWED_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  }

  // Read request body if present
  let body;
  if (!['GET', 'HEAD'].includes(method)) {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > 0) {
      body = buffer;
    }
  }

  let response;
  try {
    response = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body,
      redirect: 'follow',
    });
  } catch (err) {
    return jsonResponse(
      {
        error: {
          code: 'PROXY_NETWORK_ERROR',
          message: `Worker failed to reach LG ThinQ API: ${err.message}`,
        },
      },
      502
    );
  }

  // Clone headers and add CORS
  const responseHeaders = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    responseHeaders.set(k, v);
  }
  responseHeaders.set('Access-Control-Expose-Headers', '*');

  // Strip hop-by-hop headers
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');
  responseHeaders.delete('transfer-encoding');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    }

    // Health check endpoint
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      return jsonResponse({
        status: 'ok',
        service: 'thinq-washer-proxy',
        regions: Object.keys(LG_HOSTS),
        timestamp: new Date().toISOString(),
      });
    }

    // Try resolving as an LG API proxy request
    const targetUrl = resolveTargetUrl(request, url);
    if (targetUrl) {
      return proxyRequest(request, targetUrl);
    }

    // If static assets binding is available, serve static asset
    if (typeof env?.ASSETS?.fetch === 'function') {
      try {
        const assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status !== 404) {
          return assetResponse;
        }
      } catch {
        // Fall through
      }
    }

    // Root info page if accessed directly in a browser
    if (url.pathname === '/') {
      return new Response(
        `<!doctype html>
<html>
<head><meta charset="utf-8"><title>ThinQ Washer Proxy</title></head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:40px auto;padding:0 20px;line-height:1.5">
  <h2>ThinQ Washer Cloudflare Worker</h2>
  <p>The backend proxy is operational.</p>
  <ul>
    <li>Americas: <code>/aic/*</code> &rarr; <code>https://api-aic.lgthinq.com/*</code></li>
    <li>Europe / ME / Africa: <code>/eic/*</code> &rarr; <code>https://api-eic.lgthinq.com/*</code></li>
    <li>Asia / Pacific: <code>/kic/*</code> &rarr; <code>https://api-kic.lgthinq.com/*</code></li>
    <li>Health check: <a href="/health">/health</a></li>
  </ul>
</body>
</html>`,
        {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            ...CORS_HEADERS,
          },
        }
      );
    }

    return jsonResponse(
      {
        error: {
          code: 'NOT_FOUND',
          message: `Endpoint ${url.pathname} not recognized. Available routes: /aic/*, /eic/*, /kic/*, /health`,
        },
      },
      404
    );
  },
};
