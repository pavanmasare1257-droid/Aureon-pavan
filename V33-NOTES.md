# v33 — APK read + dex bug-scan + HTML Maker

## APK reading (backend/attach.js, backend/apk-dex.js)
- Ava Lab me `.apk` attach karo (📎 / 🗜 Zip button). Manifest (binary XML) + classes.dex tables padhi jaati hain: package, version, SDK,
  permissions, activities, exported components, classes / methods, URLs, hard-coded keys, risky API (WebView JS, SSL bypass, debuggable, allowBackup ...).
- Dex ko decompile nahi karta (original source wapas nahi aata) — par class/method/string tables se bugs aur risks milte hain.
- Size limit hata di. Ab sirf memory ceiling: Render env `AVA_MAX_ZIP_MB` (default 400), `AVA_MAX_UNPACKED_MB` (2000), `AVA_UPLOAD_MB` (600).
  Badi APK ke liye Render plan me enough RAM chahiye (file memory me padhi jaati hai).

## HTML Maker (backend/html-maker.js)  — /api/sentinel/ava-html
- Ava ek complete standalone HTML page banati hai (website, tool, calculator, game...). Quality gate: DOCTYPE, viewport, title, no external resource,
  no eval, JS syntax check; fail ho to khud 2 baar sudhaar karti hai. Revise: "button blue karo" jaisa change, purana version `.prev` me.
- Preview sandbox CSP ke saath (no network). Download `.html`. 10 pages / ghanta.
- Ava Desk -> Project -> type "HTML page".
