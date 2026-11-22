# v52 — Gmail send/reply (Approve), Ava apps chalati hai, Claude connector (MCP), Code mode Repo task

(Ye zip v51 ko bhi shamil karta hai: v50 ke baad sirf ye lagao.)

## Rule jo sab me common hai
AI **sirf proposal/draft** banata hai. Bhejna, dabana, PR banana: sab **tumhare Approve** ke baad. Koi naya raasta bina Approve ke kuch nahi karta.

## 1. Gmail: mail likhna / reply (Settings > Apps & Automation > Gmail)
- "Reply draft" (important mail ke neeche) ya "Naya mail likho" -> AI draft banata hai -> neeche "Draft approve ka intezaar".
- Draft me subject/body edit kar sakte ho. "Bhejo ✓" -> "Pakka bhejo?" (dobara tap) -> tab hi Gmail se jaata hai.
- Backend: `backend/gmail-hub.js` (`/draft`, `/drafts`, `/send`, `/draft/reject`). Send ke liye Gmail dobara jodna padega (send permission).
- Tests: `backend/test/gmail.test.js` (13).

## 2. Ava tumhare apps chalati hai (Settings > Apps & Automation > Phone ke apps)
- App par tap -> "Aureon se jodo" -> phir "Ava ko kya karwana hai?" me likho -> "Ava se karwao".
- Loop phone par (`AureonAppAgent.java`), AI server par (`backend/app-agent.js`). Ava screen ke numbered nodes dekhti hai, ek ek step leti hai.
- **Send / Post / Pay / Delete / Confirm / Call jaise button se pehle notification me Allow / Roko aata hai** (2 min me jawab nahi = Roko).
- Banking / UPI / wallet / password-manager / Settings / Play Store apps band. Max 14 step. Doosra app aa gaya to task ruk jaata hai. Password fields kabhi nahi padhti/likhti.
- Accessibility ON honi chahiye (Settings me khud khulti hai). Screen text AI server ko jaata hai (consent note dikhta hai).
- Notification permission zaroori hai, warna Allow dikhega hi nahi (aur task Roko ho jaata hai).

## 3. Claude connector (Settings > Apps & Automation > Claude connector)
- "Token banao" -> token + URL copy karo. Claude me: Settings > Connectors > Add custom connector -> URL -> header `Authorization: Bearer <token>`.
- Tools: `aureon_overview`, `gmail_important`, `gmail_draft` (sirf draft), `gmail_pending_drafts`, `automations_list`. **Koi send/run/deploy tool nahi.**
- Token sirf hash ke roop me save, kabhi bhi "Band karo"; 60 call / 10 min limit. Backend: `backend/mcp-server.js` (`POST /mcp`). Tests: `mcp.test.js` (4).

## 4. Code mode: Repo task (Settings > Code mode > Repo task)
- Task likho -> Ava relevant files padhti hai -> proposal + diff -> Approve (2 tap) -> **naya branch `aureon/task-xxxx` + Pull Request**.
- main me seedha kuch nahi, **merge kabhi nahi** (tum khud karoge). Sirf owner. JS/JSON syntax check pehle; `.github`, `.env`, secrets, lock files band.
- Render env: `GITHUB_TOKEN` (fine-grained: Contents + Pull requests = Read & write, sirf is repo par) aur `GITHUB_REPO=owner/repo` (optional `AVA_GITHUB_BASE`, default `main`).
- Backend: `backend/repo-task.js`. Tests: `repo-task.test.js` (5), `app-agent.test.js` (4).

## Dashboard
Gmail card me "N draft approve ka intezaar", Phone card me Ava ka last app-task.

## Files
backend: gmail-hub.js, mcp-server.js, repo-task.js, app-agent.js, server.js, test/{gmail,mcp,repo-task,app-agent}.test.js
www: dash-hub.js, code-hub.js, connect-hub.js, index.html
android: AureonAppAgent.java, AureonAgentReceiver.java (new), AureonAccessibilityService.java, AureonActionsPlugin.java, AndroidManifest.xml

## Deploy
APK rebuild zaroori (android + www badle). Render: env GITHUB_TOKEN / GITHUB_REPO (repo task), Google keys (Gmail), push par redeploy.

## Abhi test nahi hua (device/accounts chahiye)
Asli Google login + send, asli GitHub PR, phone par App Agent (accessibility + notification Allow), Claude me connector jodna.
Java ko mere paas Android SDK nahi, stub-compile se check hua; asli compile APK build par pata chalega.
