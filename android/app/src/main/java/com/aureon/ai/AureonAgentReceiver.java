package com.aureon.ai;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Receives the Allow / Stop taps from the App Agent notifications (not exported: only this app's own PendingIntents reach it). */
public class AureonAgentReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        AureonAppAgent.onDecision(intent.getAction());
    }
}
