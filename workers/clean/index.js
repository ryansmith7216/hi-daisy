async function decrypt(encryptedWithVersion, env) {
  const [encryptedBase64, version] = encryptedWithVersion.split('_v');
  if (!encryptedBase64 || !version) {
    throw new Error('Invalid encrypted format or missing version.');
  }

  const secretName = `INTERNAL_APIS_ENCRYPTION_SECRET_v${version}`;
  const secret = env[secretName];
  if (!secret) {
    throw new Error(`Missing secret: ${secretName}`);
  }

  const encryptedBytes = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
  const salt = encryptedBytes.slice(0, 16);
  const iv = encryptedBytes.slice(16, 28);
  const data = encryptedBytes.slice(28);

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );

  return new TextDecoder().decode(decrypted);
}

// Logs errors or cron logs to the database
async function logErrorToDB(env, errorMessage, errorType = 'Error') {
  try {
    const timestamp = new Date().toISOString();
    await env.DB_PRIMARY.prepare(
      `INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
       VALUES (?, ?, ?, ?)`
    ).bind(timestamp, 'clean', errorMessage, errorType).run();
  } catch (dbError) {
    // Silently fail if logging fails
  }
}

export default {
  async fetch(request, env, ctx) {
    const allowedMethods = ['POST'];
    if (!allowedMethods.includes(request.method)) {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          'Allow': allowedMethods.join(', '),
          'Content-Type': 'text/plain',
        },
      });
    }
  
    const contentType = request.headers.get('Content-Type');
    const authHeader = request.headers.get('Authorization');

    if (!contentType ||
      contentType !== 'application/json') {
    return new Response('Bad Request: Content-Type must be application/json', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
  if (!authHeader ||
      !authHeader.startsWith('Bearer ')) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
    });
  }
  
    try {
      const settingsQuery = await env.DB_PRIMARY.prepare(
        "SELECT DB_SETTING_NAME, SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME IN (?, ?, ?, ?)"
      ).bind('internal_api_key', 'errors_max_days_age', 'slack_dashboard_max_hours_age', 'error_debug_logs').all();
  
      const settingsMap = {};
      for (const row of settingsQuery.results) {
        settingsMap[row.DB_SETTING_NAME] = row.SETTING_VALUE;
      }
  
      const encryptedKey = settingsMap['internal_api_key'];
      if (!encryptedKey) {
        throw new Error('Internal API key not found in settings.');
      }
      
      const decryptedKey = await decrypt(encryptedKey, env);
      const token = authHeader.slice(7);
      if (token !== decryptedKey) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
        });
      }      
  
      const path = new URL(request.url).pathname;
      const pathToSettingMap = {
        "/api/v1/clean/dashboard": "slack_dashboard_max_hours_age",
        "/api/v1/clean/errors": "errors_max_days_age"
      };
  
      const settingKey = pathToSettingMap[path];
      if (!settingKey) {
        return new Response("Not Found", {
          status: 404,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      let deletedCount = 0;
      if (settingsMap['error_debug_logs'] === 'TRUE') {
        await logErrorToDB(env, `Manual cleanup started for path: ${path}`, "Debug");
      }      
      
      if (settingKey === "errors_max_days_age") {
        const daysToKeep = parseInt(settingsMap[settingKey], 10);
        if (!isNaN(daysToKeep)) {
          const now = new Date();
          const cutoffDate = new Date(now.getTime() - daysToKeep * 24 * 60 * 60 * 1000);
          const cutoffISOString = cutoffDate.toISOString();
      
          const result = await env.DB_PRIMARY.prepare(
            "DELETE FROM Error WHERE ERROR_TIMESTAMP_UTC < ?"
          ).bind(cutoffISOString).run();
          deletedCount += result.meta.changes || 0;
        }
      }

      if (settingKey === "slack_dashboard_max_hours_age") {
        const hoursToKeep = parseInt(settingsMap[settingKey], 10);
        if (!isNaN(hoursToKeep)) {
          const now = Date.now();
          const cutoffUnix = Math.floor((now - hoursToKeep * 60 * 60 * 1000) / 1000);
      
          const result = await env.DB_PRIMARY.prepare(
            "DELETE FROM Dashboard WHERE MESSAGE_TIMESTAMP < ?"
          ).bind(cutoffUnix.toString()).run();
          deletedCount += result.meta.changes || 0;
        }
      }
      
      if (settingsMap['error_debug_logs'] === 'TRUE') {
        await logErrorToDB(env, `Manual cleanup completed for path: ${path} — ${deletedCount} rows deleted`, "Debug");
      }      
      
      return new Response('Success', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });      
  
    } catch (err) {
      console.error('Authorization error:', err);
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
      });
    }
  },
  async scheduled(event, env, ctx) {
    const startTime = Date.now();
    await logErrorToDB(env, "Scheduled cleanup started", "Cron");
  
    const settingsQuery = await env.DB_PRIMARY.prepare(
      "SELECT DB_SETTING_NAME, SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME IN (?, ?, ?)"
    ).bind('internal_api_key', 'errors_max_days_age', 'slack_dashboard_max_hours_age').all();
  
    const settingsMap = {};
    for (const row of settingsQuery.results) {
      settingsMap[row.DB_SETTING_NAME] = row.SETTING_VALUE;
    }
  
    let deletedErrors = 0;
    let deletedDashboard = 0;
  
    const daysToKeep = parseInt(settingsMap["errors_max_days_age"], 10);
    if (!isNaN(daysToKeep)) {
      const now = new Date();
      const cutoffDate = new Date(now.getTime() - daysToKeep * 24 * 60 * 60 * 1000);
      const cutoffISOString = cutoffDate.toISOString();
      const result = await env.DB_PRIMARY.prepare(
        "DELETE FROM Error WHERE ERROR_TIMESTAMP_UTC < ?"
      ).bind(cutoffISOString).run();
      deletedErrors += result.meta.changes || 0;
    }
  
    const hoursToKeep = parseInt(settingsMap["slack_dashboard_max_hours_age"], 10);
    if (!isNaN(hoursToKeep)) {
      const now = Date.now();
      const cutoffUnix = Math.floor((now - hoursToKeep * 60 * 60 * 1000) / 1000);
      const result = await env.DB_PRIMARY.prepare(
        "DELETE FROM Dashboard WHERE MESSAGE_TIMESTAMP < ?"
      ).bind(cutoffUnix.toString()).run();
      deletedDashboard += result.meta.changes || 0;
    }
  
    const runTime = `${Date.now() - startTime}ms`;
    const logMessage = `Scheduled cleanup completed: ${JSON.stringify({
      dashboard: `${deletedDashboard} rows deleted`,
      errors: `${deletedErrors} rows deleted`,
      runTime
    })}`;
  
    await logErrorToDB(env, logMessage, "Cron");
  }  
};
