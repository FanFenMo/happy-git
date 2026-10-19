package com.happygit.app.nativebridge;

import java.util.concurrent.Callable;
import java.util.concurrent.locks.ReentrantLock;

public class PageTaskScheduler {

    private final ReentrantLock leaseLock = new ReentrantLock(true);
    private long lastNavigationTime = 0;
    private static final long MIN_INTERVAL_MS = 1500;
    private long rateLimitedUntil = 0;

    public <T> T withPageLease(String contextId, String purpose, Callable<T> work) throws Exception {
        leaseLock.lock();
        try {
            enforceThrottling();
            return work.call();
        } finally {
            lastNavigationTime = System.currentTimeMillis();
            leaseLock.unlock();
        }
    }

    public synchronized void enforceThrottling() throws InterruptedException {
        long now = System.currentTimeMillis();
        if (rateLimitedUntil > now) {
            Thread.sleep(rateLimitedUntil - now);
        }
        long elapsed = System.currentTimeMillis() - lastNavigationTime;
        if (elapsed < MIN_INTERVAL_MS) {
            Thread.sleep(MIN_INTERVAL_MS - elapsed);
        }
    }

    public synchronized void handleRateLimit() {
        rateLimitedUntil = System.currentTimeMillis() + 60000;
    }
}
