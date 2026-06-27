// ==================== CONFIGURATION ====================
// Write your numeric Telegram ID here (e.g., "123456789") to activate the Admin Panel.
// You can obtain your numeric ID using bots like @userinfobot on Telegram.
const CONFIG_ADMIN_TELEGRAM_ID = "123456789"; 
// =======================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const update = await request.json();

      if (update.message) {
        await handleMessage(env, update.message);
      } 
      else if (update.callback_query) {
        await handleCallbackQuery(env, update.callback_query);
      }
    } catch (error) {
      console.error("Worker lifecycle error:", error);
    }

    return new Response("OK", { status: 200 });
  }
};

/**
 * Validates whether the interacting user has administrator privileges
 */
function checkIsAdmin(userId, env) {
  const hardcodedId = String(CONFIG_ADMIN_TELEGRAM_ID).replace(/['"]/g, "").trim();
  
  if (hardcodedId && hardcodedId !== "123456789" && hardcodedId !== "") {
    return String(userId) === hardcodedId;
  }

  if (env.ADMIN_TELEGRAM_ID) {
    const cleanAdminId = String(env.ADMIN_TELEGRAM_ID).replace(/['"]/g, "").trim();
    return String(userId) === cleanAdminId;
  }

  return false;
}

/**
 * Registers system commands with the Telegram interface
 */
async function registerSlashCommands(botToken) {
  const url = `https://api.telegram.org/bot${botToken}/setMyCommands`;
  const payload = {
    commands: [
      { command: "start", description: "Initialize the interface / Authenticate" },
      { command: "help", description: "Display system documentation" },
      { command: "end", description: "Terminate current active session" }
    ]
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error("Command registration failed:", error);
  }
}

/**
 * Processes incoming text messages and menu selections
 */
async function handleMessage(env, message) {
  const userId = message.from.id;
  const username = message.from.username || null;
  const chatId = message.chat.id;
  const text = message.text ? message.text.trim() : "";

  try {
    let user = await getUserRecord(env.KV, userId, username);

    if (user.banned) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "❌ *Access Restricted:* This account has been restricted by the system administrator.");
      return;
    }

    await updateActiveUserTracking(env.KV, userId);

    user.username = username;
    user.lastActive = Date.now();
    await env.KV.put(`user:${String(userId).trim()}`, JSON.stringify(user));

    if (text) {
      await storeUserMessage(env.KV, userId, text);
    }

    const lockTimeLeft = await getLockoutTimeLeft(env.KV, userId);
    if (lockTimeLeft > 0) {
      const waitText = formatDuration(lockTimeLeft);
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `🔒 *Security Lockout Active:* Multiple invalid attempts detected. Please retry in *${waitText}*.`
      );
      return;
    }

    if (text.startsWith("/start") || text.startsWith("/help")) {
      await registerSlashCommands(env.TELEGRAM_BOT_TOKEN);
    }

    if (text === "/end") {
      user.authUntil = null;
      await env.KV.put(`user:${String(userId).trim()}`, JSON.stringify(user));
      await setSessionStep(env.KV, userId, "idle");
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "🔒 *Session Terminated:* Your session has been safely closed. Submit /start to re-authenticate.",
        { remove_keyboard: true }
      );
      return;
    }

    if (text === "/help") {
      const helpText = "<b>Cloudflare Quota Monitor Bot</b>\n\n" +
        "This bot tracks and displays the remaining API requests for your Cloudflare Workers.\n\n" +
        "<b>Integration Guide:</b>\n\n" +
        "1. Select <b>➕ Add API Key</b> from the menu.\n" +
        "2. Provide a custom label to identify your configuration.\n" +
        "3. Input your Cloudflare <b>Account ID</b> (located on the right sidebar of the Workers & Pages dashboard).\n" +
        "4. Generate a secure API Token with the following steps:\n\n" +
        "   • Navigate to your Cloudflare Dashboard Profile.\n" +
        "   • Select <b>API Tokens</b> → <b>Create Token</b>.\n" +
        "   • Select <b>Create Custom Token</b>.\n" +
        "   • Assign the following permission:\n\n" +
        "     <b>Account → Account Analytics → Read</b>\n\n" +
        "   • Define the scope (All Accounts or a specific Account) under the <b>Include</b> section.\n" +
        "   • Save and copy the generated token.\n\n" +
        "Once configured, the system will query and monitor your remaining API request limits.";
      
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, helpText, null, "HTML");
      return;
    }

    const isAuthorized = user.authUntil && Date.now() < user.authUntil;
    const session = await getSessionState(env.KV, userId);

    if (!isAuthorized) {
      if (session.step === "AWAITING_PASSWORD") {
        await handlePasswordAttempt(env, user, text, chatId);
      } else {
        await setSessionStep(env.KV, userId, "AWAITING_PASSWORD");
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "🔑 *Identity Verification Required:*\n\nPlease enter the security password to unlock the dashboard:");
      }
      return;
    }

    const isAdmin = checkIsAdmin(userId, env);

    if (text === "⚙️ Admin Panel") {
      if (!isAdmin) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "❌ *Access Denied:* You do not have permission to view the administration panel.");
        return;
      }
      await displayAdminPanel(env, chatId);
      return;
    }

    if (text === "➕ Add API Key") {
      await setSessionStep(env.KV, userId, "ADD_CF_NAME");
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "➕ *Register Cloudflare API*\n\n*Step 1/3:* Please enter a descriptive name for this profile (e.g., `Production Web`):",
        { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cancel_add" }]] }
      );
      return;
    }

    if (text === "📊 Usage Metrics") {
      await displayRemainingRequests(env, chatId, userId);
      return;
    }

    if (text.startsWith("/start")) {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "👋 *Verification Successful:* Dashboard active. Please select an operation from the panel below:",
        makeMainMenuKeyboard(isAdmin)
      );
      await setSessionStep(env.KV, userId, "idle");
      return;
    }

    if (session.step === "ADD_CF_NAME") {
      if (!text) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ Input required. Please provide a valid custom profile name:");
        return;
      }
      session.tempData.name = text;
      await setSessionStep(env.KV, userId, "ADD_CF_ACCOUNT_ID", session.tempData);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "🔑 *Step 2/3:* Provide the Cloudflare *Account ID*:");
    } 
    else if (session.step === "ADD_CF_ACCOUNT_ID") {
      if (!text) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ Input required. Please provide a valid Cloudflare Account ID:");
        return;
      }
      session.tempData.accountId = text;
      await setSessionStep(env.KV, userId, "ADD_CF_TOKEN", session.tempData);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "🔑 *Step 3/3:* Provide the Cloudflare *API Token*:");
    } 
    else if (session.step === "ADD_CF_TOKEN") {
      if (!text) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ Input required. Please provide a valid API Token:");
        return;
      }
      const newApi = {
        id: crypto.randomUUID(),
        name: session.tempData.name,
        accountId: session.tempData.accountId,
        apiToken: text
      };
      const apis = await getSavedApis(env.KV, userId);
      apis.push(newApi);
      await env.KV.put(`cf_apis:${String(userId).trim()}`, JSON.stringify(apis));
      await setSessionStep(env.KV, userId, "idle");
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `✅ *Configuration Saved:* Profile "${newApi.name}" has been successfully registered.`,
        makeMainMenuKeyboard(isAdmin)
      );
    } 
    else if (session.step === "ADMIN_SET_NAME") {
      const targetUserId = session.tempData.targetUserId;
      if (!text) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ Input required. Please enter a valid display name:");
        return;
      }
      const targetUser = await getUserRecord(env.KV, targetUserId, null);
      targetUser.customName = text;
      await env.KV.put(`user:${String(targetUserId).trim()}`, JSON.stringify(targetUser));

      await setSessionStep(env.KV, userId, "idle");
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `✅ *Profile Updated:* Display label set to \`${text}\` for user \`${targetUserId}\`.`,
        makeMainMenuKeyboard(isAdmin)
      );
    }
    else if (session.step.startsWith("EDIT_CF_")) {
      const apiId = session.tempData.editingApiId;
      const apis = await getSavedApis(env.KV, userId);
      const index = apis.findIndex(a => a.id === apiId);

      if (index === -1) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ *Error:* Profile not found.");
        await setSessionStep(env.KV, userId, "idle");
        return;
      }

      if (session.step === "EDIT_CF_NAME") {
        apis[index].name = text;
      } else if (session.step === "EDIT_CF_ACCOUNT_ID") {
        apis[index].accountId = text;
      } else if (session.step === "EDIT_CF_TOKEN") {
        apis[index].apiToken = text;
      }

      await env.KV.put(`cf_apis:${String(userId).trim()}`, JSON.stringify(apis));
      await setSessionStep(env.KV, userId, "idle");
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `✅ *Success:* Parameter updated successfully.`,
        makeMainMenuKeyboard(isAdmin)
      );
    } 
    else if (session.step === "ADMIN_BROADCAST_WRITE") {
      if (!text) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ Transmission failed. Message body cannot be empty:");
        return;
      }

      const selectedRecipients = session.tempData.broadcastUsers || [];
      let successCounter = 0;
      let errorCounter = 0;

      for (const targetId of selectedRecipients) {
        try {
          const res = await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            targetId,
            `📢 *Global System Broadcast:*\n\n${text}`
          );
          if (res.ok) {
            successCounter++;
          } else {
            errorCounter++;
          }
        } catch (error) {
          console.error(`Broadcast failed for user ${targetId}:`, error);
          errorCounter++;
        }
      }

      await setSessionStep(env.KV, userId, "idle");
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `📢 *Broadcast Completed:*\n\n• Successfully Sent: *${successCounter}*\n• Failed / Unreachable: *${errorCounter}*`,
        makeMainMenuKeyboard(isAdmin)
      );
    }
    else {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "💡 Please utilize the dashboard menu to navigate active services:",
        makeMainMenuKeyboard(isAdmin)
      );
    }
  } catch (error) {
    console.error("Message processing exception:", error);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ An unexpected internal error occurred.");
  }
}

/**
 * Manages callback flows triggered from inline interfaces
 */
async function handleCallbackQuery(env, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  try {
    const user = await getUserRecord(env.KV, userId, callbackQuery.from.username);
    
    if (user.banned) {
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "❌ Access restricted.", true);
      return;
    }

    const isAuthorized = user.authUntil && Date.now() < user.authUntil;
    if (!isAuthorized) {
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "🔒 Session expired. Please re-authenticate.", true);
      return;
    }

    const isAdmin = checkIsAdmin(userId, env);

    if ((data.startsWith("admin_") || data.startsWith("sh_") || data.startsWith("msg_") || data.startsWith("edit_share_")) && !isAdmin) {
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "🚫 Administrative privileges required.", true);
      return;
    }

    user.lastActive = Date.now();
    await env.KV.put(`user:${String(userId).trim()}`, JSON.stringify(user));

    if (data === "cancel_add") {
      await setSessionStep(env.KV, userId, "idle");
      await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, "❌ Action cancelled.");
    } 
    else if (data === "remaining_reqs") {
      await displayRemainingRequests(env, chatId, userId, messageId);
    } 
    else if (data === "admin_panel") {
      await displayAdminPanel(env, chatId, messageId);
    } 
    else if (data.startsWith("admin_view:")) {
      const targetUserId = data.split(":")[1];
      await displayAdminUserDetail(env, chatId, messageId, targetUserId);
    } 
    else if (data.startsWith("admin_ban:")) {
      const targetUserId = data.split(":")[1];
      await setBanStatus(env, chatId, messageId, targetUserId, true);
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "Account Restricted.");
    } 
    else if (data.startsWith("admin_unban:")) {
      const targetUserId = data.split(":")[1];
      await setBanStatus(env, chatId, messageId, targetUserId, false);
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "Account Reinstated.");
    }
    else if (data.startsWith("admin_set_name_start:")) {
      const targetUserId = data.split(":")[1];
      await setSessionStep(env.KV, userId, "ADMIN_SET_NAME", { targetUserId });
      await editTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        messageId,
        `✏️ *Set Custom Display Name*\n\nPlease enter the new display name for user \`${targetUserId}\`:`,
        { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `admin_view:${targetUserId}` }]] }
      );
    }
    else if (data.startsWith("admin_delete_confirm:")) {
      const targetUserId = data.split(":")[1];
      const promptText = `⚠️ *Confirm Account Deletion:*\n\nAre you sure you want to permanently delete user \`${targetUserId}\` and all associated configurations? This action cannot be undone.`;
      const confirmButtons = [
        [
          { text: "🔥 Delete All Records", callback_data: `admin_delete_execute:${targetUserId}` },
          { text: "❌ Cancel", callback_data: `admin_view:${targetUserId}` }
        ]
      ];
      await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, promptText, { inline_keyboard: confirmButtons });
    }
    else if (data.startsWith("admin_delete_execute:")) {
      const targetUserId = String(data.split(":")[1]).trim();
      
      const keysToDelete = [
        `user:${targetUserId}`,
        `session_state:${targetUserId}`,
        `auth_state:${targetUserId}`,
        `cf_apis:${targetUserId}`,
        `shared_apis:${targetUserId}`,
        `user_messages:${targetUserId}`
      ];

      for (const key of keysToDelete) {
        await env.KV.delete(key);
      }

      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "All records successfully purged.", true);
      await displayAdminPanel(env, chatId, messageId);
    }
    else if (data.startsWith("msg_v:")) {
      const parts = data.split(":");
      const targetUserId = parts[1];
      const page = parseInt(parts[2] || "0", 10);
      await displayUserMessages(env, chatId, messageId, targetUserId, page);
    }
    else if (data.startsWith("msg_d:")) {
      const parts = data.split(":");
      const targetUserId = parts[1];
      const messageUUID = parts[2];
      const page = parseInt(parts[3] || "0", 10);

      const dbKey = `user_messages:${String(targetUserId).trim()}`;
      const raw = await env.KV.get(dbKey);
      if (raw) {
        let messages = JSON.parse(raw);
        messages = messages.filter(item => item.id !== messageUUID);
        await env.KV.put(dbKey, JSON.stringify(messages));
      }
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "Log entry deleted.");
      await displayUserMessages(env, chatId, messageId, targetUserId, page);
    }
    else if (data.startsWith("msg_da:")) {
      const targetUserId = data.split(":")[1];
      const dbKey = `user_messages:${String(targetUserId).trim()}`;
      await env.KV.delete(dbKey);
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "Message log cleared.");
      await displayUserMessages(env, chatId, messageId, targetUserId, 0);
    }
    else if (data === "sh_lst") {
      await displayAdminShareApisList(env, chatId, messageId);
    }
    else if (data.startsWith("sh_usr:")) {
      const apiId = data.split(":")[1];
      await displayAdminShareUsers(env, chatId, messageId, apiId);
    }
    else if (data.startsWith("sh_tg:")) {
      const parts = data.split(":");
      const apiId = parts[1];
      const targetUserId = parts[2];
      const adminId = String(CONFIG_ADMIN_TELEGRAM_ID).replace(/['"]/g, "").trim();

      const adminApis = await getSavedApis(env.KV, adminId);
      const targetApi = adminApis.find(a => a.id === apiId);

      if (targetApi) {
        let sharedList = await getSharedApis(env.KV, targetUserId);
        const existsIdx = sharedList.findIndex(a => a.id === apiId);

        if (existsIdx > -1) {
          sharedList.splice(existsIdx, 1);
        } else {
          sharedList.push(targetApi);
        }
        await env.KV.put(`shared_apis:${String(targetUserId).trim()}`, JSON.stringify(sharedList));
        await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "Sharing permission updated.");
      } else {
        await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "⚠️ Active parent configuration not found.", true);
      }
      await displayAdminShareUsers(env, chatId, messageId, apiId);
    }
    else if (data === "admin_broadcast_start") {
      const session = await getSessionState(env.KV, userId);
      session.tempData.broadcastUsers = [];
      await setSessionStep(env.KV, userId, "idle", session.tempData);
      await displayAdminBroadcastPanel(env, chatId, messageId, session);
    }
    else if (data.startsWith("admin_bc_toggle:")) {
      const targetUserId = data.split(":")[1];
      const session = await getSessionState(env.KV, userId);
      let selectedList = session.tempData.broadcastUsers || [];
      
      if (selectedList.includes(targetUserId)) {
        selectedList = selectedList.filter(id => id !== targetUserId);
      } else {
        selectedList.push(targetUserId);
      }

      session.tempData.broadcastUsers = selectedList;
      await setSessionStep(env.KV, userId, "idle", session.tempData);
      await displayAdminBroadcastPanel(env, chatId, messageId, session);
    }
    else if (data === "admin_bc_write") {
      const session = await getSessionState(env.KV, userId);
      const selectedList = session.tempData.broadcastUsers || [];
      if (selectedList.length === 0) {
        await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "⚠️ Select at least one recipient.", true);
        return;
      }
      await setSessionStep(env.KV, userId, "ADMIN_BROADCAST_WRITE", session.tempData);
      await editTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        messageId,
        `📢 *System Broadcast Composition*\n\nTargeting: *${selectedList.length}* user(s).\n\nPlease write the message to transmit:`,
        { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "admin_panel" }]] }
      );
    }
    else if (data.startsWith("edit_menu:")) {
      const apiId = data.split(":")[1];
      const apis = await getSavedApis(env.KV, userId);
      const api = apis.find(a => a.id === apiId);

      if (!api) {
        await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "⚠️ Configuration profile not found.", true);
        return;
      }

      const editPrompt = `✏ *Modify Account Details: ${api.name}*\n\nSelect a parameter to update:`;
      const editButtons = [
        [
          { text: "✏️ Edit Label", callback_data: `edit_cf_name:${apiId}` },
          { text: "✏️ Edit Account ID", callback_data: `edit_cf_account:${apiId}` }
        ],
        [
          { text: "✏️ Edit API Token", callback_data: `edit_cf_token:${apiId}` }
        ],
        [{ text: "⬅️ Back", callback_data: "remaining_reqs" }]
      ];
      await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, editPrompt, { inline_keyboard: editButtons });
    } 
    else if (data.startsWith("edit_cf_name:")) {
      const apiId = data.split(":")[1];
      await setSessionStep(env.KV, userId, "EDIT_CF_NAME", { editingApiId: apiId });
      await editTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        messageId,
        "✏️ *Update Label*\n\nPlease enter the new custom label for this profile:",
        { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `edit_menu:${apiId}` }]] }
      );
    }
    else if (data.startsWith("edit_cf_account:")) {
      const apiId = data.split(":")[1];
      await setSessionStep(env.KV, userId, "EDIT_CF_ACCOUNT_ID", { editingApiId: apiId });
      await editTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        messageId,
        "✏️ *Update Account ID*\n\nPlease enter the new Cloudflare *Account ID*:",
        { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `edit_menu:${apiId}` }]] }
      );
    }
    else if (data.startsWith("edit_cf_token:")) {
      const apiId = data.split(":")[1];
      await setSessionStep(env.KV, userId, "EDIT_CF_TOKEN", { editingApiId: apiId });
      await editTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        messageId,
        "✏️ *Update API Token*\n\nPlease enter the new Cloudflare *API Token*:",
        { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `edit_menu:${apiId}` }]] }
      );
    }
    else if (data.startsWith("delete_cf_confirm:")) {
      const apiId = data.split(":")[1];
      await displayDeleteConfirmation(env, chatId, messageId, userId, apiId);
    } 
    else if (data.startsWith("delete_cf_execute:")) {
      const apiId = data.split(":")[1];
      await executeDeleteCf(env, chatId, messageId, userId, apiId);
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "Configuration deleted.");
    }

    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id);
  } catch (error) {
    console.error("Callback processing exception:", error);
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQuery.id, "⚠️ Error handling dashboard event.", true);
  }
}

/**
 * Validates and processes access attempts
 */
async function handlePasswordAttempt(env, user, text, chatId) {
  const userId = user.id;
  const systemPassword = env.BOT_PASSWORD || "admin";
  const isAdmin = checkIsAdmin(userId, env);

  if (text === systemPassword) {
    user.successLogins = (user.successLogins || 0) + 1;
    user.authUntil = Date.now() + 24 * 60 * 60 * 1000;
    await env.KV.put(`user:${String(userId).trim()}`, JSON.stringify(user));

    const authState = await getAuthState(env.KV, userId);
    authState.failedAttempts = 0;
    await env.KV.put(`auth_state:${String(userId).trim()}`, JSON.stringify(authState));

    await setSessionStep(env.KV, userId, "idle");
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "✅ *Verification Successful:* Bot interface is now unlocked.",
      makeMainMenuKeyboard(isAdmin)
    );
  } else {
    const authState = await getAuthState(env.KV, userId);
    authState.failedAttempts += 1;

    if (authState.failedAttempts >= 3) {
      authState.failedAttempts = 0;
      authState.penaltyLevel = Math.min(4, (authState.penaltyLevel || 0) + 1);

      let durationMs = 0;
      if (authState.penaltyLevel === 1) durationMs = 1 * 60 * 1000;
      else if (authState.penaltyLevel === 2) durationMs = 5 * 60 * 1000;
      else if (authState.penaltyLevel === 3) durationMs = 60 * 60 * 1000;
      else durationMs = 24 * 60 * 60 * 1000;

      authState.lockUntil = Date.now() + durationMs;
      await env.KV.put(`auth_state:${String(userId).trim()}`, JSON.stringify(authState));

      const lockDurationText = formatDuration(durationMs);
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `❌ *Security Lockout:* Three invalid entries. Access locked for *${lockDurationText}*.`
      );
      await setSessionStep(env.KV, userId, "idle");
    } else {
      await env.KV.put(`auth_state:${String(userId).trim()}`, JSON.stringify(authState));
      const remainingAttempts = 3 - authState.failedAttempts;
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `❌ *Invalid Password:* Access denied. *${remainingAttempts}* attempts remaining.`
      );
    }
  }
}

/**
 * Updates the global cache with the latest active user ID
 */
async function updateActiveUserTracking(KV, userId) {
  await KV.put("global:last_active_user", String(userId));
}

/**
 * Handles quota queries and renders resource usage metrics
 */
async function displayRemainingRequests(env, chatId, userId, messageId = null) {
  const personalApis = await getSavedApis(env.KV, userId);
  const sharedApis = await getSharedApis(env.KV, userId);

  const mergedApis = [
    ...personalApis.map(api => ({ ...api, isShared: false })),
    ...sharedApis.map(api => ({ ...api, isShared: true }))
  ];

  if (mergedApis.length === 0) {
    const text = "⚠️ *Empty Configuration:* You do not have any Cloudflare API profiles saved.";
    const keyboard = {
      inline_keyboard: [
        [{ text: "➕ Add API Key", callback_data: "add_cf" }]
      ]
    };
    if (messageId) {
      await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, keyboard);
    } else {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, keyboard);
    }
    return;
  }

  let targetMessageId = messageId;
  if (!targetMessageId) {
    const loadingRes = await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "🔄 *Querying Cloudflare Analytics API...*");
    const loadingData = await loadingRes.json();
    targetMessageId = loadingData.result?.message_id;
  } else {
    await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, targetMessageId, "🔄 *Querying Cloudflare Analytics API...*");
  }

  const queryResults = await Promise.all(
    mergedApis.map(async (api) => {
      try {
        const usage = await getDailyWorkerUsage(api.accountId, api.apiToken);
        const limit = 100000;
        const remaining = Math.max(0, limit - usage);
        const percentage = Math.min(100, Math.max(0, (remaining / limit) * 100));
        return { ...api, remaining, limit, percentage, error: null };
      } catch (err) {
        return { ...api, error: err.message };
      }
    })
  );

  let msgText = "📊 *Resource Usage Summary*\n\n";
  const keyboardButtons = [];

  for (const item of queryResults) {
    const contextLabel = item.isShared ? " (Shared 👥)" : "";
    msgText += `🔹 *${item.name}${contextLabel}*\n`;
    if (item.error) {
      msgText += `⚠️ _Connection Error: ${item.error}_\n\n`;
    } else {
      const bar = makeProgressBar(item.percentage);
      const precisePercentage = item.percentage.toFixed(3);
      msgText += `\`[${bar}] ${precisePercentage}%\`\n`;
      msgText += `• Quota remaining: *${item.remaining.toLocaleString()}* / ${item.limit.toLocaleString()}\n\n`;
    }
    
    if (!item.isShared) {
      keyboardButtons.push([
        { text: `✏️ Edit ${item.name}`, callback_data: `edit_menu:${item.id}` },
        { text: `🗑️ Delete ${item.name}`, callback_data: `delete_cf_confirm:${item.id}` }
      ]);
    }
  }

  keyboardButtons.push([{ text: "🔄 Refresh Metrics", callback_data: "remaining_reqs" }]);

  await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, targetMessageId, msgText, { inline_keyboard: keyboardButtons });
}

/**
 * Handles profile deletion confirmation prompt
 */
async function displayDeleteConfirmation(env, chatId, messageId, userId, apiId) {
  const apis = await getSavedApis(env.KV, userId);
  const api = apis.find(a => a.id === apiId);

  if (!api) {
    await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, "⚠️ Configuration profile not found.");
    return;
  }

  const promptText = `⚠️ *Confirm Profile Removal:*\n\nAre you sure you want to delete the Cloudflare profile "*${api.name}*"?`;
  const confirmButtons = [
    [
      { text: "🔥 Delete Profile", callback_data: `delete_cf_execute:${apiId}` },
      { text: "❌ Cancel", callback_data: "remaining_reqs" }
    ]
  ];

  await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, promptText, { inline_keyboard: confirmButtons });
}

/**
 * Erases targeted Cloudflare configuration profile
 */
async function executeDeleteCf(env, chatId, messageId, userId, apiId) {
  let apis = await getSavedApis(env.KV, userId);
  apis = apis.filter(a => a.id !== apiId);
  await env.KV.put(`cf_apis:${String(userId).trim()}`, JSON.stringify(apis));

  await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, "✅ *Profile successfully removed.*", {
    inline_keyboard: [[{ text: "⬅️ Back", callback_data: "remaining_reqs" }]]
  });
}

/**
 * Lists registered system profiles inside administration module
 */
async function displayAdminPanel(env, chatId, messageId = null) {
  const listKeys = await env.KV.list({ prefix: "user:" });
  const buttons = [];

  for (const key of listKeys.keys) {
    const rawUserData = await env.KV.get(key.name);
    if (rawUserData) {
      const parsedUser = JSON.parse(rawUserData);
      const userIdFromKey = key.name.replace("user:", "").trim();
      const finalUserId = parsedUser.id || userIdFromKey;
      
      const buttonLabel = `ID: ${finalUserId}`;
      const isTargetAdmin = checkIsAdmin(finalUserId, env);
      const labelSuffix = isTargetAdmin ? " 👑" : "";

      buttons.push([{ text: `${buttonLabel}${labelSuffix}`, callback_data: `admin_view:${finalUserId}` }]);
    }
  }

  buttons.push([
    { text: "📢 Global Broadcast", callback_data: "admin_broadcast_start" },
    { text: "🔗 Manage Shared APIs", callback_data: "sh_lst" }
  ]);

  const adminText = "⚙️ *Administration Panel*\n\nListed below are the profiles authenticated with the system. Select an account to view its status card, manage restrictions, or purge its records:";
  const keyboard = { inline_keyboard: buttons };

  if (messageId) {
    await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, adminText, keyboard);
  } else {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, adminText, keyboard);
  }
}

/**
 * Renders target profile details for administrative audits
 */
async function displayAdminUserDetail(env, chatId, messageId, targetUserId) {
  const cleanTargetUserId = String(targetUserId).trim();
  const rawUserData = await env.KV.get(`user:${cleanTargetUserId}`);
  
  let user;
  if (!rawUserData) {
    user = {
      id: cleanTargetUserId,
      username: null,
      banned: false,
      successLogins: 0,
      lastActive: null
    };
  } else {
    user = JSON.parse(rawUserData);
    if (!user.id) {
      user.id = cleanTargetUserId;
    }
  }

  const statusString = user.banned ? "🚫 Restricted" : "✅ Active";
  const lastActiveText = user.lastActive ? new Date(user.lastActive).toLocaleString() : "Never";

  const idValueToShow = user.customName || user.id;
  const rawIdDetails = user.customName ? ` (Raw ID: \`${user.id}\`)` : "";

  const description = `👤 *Security Audit Profile*\n\n` +
                      `• *ID:* \`${idValueToShow}\`${rawIdDetails}\n` +
                      `• *Username:* ${user.username ? `@${user.username}` : "_None Available_"}\n` +
                      `• *Verified Access Count:* \`${user.successLogins || 0}\`\n` +
                      `• *Account Status:* ${statusString}\n` +
                      `• *Last Active:* _${lastActiveText}_`;

  const modificationButtons = [];
  const isTargetAdmin = checkIsAdmin(user.id, env);

  if (!isTargetAdmin) {
    if (user.banned) {
      modificationButtons.push([{ text: "✅ Reinstate User", callback_data: `admin_unban:${user.id}` }]);
    } else {
      modificationButtons.push([{ text: "🚫 Restrict User", callback_data: `admin_ban:${user.id}` }]);
    }
  }
  
  modificationButtons.push([{ text: "✏️ Assign Custom Label", callback_data: `admin_set_name_start:${user.id}` }]);

  if (!isTargetAdmin) {
    modificationButtons.push([{ text: "❌ Purge User Data", callback_data: `admin_delete_confirm:${user.id}` }]);
  }

  modificationButtons.push([{ text: "💬 View Activity Logs", callback_data: `msg_v:${user.id}:0` }]);
  modificationButtons.push([{ text: "⬅️ Back", callback_data: "admin_panel" }]);

  await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, description, { inline_keyboard: modificationButtons });
}

/**
 * Bans or reinstates user profiles in Database
 */
async function setBanStatus(env, chatId, messageId, targetUserId, mustBan) {
  const cleanTargetUserId = String(targetUserId).trim();
  const rawUserData = await env.KV.get(`user:${cleanTargetUserId}`);
  let user;
  if (rawUserData) {
    user = JSON.parse(rawUserData);
  } else {
    user = {
      id: cleanTargetUserId,
      username: null,
      successLogins: 0,
      lastActive: Date.now()
    };
  }
  user.banned = mustBan;
  if (mustBan) {
    user.authUntil = null;
  }
  await env.KV.put(`user:${cleanTargetUserId}`, JSON.stringify(user));
  await displayAdminUserDetail(env, chatId, messageId, cleanTargetUserId);
}

/**
 * Visualizes transaction logs securely
 */
async function displayUserMessages(env, chatId, messageId, targetUserId, page) {
  const cleanTargetUserId = String(targetUserId).trim();
  const rawMsgs = await env.KV.get(`user_messages:${cleanTargetUserId}`);
  const messages = rawMsgs ? JSON.parse(rawMsgs) : [];
  
  const rawUserData = await env.KV.get(`user:${cleanTargetUserId}`);
  const targetUser = rawUserData ? JSON.parse(rawUserData) : { id: cleanTargetUserId };
  
  const activeLabelName = targetUser.customName || (targetUser.username ? `@${targetUser.username}` : `ID: ${cleanTargetUserId}`);
  const userLabel = `${activeLabelName} (ID: ${cleanTargetUserId})`;

  const recordsPerPage = 5;
  const totalPages = Math.max(1, Math.ceil(messages.length / recordsPerPage));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));

  const startIdx = currentPage * recordsPerPage;
  const batch = messages.slice(startIdx, startIdx + recordsPerPage);

  let outputText = `💬 *Activity Log for ${userLabel}* (Page ${currentPage + 1}/${totalPages})\n\n`;
  const inlineRows = [];

  if (batch.length === 0) {
    outputText += "_No recorded transactions found in the database._";
  } else {
    batch.forEach((msg, idx) => {
      const realIndex = startIdx + idx;
      const formattedTime = new Date(msg.timestamp).toLocaleString();
      outputText += `*#${realIndex + 1}* [_${formattedTime}_]\n\`${msg.text}\`\n\n`;
      
      inlineRows.push([
        { text: `🗑️ Purge Entry #${realIndex + 1}`, callback_data: `msg_d:${cleanTargetUserId}:${msg.id}:${currentPage}` }
      ]);
    });

    inlineRows.push([
      { text: "🔥 Purge Log History", callback_data: `msg_da:${cleanTargetUserId}` }
    ]);
  }

  const navigationRow = [];
  if (currentPage > 0) {
    navigationRow.push({ text: "◀️ Prev", callback_data: `msg_v:${cleanTargetUserId}:${currentPage - 1}` });
  }
  navigationRow.push({ text: "⬅️ Back", callback_data: `admin_view:${cleanTargetUserId}` });
  if (currentPage < totalPages - 1) {
    navigationRow.push({ text: "Next ▶️", callback_data: `msg_v:${cleanTargetUserId}:${currentPage + 1}` });
  }
  inlineRows.push(navigationRow);

  await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, outputText, { inline_keyboard: inlineRows });
}

/**
 * Lists Cloudflare profiles available for distribution
 */
async function displayAdminShareApisList(env, chatId, messageId) {
  const adminId = String(CONFIG_ADMIN_TELEGRAM_ID).replace(/['"]/g, "").trim();
  const apis = await getSavedApis(env.KV, adminId);

  let text = "🔗 *API Access Sharing Console*\n\nSelect a configuration profile to delegate or revoke read-only sharing privileges:";
  const buttons = [];

  if (apis.length === 0) {
    text += "\n\n⚠️ _No registered API profiles found under your Admin ID. Add an API Key first._";
  } else {
    for (const api of apis) {
      buttons.push([{ text: `Manage: ${api.name}`, callback_data: `sh_usr:${api.id}` }]);
    }
  }

  buttons.push([{ text: "⬅️ Back", callback_data: "admin_panel" }]);
  await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, { inline_keyboard: buttons });
}

/**
 * Handles API credential profile sharing controls
 */
async function displayAdminShareUsers(env, chatId, messageId, apiId) {
  const listKeys = await env.KV.list({ prefix: "user:" });
  const buttons = [];
  const adminId = String(CONFIG_ADMIN_TELEGRAM_ID).replace(/['"]/g, "").trim();

  const adminApis = await getSavedApis(env.KV, adminId);
  const targetApi = adminApis.find(a => a.id === apiId);

  if (!targetApi) {
    await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, "⚠️ API Configuration profile not found.", {
      inline_keyboard: [[{ text: "⬅️ Back", callback_data: "sh_lst" }]]
    });
    return;
  }

  let text = `🔗 *Sharing Configuration: "${targetApi.name}"*\n\nDelegate read-only access to users below. Authorized users can monitor remaining request quotas but cannot view the underlying credentials:`;

  for (const key of listKeys.keys) {
    const rawUserData = await env.KV.get(key.name);
    if (rawUserData) {
      const parsedUser = JSON.parse(rawUserData);
      const userIdFromKey = key.name.replace("user:", "").trim();
      const finalUserId = parsedUser.id || userIdFromKey;

      if (String(finalUserId).trim() === adminId) continue;

      const shared = await getSharedApis(env.KV, finalUserId);
      const isAssigned = shared.some(a => a.id === apiId);
      const mark = isAssigned ? "✅" : "⬜";

      const activeLabelName = parsedUser.customName || (parsedUser.username ? `@${parsedUser.username}` : `ID: ${finalUserId}`);
      const label = `${activeLabelName} (ID: ${finalUserId})`;
      buttons.push([{
        text: `${mark} ${label}`,
        callback_data: `sh_tg:${apiId}:${finalUserId}`
      }]);
    }
  }

  buttons.push([{ text: "⬅️ Back", callback_data: "sh_lst" }]);
  await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, { inline_keyboard: buttons });
}

/**
 * Displays recipient checklist for global broadcasts
 */
async function displayAdminBroadcastPanel(env, chatId, messageId, session) {
  const listKeys = await env.KV.list({ prefix: "user:" });
  const buttons = [];
  const selectedList = session.tempData.broadcastUsers || [];

  let text = "📢 *Broadcast Distribution Console*\n\nToggle user checklists to specify recipients for this transmission:";

  for (const key of listKeys.keys) {
    const rawUserData = await env.KV.get(key.name);
    if (rawUserData) {
      const parsedUser = JSON.parse(rawUserData);
      const userIdFromKey = key.name.replace("user:", "").trim();
      const finalUserId = parsedUser.id || userIdFromKey;
      
      const isSelected = selectedList.includes(String(finalUserId).trim());
      const mark = isSelected ? "✅" : "⬜";

      const activeLabelName = parsedUser.customName || (parsedUser.username ? `@${parsedUser.username}` : `ID: ${finalUserId}`);
      const label = `${activeLabelName} (ID: ${finalUserId})`;
      buttons.push([{
        text: `${mark} ${label}`,
        callback_data: `admin_bc_toggle:${finalUserId}`
      }]);
    }
  }

  buttons.push([
    { text: "✍️ Write Message", callback_data: "admin_bc_write" },
    { text: "⬅️ Back", callback_data: "admin_panel" }
  ]);

  await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, { inline_keyboard: buttons });
}

/**
 * Handles GraphQL API aggregation for Worker requests
 */
async function getDailyWorkerUsage(accountId, apiToken) {
  const startDay = new Date();
  startDay.setUTCHours(0, 0, 0, 0);
  const sinceISO = startDay.toISOString();

  const endDay = new Date();
  endDay.setUTCHours(23, 59, 59, 999);
  const untilISO = endDay.toISOString();

  const gqlRequestPayload = {
    query: `
      query {
        viewer {
          accounts(filter: { accountTag: "${accountId}" }) {
            workersInvocationsAdaptive(
              limit: 10000,
              filter: {
                datetime_geq: "${sinceISO}",
                datetime_leq: "${untilISO}"
              }
            ) {
              sum {
                requests
              }
            }
          }
        }
      }
    `
  };

  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(gqlRequestPayload)
  });

  if (!response.ok) {
    throw new Error(`HTTP API Status code ${response.status}`);
  }

  const body = await response.json();
  if (body.errors && body.errors.length > 0) {
    throw new Error(body.errors[0].message);
  }

  const accountRecords = body.data?.viewer?.accounts;
  if (!accountRecords || accountRecords.length === 0) {
    return 0;
  }

  const aggregates = accountRecords[0].workersInvocationsAdaptive || [];
  let aggregateTotal = 0;
  for (const dataset of aggregates) {
    aggregateTotal += dataset.sum?.requests || 0;
  }

  return aggregateTotal;
}

/* ==========================================================
   STORAGE & UTILITY HELPER METHODS
   ========================================================== */

async function getUserRecord(KV, userId, username) {
  const cleanId = String(userId).trim();
  const value = await KV.get(`user:${cleanId}`);
  if (value) {
    const parsed = JSON.parse(value);
    if (!parsed.id) {
      parsed.id = cleanId;
    }
    return parsed;
  }
  
  return {
    id: cleanId,
    username: username,
    banned: false,
    successLogins: 0,
    authUntil: null,
    lastActive: Date.now(),
    customName: null
  };
}

async function getAuthState(KV, userId) {
  const cleanId = String(userId).trim();
  const value = await KV.get(`auth_state:${cleanId}`);
  if (value) return JSON.parse(value);
  return { failedAttempts: 0, lockUntil: null, penaltyLevel: 0 };
}

async function getSessionState(KV, userId) {
  const cleanId = String(userId).trim();
  const value = await KV.get(`session_state:${cleanId}`);
  if (value) return JSON.parse(value);
  return { step: "idle", tempData: {} };
}

async function setSessionStep(KV, userId, step, tempData = {}) {
  const cleanId = String(userId).trim();
  await KV.put(`session_state:${cleanId}`, JSON.stringify({ step, tempData }));
}

async function getSavedApis(KV, userId) {
  const cleanId = String(userId).trim();
  const value = await KV.get(`cf_apis:${cleanId}`);
  return value ? JSON.parse(value) : [];
}

async function getSharedApis(KV, userId) {
  const cleanId = String(userId).trim();
  const value = await KV.get(`shared_apis:${cleanId}`);
  return value ? JSON.parse(value) : [];
}

async function getLockoutTimeLeft(KV, userId) {
  const state = await getAuthState(KV, userId);
  if (state.lockUntil && Date.now() < state.lockUntil) {
    return state.lockUntil - Date.now();
  }
  return 0;
}

async function storeUserMessage(KV, userId, messageText) {
  const cleanId = String(userId).trim();
  const dbKey = `user_messages:${cleanId}`;
  const raw = await KV.get(dbKey);
  const list = raw ? JSON.parse(raw) : [];
  list.push({
    id: crypto.randomUUID(),
    text: messageText,
    timestamp: Date.now()
  });
  await KV.put(dbKey, JSON.stringify(list));
}

function makeMainMenuKeyboard(isAdmin) {
  const keyboardRows = [];
  if (isAdmin) {
    keyboardRows.push([{ text: "⚙️ Admin Panel" }]);
  }
  keyboardRows.push(
    [{ text: "➕ Add API Key" }, { text: "📊 Usage Metrics" }]
  );
  return {
    keyboard: keyboardRows,
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function makeProgressBar(percent) {
  const blocksCount = 10;
  const filledCount = Math.round(percent / 10);
  const emptyCount = blocksCount - filledCount;
  return "🟩".repeat(filledCount) + "⬜".repeat(emptyCount);
}

function formatDuration(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} seconds`;
  const minutes = Math.ceil(totalSeconds / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hours`;
}

async function sendTelegramMessage(botToken, chatId, text, replyMarkup = null, parseMode = "Markdown") {
  const payload = { chat_id: chatId, text, parse_mode: parseMode };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`Telegram sendMessage failed. Status: ${res.status}. Response: ${errorText}`);
  }

  return res;
}

async function editTelegramMessage(botToken, chatId, messageId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown" };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const res = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`Telegram editMessageText failed. Status: ${res.status}. Response: ${errorText}`);
  }

  return res;
}

async function answerCallbackQuery(botToken, callbackQueryId, text = "", showAlert = false) {
  const payload = { callback_query_id: callbackQueryId, text, show_alert: showAlert };
  return await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}