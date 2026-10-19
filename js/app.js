import {
  configureApi,
  getDevices,
  getDeviceStatus,
  getDeviceProfile,
  executeCommand,
  ThinQApiError,
  DEFAULT_WORKER_URL,
} from './api.js';
import * as storage from './storage.js';

const POLL_INTERVAL_MS = 60_000;
const POST_COMMAND_REFRESH_MS = 2_500;
const WASHER_TYPES = new Set(['DEVICE_WASHER', 'DEVICE_WASHTOWER_WASHER']);

// Buttons we render when the device profile lists the value as writable.
const COMMANDS = [
  { value: 'START', label: 'Start', icon: 'bi-play-fill', style: 'btn-success' },
  { value: 'PAUSE', label: 'Pause', icon: 'bi-pause-fill', style: 'btn-warning' },
  { value: 'STOP', label: 'Stop', icon: 'bi-stop-fill', style: 'btn-danger' },
];

const ACTIVE_STATES = new Set([
  'RUNNING', 'DETECTING', 'PREWASH', 'WASHING', 'RINSING', 'SPINNING', 'DRYING', 'SOAKING',
  'STEAM_SOFTENING', 'COOLING', 'REFRESHING', 'ADD_DRAIN', 'CHANGE_CONDITION', 'RINSE_HOLD',
]);
const FINISHED_STATES = new Set(['END']);
const IDLE_STATES = new Set(['POWER_OFF', 'INITIAL', 'SLEEP']);

const state = {
  settings: null,
  washers: [],
  selected: null,
  profileEntry: null,
  locationName: null,
  multiLocation: false,
  lastRunState: null,
  remoteEnabled: true,
  pollTimer: null,
  refreshing: false,
  selectionSeq: 0,
};

const $ = (id) => document.getElementById(id);
const el = {
  alertArea: $('alertArea'),
  loadingView: $('loadingView'),
  loadingText: $('loadingText'),
  emptyView: $('emptyView'),
  selectorCard: $('selectorCard'),
  deviceSelect: $('deviceSelect'),
  dashboard: $('dashboard'),
  deviceName: $('deviceName'),
  deviceModel: $('deviceModel'),
  onlineBadge: $('onlineBadge'),
  remainingHero: $('remainingHero'),
  remainingLabel: $('remainingLabel'),
  finishTime: $('finishTime'),
  runBadge: $('runBadge'),
  cycleValue: $('cycleValue'),
  remainingValue: $('remainingValue'),
  doorValue: $('doorValue'),
  tempValue: $('tempValue'),
  spinValue: $('spinValue'),
  stateValue: $('stateValue'),
  lastRefresh: $('lastRefresh'),
  refreshBtn: $('refreshBtn'),
  controls: $('controls'),
  controlsHint: $('controlsHint'),
  notifyBtn: $('notifyBtn'),
  settingsBtn: $('settingsBtn'),
  settingsModal: $('settingsModal'),
  settingsForm: $('settingsForm'),
  settingsIntro: $('settingsIntro'),
  settingsError: $('settingsError'),
  settingsSave: $('settingsSave'),
  settingsCancel: $('settingsCancel'),
  settingsClose: $('settingsClose'),
  clearSettingsBtn: $('clearSettingsBtn'),
  tokenInput: $('tokenInput'),
  toggleTokenBtn: $('toggleTokenBtn'),
  countryInput: $('countryInput'),
  regionSelect: $('regionSelect'),
  workerUrlInput: $('workerUrlInput'),
  reloadDevicesBtn: $('reloadDevicesBtn'),
  toast: $('toast'),
  toastBody: $('toastBody'),
};

const settingsModal = new bootstrap.Modal(el.settingsModal);
const toast = new bootstrap.Toast(el.toast, { delay: 4000 });

/* ---------------------------------------------------------------- helpers */

function show(node, visible = true) {
  node.classList.toggle('d-none', !visible);
}

function humanize(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = String(value).replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function setLoading(text) {
  el.loadingText.textContent = text;
  show(el.loadingView, true);
}

function hideLoading() {
  show(el.loadingView, false);
}

function showToast(message, variant = 'primary') {
  el.toast.className = `toast align-items-center border-0 text-bg-${variant}`;
  el.toastBody.textContent = message;
  toast.show();
}

function clearAlert() {
  el.alertArea.replaceChildren();
}

/** Friendly error banner with optional Retry / Settings actions. */
function showError(err, retryFn) {
  const message = err instanceof ThinQApiError ? err.message : `Unexpected error: ${err?.message || err}`;
  console.error(err);

  const alert = document.createElement('div');
  alert.className = 'alert alert-danger d-flex flex-column flex-sm-row gap-2 align-items-sm-center justify-content-between';
  alert.setAttribute('role', 'alert');

  const text = document.createElement('div');
  text.innerHTML = '<i class="bi bi-exclamation-triangle-fill me-2"></i>';
  text.append(document.createTextNode(message));
  alert.append(text);

  const actions = document.createElement('div');
  actions.className = 'd-flex gap-2 flex-shrink-0';
  if (err instanceof ThinQApiError && err.isAuthError) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-light';
    btn.textContent = 'Update token';
    btn.addEventListener('click', () => openSettings());
    actions.append(btn);
  }
  if (retryFn) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-danger';
    btn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Retry';
    btn.addEventListener('click', () => {
      clearAlert();
      retryFn();
    });
    actions.append(btn);
  }
  alert.append(actions);
  el.alertArea.replaceChildren(alert);
}

/** Returns the first primitive value whose key matches the pattern (searches nested objects). */
function findDeep(obj, pattern, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
  for (const [key, value] of Object.entries(obj)) {
    if (pattern.test(key) && (value === null || typeof value !== 'object')) return value;
  }
  for (const value of Object.values(obj)) {
    const found = findDeep(value, pattern, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Washer state/profile may be one object or an array of per-location entries. */
function pickLocationEntry(data, locationName) {
  if (!Array.isArray(data)) return data || null;
  if (!data.length) return null;
  return (
    data.find((e) => e?.location?.locationName === locationName) ||
    data.find((e) => e?.location?.locationName === 'MAIN') ||
    data[0]
  );
}

function formatRemaining(timer) {
  if (!timer) return null;
  const h = Number(timer.remainHour ?? 0);
  const m = Number(timer.remainMinute ?? 0);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return { hero: `${h}:${String(m).padStart(2, '0')}`, text: h ? `${h} h ${m} min` : `${m} min`, total: h * 60 + m };
}

function formatFinishTime(totalMinutes, now = new Date()) {
  const finish = new Date(now.getTime() + totalMinutes * 60_000);
  return `${String(finish.getHours()).padStart(2, '0')}:${String(finish.getMinutes()).padStart(2, '0')}`;
}

function classifyRunState(runState) {
  if (!runState) return { label: 'Unknown', badge: 'text-bg-secondary' };
  if (ACTIVE_STATES.has(runState)) return { label: 'Running', badge: 'text-bg-primary running-pulse' };
  if (FINISHED_STATES.has(runState)) return { label: 'Finished', badge: 'text-bg-success' };
  if (runState === 'PAUSE') return { label: 'Paused', badge: 'text-bg-warning' };
  if (runState === 'RESERVED') return { label: 'Scheduled', badge: 'text-bg-info' };
  if (runState === 'ERROR') return { label: 'Error', badge: 'text-bg-danger' };
  if (IDLE_STATES.has(runState)) return { label: 'Idle', badge: 'text-bg-secondary' };
  return { label: humanize(runState), badge: 'text-bg-secondary' };
}

/* ---------------------------------------------------------- notifications */

function updateNotifyButton() {
  if (!('Notification' in window)) {
    show(el.notifyBtn, false);
    return;
  }
  const granted = Notification.permission === 'granted';
  el.notifyBtn.classList.toggle('active', granted);
  el.notifyBtn.title = granted ? 'Notifications enabled' : 'Enable notifications';
  el.notifyBtn.querySelector('i').className = granted ? 'bi bi-bell-fill' : 'bi bi-bell';
}

async function requestNotifications() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    showToast('Notifications are enabled. Keep this tab open to be notified.', 'success');
    return;
  }
  if (Notification.permission === 'denied') {
    showToast('Notifications are blocked. Allow them in your browser site settings.', 'warning');
    return;
  }
  const result = await Notification.requestPermission();
  updateNotifyButton();
  if (result === 'granted') showToast('You will be notified when the cycle finishes.', 'success');
}

function notifyCycleFinished(deviceName) {
  showToast(`${deviceName}: cycle finished!`, 'success');
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('Washing finished', {
        body: `${deviceName} has finished its cycle.`,
        tag: 'thinq-washer-finished',
      });
    } catch {
      // Some mobile browsers only allow notifications from a service worker.
    }
  }
}

/* --------------------------------------------------------------- settings */

function openSettings({ firstRun = false } = {}) {
  const s = state.settings;
  el.tokenInput.value = s?.token || '';
  el.countryInput.value = s?.country || '';
  el.regionSelect.value = s?.region || 'auto';
  if (el.workerUrlInput) {
    el.workerUrlInput.value = s?.workerUrl ?? DEFAULT_WORKER_URL;
  }
  el.tokenInput.type = 'password';
  show(el.settingsError, false);
  show(el.settingsCancel, !firstRun);
  show(el.settingsClose, !firstRun);
  show(el.clearSettingsBtn, !firstRun);
  el.settingsIntro.textContent = firstRun
    ? 'Welcome! Enter your LG ThinQ Personal Access Token and country to get started. Settings are stored only in this browser.'
    : 'Update your connection settings. They are stored only in this browser\'s localStorage.';
  settingsModal.show();
}

function setSettingsBusy(busy) {
  el.settingsSave.disabled = busy;
  el.settingsSave.querySelector('.spinner-border').classList.toggle('d-none', !busy);
}

function settingsError(message) {
  el.settingsError.textContent = message;
  show(el.settingsError, true);
}

async function onSettingsSubmit(event) {
  event.preventDefault();
  show(el.settingsError, false);

  const token = el.tokenInput.value.trim();
  const country = el.countryInput.value.trim().toUpperCase();
  const region = el.regionSelect.value;
  const workerUrl = el.workerUrlInput ? (el.workerUrlInput.value.trim() || DEFAULT_WORKER_URL) : DEFAULT_WORKER_URL;

  if (!token) return settingsError('Please enter your Personal Access Token.');
  if (!/^[A-Za-z0-9_\-.]{20,}$/.test(token)) {
    return settingsError('The token format looks invalid. Copy the full token from the LG PAT portal (it usually starts with "thinqpat_").');
  }
  if (!/^[A-Z]{2}$/.test(country)) return settingsError('Country code must be a 2-letter ISO code, e.g. US, DE, KR.');

  setSettingsBusy(true);
  try {
    // Validate the token with a real API call before saving it.
    configureApi({ token, country, region, workerUrl, clientId: storage.getClientId() });
    const devices = await getDevices();

    storage.saveSettings({ token, country, region, workerUrl });
    state.settings = storage.loadSettings();
    settingsModal.hide();
    showToast('Connected to LG ThinQ.', 'success');
    await loadDevices(devices);
  } catch (err) {
    // Restore previous working configuration if there was one.
    if (state.settings) configureApi({ ...state.settings, clientId: storage.getClientId() });
    settingsError(err instanceof ThinQApiError ? err.message : `Validation failed: ${err.message}`);
  } finally {
    setSettingsBusy(false);
  }
}

function onClearSettings() {
  if (!confirm('Remove the saved token and settings from this browser?')) return;
  storage.clearSettings();
  stopPolling();
  state.settings = null;
  state.washers = [];
  state.selected = null;
  show(el.dashboard, false);
  show(el.selectorCard, false);
  show(el.emptyView, false);
  clearAlert();
  // Modal stays open (hide is blocked without settings); switch it to first-run mode.
  openSettings({ firstRun: true });
}

/* ---------------------------------------------------------------- devices */

async function loadDevices(prefetched) {
  clearAlert();
  stopPolling();
  show(el.emptyView, false);
  show(el.dashboard, false);
  show(el.selectorCard, false);
  setLoading('Loading devices…');

  try {
    const devices = prefetched ?? (await getDevices());
    state.washers = devices.filter((d) => WASHER_TYPES.has(d?.deviceInfo?.deviceType));
  } catch (err) {
    hideLoading();
    showError(err, () => loadDevices());
    return;
  }

  hideLoading();

  if (state.washers.length === 0) {
    show(el.emptyView, true);
    return;
  }

  if (state.washers.length === 1) {
    await selectDevice(state.washers[0].deviceId);
    return;
  }

  renderSelector();
  const stored = storage.getSelectedDeviceId();
  if (stored && state.washers.some((w) => w.deviceId === stored)) {
    el.deviceSelect.value = stored;
    await selectDevice(stored);
  }
}

function deviceLabel(device) {
  return device?.deviceInfo?.alias || device?.deviceInfo?.modelName || 'Washing machine';
}

function renderSelector() {
  const placeholder = new Option('Select a washing machine…', '', true, true);
  placeholder.disabled = true;
  const options = state.washers.map((w) => new Option(deviceLabel(w), w.deviceId));
  el.deviceSelect.replaceChildren(placeholder, ...options);
  show(el.selectorCard, true);
}

async function selectDevice(deviceId) {
  const device = state.washers.find((w) => w.deviceId === deviceId);
  if (!device) return;

  const seq = ++state.selectionSeq;
  stopPolling();
  clearAlert();
  storage.setSelectedDeviceId(deviceId);

  state.selected = device;
  state.profileEntry = null;
  state.lastRunState = null;
  state.locationName = null;
  state.multiLocation = false;

  el.deviceName.textContent = deviceLabel(device);
  el.deviceModel.textContent = device.deviceInfo?.modelName || '';
  resetDashboard();
  show(el.dashboard, true);

  await loadProfile(seq);
  if (seq !== state.selectionSeq) return;
  await refreshStatus();
  startPolling();
}

async function loadProfile(seq) {
  try {
    const profile = await getDeviceProfile(state.selected.deviceId);
    if (seq !== state.selectionSeq) return;
    state.profileEntry = pickLocationEntry(profile?.property ?? profile, state.locationName);
  } catch (err) {
    if (seq !== state.selectionSeq) return;
    state.profileEntry = null;
    showError(err, async () => {
      await loadProfile(state.selectionSeq);
      renderControls();
    });
  }
  renderControls();
}

/* ----------------------------------------------------------------- status */

async function refreshStatus() {
  if (!state.selected || state.refreshing) return;
  const seq = state.selectionSeq;
  const device = state.selected;

  state.refreshing = true;
  el.refreshBtn.disabled = true;

  try {
    const raw = await getDeviceStatus(device.deviceId);
    if (seq !== state.selectionSeq) return;

    state.multiLocation = Array.isArray(raw) && raw.length > 1;
    const entry = pickLocationEntry(raw, state.locationName);
    state.locationName = entry?.location?.locationName ?? null;

    renderStatus(entry);
    setOnline(true, entry?.runState?.currentState);
    checkForFinish(entry?.runState?.currentState, deviceLabel(device));
    clearAlert();
  } catch (err) {
    if (seq !== state.selectionSeq) return;
    if (err instanceof ThinQApiError && err.isDeviceOffline) {
      setOnline(false);
      renderControls();
    } else {
      showError(err, refreshStatus);
    }
  } finally {
    state.refreshing = false;
    el.refreshBtn.disabled = false;
    el.lastRefresh.textContent = new Date().toLocaleTimeString();
  }
}

function resetDashboard() {
  for (const node of [el.cycleValue, el.remainingValue, el.doorValue, el.tempValue, el.spinValue, el.stateValue]) {
    node.textContent = '—';
  }
  el.remainingHero.textContent = '--:--';
  el.remainingLabel.textContent = 'remaining';
  el.finishTime.textContent = '';
  el.finishTime.classList.add('d-none');
  el.runBadge.className = 'badge fs-6 mt-2 text-bg-secondary';
  el.runBadge.textContent = '—';
  el.lastRefresh.textContent = 'never';
  el.onlineBadge.className = 'badge rounded-pill text-bg-secondary';
  el.onlineBadge.textContent = 'Checking…';
  el.controls.replaceChildren();
  el.controlsHint.textContent = '';
}

function setOnline(online, runState) {
  if (!online) {
    el.onlineBadge.className = 'badge rounded-pill text-bg-danger';
    el.onlineBadge.innerHTML = '<i class="bi bi-wifi-off"></i> Offline';
    return;
  }
  const poweredOff = runState === 'POWER_OFF';
  el.onlineBadge.className = `badge rounded-pill ${poweredOff ? 'text-bg-secondary' : 'text-bg-success'}`;
  el.onlineBadge.innerHTML = `<i class="bi bi-wifi"></i> ${poweredOff ? 'Online · off' : 'Online'}`;
}

function renderStatus(entry) {
  const runState = entry?.runState?.currentState;
  const cls = classifyRunState(runState);
  const remaining = formatRemaining(entry?.timer);
  const delay = formatRemaining({
    remainHour: entry?.timer?.relativeHourToStop,
    remainMinute: entry?.timer?.relativeMinuteToStop,
  });
  const showDelayEnd = (runState === 'RESERVED' || ACTIVE_STATES.has(runState))
    && delay && Number.isFinite(delay.total) && delay.total > 0;

  el.runBadge.className = `badge fs-6 mt-2 ${cls.badge}`;
  el.runBadge.textContent = cls.label;
  el.stateValue.textContent = cls.label;

  const cycleRemaining = remaining ? remaining.hero : '--:--';
  el.remainingHero.textContent = showDelayEnd ? formatFinishTime(delay.total) : cycleRemaining;
  el.remainingLabel.textContent = showDelayEnd ? 'Delay end' : 'remaining';
  el.remainingValue.textContent = remaining && (remaining.total > 0 || ACTIVE_STATES.has(runState)) ? remaining.text : '—';
  const showFinishTime = !showDelayEnd && ACTIVE_STATES.has(runState) && remaining && Number.isFinite(remaining.total) && remaining.total > 0;
  el.finishTime.textContent = showFinishTime ? `Estimated finish: ${formatFinishTime(remaining.total)}` : '';
  el.finishTime.classList.toggle('d-none', !showFinishTime);

  // Course / cycle name is model dependent; fall back to the current phase.
  const course = findDeep(entry, /^(course|currentCourse|courseName|washCourse|cycleName)$/i);
  el.cycleValue.textContent = humanize(course ?? runState);

  const door = findDeep(entry, /door.*lock|lock.*door|^doorState$|^doorStatus$/i);
  if (typeof door === 'boolean') el.doorValue.textContent = door ? 'Locked' : 'Unlocked';
  else el.doorValue.textContent = humanize(door);

  const temp = findDeep(entry, /(water|wash).*temp|^temp(erature)?(level)?$/i);
  el.tempValue.textContent = typeof temp === 'number' ? `${temp} °` : humanize(temp);

  const spin = findDeep(entry, /spin/i);
  el.spinValue.textContent = typeof spin === 'number' ? `${spin} rpm` : humanize(spin);

  state.remoteEnabled = entry?.remoteControlEnable?.remoteControlEnabled !== false;
  renderControls();
}

function checkForFinish(runState, name) {
  const prev = state.lastRunState;
  state.lastRunState = runState ?? null;
  if (!prev || prev === runState) return;

  const wasRunning = ACTIVE_STATES.has(prev) || prev === 'PAUSE';
  const nowDone = FINISHED_STATES.has(runState) || IDLE_STATES.has(runState);
  if (wasRunning && nowDone) notifyCycleFinished(name);
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(refreshStatus, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/* --------------------------------------------------------------- controls */

/** Writable washerOperationMode values advertised by the device profile. */
function supportedOperationModes() {
  const op = state.profileEntry?.operation?.washerOperationMode;
  if (!op) return [];
  const writable = Array.isArray(op.mode) ? op.mode.includes('w') : true;
  if (!writable) return [];
  return op.value?.w ?? (Array.isArray(op.value) ? op.value : []);
}

function renderControls() {
  const supported = new Set(supportedOperationModes());
  const available = COMMANDS.filter((c) => supported.has(c.value));
  const offline = el.onlineBadge.textContent.includes('Offline');

  el.controls.replaceChildren(
    ...available.map((cmd) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${cmd.style} btn-lg`;
      btn.innerHTML = `<i class="bi ${cmd.icon}"></i> ${cmd.label}`;
      btn.disabled = !state.remoteEnabled || offline;
      btn.addEventListener('click', () => runCommand(cmd, btn));
      return btn;
    }),
  );

  if (!state.profileEntry) {
    el.controlsHint.textContent = 'Device capabilities could not be loaded yet.';
  } else if (available.length === 0) {
    el.controlsHint.textContent = 'This washing machine does not expose Start/Pause/Stop via the ThinQ Open API.';
  } else if (offline) {
    el.controlsHint.textContent = 'The washer is offline.';
  } else if (!state.remoteEnabled) {
    el.controlsHint.textContent = 'Remote control is disabled. Enable "Remote Start" on the washer to use these controls.';
  } else {
    el.controlsHint.textContent = '';
  }
}

async function runCommand(cmd, button) {
  if (!state.selected) return;
  const buttons = [...el.controls.querySelectorAll('button')];
  buttons.forEach((b) => (b.disabled = true));
  const original = button.innerHTML;
  button.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Sending…';

  const payload = { operation: { washerOperationMode: cmd.value } };
  if (state.multiLocation && state.locationName) payload.location = { locationName: state.locationName };

  try {
    await executeCommand(state.selected.deviceId, payload);
    showToast(`${cmd.label} command sent.`, 'success');
    setTimeout(refreshStatus, POST_COMMAND_REFRESH_MS);
  } catch (err) {
    showError(err, () => runCommand(cmd, button));
  } finally {
    button.innerHTML = original;
    renderControls();
  }
}

/* ------------------------------------------------------------------- init */

function bindEvents() {
  el.settingsBtn.addEventListener('click', () => openSettings({ firstRun: !state.settings }));
  el.settingsForm.addEventListener('submit', onSettingsSubmit);
  el.clearSettingsBtn.addEventListener('click', onClearSettings);
  el.toggleTokenBtn.addEventListener('click', () => {
    const hidden = el.tokenInput.type === 'password';
    el.tokenInput.type = hidden ? 'text' : 'password';
    el.toggleTokenBtn.querySelector('i').className = hidden ? 'bi bi-eye-slash' : 'bi bi-eye';
  });
  el.countryInput.addEventListener('input', () => {
    el.countryInput.value = el.countryInput.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  // Prevent dismissing the dialog until valid settings exist.
  el.settingsModal.addEventListener('hide.bs.modal', (e) => {
    if (!state.settings) e.preventDefault();
  });
  // Clear the token from the DOM once the dialog closes.
  el.settingsModal.addEventListener('hidden.bs.modal', () => {
    el.tokenInput.value = '';
  });

  el.deviceSelect.addEventListener('change', () => selectDevice(el.deviceSelect.value));
  el.refreshBtn.addEventListener('click', refreshStatus);
  el.reloadDevicesBtn.addEventListener('click', () => loadDevices());
  el.notifyBtn.addEventListener('click', requestNotifications);

  // Refresh immediately when the user returns to the tab.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.selected) void refreshStatus();
  });
}

async function init() {
  bindEvents();
  updateNotifyButton();

  state.settings = storage.loadSettings();
  if (!state.settings) {
    openSettings({ firstRun: true });
    return;
  }

  try {
    configureApi({ ...state.settings, clientId: storage.getClientId() });
  } catch (err) {
    showError(err);
    openSettings();
    return;
  }
  await loadDevices();
}

await init();
