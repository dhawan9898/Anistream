# R8 rules for the minified release build.
#
# Capacitor finds plugins and their @PluginMethod methods by reflection and
# calls into the WebView through @JavascriptInterface methods, so none of
# those may be renamed or stripped. Capacitor's library ships consumer rules
# for this already; these are kept here explicitly as a safety net.

# Annotations are read at runtime (@CapacitorPlugin, @PluginMethod, ...).
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod

# Readable crash stack traces (mapping.txt is uploaded by CI).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Capacitor bridge + plugins.
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * {
    @com.getcapacitor.PluginMethod public <methods>;
}
-keep public class * extends com.getcapacitor.Plugin { *; }

# WebView <-> JS bridge methods.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# This app's plugin and activities (registered by class / manifest name).
-keep class com.anicli.stream.ExoPlayerPlugin { *; }
-keep class com.anicli.stream.MainActivity
-keep class com.anicli.stream.ExoPlayerActivity

# Cordova compatibility layer bundled by Capacitor.
-keep public class * extends org.apache.cordova.* {
    public <methods>;
    public <fields>;
}
-dontwarn org.apache.cordova.**
