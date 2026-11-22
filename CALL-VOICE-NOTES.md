# Call + voice notes (v50)

- Away mode (AureonAwayMode.java): `acceptRingingCall()` se call uthti hai, phir **speakerphone + TTS (USAGE_VOICE_COMMUNICATION)** se Ava bolti hai
  aur phone ka **mic + SpeechRecognizer** se caller ko sunti hai. Android third-party app ko call audio me seedha bolne/sunne nahi deta,
  isliye awaaz speaker se aati hai. Mic kai phones par call me silent hota hai -> log me `noaudio` / `silent`.
  Asli fix = call forwarding + server-side voice (Twilio/Exotel) — abhi bana nahi.
- v50: `AureonCallScreeningService` (role "caller ID & spam app") ring se pehle number deta hai -> caller ka naam turant. Kabhi call block nahi karta.
- v50: voice se "kat / decline / mat uthao" call reject (sirf jab call ring ho rahi ho). "pickup / utha lo" call utha leta hai.
- v50: ring ke time TalkBack jaisa audio focus + volume 60% tak (15 sec me wapas). Ava ki awaaz: en-IN / hi-IN, pitch 1.12, speed 1.02.
- Debug: Settings > Away mode > Caller voice check (numberSeen, nameFound, spoke, volume, DND). Away call log me `Debug:` line (speaker, tts, callVol).
