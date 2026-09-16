package com.anicli.stream;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ExoPlayerPlugin")
public class ExoPlayerPlugin extends Plugin {

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        String title = call.getString("title", "AniStream");
        String episode = call.getString("episode", "1");
        String referer = call.getString("referer", "https://zokoanime.video/");

        if (url == null || url.isEmpty()) {
            call.reject("Must provide a video URL");
            return;
        }

        Intent intent = new Intent(getContext(), ExoPlayerActivity.class);
        intent.putExtra("url", url);
        intent.putExtra("title", title);
        intent.putExtra("episode", episode);
        intent.putExtra("referer", referer);

        getActivity().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("success", true);
        call.resolve(ret);
    }
}
