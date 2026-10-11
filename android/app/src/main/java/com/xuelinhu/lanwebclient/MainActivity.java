package com.xuelinhu.lanwebclient;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final int AUDIO_PERMISSION_REQUEST = 41;
    private android.content.SharedPreferences preferences;
    private WebView webView;
    private ProgressBar progressBar;
    private PermissionRequest pendingPermissionRequest;
    private String serverUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences("lan-web-client", MODE_PRIVATE);
        serverUrl = preferences.getString("serverUrl", BuildConfig.DEFAULT_URL);
        showWebView();
    }

    private void showWebView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        Button serverButton = new Button(this);
        serverButton.setText("服务地址");
        serverButton.setOnClickListener(view -> showServerDialog());
        Button refreshButton = new Button(this);
        refreshButton.setText("刷新");
        refreshButton.setOnClickListener(view -> webView.reload());
        toolbar.addView(serverButton, new LinearLayout.LayoutParams(0, dp(48), 1));
        toolbar.addView(refreshButton, new LinearLayout.LayoutParams(0, dp(48), 1));
        root.addView(toolbar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        webView = new WebView(this);
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.rgb(0, 121, 107)));
        root.addView(progressBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (isSameOrigin(request.getUrl(), Uri.parse(serverUrl))) return false;
                Toast.makeText(MainActivity.this, "已拦截跨站页面跳转", Toast.LENGTH_SHORT).show();
                return true;
            }

            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                Uri target = request.getUrl();
                if (("http".equals(target.getScheme()) || "https".equals(target.getScheme()))
                        && !isSameOrigin(target, Uri.parse(serverUrl))) {
                    return new android.webkit.WebResourceResponse(
                            "text/plain", "UTF-8", 403, "Blocked", null,
                            new java.io.ByteArrayInputStream(new byte[0]));
                }
                return null;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this, "无法连接服务，请检查服务地址和局域网连接", Toast.LENGTH_LONG).show();
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                progressBar.setProgress(progress);
                progressBar.setVisibility(progress >= 100 ? ProgressBar.GONE : ProgressBar.VISIBLE);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                if (!isSameOrigin(request.getOrigin(), Uri.parse(serverUrl))) {
                    request.deny();
                    return;
                }
                boolean requestsAudio = false;
                for (String resource : request.getResources()) {
                    requestsAudio |= PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource);
                    if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        request.deny();
                        return;
                    }
                }
                if (requestsAudio && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                        != PackageManager.PERMISSION_GRANTED) {
                    pendingPermissionRequest = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, AUDIO_PERMISSION_REQUEST);
                    return;
                }
                request.grant(request.getResources());
            }
        });
        webView.loadUrl(serverUrl);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == AUDIO_PERMISSION_REQUEST && pendingPermissionRequest != null) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                pendingPermissionRequest.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                pendingPermissionRequest.deny();
            }
            pendingPermissionRequest = null;
        }
    }

    private void showServerDialog() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("http://192.168.1.9:4026");
        input.setText(serverUrl);
        input.setSelectAllOnFocus(true);
        new AlertDialog.Builder(this)
                .setTitle("服务地址")
                .setView(input)
                .setNegativeButton("取消", null)
                .setPositiveButton("连接", (dialog, which) -> {
                    String candidate = input.getText().toString().trim().replaceAll("/+$", "");
                    if (!isAllowedServer(candidate)) {
                        Toast.makeText(this, "HTTP 仅允许局域网地址，公网服务请使用 HTTPS", Toast.LENGTH_LONG).show();
                        return;
                    }
                    serverUrl = candidate;
                    preferences.edit().putString("serverUrl", serverUrl).apply();
                    webView.loadUrl(serverUrl);
                })
                .show();
    }

    private boolean isAllowedServer(String value) {
        Uri uri = Uri.parse(value);
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (host == null || uri.getUserInfo() != null
                || uri.getPort() != -1 && (uri.getPort() < 1 || uri.getPort() > 65535)) return false;
        if ("https".equalsIgnoreCase(scheme)) return true;
        if (!"http".equalsIgnoreCase(scheme)) return false;
        String[] octets = host.split("\\.");
        if ("localhost".equalsIgnoreCase(host)) return true;
        if (octets.length != 4) return false;
        try {
            int first = Integer.parseInt(octets[0]);
            int second = Integer.parseInt(octets[1]);
            int third = Integer.parseInt(octets[2]);
            int fourth = Integer.parseInt(octets[3]);
            if (first > 255 || second > 255 || third > 255 || fourth > 255) return false;
            return first == 10 || first == 127 || first == 192 && second == 168
                    || first == 172 && second >= 16 && second <= 31;
        } catch (NumberFormatException error) {
            return false;
        }
    }

    private boolean isSameOrigin(Uri target, Uri origin) {
        return target.getScheme() != null && target.getScheme().equals(origin.getScheme())
                && target.getHost() != null && origin.getHost() != null
                && target.getHost().equalsIgnoreCase(origin.getHost())
                && target.getPort() == origin.getPort();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
