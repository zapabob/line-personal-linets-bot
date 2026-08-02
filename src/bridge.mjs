import http from "node:http";
import fs from "node:fs";
import { URL } from "node:url";
import { loginWithAuthToken, loginWithPassword, loginWithQR } from "@evex/linejs";
import { FileStorage } from "@evex/linejs/storage";

function lineEnv(suffix, fallbackPersonal = true) {
  const direct = process.env[`LINEJS_PERSONAL_${suffix}`];
  if (direct) return direct;
  const useLegacy = /^(1|true|yes)$/i.test(process.env.LINEJS_PERSONAL_USE_LINE_PERSONAL_FALLBACK || "");
  return (fallbackPersonal && useLegacy) ? process.env[`LINE_PERSONAL_${suffix}`] : undefined;
}

const host = lineEnv("HOST", false) || "127.0.0.1";
const port = Number(lineEnv("PORT", false) || "9101");
const device = lineEnv("DEVICE") || "DESKTOPWIN";
const loginMode = (lineEnv("LOGIN_MODE", false) || "auto").toLowerCase();
const disableQrLogin = loginMode === "email_password" || loginMode === "password" || /^(1|true|yes)$/i.test(lineEnv("DISABLE_QR", false) || "");
const storagePath = lineEnv("STORAGE", false) || "./linejs-storage.json";
const allowedUsers = new Set((lineEnv("ALLOWED_USERS") || "").split(",").map(s => s.trim()).filter(Boolean));
const groupAdminMids = new Set((lineEnv("GROUP_ADMIN_MIDS") || lineEnv("GROUP_ADMINS") || "").split(",").map(s => s.trim()).filter(Boolean));
const allowedGroupMids = new Set((lineEnv("ALLOWED_GROUP_MIDS") || lineEnv("ALLOWED_GROUPS") || "").split(",").map(s => s.trim()).filter(Boolean));
const banlistPath = lineEnv("GROUP_BANLIST", false) || "./linejs-group-banlist.json";

// Auto-reply configuration
const autoReplyEnabled = /^(1|true|yes)$/i.test(lineEnv("AUTO_REPLY") || "1");
const autoReplyTriggers = (lineEnv("AUTO_REPLY_TRIGGERS") || "#はくあ,#hermesagent")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const autoReplyOnlyGroups = /^(1|true|yes)$/i.test(lineEnv("AUTO_REPLY_ONLY_GROUPS") || "1");
const autoReplyCooldownMs = Number(lineEnv("AUTO_REPLY_COOLDOWN_MS") || "5000");
const autoReplyWebhook = lineEnv("AUTO_REPLY_WEBHOOK") || "";
const autoReplyWebhookTimeoutMs = Number(lineEnv("AUTO_REPLY_WEBHOOK_TIMEOUT_MS") || "10000");

let client = null;
let loginState = "starting";
let loginError = null;
let profile = null;
let qrUrl = null;
let pinCode = null;
let startedAt = new Date().toISOString();
const events = [];
const lastReplyAt = new Map(); // chatMid -> timestamp
const sentMessageIds = new Set();
const messageAuthors = new Map(); // messageId -> { chatMid, fromMid }
const bannedByChat = new Map(); // chatMid -> Set<userMid>

function loadBanlist() {
  try {
    const raw = JSON.parse(fs.readFileSync(banlistPath, "utf8"));
    for (const [chatMid, mids] of Object.entries(raw || {})) {
      bannedByChat.set(chatMid, new Set(Array.isArray(mids) ? mids.filter(Boolean) : []));
    }
  } catch (_err) {}
}

function saveBanlist() {
  const out = {};
  for (const [chatMid, mids] of bannedByChat.entries()) out[chatMid] = [...mids];
  try { fs.writeFileSync(banlistPath, JSON.stringify(out, null, 2), "utf8"); } catch (_err) {}
}

loadBanlist();

function getReplyTargetId(message) {
  try {
    return message.raw?.relatedMessageId || message.getReplyTarget?.()?.id || null;
  } catch (_err) {
    return message.raw?.relatedMessageId || null;
  }
}

function rememberSentMessage(result) {
  const candidates = [
    result?.id,
    result?.messageId,
    result?.message?.id,
    result?.raw?.id,
    result?.[0]?.id,
    result?.[0]?.messageId,
    result?.[0]?.message?.id,
  ].filter(v => typeof v === "string" && v);
  for (const id of candidates) sentMessageIds.add(id);
  while (sentMessageIds.size > 300) sentMessageIds.delete(sentMessageIds.values().next().value);
  return candidates;
}

function rememberMessageAuthor(message, chatMid) {
  const id = message.raw?.id;
  const fromMid = getFromMid(message);
  if (id && fromMid) messageAuthors.set(id, { chatMid, fromMid });
  while (messageAuthors.size > 1000) messageAuthors.delete(messageAuthors.keys().next().value);
}

async function sendContextualReply(message, chatMid, text) {
  let result = null;
  try {
    result = await client.base.talk.sendMessage({ to: chatMid, text, relatedMessageId: message.raw?.id });
  } catch (_err) {
    result = await message.reply(text);
  }
  return rememberSentMessage(result);
}

function redactError(err) {
  const s = err && err.stack ? String(err.stack) : String(err);
  return s
    .replace(/(LINE_PERSONAL_(?:AUTH_TOKEN|PASSWORD|PASS|EMAIL|ADDRESS)=)[^\s]+/g, "$1<redacted>")
    .replace(/(LINEJS_PERSONAL_(?:AUTH_TOKEN|PASSWORD|PASS|EMAIL|ADDRESS)=)[^\s]+/g, "$1<redacted>")
    .slice(0, 4000);
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v));
}

function pushEvent(type, payload = {}) {
  const evt = jsonSafe({ at: new Date().toISOString(), type, ...payload });
  events.push(evt);
  while (events.length > 500) events.shift();
  console.log(JSON.stringify({ event: evt }));
}

process.on("unhandledRejection", (err) => {
  pushEvent("process:unhandled_rejection", { error: redactError(err) });
});

process.on("uncaughtException", (err) => {
  pushEvent("process:uncaught_exception", { error: redactError(err) });
});

// Sanitize text for safe logging - remove potential tokens/secrets
function sanitizeForLog(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/[A-Za-z0-9_\-]{20,}/g, "<redacted>") // Long alphanumeric strings that look like tokens
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<email>") // emails
    .slice(0, 200);
}

function getMidValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.id === "string") return value.id;
  return "";
}

function getChatMid(message) {
  return getMidValue(message.to) || message.raw?.to || "";
}

function getFromMid(message) {
  return getMidValue(message.from) || message.raw?.from || "";
}

// Check if message is in a group chat (LINE group MIDs start with 'c', rooms with 'r')
function isGroupChat(message) {
  const to = getChatMid(message);
  if (!to) return false;
  // Group mids typically start with 'c', room mids with 'r', user mids with 'u'
  return typeof to === "string" && (to.startsWith("c") || to.startsWith("r"));
}

// Check if message contains trigger tags
function hasTriggerTag(text) {
  if (!text || typeof text !== "string") return false;
  const lower = normalizeCommandText(text).toLowerCase();
  return autoReplyTriggers.some(trigger => lower.includes(trigger.toLowerCase()));
}

// Check cooldown for a chat
function canReply(chatMid, cooldownMs = autoReplyCooldownMs) {
  const now = Date.now();
  const last = lastReplyAt.get(chatMid) || 0;
  if (now - last < cooldownMs) return false;
  lastReplyAt.set(chatMid, now);
  return true;
}

function isConfiguredGroupAdmin(fromMid) {
  return Boolean(fromMid && (fromMid === profile?.mid || groupAdminMids.has(fromMid)));
}

function normalizeCommandText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[＃]/g, "#")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAdminCommand(message) {
  const text = normalizeCommandText(message.text);
  if (!text) return null;
  let action = null;
  const slash = text.match(/^(?:!|\/)(kick|ban|kickban|unban)\b/i);
  if (slash) action = slash[1].toLowerCase() === "kickban" ? "ban" : slash[1].toLowerCase();
  if (!action) {
    const m = text.match(/(?:#はくあ|#hermesagent)\s*(キック\s*\(\s*バン\s*\)|キックバン|kickban|キック|kick|バン|ban|解除|unban)/i);
    if (m) action = ({ "キック(バン)": "ban", "キックバン": "ban", "kickban": "ban", "キック": "kick", "バン": "ban", "解除": "unban" }[m[1].replace(/\s+/g, "")] || m[1].toLowerCase());
  }
  if (!action) return null;
  const explicitMids = [...text.matchAll(/\bu[a-f0-9]{32}\b/ig)].map(m => m[0]);
  let mentionedMids = [];
  try { mentionedMids = message.getMentions?.().map(m => m.mid).filter(Boolean) || []; } catch (_err) {}
  const replyTargetId = getReplyTargetId(message);
  const replyAuthor = replyTargetId ? messageAuthors.get(replyTargetId)?.fromMid : null;
  const targetMids = [...new Set([...explicitMids, ...mentionedMids, ...(replyAuthor ? [replyAuthor] : [])])];
  return { action, targetMids, replyTargetId };
}

async function getChat(chatMid) {
  if (typeof client.getChat === "function") return await client.getChat(chatMid);
  const chats = await client.fetchJoinedChats();
  return chats.find(c => c.mid === chatMid) || null;
}

async function kickFromChat(chatMid, targetMid) {
  const chat = await getChat(chatMid);
  if (chat?.kick) return await chat.kick(targetMid);
  return await client.base.talk.deleteOtherFromChat({ request: { chatMid, targetUserMids: [targetMid] } });
}

async function handleAdminCommand(message, chatMid, isGroup) {
  const cmd = parseAdminCommand(message);
  if (!cmd) return false;
  pushEvent("group_admin:candidate", { chatMid, from: getFromMid(message), action: cmd.action, hasReplyTarget: Boolean(cmd.replyTargetId), targetCount: cmd.targetMids.length });
  if (!isGroup) {
    await sendContextualReply(message, chatMid, "グループ管理コマンドはグループ内だけだよ。");
    return true;
  }
  const fromMid = getFromMid(message);
  if (!isConfiguredGroupAdmin(fromMid)) {
    await sendContextualReply(message, chatMid, "それは管理権限ある人だけね。");
    pushEvent("group_admin:denied", { chatMid, from: fromMid, action: cmd.action });
    return true;
  }
  if (!cmd.targetMids.length) {
    await sendContextualReply(message, chatMid, "対象の発言にリプライするか、対象MID/メンションを入れてね。");
    return true;
  }
  const banSet = bannedByChat.get(chatMid) || new Set();
  bannedByChat.set(chatMid, banSet);
  const results = [];
  for (const targetMid of cmd.targetMids) {
    try {
      if (targetMid === profile?.mid || targetMid === fromMid) throw new Error("refusing to target self/admin");
      if (cmd.action === "ban") banSet.add(targetMid);
      if (cmd.action === "unban") {
        banSet.delete(targetMid);
        results.push({ targetMid, ok: true, action: "unban" });
        continue;
      }
      await kickFromChat(chatMid, targetMid);
      results.push({ targetMid, ok: true, action: cmd.action });
    } catch (err) {
      results.push({ targetMid, ok: false, action: cmd.action, error: redactError(err).slice(0, 300) });
    }
  }
  saveBanlist();
  pushEvent("group_admin:command", { chatMid, from: fromMid, action: cmd.action, results });
  const ok = results.filter(r => r.ok).length;
  await sendContextualReply(message, chatMid, `${cmd.action}: ${ok}/${results.length}件処理したよ。`);
  return true;
}

async function enforceBanlist(message, chatMid, isGroup) {
  if (!isGroup) return false;
  const fromMid = getFromMid(message);
  if (!fromMid) return false;
  const banSet = bannedByChat.get(chatMid);
  if (!banSet?.has(fromMid)) return false;
  try {
    await kickFromChat(chatMid, fromMid);
    pushEvent("group_admin:ban_enforced", { chatMid, targetMid: fromMid });
  } catch (err) {
    pushEvent("group_admin:ban_enforce_error", { chatMid, targetMid: fromMid, error: redactError(err) });
  }
  return true;
}

const requiredSignature = " #はくあ #hermesagent";

function ensureRequiredSignature(text, maxLength = 5000) {
  text = String(text || "").trim();
  if (!text) text = "呼んだ？";
  if (text.includes("#はくあ") && text.toLowerCase().includes("#hermesagent")) {
    return text.slice(0, maxLength);
  }
  const bodyLimit = Math.max(1, maxLength - requiredSignature.length);
  return `${text.slice(0, bodyLimit).trim()}${requiredSignature}`.trim();
}

// Sanitize response text - no personal info
function sanitizeResponse(text) {
  if (!text || typeof text !== "string") return text;
  // First pass: redact key=value patterns for known secret keys
  text = text.replace(/(LINE(?:JS)?_PERSONAL_(?:AUTH_TOKEN|PASSWORD|PASS|EMAIL|ADDRESS)=)[^\s]+/gi, "$1<redacted>");
  // Second pass: redact other common secret patterns
  text = text.replace(/\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH_TOKEN|EMAIL|ADDRESS)\s*[=:]\s*[^\s]+/gi, "<redacted>");
  // Third pass: redact email addresses
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<redacted>");
  // Fourth pass: redact long alphanumeric strings that look like tokens (32+ chars)
  text = text.replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "<redacted>");
  return ensureRequiredSignature(text, 5000);
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(jsonSafe(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function statusPayload() {
  return {
    ok: true,
    startedAt,
    loginState,
    loginError,
    profile,
    auth: {
      authToken: Boolean(lineEnv("AUTH_TOKEN")),
      email: Boolean(lineEnv("EMAIL") || lineEnv("ADDRESS")),
      password: Boolean(lineEnv("PASSWORD") || lineEnv("PASS")),
      qrAvailable: Boolean(qrUrl),
      pinAvailable: Boolean(pinCode),
    },
    qrUrl,
    pinCode,
    device,
    allowedUsersConfigured: allowedUsers.size > 0,
    allowedGroupMids: [...allowedGroupMids],
    groupAdminConfigured: groupAdminMids.size > 0,
    banlistChats: bannedByChat.size,
    autoReply: {
      enabled: autoReplyEnabled,
      triggers: autoReplyTriggers,
      onlyGroups: autoReplyOnlyGroups,
      cooldownMs: autoReplyCooldownMs,
      webhookConfigured: Boolean(autoReplyWebhook),
      webhookTimeoutMs: autoReplyWebhookTimeoutMs,
    },
    eventCount: events.length,
  };
}

async function startLogin() {
  try {
    loginState = "logging_in";
    const storage = new FileStorage(storagePath);
    const init = { device, storage };
    const authToken = lineEnv("AUTH_TOKEN");
    const email = lineEnv("EMAIL") || lineEnv("ADDRESS");
    const password = lineEnv("PASSWORD") || lineEnv("PASS");
    if (authToken) {
      pushEvent("login:auth_token:start", { device });
      client = await loginWithAuthToken(authToken, init);
    } else if (email && password) {
      pushEvent("login:password:start", { device });
      client = await loginWithPassword({
        email,
        password,
        onPincodeRequest(pin) {
          pinCode = pin;
          pushEvent("login:pin", { pin });
        },
      }, init);
    } else if (disableQrLogin) {
      throw new Error("email_password_login_required: LINEJS_PERSONAL_EMAIL and LINEJS_PERSONAL_PASSWORD must be configured; QR login is disabled");
    } else {
      pushEvent("login:qr:start", { device });
      client = await loginWithQR({
        onReceiveQRUrl(url) {
          qrUrl = url;
          pushEvent("login:qr", { qrUrl: url });
        },
        onPincodeRequest(pin) {
          pinCode = pin;
          pushEvent("login:pin", { pin });
        },
      }, init);
    }
    profile = await client.getMyProfile().then(p => ({ mid: p.mid, displayName: p.displayName, statusMessage: p.statusMessage })).catch(() => null);
    loginState = "ready";
    pushEvent("login:ready", { profile });
    client.on("message", (message) => {
      const chatMid = getChatMid(message);
      const isGroup = isGroupChat(message);
      rememberMessageAuthor(message, chatMid);
      const evt = {
        messageId: message.raw?.id,
        text: sanitizeForLog(message.text),
        from: message.from,
        to: message.to,
        isMyMessage: message.isMyMessage,
        contentType: message.raw?.contentType,
        isGroup,
        replyTargetId: getReplyTargetId(message),
      };
      if (allowedUsers.size && evt.from?.id && !allowedUsers.has(evt.from.id)) {
        pushEvent("message:ignored", { from: evt.from, reason: "not_allowed" });
        return;
      }
      if (allowedGroupMids.size && (!isGroup || !allowedGroupMids.has(chatMid))) {
        pushEvent("message:ignored", { to: chatMid, reason: "group_not_allowed" });
        return;
      }
      pushEvent("message", evt);

      void (async () => {
        await enforceBanlist(message, chatMid, isGroup);
        const handledAdmin = await handleAdminCommand(message, chatMid, isGroup);
        if (handledAdmin) return;

        // Forward every non-self group message to the Go webhook server.
        // Go decides whether to reply (tag or reply-to-us) and sends via /send.
        if (!message.isMyMessage && isGroup) {
          forwardToGoWebhook(message, chatMid);
        }

        // Auto-reply logic (legacy; disabled - Go webhook now owns replies)
        if (false && autoReplyEnabled && message.text && !message.isMyMessage) {
          const hasTrigger = hasTriggerTag(message.text);
          const replyTargetId = getReplyTargetId(message);
          const isReplyToUs = Boolean(replyTargetId && sentMessageIds.has(replyTargetId));

          // Check conditions: group only (if enabled), has trigger tag or replies to our recent message.
          if ((!autoReplyOnlyGroups || isGroup) && (hasTrigger || isReplyToUs) && canReply(`${chatMid}:${replyTargetId || "tag"}`, isReplyToUs ? 30000 : autoReplyCooldownMs)) {
            let replyText = `呼んだ？`;

            // If webhook configured, call it for dynamic reply generation
            if (autoReplyWebhook) {
              (async () => {
                try {
                  const controller = new AbortController();
                  const timeoutId = setTimeout(() => controller.abort(), autoReplyWebhookTimeoutMs);
                  
                  const webhookPayload = {
                    message: {
                      text: sanitizeForLog(message.text),
                      from: message.from,
                      to: chatMid,
                      isGroup: isGroup,
                      isReply: Boolean(replyTargetId),
                      isReplyToUs: isReplyToUs,
                      replyTargetId: replyTargetId,
                      mid: message.raw?.id,
                    },
                    profile: profile,
                    trigger: autoReplyTriggers.find(t => message.text.toLowerCase().includes(t)) || (isReplyToUs ? "reply" : null),
                  };
                  
                  const response = await fetch(autoReplyWebhook, {
                    method: "POST",
                    headers: { "content-type": "application/json; charset=utf-8" },
                    body: JSON.stringify(webhookPayload),
                    signal: controller.signal,
                  });
                  
                  clearTimeout(timeoutId);
                  
                  if (response.ok) {
                    const data = await response.json();
                    if (data && typeof data.text === "string" && data.text.trim()) {
                      replyText = data.text;
                    }
                  } else {
                    pushEvent("auto_reply:webhook_error", { status: response.status, chatMid });
                  }
                } catch (err) {
                  pushEvent("auto_reply:webhook_error", { error: redactError(err), chatMid });
                }
                
                const safeReply = sanitizeResponse(replyText);
                sendContextualReply(message, chatMid, safeReply)
                  .then(sentIds => pushEvent("auto_reply", { to: chatMid, textPreview: safeReply.slice(0, 80), isGroup, trigger: hasTrigger, isReplyToUs, sentIds, dynamic: true }))
                  .catch(err => pushEvent("auto_reply:error", { to: chatMid, error: redactError(err) }));
              })();
              return; // Early return since async IIFE handles the reply
            }
            
            const safeReply = sanitizeResponse(replyText);
            
            sendContextualReply(message, chatMid, safeReply)
              .then(sentIds => pushEvent("auto_reply", { to: chatMid, textPreview: safeReply.slice(0, 80), isGroup, trigger: hasTrigger, isReplyToUs, sentIds, dynamic: false }))
              .catch(err => pushEvent("auto_reply:error", { to: chatMid, error: redactError(err) }));
          }
        }
      })().catch(err => pushEvent("message_pipeline:error", { error: redactError(err) }));
    });
    client.on("event", (event) => pushEvent("talk:event", { lineType: event.type }));
    client.on("call:incoming", (event) => pushEvent("call:incoming", { event }));
    client.on("call:cancel", (event) => pushEvent("call:cancel", { event }));
    client.listen({ talk: true, square: false });

    // Keep connection alive; auto re-login if token logs out.
    startKeepalive();
  } catch (err) {
    loginState = "error";
    loginError = redactError(err);
    pushEvent("login:error", { error: loginError });
  }
}

  // ---- Keepalive / auto re-login on token logout ----
  function startKeepalive() {
    setInterval(async () => {
      try {
        if (!client || loginState === "error") {
          pushEvent("login:relogin:attempt", { reason: "token_or_state_error" });
          await startLogin();
        }
      } catch (err) {
        pushEvent("login:relogin:error", { error: redactError(err) });
      }
    }, 20000);
  }

  // ---- Forward received group messages to Go webhook server ----
  const webhookForwardUrl = (lineEnv("WEBHOOK_FORWARD_URL") || "http://127.0.0.1:9102/webhook").trim();

  function forwardToGoWebhook(message, chatMid) {
    const payload = JSON.stringify({
      messageId: message.raw?.id,
      text: message.text,
      from: message.from,
      to: chatMid,
      isMyMessage: message.isMyMessage,
      isGroup: isGroupChat(message),
      replyTargetId: getReplyTargetId(message),
      isReplyToUs: false,
    });
    fetch(webhookForwardUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: payload,
    }).catch(err => pushEvent("webhook:forward_error", { error: redactError(err) }));
  }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/status") return sendJson(res, 200, statusPayload());
    if (req.method === "GET" && url.pathname === "/events") {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 20), 200));
      return sendJson(res, 200, { ok: true, events: events.slice(-limit) });
    }
    if (req.method === "GET" && url.pathname === "/chats") {
      if (!client || loginState !== "ready") return sendJson(res, 503, { ok: false, error: "not_ready", loginState });
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 50), 500));
      const chats = await client.fetchJoinedChats();
      return sendJson(res, 200, { ok: true, chats: chats.slice(0, limit).map(c => ({ mid: c.mid, name: c.name })) });
    }
    if (req.method === "POST" && url.pathname === "/send") {
      if (!client || loginState !== "ready") return sendJson(res, 503, { ok: false, error: "not_ready", loginState });
      const body = await parseBody(req);
      const to = String(body.to || "").trim();
      const text = sanitizeResponse(String(body.text || ""));
      const relatedMessageId = String(body.relatedMessageId || body.replyToMessageId || "").trim();
      if (!to || !text) return sendJson(res, 400, { ok: false, error: "to and text are required" });
      let result = null;

      try {
        if (relatedMessageId) {
          result = await client.base.talk.sendMessage({ to, text, relatedMessageId });
        } else {
          result = await client.sendCompactMessage(to, text);
        }
      } catch (compactError) {
        const payload = relatedMessageId
          ? { to, text, relatedMessageId }
          : { to, text, e2ee: body.e2ee !== false };
        result = await client.base.talk.sendMessage(payload);
      }
      const sentIds = rememberSentMessage(result);
      pushEvent("send", { to, textPreview: text.slice(0, 80), length: text.length, relatedMessageId: relatedMessageId || null, sentIds });

      return sendJson(res, 200, { ok: true, result, sentIds });
    }
    return sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: redactError(err) });
  }
});

server.listen(port, host, () => {
  pushEvent("server:ready", { host, port });
  void startLogin();
});

function shutdown() {
  pushEvent("server:shutdown");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (process.platform === "win32") process.on("SIGBREAK", shutdown);
