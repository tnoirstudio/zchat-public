(function () {
    "use strict";

    const theme = localStorage.getItem("zchat_theme") || "dark";
    document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");

    const AVATAR_COLORS = ["#4F46E5", "#0284C7", "#16A34A", "#D97706", "#DC2626", "#9333EA", "#2563EB", "#0D9488"];
    function colorFor(seed) {
        let hash = 0;
        const s = String(seed || "");
        for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
        return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
    }
    function initials(name) {
        return (name || "")
            .split(" ")
            .filter(Boolean)
            .slice(0, 2)
            .map((n) => n[0].toUpperCase())
            .join("") || "?";
    }


    /* ---- Avatar display (giống ui-helpers / avatar-pin-clear): signed URL + cache ---- */
    const _avCache = Object.create(null);
    const _avInflight = Object.create(null);
    const AV_TTL = 6 * 24 * 3600 * 1000;

    function parseAvatarStoragePath(ref) {
        if (!ref) return null;
        const s = String(ref).trim();
        if (s.startsWith("storage:avatars/")) return s.slice("storage:avatars/".length).split("?")[0];
        if (s.startsWith("storage:")) {
            const rest = s.slice(8);
            const i = rest.indexOf("/");
            if (i > 0 && rest.slice(0, i) === "avatars") return rest.slice(i + 1).split("?")[0];
        }
        const pub = s.match(/\/storage\/v1\/object\/public\/avatars\/(.+?)(?:\?|$)/);
        if (pub) return decodeURIComponent(pub[1]);
        const sig = s.match(/\/storage\/v1\/object\/sign\/avatars\/(.+?)(?:\?|$)/);
        if (sig) return decodeURIComponent(sig[1]);
        return null;
    }

    function getCachedAvatarUrl(ref) {
        const key = parseAvatarStoragePath(ref) || String(ref || "").trim();
        if (!key) return null;
        const hit = _avCache[key];
        if (hit && hit.url && hit.exp > Date.now()) return hit.url;
        try {
            const raw = sessionStorage.getItem("zchat_avurl_" + key);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.url && parsed.exp > Date.now()) {
                    _avCache[key] = parsed;
                    return parsed.url;
                }
            }
        } catch (_) {}
        return null;
    }

    function setCachedAvatarUrl(ref, url) {
        const key = parseAvatarStoragePath(ref) || String(ref || "").trim();
        if (!key || !url) return;
        const entry = { url, exp: Date.now() + AV_TTL };
        _avCache[key] = entry;
        try { sessionStorage.setItem("zchat_avurl_" + key, JSON.stringify(entry)); } catch (_) {}
    }

    async function resolveAvatarDisplayUrl(ref) {
        if (!ref) return null;
        const s = String(ref).trim();
        if (/^https?:\/\//i.test(s) && !parseAvatarStoragePath(s)) return s;
        const cached = getCachedAvatarUrl(s);
        if (cached) return cached;
        const path = parseAvatarStoragePath(s);
        if (!path || !window.supabaseClient) {
            return /^https?:\/\//i.test(s) ? s : null;
        }
        if (_avInflight[path]) return _avInflight[path];
        _avInflight[path] = (async () => {
            try {
                const { data, error } = await window.supabaseClient.storage
                    .from("avatars")
                    .createSignedUrl(path, 3600 * 24 * 7);
                if (!error && data && data.signedUrl) {
                    setCachedAvatarUrl(s, data.signedUrl);
                    return data.signedUrl;
                }
            } catch (e) {
                console.warn("[ZChat] avatar signed URL:", e);
            } finally {
                delete _avInflight[path];
            }
            return /^https?:\/\//i.test(s) ? s : null;
        })();
        return _avInflight[path];
    }

    function renderProfileAvatarEl(el, opts) {
        if (!el) return;
        const username = opts.username || "Guest";
        const avatarType = opts.avatarType || "initials";
        const avatarColor = opts.avatarColor || colorFor(username);
        const avatarEmoji = opts.avatarEmoji || "😀";
        const avatarUrl = opts.avatarUrl || "";

        if (avatarType === "photo" && avatarUrl) {
            el.style.backgroundColor = "var(--elevated2)";
            const instant = getCachedAvatarUrl(avatarUrl);
            el.innerHTML = '<img src="' + (instant || "") + '" alt="Avatar" class="h-full w-full rounded-full object-cover" loading="lazy" decoding="async" />';
            if (!instant) {
                resolveAvatarDisplayUrl(avatarUrl).then((url) => {
                    const img = el.querySelector("img");
                    if (img && url) img.src = url;
                }).catch(() => {});
            }
        } else if (avatarType === "emoji") {
            el.style.backgroundColor = "var(--elevated2)";
            el.textContent = avatarEmoji;
        } else {
            el.style.backgroundColor = avatarColor;
            el.style.color = "var(--avatar-text)";
            el.textContent = initials(username);
        }
    }


    const av = document.getElementById("profileAvatar");
    if (av) {
        renderProfileAvatarEl(av, {
            username: (localStorage.getItem("zchat_username") || "?").trim(),
            avatarType: localStorage.getItem("zchat_avatar_type") || "initials",
            avatarColor: localStorage.getItem("zchat_avatar_color") || null,
            avatarEmoji: localStorage.getItem("zchat_avatar_emoji") || "😀",
            avatarUrl: localStorage.getItem("zchat_avatar_url") || "",
        });
    }

    if (window.lucide) window.lucide.createIcons();

    const frame = document.getElementById("tallyFrame");
    if (frame) {
        const src = frame.getAttribute("data-tally-src");
        if (src && !frame.getAttribute("src")) frame.setAttribute("src", src);
    }

    if (!window._tallyEmbedLoaded) {
        window._tallyEmbedLoaded = true;
        const s = document.createElement("script");
        s.src = "https://tally.so/widgets/embed.js";
        s.async = true;
        document.body.appendChild(s);
    }
})();
