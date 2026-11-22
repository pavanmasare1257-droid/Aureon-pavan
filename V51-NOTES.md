# v51 — Dashboard, Gmail (read-only), Phone apps

## Naya
- **My Dashboard** (Settings ke upar): Phone (battery, Away mode + nayi calls), Gmail important mails, Digital Twin approvals + dead-man switch,
  Apps & Automation ke last runs, aur "Mere apps" quick-launch. Har card alag load hota hai.
- **Gmail** (Settings > Apps & Automation): read-only, OAuth. Backend `backend/gmail-hub.js`, routes `/api/gmail/*`. Setup: `GMAIL-SETUP.md`.
- **Phone ke apps** (Settings > Apps & Automation): phone me installed saare apps (search ke saath). Tap -> Kholo / Aureon se jodo.
  Jude apps Dashboard me ek-tap launch. List phone se bahar nahi jaati (sirf localStorage `aureon_phone_apps`).
  Native: `AureonActionsPlugin.listInstalledApps()` aur `openAppByPackage({pkg})`.

## Files
backend/gmail-hub.js (new), backend/test/gmail.test.js (new), backend/server.js (gmail mount),
www/dash-hub.js (new), www/connect-hub.js, www/index.html, android/.../AureonActionsPlugin.java, GMAIL-SETUP.md, V51-NOTES.md.

## Deploy
Backend + www + Android badle -> push ke baad APK rebuild zaroori. Gmail ke liye Render env vars (GMAIL-SETUP.md).
Ye zip v50 ke upar bana hai (server.js, index.html, AureonActionsPlugin.java me v50 ke changes bhi hain).

## Jaan-boojhkar nahi kiya
- Gmail se koi action (reply/delete/send) nahi: sirf padhna. Aage kuch bhi add ho to approve-gate se guzre.
- "Aureon se jodo" ka matlab: kholna + quick-launch + voice se naam lena. Doosre app ke andar ka data padhna iska hissa nahi
  (uske liye us app ka API/MCP "Jude hue apps" me jodo).
