# v53 — Ava mail ko khud padhti hai: chat me jawab + urgent par notification

(Cumulative: v51 + v52 + v53. v50 ke baad sirf ye zip lagao.)

## 1. Chat me: "important mail batao"
Chat box me ye likho: "important mail batao", "koi urgent mail aaya?", "gmail check karo", "offer letter aaya kya?".
Ava Gmail (read-only) padhke chat me hi bata deti hai: summary + 6 tak mails, har ek ke saath wajah.
"mail likh do / reply bhej do / delete" jaise messages yahan nahi pakde jaate: wo draft -> Approve flow se hi jaate hain.
File: `www/mail-hub.js` (hook `AureonMail.chatIntent` in app.js `sendMessage`, Away/Docs jaisa).
Dhyan: ye typed chat / home input par pakka hai. Alag voice-mode (Ava overlay) par maine verify nahi kiya.

## 2. Urgent mail par notification (Settings > Apps & Automation > Gmail > "Urgent mail par notification")
- "Chalu karo" dabao. Phone har ~20 min backend se puchta hai "naya zaroori mail?". Backend Gmail padhta hai, AI chunti hai: offer letter / interview /
  result / admission / bank-payment-security alert / bill due / delivery-travel problem / official notice / koi insaan jo urgent jawab maang raha ho.
  Newsletter, offers, social, OTP par notification **nahi**. AI na chale to keyword list (offer letter, interview, urgent, payment failed, security alert...) kaam karti hai.
- Pehla check sirf "baseline": jo mails pehle se unread hain un par notification nahi aati. Har mail par sirf ek baar notification.
- Sirf PADHTA hai aur batata hai. Bhejna/reply/delete kuch nahi (Gmail send ka rule waisa hi: draft + tumhara Approve).
- Phone par key alag "watch key" hai (sirf hash server par). Key band/Gmail Hatao karte hi watcher ruk jaata hai.
- Native: `AureonMailWatch.java` + `AureonMailWatchReceiver.java` (AlarmManager, reboot par wapas chalu: RECEIVE_BOOT_COMPLETED). Backend: `/api/gmail/watch/*` in `gmail-hub.js`.
- **Realme/ColorOS:** Settings > Apps > Aureon > Auto-start ON aur Battery "Unrestricted". Warna phone alarm kaat sakta hai (Android ki limit: alarm 15-20 min ke aas-paas aata hai, second-exact nahi).
- Server ko jaagte rehna chahiye (Render free plan so jaata hai, par phone ka har poll use jagata hai).
- Notification permission zaroori. Notification par tap = Aureon khulta hai.

## Files
backend: gmail-hub.js (watch routes), test/gmail.test.js (18 tests)
www: mail-hub.js (new), connect-hub.js, dash-hub.js, app.js, index.html
android: AureonMailWatch.java, AureonMailWatchReceiver.java (new), AureonActionsPlugin.java (mailWatchSet/Status), AndroidManifest.xml

## Deploy
APK rebuild zaroori. Backend push par Render redeploy. Gmail pehle se jura ho to naya kuch nahi karna (watch alag key se chalta hai).
Test nahi hua: asli Gmail + notification phone par (mere paas device/Google account nahi). Java stub-compile se check hua.
