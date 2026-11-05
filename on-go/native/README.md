# ON GO — Capacitor store shell

Wraps the live PWA at [https://ongo-app.com](https://ongo-app.com) for Apple App Store and Google Play.

**Bundle ID / applicationId:** `com.ongoapp.app`  
**App name:** ON GO  
**Approach:** Capacitor `server.url` → production site (store builds stay current with Netlify deploys).

## Why server URL (not bundled `public/`)

| | Server URL (`https://ongo-app.com`) | Bundled static `public/` |
|---|---|---|
| Beta updates | Instant with web deploy | Requires new store binary |
| Review risk | Disclose “loads content from ongo-app.com”; keep core UX stable | More “offline binary” feel |
| Best for | Live marketplace beta | Rarely changing apps |

We use **server URL** + `allowNavigation` for ongo-app.com so TestFlight / Play internal builds do not go stale during beta. Local `www/` is only the Capacitor sync shell / offline fallback.

## Prerequisites

- Node 18+
- **iOS:** macOS, Xcode 15+, CocoaPods, Apple Developer Program
- **Android:** Android Studio, JDK 17+, Google Play Console account

## Setup

```bash
cd on-go/native
npm install
npm run assets          # icons + splash from resources/icon-source.png
npx cap sync
```

### iOS

```bash
npm run open:ios        # opens Xcode
# Product → Archive → Distribute App → App Store Connect / TestFlight
```

### Android

```bash
npm run open:android    # opens Android Studio
# Build → Generate Signed Bundle / APK → upload to Play Console
# or: npm run build:android
```

## Permissions (already configured)

- **Location (when in use):** nearby venues + visit-point verification  
- **Camera (optional hardware):** venue QR scan for visit points  
- Deep links: `ongo://` scheme + associated domains / App Links for `ongo-app.com`  
  Replace `TEAMID` in `public/.well-known/apple-app-site-association` and the Play SHA-256 in `assetlinks.json` after accounts exist.

## Secrets

Do **not** commit provisioning profiles, keystores, `google-services.json` with secrets, or API keys here. Signing stays on Damien’s machine / CI secrets.

## Full store checklist

See Project docs: `docs/app-store-launch.md`.
