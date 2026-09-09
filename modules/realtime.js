/* ============================================================
 * 21-realtime.js
 * ============================================================ */

const _convMineCache = Object.create(null);
const _convMineNegAt = Object.create(null);
const CONV_NEG_TTL = 8000;

let _rtPaintList = false;
let _rtPaintChat = null;
let _rtPaintScheduled = false;
let _rtDirtyWhileHidden = false;

function _scheduleRealtimePaint(chat, needList) {
    if (needList) _rtPaintList = true;
    if (chat) _rtPaintChat = chat;

    if (document.visibilityState && document.visibilityState !== "visible") {
        _rtDirtyWhileHidden = true;
        return;
    }

    if (_rtPaintScheduled) return;
    _rtPaintScheduled = true;

    const run = () => {
        _rtPaintScheduled = false;
        const list = _rtPaintList;
        const c = _rtPaintChat;
        _rtPaintList = false;
        _rtPaintChat = null;
        try {
            if (c && state.activeChatId === c.id && typeof renderMessages === "function") {
                renderMessages(c);
            }
            if (list && typeof renderChatList === "function") renderChatList();
        } catch (err) {
            console.error("[ZChat] realtime paint:", err);
        }
    };

    if (window.__zchatPerf && typeof window.__zchatPerf.schedule === "function") {
        window.__zchatPerf.schedule(run);
    } else {
        requestAnimationFrame(run);
    }
}

if (typeof document !== "undefined" && !window.__zchatRtVisBound) {
    window.__zchatRtVisBound = true;
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible" || !_rtDirtyWhileHidden) return;
        _rtDirtyWhileHidden = false;
        const chat = state && state.chats
            ? state.chats.find((c) => c.id === state.activeChatId)
            : null;
        _scheduleRealtimePaint(chat || null, true);
    });
}

function isChatIdMine(chatId, meLower) {
    if (!chatId || !meLower) return false;
    if (chatId.startsWith("saved_")) {
        const uid = myUserIdCache || localStorage.getItem("zchat_user_id") || "";
        if (uid && chatId === ("saved_" + uid)) return true;
        if (chatId === ("saved_" + meLower)) return true;
        return false;
    }
    if (chatId.startsWith("chat_")) {
        const rest = chatId.slice(5);
        return rest === meLower || rest.startsWith(meLower + "_") || rest.endsWith("_" + meLower);
    }
    if (isUuid(chatId)) {
        if (conversationOtherName[chatId]) return true;
        if (state.chats.some((c) => c.id === chatId)) return true;
        return false;
    }
    return false;
}

async function isConversationMineAsync(chatId) {
    if (!isUuid(chatId) || !window.supabaseClient) return false;
    if (_convMineCache[chatId] === true) return true;
    if (_convMineCache[chatId] === false) {
        const t = _convMineNegAt[chatId] || 0;
        if (Date.now() - t < CONV_NEG_TTL) return false;
    }
    if (isChatIdMine(chatId, (currentUsername || "").toLowerCase())) {
        _convMineCache[chatId] = true;
        return true;
    }
    const myId = await getMyUserId();
    if (!myId) return false;
    try {
        const { data } = await window.supabaseClient
            .from("conversations")
            .select("id")
            .eq("id", chatId)
            .or(`user_1.eq.${myId},user_2.eq.${myId}`)
            .maybeSingle();
        const ok = !!(data && data.id);
        _convMineCache[chatId] = ok;
        if (!ok) _convMineNegAt[chatId] = Date.now();
        else delete _convMineNegAt[chatId];
        return ok;
    } catch (_) {
        return false;
    }
}

function resolveOtherNameFromChatId(chatId, me, senderUsername) {
    const meL = (me || "").toLowerCase();
    if (!chatId) return senderUsername && senderUsername.toLowerCase() !== meL ? senderUsername : "Chat User";
    if (chatId.startsWith("saved_")) return (currentUsername || localStorage.getItem("zchat_username") || me || "Me").trim();
    if (chatId.startsWith("chat_")) {
        const rest = chatId.slice(5);
        if (meL && rest.startsWith(meL + "_")) return rest.slice(meL.length + 1);
        if (meL && rest.endsWith("_" + meL)) return rest.slice(0, -(meL.length + 1));
        const other = rest.split("_").find((p) => p && p !== meL);
        if (other) return other;
    }
    if (isUuid(chatId) && conversationOtherName[chatId]) {
        return conversationOtherName[chatId];
    }
    if (senderUsername && senderUsername.toLowerCase() !== meL) return senderUsername;
    return "Chat User";
}

function _pushSorted(chat, item) {
    const arr = chat.messages;
    const n = arr.length;
    if (!n || item.createdAt >= arr[n - 1].createdAt) {
        arr.push(item);
        return;
    }
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].createdAt <= item.createdAt) lo = mid + 1;
        else hi = mid;
    }
    arr.splice(lo, 0, item);
}

async function _decryptRtText(raw, me) {
    let rtText = raw || "";
    if (!window.ZChatE2EE || !rtText) return rtText;
    try {
        await window.ZChatE2EE.ensureUserKeys(me);
        const priv = window.ZChatE2EE.getLocalPrivateKey();
        if (priv) {
            const plain = await window.ZChatE2EE.safeDecryptContent(rtText, priv);
            if (plain != null) rtText = plain;
        }
    } catch (_) {}
    return rtText;
}

function subscribeToMessages() {
    if (!window.supabaseClient) {
        console.warn("[ZChat] Realtime: supabaseClient missing");
        return;
    }

    const channel = window.supabaseClient
        .channel("zchat-messages-realtime")
        .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "messages" },
            async (payload) => {
                try {
                    const newMsg = payload.new;
                    if (!newMsg) return;

                    const me = (currentUsername || localStorage.getItem("zchat_username") || "").trim();
                    const meLower = me.toLowerCase();
                    const chatId = newMsg.chat_id;
                    if (!chatId || !meLower) return;

                    let mine = isChatIdMine(chatId, meLower);
                    if (!mine && isUuid(chatId)) {
                        mine = await isConversationMineAsync(chatId);
                    }
                    if (!mine) return;

                    if (String(chatId).startsWith("saved_")) {
                        const uid = myUserIdCache || localStorage.getItem("zchat_user_id") || "";
                        if (!((uid && chatId === ("saved_" + uid)) || chatId === ("saved_" + meLower))) return;
                    }

                    let chat = state.chats.find((c) => c.id === chatId);

                    if (!chat) {
                        let otherName;
                        if (String(chatId).startsWith("saved_")) {
                            otherName = me || "Me";
                        } else {
                            otherName = resolveOtherNameFromChatId(chatId, me, userIdToName[newMsg.sender_id] || null);
                            if (isUuid(chatId) && (otherName === "Chat User" || !otherName)) {
                                const myId = await getMyUserId();
                                const resolved = await resolveOtherNameFromConversationId(chatId, myId);
                                if (resolved) otherName = resolved;
                            }
                            if ((!otherName || otherName === "Chat User") &&
                                newMsg.sender_id &&
                                String(newMsg.sender_id) !== String(myIdNow())) {
                                const n = userIdToName[newMsg.sender_id] ||
                                    (await resolveUsernameByUserId(newMsg.sender_id));
                                if (n) otherName = n;
                            }
                        }
                        const selfNote = String(chatId).startsWith("saved_");
                        chat = {
                            id: chatId,
                            participant: {
                                id: uid("u"),
                                name: otherName || "Chat User",
                                online: true,
                                lastSeen: null,
                                isSelfNotes: selfNote,
                            },
                            unread: 0,
                            disappearingTime: "off",
                            blockScreenshots: false,
                            messages: [],
                        };
                        state.chats.unshift(chat);
                        if (otherName && !selfNote) {
                            fetchAvatarForUsername(otherName).then((row) => {
                                if (row) {
                                    applyAvatarFields(chat.participant, row);
                                    if (row.id) chat.participant.userId = row.id;
                                    _scheduleRealtimePaint(
                                        state.activeChatId === chat.id ? chat : null,
                                        true
                                    );
                                }
                            });
                        }
                    }

                    if (chat.messages.some((m) => m.id === newMsg.id)) return;

                    const ts = new Date(newMsg.created_at).getTime();
                    const isMineMsg = isRowFromMe(newMsg, myIdNow());

                    if (isMineMsg) {
                        const pending = [...chat.messages].reverse().find((m) =>
                            m.senderId === "me" &&
                            typeof m.id === "string" &&
                            (m.id.startsWith("m_") || m.status === "sending" || m.status === "delivered") &&
                            Math.abs((m.createdAt || 0) - ts) < 60000
                        );
                        if (pending) {
                            const oldId = pending.id;
                            pending.id = newMsg.id;
                            pending.status = "delivered";
                            const el = document.getElementById("msg-" + oldId);
                            if (el) {
                                el.id = "msg-" + newMsg.id;
                                el.dataset.msgId = String(newMsg.id);
                            }
                            if (typeof _msgPaint !== "undefined" && _msgPaint && String(_msgPaint.lastId) === String(oldId)) {
                                _msgPaint.lastId = newMsg.id;
                            }
                            if (typeof renderChatList === "function") renderChatList();
                            return;
                        }
                    }

                    const rtText = await _decryptRtText(newMsg.content || "", me);

                    _pushSorted(chat, {
                        id: newMsg.id,
                        senderId: isMineMsg ? "me" : (newMsg.sender_id || "other"),
                        text: rtText,
                        createdAt: ts,
                        status: isMineMsg ? "delivered" : "delivered",
                    });

                    if (state.activeChatId === chat.id) {
                        if (typeof chatHeaderName !== "undefined" && chatHeaderName) {
                            chatHeaderName.innerHTML =
                                escapeHtml(chat.participant.name) +
                                getVerifiedBadge(!!chat.participant.isVerified);
                        }
                        markChatAsRead(chat.id);
                        if (!isMineMsg && document.visibilityState !== "visible") {
                            const from = (chat.participant && chat.participant.name) || "Someone";
                            if (window.ZChatPush && window.ZChatPush.notifyLocal) {
                                window.ZChatPush.notifyLocal(from);
                            }
                        }
                        _scheduleRealtimePaint(chat, true);
                    } else if (!isMineMsg) {
                        chat.unread = (chat.unread || 0) + 1;
                        const from = (chat.participant && chat.participant.name) || "Someone";
                        if (window.ZChatPush && window.ZChatPush.notifyLocal) {
                            window.ZChatPush.notifyLocal(from);
                        }
                        _scheduleRealtimePaint(null, true);
                    } else {
                        _scheduleRealtimePaint(null, true);
                    }
                } catch (err) {
                    console.error("[ZChat] Realtime handler error:", err);
                }
            }
        )
        .on(
            "postgres_changes",
            { event: "UPDATE", schema: "public", table: "messages" },
            async (payload) => {
                try {
                    const updatedMsg = payload.new;
                    if (!updatedMsg) return;

                    const me = (currentUsername || localStorage.getItem("zchat_username") || "").trim();
                    const meLower = me.toLowerCase();
                    const chatId = updatedMsg.chat_id;
                    if (!chatId || !meLower) return;

                    if (!isChatIdMine(chatId, meLower) &&
                        !(typeof isUuid === "function" && isUuid(chatId) && state.chats.some((c) => c.id === chatId))) {
                        return;
                    }

                    const chat = state.chats.find((c) => c.id === chatId);
                    if (!chat) return;

                    const msg = chat.messages.find((m) => m.id === updatedMsg.id);
                    if (!msg) return;

                    let needRender = false;
                    if (updatedMsg.read_at && msg.status !== "read") {
                        msg.status = "read";
                        needRender = true;
                    }

                    const rawContent = updatedMsg.content || "";
                    if (rawContent) {
                        let plain = rawContent;
                        if (window.ZChatE2EE) {
                            try {
                                await window.ZChatE2EE.ensureUserKeys(me);
                                const priv = window.ZChatE2EE.getLocalPrivateKey();
                                if (priv) {
                                    const d = await window.ZChatE2EE.safeDecryptContent(rawContent, priv);
                                    if (d != null) plain = d;
                                }
                            } catch (_) {}
                        }
                        const stillCipher =
                            plain === rawContent &&
                            window.ZChatE2EE &&
                            typeof window.ZChatE2EE.looksLikeE2eePayload === "function" &&
                            window.ZChatE2EE.looksLikeE2eePayload(rawContent);
                        if (!stillCipher && plain !== msg.text) {
                            msg.text = plain;
                            msg.isEdited = true;
                            needRender = true;
                        }
                    }

                    if (needRender) {
                        if (msg.isEdited && state.activeChatId === chat.id) {
                            _scheduleRealtimePaint(chat, true);
                        } else {
                            _scheduleRealtimePaint(
                                state.activeChatId === chat.id ? chat : null,
                                true
                            );
                        }
                    }
                } catch (err) {
                    console.error("[ZChat] Realtime UPDATE handler error:", err);
                }
            }
        )
        .on(
            "postgres_changes",
            { event: "DELETE", schema: "public", table: "messages" },
            (payload) => {
                try {
                    const deletedId = payload.old && payload.old.id;
                    if (!deletedId) return;

                    for (const chat of state.chats) {
                        const idx = chat.messages.findIndex((m) => m.id === deletedId);
                        if (idx === -1) continue;

                        chat.messages.splice(idx, 1);
                        _scheduleRealtimePaint(
                            state.activeChatId === chat.id ? chat : null,
                            true
                        );
                        break;
                    }
                } catch (err) {
                    console.error("[ZChat] Realtime DELETE handler error:", err);
                }
            }
        )
        .subscribe((status) => {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                console.error("[ZChat] Realtime FAILED");
            }
        });

    return channel;
}
