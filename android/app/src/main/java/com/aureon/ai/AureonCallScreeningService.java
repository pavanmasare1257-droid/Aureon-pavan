package com.aureon.ai;

import android.net.Uri;
import android.os.Build;
import android.telecom.Call;
import android.telecom.CallScreeningService;

import androidx.annotation.RequiresApi;

/**
 * Android hands every incoming call to the "call screening" app BEFORE the phone rings, together with the number. That is far more
 * reliable (and faster) than the PHONE_STATE broadcast, which phones like Realme/ColorOS delay or drop. Aureon lets every call through
 * untouched; it only uses the moment to say who is calling. Works only after the user gives Aureon the "caller ID & spam app" role
 * (Settings > Away mode > Caller voice check > Turn on instant caller name).
 */
@RequiresApi(api = Build.VERSION_CODES.N)
public class AureonCallScreeningService extends CallScreeningService {
    @Override
    public void onScreenCall(Call.Details details) {
        try {
            respondToCall(details, new CallResponse.Builder().build());   // allow, no changes: we never block or silence anything
        } catch (Throwable ignored) { /* never let screening break a call */ }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && details.getCallDirection() != Call.Details.DIRECTION_INCOMING) return;
            Uri handle = details.getHandle();
            String number = handle == null ? "" : String.valueOf(handle.getSchemeSpecificPart());
            AureonCallAnnouncer.onScreenedCall(getApplicationContext(), number);
        } catch (Throwable ignored) { /* announcing is best effort */ }
    }
}
