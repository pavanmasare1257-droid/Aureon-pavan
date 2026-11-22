package com.aureon.ai;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Alarm tick (every ~20 min) and boot: polls the urgent-mail watcher, then arms the next tick. */
public class AureonMailWatchReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(final Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)) {
            AureonMailWatch.rearmIfEnabled(context, 120000L);
            return;
        }
        if (!AureonMailWatch.ACTION_POLL.equals(action) || !AureonMailWatch.isEnabled(context)) return;
        AureonMailWatch.rearmIfEnabled(context, 20L * 60L * 1000L);   // next tick first, so one failure never ends the chain
        final PendingResult pr = goAsync();
        final Context app = context.getApplicationContext();
        new Thread(new Runnable() {
            @Override public void run() {
                try { AureonMailWatch.pollNow(app); } finally { pr.finish(); }
            }
        }, "aureon-mail-watch").start();
    }
}
