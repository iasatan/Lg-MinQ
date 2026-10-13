# ThinQ Washer – static web app

A single-page, frontend-only web app for monitoring and controlling an LG ThinQ washing machine through the official **LG ThinQ Connect Open API**. It's plain HTML, CSS and JavaScript (ES modules) plus Bootstrap 5 from a CDN. There's no backend and no build step.

## Features

- Settings dialog on first start (Personal Access Token, country code, optional API region). Settings are saved in `localStorage` and you can change them later.
- The app checks the token against the API before saving it.
- It finds washing machines automatically. If there's only one, it selects it. If there are several, it shows a selector.
- The dashboard shows the device name, online status, current cycle, remaining time, door lock, water temperature, spin speed, run state and the last refresh time.
- Start, Pause and Stop buttons appear only when the device profile lists that command as writable.
- Status refreshes automatically every 60 seconds, and again whenever you return to the tab.
- A browser notification fires when a cycle finishes. The tab must stay open.
- Error messages are written for users. The app handles request timeouts (15 s) and offers a Retry button.

## Project structure

```
index.html        Single page + settings dialog
css/styles.css    Custom styles (light mode)
js/app.js         UI logic, application flow, notifications
js/api.js         LG API client + LG_API_CONFIG (all endpoints in one place)
js/storage.js     localStorage helpers
```

To change a base URL, endpoint path, API key or timeout, edit `LG_API_CONFIG` at the top of `js/api.js`.

## Create an LG ThinQ Personal Access Token (PAT)

1. Open <https://connect-pat.lgthinq.com> and sign in with the LG account that your washer is registered to.
2. Click **ADD NEW TOKEN**.
3. Enter a name and select the scopes you need:
   - *Permission to view all devices*
   - *Permission to view all device statuses*
   - *All device control rights* (needed for Start/Pause/Stop)
4. Click **CREATE TOKEN** and copy the token. It starts with `thinqpat_`.
5. Open the app and paste the token. Then enter your **2-letter ISO country code** (for example `US`, `DE`, `GB`, `KR`). It should match your ThinQ account country.
6. Leave **API region** set to *Auto* unless requests fail. The regions are:
   - `aic` – Americas
   - `eic` – Europe, Middle East, Africa
   - `kic` – Asia / Pacific

To run remote commands, turn on **Remote Start** on the washer itself. LG requires this for safety.

## Run locally

Browsers load ES modules only over HTTP, not from `file://`. Use any static server:

```bash
npx serve .
# or
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Deploy to GitHub Pages

1. Create a GitHub repository and push these files to the repository root:
   ```bash
   git init
   git add .
   git commit -m "ThinQ washer web app"
   git branch -M main
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```
2. On GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*. Choose the `main` branch and the `/ (root)` folder, then click **Save**.
4. After a minute or two, the app is available at `https://<user>.github.io/<repo>/`.

All paths are relative, so the app also works from a sub-path. No build step or configuration is needed.

## CORS note

The app calls `https://api-*.lgthinq.com` directly from the browser. If LG doesn't send CORS headers for your origin, the browser blocks the requests. The app then shows a "could not reach the LG ThinQ API" error.

If that happens, the only fix is a small CORS proxy that you control, such as a Cloudflare Worker. Point the `baseUrls` in `LG_API_CONFIG` at the proxy. Don't use public third-party CORS proxies, because your token would pass through them.

## Device capability notes

- Commands come from the device profile (`operation.washerOperationMode`, values with mode `w`). Many LG washers expose only `START`, `STOP`, `POWER_OFF` and `WAKE_UP`. If `PAUSE` isn't listed, the Pause button is hidden.
- Door lock, water temperature, spin speed and course name are reported only by some models. Fields the device doesn't report show `—`.

## Security considerations

- **The PAT is a bearer credential.** Anyone who has it can view and control every device on your LG account until you revoke it.
- The token is stored **in plain text in your browser's `localStorage`** for this site's origin. Any script running on that origin can read it. That includes other projects on the same `https://<user>.github.io` origin, because GitHub Pages user and project sites share one origin. For better isolation, use a custom domain or a dedicated account or organization.
- Use the app only on devices you trust. Don't use it on shared or public computers. Use **Settings → Clear saved data** when you're done.
- Give the token only the scopes it needs. Leave out control rights if you only want to monitor.
- If you think the token has leaked, revoke it right away at <https://connect-pat.lgthinq.com>.
- The token is sent only to LG's API hosts over HTTPS. The app has no analytics, no tracking and no third-party calls, apart from loading Bootstrap from jsDelivr.
- Never commit your token to the repository. The app never needs it in source code.
- The `x-api-key` in `js/api.js` is a public identifier that LG publishes for ThinQ Connect clients. It isn't a secret.

## Disclaimer

This is an unofficial project and isn't affiliated with LG Electronics. Use it at your own risk. Starting a washer remotely can be unsafe if it isn't loaded and supervised properly.
