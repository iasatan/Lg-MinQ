/**
 * LG ThinQ Connect (official Open API) client.
 * Docs: https://smartsolution.developer.lge.com/en/apiManage/thinq_connect
 */

/**
 * Single place for every LG API endpoint and constant.
 * Change values here if LG moves or renames anything.
 */
export const LG_API_CONFIG = Object.freeze({
  // Public API key published by LG for ThinQ Connect PAT clients.
  apiKey: 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3',
  servicePhase: 'OP',
  timeoutMs: 15000,

  baseUrls: Object.freeze({
    aic: 'https://api-aic.lgthinq.com', // Americas
    eic: 'https://api-eic.lgthinq.com', // Europe, Middle East, Africa
    kic: 'https://api-kic.lgthinq.com', // Asia, Pacific
  }),

  endpoints: Object.freeze({
    route: () => '/route',
    devices: () => '/devices',
    deviceProfile: (deviceId) => `/devices/${encodeURIComponent(deviceId)}/profile`,
    deviceState: (deviceId) => `/devices/${encodeURIComponent(deviceId)}/state`,
    deviceControl: (deviceId) => `/devices/${encodeURIComponent(deviceId)}/control`,
  }),

  defaultRegion: 'kic',
  regionCountries: Object.freeze({
    aic: [
      'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'EC', 'VE', 'UY', 'PY', 'BO', 'PA', 'CR',
      'GT', 'HN', 'SV', 'NI', 'DO', 'PR', 'JM', 'TT', 'BS', 'BB', 'HT', 'CU',
    ],
    eic: [
      'GB', 'IE', 'DE', 'FR', 'IT', 'ES', 'PT', 'NL', 'BE', 'LU', 'AT', 'CH', 'LI', 'DK', 'SE',
      'NO', 'FI', 'IS', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'HR', 'SI', 'RS', 'BA', 'ME',
      'MK', 'AL', 'XK', 'EE', 'LV', 'LT', 'UA', 'MD', 'BY', 'RU', 'KZ', 'UZ', 'GE', 'AM', 'AZ',
      'TR', 'CY', 'MT', 'IL', 'AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'JO', 'LB', 'IQ', 'IR', 'EG',
      'MA', 'DZ', 'TN', 'LY', 'ZA', 'NG', 'KE', 'GH', 'ET', 'TZ', 'UG', 'SN', 'CI', 'AO',
    ],
  }),
});

export class ThinQApiError extends Error {
  constructor(message, { status = 0, code = 'UNKNOWN', retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'ThinQApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }

  get isAuthError() {
    return this.status === 401 || this.code === 'INVALID_TOKEN';
  }

  get isDeviceOffline() {
    return this.code === '1222' || /not\s*connected|offline|disconnect/i.test(this.message);
  }
}

let session = null;

export function resolveRegion(country) {
  const cc = (country || '').toUpperCase();
  for (const [region, countries] of Object.entries(LG_API_CONFIG.regionCountries)) {
    if (countries.includes(cc)) return region;
  }
  return LG_API_CONFIG.defaultRegion;
}

/** Must be called before any API function. */
export function configureApi({ token, country, clientId, region = 'auto' }) {
  const resolved = region && region !== 'auto' ? region : resolveRegion(country);
  const baseUrl = LG_API_CONFIG.baseUrls[resolved];
  if (!baseUrl) throw new ThinQApiError(`Unknown API region "${resolved}".`, { code: 'CONFIG' });
  session = { token, country: country.toUpperCase(), clientId, baseUrl };
}

/** LG expects a unique 22-char base64url message id per request. */
function makeMessageId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildHeaders() {
  return {
    Authorization: `Bearer ${session.token}`,
    'x-country': session.country,
    'x-client-id': session.clientId,
    'x-message-id': makeMessageId(),
    'x-api-key': LG_API_CONFIG.apiKey,
    'x-service-phase': LG_API_CONFIG.servicePhase,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function toApiError(status, payload) {
  const lgCode = payload?.error?.code ? String(payload.error.code) : null;
  const lgMessage = payload?.error?.message;
  const suffix = lgMessage ? ` (LG: ${lgMessage}${lgCode ? `, code ${lgCode}` : ''})` : '';

  if (status === 401) {
    return new ThinQApiError(`Your Personal Access Token is invalid or has expired.${suffix}`, { status, code: 'INVALID_TOKEN' });
  }
  if (status === 403) {
    return new ThinQApiError(`Access denied. Check the token scopes and the country code.${suffix}`, { status, code: lgCode || 'FORBIDDEN' });
  }
  if (status === 404) {
    return new ThinQApiError(`The device or API endpoint was not found.${suffix}`, { status, code: lgCode || 'NOT_FOUND' });
  }
  if (status === 429) {
    return new ThinQApiError(`Too many requests. Please wait a moment and try again.${suffix}`, { status, code: lgCode || 'RATE_LIMIT', retryable: true });
  }
  if (status >= 500) {
    return new ThinQApiError(`The LG ThinQ service is having problems right now.${suffix}`, { status, code: lgCode || 'SERVER', retryable: true });
  }
  return new ThinQApiError(lgMessage || `Request failed with HTTP ${status}.`, { status, code: lgCode || 'HTTP', retryable: true });
}

/** Shared fetch wrapper: headers, timeout, error mapping and response unwrapping. */
async function request(path, { method = 'GET', body } = {}) {
  if (!session) throw new ThinQApiError('The API is not configured yet.', { code: 'CONFIG' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LG_API_CONFIG.timeoutMs);

  let res;
  try {
    res = await fetch(session.baseUrl + path, {
      method,
      headers: buildHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ThinQApiError('The LG server did not respond in time.', { code: 'TIMEOUT', retryable: true, cause: err });
    }
    throw new ThinQApiError(
      'Could not reach the LG ThinQ API. Check your internet connection (the request may also be blocked by browser CORS policy).',
      { code: 'NETWORK', retryable: true, cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) throw toApiError(res.status, payload);
  return payload?.response ?? payload;
}

/**
 * API call: GET /devices
 * Returns every device registered to the PAT owner's ThinQ account.
 * @returns {Promise<Array<{deviceId: string, deviceInfo: {deviceType: string, modelName: string, alias: string, reportable: boolean}}>>}
 */
export async function getDevices() {
  const result = await request(LG_API_CONFIG.endpoints.devices());
  return Array.isArray(result) ? result : [];
}

/**
 * API call: GET /devices/{deviceId}/state
 * Returns the live state of a device. Washers return an array (one entry per location/drum).
 */
export async function getDeviceStatus(deviceId) {
  return request(LG_API_CONFIG.endpoints.deviceState(deviceId));
}

/**
 * API call: GET /devices/{deviceId}/profile
 * Returns the device capability profile (readable/writable properties and allowed values).
 */
export async function getDeviceProfile(deviceId) {
  return request(LG_API_CONFIG.endpoints.deviceProfile(deviceId));
}

/**
 * API call: POST /devices/{deviceId}/control
 * Sends a control command, e.g. { operation: { washerOperationMode: 'START' } }.
 */
export async function executeCommand(deviceId, command) {
  return request(LG_API_CONFIG.endpoints.deviceControl(deviceId), { method: 'POST', body: command });
}
