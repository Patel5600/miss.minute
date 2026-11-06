package com.patel5600.missminute.mobile.bridge;

import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.patel5600.missminute.mobile.BuildConfig;
import com.patel5600.missminute.mobile.R;
import com.patel5600.missminute.mobile.core.protocol.Role;

import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Hosts one of the two web pages (overlay or dashboard) in a locked-down WebView.
 *
 * <ul>
 *   <li>Pages load only from {@code https://appassets.androidplatform.net/assets/web/} through
 *       {@link WebViewAssetLoader}. Every other URL gets 403, so the page can reach no network and no
 *       file.</li>
 *   <li>Every served response carries a Content-Security-Policy and {@code Cache-Control: no-store}.</li>
 *   <li>Native and page talk through {@code WebViewCompat.addWebMessageListener} (object
 *       {@code missNative}), accepted only from the main frame of that one origin. There is no
 *       {@code addJavascriptInterface}.</li>
 *   <li>Requests are handled on one worker thread; replies and pushes are posted on the main thread,
 *       as {@link JavaScriptReplyProxy} requires.</li>
 * </ul>
 */
public final class WebHost {
    public static final String HOST = "appassets.androidplatform.net";
    public static final String ORIGIN = "https://" + HOST;
    public static final String OBJECT_NAME = "missNative";
    public static final String ASSET_PATH = "/assets/web/";

    static final String CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            + "img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https:; base-uri 'none'; "
            + "form-action 'none'; frame-ancestors 'none'";

    private static final String TAG = "MMWeb";
    private static final int MAX_RECREATIONS = 3;

    /** Reasons passed to {@link Callbacks#onProblem}. */
    public static final String PROBLEM_UNSUPPORTED = "unsupported";
    public static final String PROBLEM_RENDERER = "renderer";

    public interface Callbacks {
        /** The page cannot be shown: the WebView lacks a feature, or its renderer keeps crashing. */
        void onProblem(String reason);
    }

    private final Context context;
    private final Role role;
    private final BridgeRouter router;
    private final Callbacks callbacks;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker;
    private final WebViewAssetLoader loader;
    private final String pageUrl;

    private ViewGroup parent;
    private ViewGroup.LayoutParams params;
    private WebView view;
    private volatile JavaScriptReplyProxy proxy;
    private boolean destroyed;
    private int recreations;

    private WebHost(Context context, Role role, BridgeRouter router, Callbacks callbacks) {
        this.context = context;
        this.role = role;
        this.router = router;
        this.callbacks = callbacks;
        this.pageUrl = ORIGIN + ASSET_PATH + (role == Role.OVERLAY ? "overlay.html" : "dashboard.html");
        this.worker = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "mm-bridge-" + role.name().toLowerCase());
            thread.setDaemon(true);
            return thread;
        });
        this.loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(context))
                .build();
    }

    public static WebHost create(Context context, Role role, BridgeRouter router, Callbacks callbacks) {
        return new WebHost(context, role, router, callbacks);
    }

    /** False when this WebView cannot receive messages from pages (an old WebView): update it. */
    public static boolean isSupported() {
        try {
            return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * Creates the WebView, adds it to {@code container}, and loads the page. Main thread only.
     *
     * @return the view, or null when the WebView cannot host the page ({@link Callbacks#onProblem} is told)
     */
    public WebView attachTo(ViewGroup container, ViewGroup.LayoutParams layoutParams) {
        this.parent = container;
        this.params = layoutParams;
        return build() ? view : null;
    }

    private boolean build() {
        if (destroyed) {
            return false;
        }
        if (!isSupported()) {
            callbacks.onProblem(PROBLEM_UNSUPPORTED);
            return false;
        }
        WebView webView;
        try {
            webView = new WebView(context);
        } catch (RuntimeException e) {
            callbacks.onProblem(PROBLEM_UNSUPPORTED);
            return false;
        }
        configure(webView);
        // The listener must exist before the page loads: the object is injected while the page starts.
        WebViewCompat.addWebMessageListener(webView, OBJECT_NAME, Collections.singleton(ORIGIN),
                (v, message, sourceOrigin, isMainFrame, replyProxy) ->
                        onMessage(message, sourceOrigin, isMainFrame, replyProxy));
        view = webView;
        parent.addView(webView, params);
        webView.loadUrl(pageUrl);
        return true;
    }

    private void configure(WebView webView) {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        if (role == Role.OVERLAY) {
            webView.setBackgroundColor(0x00000000);
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
            webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
            webView.setVerticalScrollBarEnabled(false);
            webView.setHorizontalScrollBarEnabled(false);
            webView.setLongClickable(false);
            webView.setHapticFeedbackEnabled(false);
        } else {
            webView.setBackgroundColor(context.getColor(R.color.mm_base));
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                return intercept(request.getUrl(), request.getMethod());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                return true; // no navigation away from the page, ever
            }

            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                if (BuildConfig.DEBUG) {
                    Log.w(TAG, role + " renderer gone, crashed=" + detail.didCrash());
                }
                if (v == view) {
                    main.post(WebHost.this::recreate);
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (BuildConfig.DEBUG && request.isForMainFrame()) {
                    Log.w(TAG, role + " page error " + error.getErrorCode());
                }
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) {
                proxy = null; // a new document has a new JavaScript object
            }
        });

        if (BuildConfig.DEBUG) {
            webView.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onConsoleMessage(ConsoleMessage message) {
                    Log.d(TAG, role + " console " + message.messageLevel() + ": " + message.message()
                            + " (line " + message.lineNumber() + ")");
                    return true;
                }
            });
        }
    }

    /** Serves only GET requests for files under /assets/web/ on the one virtual origin. */
    WebResourceResponse intercept(Uri url, String method) {
        if (!"GET".equalsIgnoreCase(method) || !isOurOrigin(url)) {
            return refusal(403, "Forbidden");
        }
        String path = url.getPath();
        if (path == null || !path.startsWith(ASSET_PATH) || path.contains("..")) {
            return refusal(403, "Forbidden");
        }
        WebResourceResponse response = loader.shouldInterceptRequest(url);
        if (response == null) {
            return refusal(404, "Not Found");
        }
        Map<String, String> headers = new HashMap<>();
        Map<String, String> existing = response.getResponseHeaders();
        if (existing != null) {
            headers.putAll(existing);
        }
        headers.put("Content-Security-Policy", CSP);
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        response.setResponseHeaders(headers);
        return response;
    }

    private static WebResourceResponse refusal(int status, String reason) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", status, reason, headers,
                new ByteArrayInputStream(new byte[0]));
    }

    private static boolean isOurOrigin(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) && uri.getPort() == -1;
    }

    /** Runs on the UI thread. Anything not from the main frame of our origin is dropped without an answer. */
    private void onMessage(WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame,
                           final JavaScriptReplyProxy replyProxy) {
        if (destroyed || !isMainFrame || !isOurOrigin(sourceOrigin)) {
            return;
        }
        if (message.getType() != WebMessageCompat.TYPE_STRING || message.getData() == null) {
            return;
        }
        final String text = message.getData();
        proxy = replyProxy;
        recreations = 0; // a page that talks is healthy
        try {
            worker.execute(() -> router.dispatch(text, json -> main.post(() -> post(replyProxy, json))));
        } catch (RejectedExecutionException e) {
            // destroyed while a message was arriving
        }
    }

    private void post(JavaScriptReplyProxy target, String json) {
        if (destroyed) {
            return;
        }
        try {
            target.postMessage(json);
        } catch (RuntimeException e) {
            if (proxy == target) {
                proxy = null; // its frame is gone
            }
        }
    }

    /** Pushes a command or event to the page. Dropped until the page has sent its first message. */
    public void send(final String json) {
        final JavaScriptReplyProxy target = proxy;
        if (target == null) {
            return;
        }
        main.post(() -> post(target, json));
    }

    /** True once the page has sent a message since it last loaded. */
    public boolean isPageConnected() {
        return proxy != null;
    }

    public void onPause(boolean pauseTimersToo) {
        if (view != null) {
            view.onPause();
            if (pauseTimersToo) {
                view.pauseTimers(); // global: it pauses every WebView in this process until resumed
            }
        }
    }

    public void onResume() {
        if (view != null) {
            view.onResume();
            view.resumeTimers();
        }
    }

    private void recreate() {
        if (destroyed || parent == null) {
            return;
        }
        proxy = null;
        removeView();
        recreations++;
        if (recreations > MAX_RECREATIONS) {
            callbacks.onProblem(PROBLEM_RENDERER);
            return;
        }
        build(); // the new page says hello and native resends its state
    }

    private void removeView() {
        WebView old = view;
        view = null;
        if (old == null) {
            return;
        }
        try {
            WebViewCompat.removeWebMessageListener(old, OBJECT_NAME);
        } catch (RuntimeException ignored) {
            // the listener may already be gone with the renderer
        }
        old.stopLoading();
        old.setWebViewClient(new WebViewClient());
        ViewGroup holder = (ViewGroup) old.getParent();
        if (holder != null) {
            holder.removeView(old);
        }
        old.destroy();
    }

    /** Releases the WebView and the worker. Main thread only; safe to call twice. */
    public void destroy() {
        if (destroyed) {
            return;
        }
        destroyed = true;
        proxy = null;
        main.removeCallbacksAndMessages(null);
        worker.shutdownNow();
        removeView();
    }
}
