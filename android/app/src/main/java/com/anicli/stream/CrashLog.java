package com.anicli.stream;

import android.content.Context;
import android.os.Build;
import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.Date;

public class CrashLog {
    private static final String FILE = "last-crash.txt";
    private static final int MAX_CHARS = 20_000;

    public static void install(Context context, String appName, String version) {
        Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                StringWriter sw = new StringWriter();
                error.printStackTrace(new PrintWriter(sw));
                String trace = sw.toString();
                if (trace.length() > MAX_CHARS) {
                    trace = trace.substring(0, MAX_CHARS);
                }
                String report = appName + " " + version + ", Android " + Build.VERSION.RELEASE
                        + " (" + Build.MANUFACTURER + " " + Build.MODEL + ")\n"
                        + new Date() + " on thread " + thread.getName() + "\n\n" + trace;
                File f = new File(context.getFilesDir(), FILE);
                try (FileOutputStream fos = new FileOutputStream(f)) {
                    fos.write(report.getBytes(StandardCharsets.UTF_8));
                }
            } catch (Throwable ignored) {
            }
            if (prev != null) {
                prev.uncaughtException(thread, error);
            }
        });
    }

    public static String read(Context context) {
        try {
            File f = new File(context.getFilesDir(), FILE);
            if (!f.isFile() || f.length() == 0) return null;
            byte[] bytes = new byte[(int) f.length()];
            try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) {
                int read = fis.read(bytes);
                return read > 0 ? new String(bytes, 0, read, StandardCharsets.UTF_8) : null;
            }
        } catch (Exception e) {
            return null;
        }
    }

    public static void clear(Context context) {
        try {
            File f = new File(context.getFilesDir(), FILE);
            if (f.exists()) //noinspection ResultOfMethodCallIgnored
                f.delete();
        } catch (Exception ignored) {
        }
    }
}
