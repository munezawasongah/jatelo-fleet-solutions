# Jatelo Fleet Driver (Android)

`apps/driver` is an Expo (SDK 58) React Native app. It is a standalone npm project (not part of the pnpm workspace) so
that EAS builds are simple.

## What drivers can do

- Sign in with the login their fleet manager created (**Drivers → driver → Driver app login → Invite**).
- See today's shift and vehicle; start/end shift. When the vehicle has no hardware tracker, starting the shift turns on
  phone GPS tracking (background, battery-aware, buffered offline and uploaded later).
- Work through dispatched jobs: navigate (Google Maps), call the contact, mark arrived, complete with **proof of delivery**
  (recipient, photos, signature) or record a failed delivery with a reason.
- Pre-/post-trip inspections from the company checklist (photos on defects), fuel fill-ups with receipt photo, defect reports.
- Chat with dispatch (with photos); push notifications for new jobs and messages.
- Everything works without signal — actions queue and sync automatically (More → Sync shows what is waiting).
- English and Kiswahili.

## Develop

```bash
cd apps/driver
npm install
EXPO_PUBLIC_API_URL=http://10.0.2.2:4000 npx expo run:android     # emulator against your local API
```

## Build an installable APK / Play Store bundle

1. `npm install -g eas-cli && eas login` (Expo account), then `eas init` once to set `extra.eas.projectId`.
2. Put Firebase `google-services.json` in `apps/driver/` for push notifications (see DEPLOYMENT.md).
3. Set the API URL for each profile in `eas.json` (`EXPO_PUBLIC_API_URL`).
4. `npm run build:apk` → shareable APK (internal testing) · `npm run build:aab` → Play Store bundle.

Play Store listing notes: the app uses background location only while the driver is on shift, to share the vehicle position
with their employer; declare this in the *Location permissions* form and show the in-app disclosure (the foreground
notification "Jatelo Fleet is tracking this trip" stays visible while tracking).
