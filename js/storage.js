/**
 * Thin wrapper around localStorage for app settings and small bits of state.
 */

const KEYS = Object.freeze({
  settings: 'thinqWasher.settings',
  clientId: 'thinqWasher.clientId',
  selectedDevice: 'thinqWasher.selectedDevice',
});

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** @returns {{token: string, country: string, region: string, workerUrl?: string} | null} */
export function loadSettings() {
  const settings = readJson(KEYS.settings);
  if (!settings?.token || !settings?.country) return null;
  return { region: 'auto', ...settings };
}

export function saveSettings({ token, country, region, workerUrl }) {
  localStorage.setItem(
    KEYS.settings,
    JSON.stringify({
      token: token.trim(),
      country: country.trim().toUpperCase(),
      region: region || 'auto',
      workerUrl: workerUrl ? workerUrl.trim() : undefined,
    }),
  );
}

export function clearSettings() {
  localStorage.removeItem(KEYS.settings);
  localStorage.removeItem(KEYS.selectedDevice);
}

/** LG requires a stable client id per installation; generate once and reuse it. */
export function getClientId() {
  let id = localStorage.getItem(KEYS.clientId);
  if (!id) {
    id = `thinq-washer-web-${crypto.randomUUID()}`;
    localStorage.setItem(KEYS.clientId, id);
  }
  return id;
}

export function getSelectedDeviceId() {
  return localStorage.getItem(KEYS.selectedDevice);
}

export function setSelectedDeviceId(deviceId) {
  if (deviceId) localStorage.setItem(KEYS.selectedDevice, deviceId);
  else localStorage.removeItem(KEYS.selectedDevice);
}
