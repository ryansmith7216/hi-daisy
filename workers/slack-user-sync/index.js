async function logErrorToDB(env, errorMessage, errorType = 'Error') {
  try {
    const timestamp = new Date().toISOString();
    await env.DB_PRIMARY.prepare(
      `INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
       VALUES (?, ?, ?, ?)`
    ).bind(timestamp, 'slack-user-sync', errorMessage, errorType).run();
  } catch (dbError) {
    // Optional: handle logging failure
  }
}

async function decrypt(encryptedWithVersion, env, secretPrefix = 'INTERNAL_APIS_ENCRYPTION_SECRET_v') {
  const [encryptedBase64, version] = encryptedWithVersion.split('_v');
  if (!encryptedBase64 || !version) throw new Error('Invalid encrypted format or missing version.');

  const secretName = `${secretPrefix}${version}`;
  const secret = env[secretName];
  if (!secret) throw new Error(`Missing secret: ${secretName}`);

  const encryptedBytes = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
  const salt = encryptedBytes.slice(0, 16);
  const iv = encryptedBytes.slice(16, 28);
  const data = encryptedBytes.slice(28);

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "PBKDF2" }, false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

async function sendSlackGetRequest(url, bearerToken) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': `Bearer ${bearerToken}`
  };
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: headers
    });
    const data = await response.text();
    return data;
  } catch (err) {
    return 'Request failed: ' + err.message;
  }
}

async function updateSyncDueTimestamp(env, slackUserId, settingsMap, userRole) {
  const roleSettingMap = {
    'Support': 'slack_user_sync_frequency_support',
    'AdvancedSupport': 'slack_user_sync_frequency_advancedsupport',
    'Manager': 'slack_user_sync_frequency_manager',
    'Developer': 'slack_user_sync_frequency_developer'
  };
  const settingKey = roleSettingMap[userRole];

  if (!settingKey || !settingsMap[settingKey]) {
    throw new Error("Missing sync frequency setting for role: " + userRole);
  }

  const syncHours = parseFloat(settingsMap[settingKey]);
  if (isNaN(syncHours)) throw new Error("Invalid sync frequency value.");

  const now = new Date();
  const syncDueAt = new Date(now.getTime() + syncHours * 60 * 60 * 1000).toISOString();

  await env.DB_PRIMARY.prepare(
    "UPDATE User SET SYNC_DUE_AT_TIMESTAMP = ? WHERE SLACK_USER_ID = ?"
  ).bind(syncDueAt, slackUserId).run();
}

async function markUserInactive(env, slackUserId) {
  const nowUtc = new Date().toISOString();
  await env.DB_PRIMARY.prepare(
    "UPDATE User SET USER_ROLE = ?, LAST_UPDATED = ? WHERE SLACK_USER_ID = ?"
  ).bind("Inactive", nowUtc, slackUserId).run();
}

async function triggerSlackAlertWorkflow(env, messageText) {
  const alertUrl = env.DB_PRIMARY.prepare(
    "SELECT SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME = ?"
  );
  const result = await alertUrl.bind("slack_error_alerts_workflow_url").first();

  if (!result || !result.SETTING_VALUE) {
    await logErrorToDB(env, "Missing slack_error_alerts_workflow_url setting", "Error");
    return;
  }

  const payload = JSON.stringify({
    message: messageText
  });

  await fetch(result.SETTING_VALUE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: payload
  });
}

async function handleSlackUserSync(env, slackUserId, userRow, settingsMap, slackToken) {
  const slackUserInfoUrl = settingsMap["slack_api_get_user_info_url"] + "?user=" + slackUserId;
  const result = await sendSlackGetRequest(slackUserInfoUrl, slackToken);
  if (settingsMap['error_debug_logs'] === 'TRUE') {
    await logErrorToDB(env, "Attempt to fetch user from Slack | Method: GET | URL: " + slackUserInfoUrl + " | Response: " + result, "Debug");
  }  

  let slackResponse;
  try {
    slackResponse = JSON.parse(result);
  } catch (parseError) {
    await logErrorToDB(env, "Slack response parsing failed: " + parseError.message, "Error");
    await setSlackSyncBypass(env);
    return { status: "error", message: "parse_failed" };
  }  

  if (!slackResponse.ok) {
    const errorMsg = slackResponse.error || "Unknown Slack error";
    await logErrorToDB(env, "Slack API Response: " + errorMsg + " | Name: " + userRow.FIRST_LAST + " | User Id: " + slackUserId, "Error");
  
    if (["invalid_auth", "not_authed", "ratelimited", "internal_error", "timeout", "unknown_error"].includes(errorMsg)) {
      await setSlackSyncBypass(env);
      return { status: "error", message: "slack_api_failure" };
    }
  
    if (errorMsg === "user_not_found") {
      if (userRow.USER_ROLE === "Developer") {
        await triggerSlackAlertWorkflow(env,
          "\nWorker: slack-user-sync" +
          "\nMessage: Developer user " + userRow.FIRST_LAST + " (ID " + slackUserId + ") was not found in Slack" +
          "\nAction Needed: Correct or make inactive as soon as possible"
        );
        return { status: "alert_triggered" };
      } else {
        await markUserInactive(env, slackUserId);
        return { status: "marked_inactive" };
      }
    }
    return { status: "no_action", message: errorMsg };
  }

  const isActive = !slackResponse.user?.deleted;
  if (!isActive) {
    if (userRow.USER_ROLE === "Developer") {
      await triggerSlackAlertWorkflow(env,
        "\nWorker: slack-user-sync" +
        "\nMessage: Developer user " + userRow.FIRST_LAST + " (ID " + slackUserId + ") is not active in Slack" +
        "\nAction Needed: Correct or make inactive as soon as possible"
      );
      return { status: "alert_triggered" };
    } else {
      await markUserInactive(env, slackUserId);
      return { status: "marked_inactive" };
    }
  }

  try {
    await updateSyncDueTimestamp(env, slackUserId, settingsMap, userRow.USER_ROLE);
    return { status: "sync_timestamp_updated" };
  } catch (err) {
    await logErrorToDB(env, "Failed to update sync timestamp: " + err.message + " | User Id: " + slackUserId, "Error");
    return { status: "error", message: "sync_update_failed" };
  }
}

async function setSlackSyncBypass(env) {
  const nowUtc = new Date().toISOString();
  await env.DB_PRIMARY.prepare(
    "UPDATE Settings SET SETTING_VALUE = ?, LAST_UPDATED = ? WHERE DB_SETTING_NAME = ?"
  ).bind("TRUE", nowUtc, "bypass_slack_user_sync").run();
}

export default {
  async fetch(request, env, ctx) {

    const url = new URL(request.url);
    const normalizedPath = url.pathname;
    if (normalizedPath === '/health') {
      if (request.method !== 'GET') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: {
            'Allow': 'GET',
            'Content-Type': 'text/plain',
          },
        });
      }
      return new Response('OK', { status: 200 });
    }

    const allowedMethods = ['POST'];
    if (!allowedMethods.includes(request.method)) {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { 'Allow': allowedMethods.join(', '), 'Content-Type': 'text/plain' },
      });
    }

    const contentType = request.headers.get('Content-Type');
    const authHeader = request.headers.get('Authorization');

    if (!contentType || contentType !== 'application/json') {
      return new Response('Bad Request: Content-Type must be application/json', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
      });
    }

    try {
      const settingsQuery = await env.DB_PRIMARY.prepare(
        "SELECT DB_SETTING_NAME, SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME IN (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        'internal_api_key',
        'error_debug_logs',
        'slack_api_get_user_info_url',
        'slack_bot_token',
        'slack_user_sync_frequency_support',
        'slack_user_sync_frequency_advancedsupport',
        'slack_user_sync_frequency_manager',
        'slack_user_sync_frequency_developer'
        ).all();

      const settingsMap = {};
      for (const row of settingsQuery.results) {
        settingsMap[row.DB_SETTING_NAME] = row.SETTING_VALUE;
      }

      const encryptedKey = settingsMap['internal_api_key'];
      if (!encryptedKey) {
        return new Response('Internal Server Error: internal_api_key not found in settings.', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      let decryptedKey;
      try {
        decryptedKey = await decrypt(encryptedKey, env);
      } catch (err) {
        await logErrorToDB(env, 'Decryption failed: ' + err.message, 'Error');
        return new Response('Internal Server Error: Failed to decrypt internal_api_key.', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      let decryptedSlackToken;
      try {
        decryptedSlackToken = await decrypt(settingsMap['slack_bot_token'], env, 'SLACK_APIS_ENCRYPTION_SECRET_v');
      } catch (err) {
        await logErrorToDB(env, 'Slack token decryption failed: ' + err.message, 'Error');
        return new Response('Internal Server Error: Failed to decrypt slack_bot_token.', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }      

      const token = authHeader.slice(7);
      if (token !== decryptedKey) {
        return new Response('Unauthorized: Token does not match internal_api_key.', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
        });
      }

      const body = await request.json();
      if (!body.SLACK_USER_ID || typeof body.SLACK_USER_ID !== 'string') {
        return new Response('Bad Request: Missing or invalid SLACK_USER_ID', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      
      const userRow = await env.DB_PRIMARY.prepare(
        "SELECT USER_ROLE, FIRST_LAST FROM User WHERE SLACK_USER_ID = ?"
      ).bind(body.SLACK_USER_ID).first();
      
      if (!userRow) {
        return new Response(JSON.stringify({ error: "User not found in database." }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (userRow.USER_ROLE === "Inactive") {
        return new Response(JSON.stringify({ error: "User is inactive in the database." }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (userRow.USER_ROLE === "Guest") {
        return new Response(JSON.stringify({ error: "Guest users are not synced with Slack." }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (settingsMap['error_debug_logs'] === 'TRUE') {
        await logErrorToDB(env, "Manual slack user sync check started for User Id: " + body.SLACK_USER_ID, "Debug");
      }

      const result = await handleSlackUserSync(env, body.SLACK_USER_ID, userRow, settingsMap, decryptedSlackToken);

      if (result.status === "error") {
        return new Response("Internal Server Error: " + result.message, {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        });
      }
      
      return new Response(JSON.stringify({
        active: result.status === "sync_timestamp_updated",
        action_taken: result.status
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      
            
    } catch (err) {
      await logErrorToDB(env, 'Unexpected error: ' + err.message, 'Error');
      return new Response('Internal Server Error: Unexpected failure.', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  },

  async scheduled(event, env, ctx) {

    const bypassQuery = await env.DB_PRIMARY.prepare(
      "SELECT SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME = ?"
    ).bind("bypass_slack_user_sync").first();
    
    if (bypassQuery && bypassQuery.SETTING_VALUE === "TRUE") {
      await logErrorToDB(env, "Scheduled slack user sync was skipped because bypass was TRUE", "Cron");
      return;
    }
    
    await logErrorToDB(env, "Scheduled slack user sync check started", "Cron");
    const startTime = Date.now();
    const syncResults = {};    

    const settingsQuery = await env.DB_PRIMARY.prepare(
      "SELECT DB_SETTING_NAME, SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME IN (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      "internal_api_key",
      "error_debug_logs",
      "slack_api_get_user_info_url",
      "slack_bot_token",
      "slack_user_sync_frequency_support",
      "slack_user_sync_frequency_advancedsupport",
      "slack_user_sync_frequency_manager",
      "slack_user_sync_frequency_developer",
      "slack_user_sync_cron_cap"
    ).all();
    
    const settingsMap = {};
    for (const row of settingsQuery.results) {
      settingsMap[row.DB_SETTING_NAME] = row.SETTING_VALUE;
    }
    
    const userCapRaw = settingsMap["slack_user_sync_cron_cap"];
    if (!userCapRaw) {
      await logErrorToDB(env, "Missing slack_user_sync_cron_cap setting", "Error");
      return;
    }
    
    const userCap = parseInt(userCapRaw);
    if (isNaN(userCap) || userCap <= 0) {
      await logErrorToDB(env, "Invalid slack_user_sync_cron_cap value", "Error");
      return;
    }
    
    let decryptedSlackToken;
    try {
      decryptedSlackToken = await decrypt(settingsMap["slack_bot_token"], env, "SLACK_APIS_ENCRYPTION_SECRET_v");
    } catch (err) {
      await logErrorToDB(env, "Slack token decryption failed: " + err.message, "Error");
      return;
    }    

    const userQuery = await env.DB_PRIMARY.prepare(
      "SELECT SLACK_USER_ID, FIRST_LAST, USER_ROLE FROM User WHERE SLACK_USER_ID != '' AND USER_ROLE NOT IN (?, ?) AND (SYNC_DUE_AT_TIMESTAMP IS NULL OR SYNC_DUE_AT_TIMESTAMP = '' OR SYNC_DUE_AT_TIMESTAMP < CURRENT_TIMESTAMP) LIMIT ?"
      ).bind("Inactive", "Guest", userCap).all();
    
    if (!userQuery || !userQuery.results || userQuery.results.length === 0) {
      if (settingsMap['error_debug_logs'] === 'TRUE') {
        await logErrorToDB(env, "No users found for scheduled sync", "Debug");
      }
    }    

    for (const user of userQuery.results) {
      try {
        const result = await handleSlackUserSync(env, user.SLACK_USER_ID, user, settingsMap, decryptedSlackToken);
        syncResults[user.FIRST_LAST] = result.status;
        if (settingsMap['error_debug_logs'] === 'TRUE') {
          await logErrorToDB(env, "Scheduled sync result for user: " + user.FIRST_LAST + " (" + user.SLACK_USER_ID + ") - " + result.status, "Debug");
        }        
      } catch (err) {
        syncResults[user.FIRST_LAST] = "error";
        await logErrorToDB(env, "Scheduled sync failed for user: " + user.FIRST_LAST + " (" + user.SLACK_USER_ID + ") - " + err.message, "Error");
      }
    }        

    const endTime = Date.now();
    const runTimeMs = endTime - startTime;
    syncResults["runTime"] = runTimeMs + "ms";
    
    const completedMessage = Object.keys(syncResults).length === 1 && syncResults["runTime"]
    ? "Scheduled slack user sync check completed: No users found for scheduled sync. " + JSON.stringify(syncResults)
    : "Scheduled slack user sync check completed: " + JSON.stringify(syncResults);
  
  await logErrorToDB(env, completedMessage, "Cron");  
  }
};
