# v54 — call fixes: naam bolna, volume, baar-baar call = tez ring

(v53 ke baad lagao. v53-callfix isme shamil hai.)

## 1. Caller ka naam kabhi-kabhi nahi bolna (AureonCallAnnouncer.java)
- Numbered-broadcast ka wait 900 ms -> 1600 ms (v50 se pehle wali value): Realme par number ~1 sec baad aata hai, 900 ms par generic line pehle bol ke naam ko kaat deti thi.
- Ek hi caller ki ek key (last 10 digits): screening aur broadcast alag format ka number dete hain (+91.. / 0..), isliye naam do baar bajta tha aur pehla beech me kat jaata tha.
- Phone ka shared TTS engine chupchap mar sakta hai: ab speak fail ho to engine naya banta hai aur usi call me naye engine se bolta hai.

## 2. Awaaz kam sunayi de (media volume)
Call aate hi media aur accessibility stream kam ho to **75% tak** badhti hai (pehle 60%), bolne ke baad purani volume wapas. Dono stream alag try-block me, ek ne mana kiya to doosra rukta nahi.

## 3. Baar-baar call = tez ring (AureonRepeatCaller.java)
- Ek hi number 10 min me 3 baar call kare -> 3rd call par tez ring, phone silent / vibrate / Do Not Disturb ho tab bhi.
- Koi khaas permission nahi: default ringtone **alarm stream** par full volume me (alarm silent mode me bhi bajta hai).
- Settings > Do Not Disturb access doge to phone ki apni ringtone: silent mode hatata hai, ring volume max, call ke baad sab wapas.
- Call uthate hi / khatam hote hi turant band, warna 45 sec me. Sirf ring badalti hai: call uthana/rokna/block kuch nahi.
- Settings > Away mode screen me naya card "Baar-baar call = tez ring": ON/OFF, "Tez ring test (6 sec)", "Do Not Disturb access do".
- Default ON.

## Files
android: AureonCallAnnouncer.java, AureonRepeatCaller.java (new), AureonActionsPlugin.java (repeatCaller*, openDndAccess)
www: away-hub.js

## Test (APK rebuild zaroori)
1. Phone silent karo, Away mode screen > "Tez ring test (6 sec)": alarm awaaz me ringtone bajni chahiye.
2. Dusre phone se ek hi number se 3 baar call karo (10 min ke andar): 3rd par tez ring.
3. Media volume 1 karke call karwao: naam saaf sunayi dena chahiye, call ke baad volume wapas 1.
Test nahi hua: asli phone par. Java stub-compile se check hua.
