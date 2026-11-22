# Gmail (read-only) setup — Aureon v51

Scopes: `gmail.readonly` (padhna) + `gmail.send` (bhejna). Mail **delete / badalna** possible hi nahi.
**Bhejna hamesha tumhare Approve se:** AI sirf DRAFT banata hai. Tum app me draft padhte ho, edit karte ho, "Bhejo" dabate ho, phir "Pakka bhejo?" par dobara tap.
Recipient AI nahi chunta: ya to tumne jo address diya, ya jis mail ka reply hai uska sender. Din me max 15 mail.
Mails kahin save nahi hote; sirf encrypted refresh token Firestore me rehta hai (`users/{uid}/integrations/gmail`). Bheji hui mail ka text bhi nahi rakha jaata.
Mail ka text AI ko sirf "data" ki tarah jaata hai (instructions follow nahi hote).
Sirf padhna chahte ho? Render env me `GMAIL_READONLY_ONLY=1` daalo.

## Ek baar ka setup (phone ke browser me, 10 min)

1. https://console.cloud.google.com kholo -> upar project dropdown -> **New project** -> naam `Aureon` -> Create.
2. **APIs & Services -> Library** -> "Gmail API" -> **Enable**.
3. **OAuth consent screen** (naye UI me: Google Auth Platform) -> User type **External** -> App name `Aureon`, support email apna.
   - **Audience / Test users** me apna Gmail add karo.
   - **Data access / Scopes** me `.../auth/gmail.readonly` aur `.../auth/gmail.send` add karo.
4. **Credentials -> Create credentials -> OAuth client ID** -> type **Web application**.
   - **Authorized redirect URIs** me ye daalo (exact):
     `https://aureone.onrender.com/api/gmail/callback`
   - Create dabao -> **Client ID** aur **Client secret** copy karo.
5. Render dashboard -> apna service -> **Environment** -> add:
   - `GOOGLE_CLIENT_ID` = (copy kiya hua)
   - `GOOGLE_CLIENT_SECRET` = (copy kiya hua)
   - `SENTINEL_ENC_KEY` pehle se set hona chahiye (Apps & Automation ke tokens ke liye bhi yahi chahiye).
   - (optional) `PUBLIC_BASE_URL` = `https://aureone.onrender.com`
   Save -> Render apne aap redeploy karega.
6. App me: Settings -> Apps & Automation -> **Gmail jodo** (pehle v51 se jura tha to **Hatao** karke dobara jodo, taaki send permission mile) -> browser me Google allow karo -> app me wapas aao.
   Ab **Important mails batao** chalega, aur **My Dashboard** me bhi dikhega.

## Dhyan do

- Google ka app **Testing** status me ho to refresh token ~7 din me expire ho sakta hai (Google ka rule, badal sakta hai).
  Fix: OAuth consent screen me **Publish app** (In production) karo. Tumhare apne account ke liye "unverified app" warning aayegi:
  **Advanced -> Go to Aureon (unsafe)** dabao — ye tumhara apna app hai.
- Kuch bhi galat lage: app me Gmail ke saamne **Hatao** dabao (token Google par revoke bhi hota hai), ya
  https://myaccount.google.com/permissions se Aureon hata do.

## Kaise chunta hai "important"

Query: pichhle 3 din, inbox, `is:important` ya unread, promotions/social/forums nahi. Phir AI bank/bill/OTP-security, job/exam, delivery,
official mail aur reply-waale insaan ke mails upar rakhta hai. AI na chale to unread-pehle list milti hai.
