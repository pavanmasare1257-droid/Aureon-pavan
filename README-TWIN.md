# Aureon integration (v46) - read this first

The twin is already wired into this project, so Steps 1, 2 and 6 below are DONE. Differences from the generic steps:
- Routes are under **/api/twin/...** (not /twin/...). The app screen and the GitHub tick workflow already use that.
- `backend/server.js` has the twin block (Firestore store, `req.uid` adapter for Aureon's login, notifications, email).
- The app opens it from **Settings > Digital Twin** (`www/twin/twin.js` + `twin-init.js`).
- Email: if `EMAIL_PROVIDER` is not set but `RESEND_API_KEY` + `ALERT_EMAIL_FROM` are (the Sentinel alert setup), the twin reuses them, and `ALERT_EMAIL_TO` becomes `OWNER_EMAIL`. Resend's free sender can only email the account owner, so for the dead-man switch to reach other people use a verified domain, or Brevo (see below).
- The scheduler now only reads users who have a recurring target or an armed dead-man switch (a registry), and runs every 5 minutes, so Firestore reads stay small.

What is left for you: Render env `TWIN_TICK_SECRET` (long random text), GitHub secrets `TWIN_TICK_SECRET` + `TWIN_BASE_URL`, then Step 5 (Firestore check) once.

---

# Aureon Twin v2 (Ava)

Pichle zip ke upar ye sab ab bana hai: asli payment aur deploy handlers, email sender, app ki screens, Firestore check script, aur cron ping.

**Kaunsa hissa kya maangta hai**
| Hissa | Folder | Kya karna hai |
|---|---|---|
| Backend | `backend/` | `git push` + Render redeploy (APK rebuild nahi) |
| App ki screen | `www/twin/` | `npx cap sync android` + APK rebuild |
| Automation | `.github/workflows/` | GitHub par push, phir 2 secrets |

Tests: `cd backend && node --test test/twin.test.js test/handlers.test.js` (59 pass). Node 18+ chahiye (Render ka default theek hai).

---

## Step 1: Files copy karo (Codespace)
```
cd /workspaces/Aureone-
unzip -o /path/to/Aureon-twin-v2.zip
```
Isse `backend/twin/`, `backend/test/`, `www/twin/`, `.github/workflows/` aa jayenge. Aapke purane files overwrite nahi hote (maine `server.js`, `package.json` nahi chhua).

## Step 2: server.js mein paste karo
`backend/twin-integration.example.js` ke blocks 1, 3 aur 4 `backend/server.js` mein paste karo (jahan `app` aur `requireAuth` ban chuke hain). Baaki optional hain, andar likha hai.

## Step 3: Render ke Environment variables
Kuch bhi set na karo to sab **safe mode** mein rahega (payment simulated, email aur deploy band).

| Variable | Kisliye |
|---|---|
| `TWIN_TICK_SECRET` | koi lamba random string (cron ping ke liye, zaroori) |
| `OWNER_NAME`, `OWNER_EMAIL` | aapka naam aur email (test email yahin aayegi) |
| `EMAIL_PROVIDER` = `brevo` | dead-man switch ke email |
| `BREVO_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME` | Brevo se milega (neeche) |
| `TWIN_DEPLOY_HOOKS_JSON` | `{"render-staging":"https://api.render.com/deploy/srv-xxx?key=yyy"}` |
| `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_DEFAULT_BRANCH` | auto-deploy se pehle tests green check karne ke liye |
| `TWIN_PAYEES_JSON`, `PAYMENTS_PROVIDER`, `RAZORPAYX_*` | **sirf** jab asli payment chahiye (neeche) |

Phir:
```
git add -A && git commit -m "twin v2" && git push
```
**Push zaroori hai**, warna Render naya code nahi chalayega.

## Step 4: GitHub secrets (cron ping)
Repo, Settings, Secrets and variables, Actions: `TWIN_TICK_SECRET` (wahi jo Render mein hai) aur `TWIN_BASE_URL` = `https://aureone.onrender.com`. Workflow har 30 minute chalta hai. Private repo par `*/10` mat karna, GitHub ke free minutes khatam ho jayenge.

## Step 5: Firestore ek baar check karo
Maine adapter sirf nakli Firestore par test kiya tha. Asli par ek baar:
```
cd backend
export FIREBASE_SERVICE_ACCOUNT="$(cat /path/to/serviceAccount.json)"
node scripts/check-twin-firestore.js
```
Sab `PASS` aana chahiye. Service account ki file repo mein commit mat karna.

## Step 6: App mein screen jodo
`www/index.html` mein `</body>` se pehle:
```html
<script src="twin/twin.js"></script>
<script>
  AureonTwin.init({
    apiBase: 'https://aureone.onrender.com',
    getIdToken: () => firebase.auth().currentUser.getIdToken()   // apne app.js jaisa token function lagao
  });
</script>
```
Kisi bhi button ya menu se `AureonTwin.open()` chalao. Phir `npx cap sync android` aur APK build. Screens: Approvals (Approve/Reject), Autonomy (Suggest / Approve / Auto + limits), Continuity, Targets, Log, aur upar "Freeze all" kill switch.

---

## Asli payment chalane se pehle (RazorpayX)
Default **simulation** hai: kuch nahi bhejta, log mein `SIMULATED` likhta hai, aur budget bhi use nahi hota. Asli karne ke liye:
1. RazorpayX account (KYC ke saath) aur payee ka `fund_account_id` chahiye. Ye normally business account hota hai, personal UPI se nahi chalta.
2. Razorpay dashboard mein Render ke outbound IPs allowlist karo (Render free plan par ye shared hain aur badal sakte hain).
3. `TWIN_PAYEES_JSON` set karo, phir `PAYMENTS_PROVIDER=razorpayx` aur teen `RAZORPAYX_*` keys.
4. Pehle **₹1** ka payee banao aur Level 2 (Approve) par test karo. Level 3 sabse baad mein, chhote caps ke saath.
Bonus safety: `TWIN_MAX_PAYMENT_INR` (default 5000) ek hard ceiling hai jise koi setting paar nahi kar sakti.

## Brevo email (5 minute)
Brevo free account, "Senders" mein apna email verify karo, "SMTP & API" se API key lo. Render mein `BREVO_API_KEY`, `EMAIL_FROM` (verified email), phir app ke Continuity tab mein **"Send me a test email"** dabao.

## Deploy hook
Render dashboard, service, Settings, **Deploy Hook** (URL copy karo, usme secret key hai). GitHub token: fine-grained, sirf is repo par, "Checks: read" aur "Metadata: read". `.github/workflows/twin-ci.yml` har push par tests chalata hai, wahi "green check" hai jo auto-deploy dekhta hai.

---

## Seedhi baat: kya test hua, kya nahi
- **Test hua:** backend (59 tests), aur UI asli backend ke saath phone-size Chromium mein (22 checks, screenshots dekhe).
- **Asli service par test NAHI hua:** Razorpay, Brevo, Render hook, GitHub API. Mere paas aapke credentials nahi hain. Requests Razorpay ki official docs ke hisaab se bani hain aur nakli server par check hui hain. Isliye pehli baar chhote amount aur Level 2 par chalao.
- **Aapka `server.js`, `www/app.js`, `index.html` maine dekhe nahi.** Isliye Step 2 aur 6 haath se karne hain. Ye 3 files bhej do to main button aur wiring khud laga dunga.
- **Push notification nahi hai.** Approvals tab app khulne par dikhta hai (badge ke saath). FCM push agla kaam hai.
- **Sirf email channel.** SMS aur WhatsApp abhi nahi.
- **GitHub cron** thoda late chal sakta hai aur public repo mein 60 din bina activity ke band ho jata hai.
- **Render free** soya ho to pehli request 30-60 second leti hai (app "waking up" dikhata hai).

## Is round mein jo gaps maine khud pakde aur theek kiye
- Auto-deploy ka "tests pass" ab server khud GitHub se saabit karta hai, koi bol kar nahi bata sakta.
- Firestore par do requests ek saath aane par ek approval do baar chal sakta tha, ya dead-man ka email do baar ja sakta tha. Ab sab atomic hai (tests ke saath).
- Payment mein timeout aaye to budget wapas nahi hota (paisa chala gaya ho sakta hai), aur log mein "UNCERTAIN" likhta hai.
- Owner check-in kar de to bacha hua plan dobara arm ho jata hai (pehle ek contact silently skip ho sakta tha).

**Alag reviewer ne ye 7 aur pakde, sab theek hue (har ek ka test hai):**
- (Critical) Caller `feature` badal kar finance ke limits bypass kar sakta tha. Ab feature action se bandha hai, caller ka likha hua maana hi nahi jata.
- (High) Deploy ka "tests green" kisi aur branch se saabit ho sakta tha. Ab hamesha wahi branch dekhi jati hai jo Render deploy karta hai.
- (High) `/twin/tick` par ajeeb header bhejne se server crash ho sakta tha. Ab nahi.
- (High) Koi recurring target fail ho to us user ka dead-man switch rukk sakta tha. Ab har job alag isolate hai.
- (Medium) Process beech mein mar jaye to bheja hua email dobara jaa sakta tha. Ab har email bhejte hi "sent" save hota hai.
- (Medium) Payment ke baad audit write fail ho to budget wapas ho jata tha (do payment cap ke bawajood). Ab audit fail hone se kuch undo nahi hota.
- (Low) Absurd schedule (`Infinity`) aur bade payload ab reject ya clamp hote hain.

**Ek baat jo ab bhi sach hai:** agar email provider email accept kar le par jawab dene mein timeout ho jaye, to dead-man switch use fail maanke 1 ghante baad dobara bhej dega. Bahut kam hota hai, par us contact ko ek email do baar mil sakta hai.
