async function decryptWithMap(encryptedWithVersion, env, secretPrefixMap, dbSettingName) {
  const [encryptedBase64, version] = encryptedWithVersion.split('_v');
  if (!encryptedBase64 || !version) {
    throw new Error('Invalid encrypted format or missing version.');
  }

  const mappedPrefix = secretPrefixMap[dbSettingName];
  if (!mappedPrefix) {
    throw new Error('Missing mapped prefix for DB_SETTING_NAME "' + dbSettingName + '"');
  }

  const secretName = mappedPrefix + '_v' + version;
  const secret = env[secretName];
  if (!secret) {
    throw new Error('Missing secret: ' + secretName);
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

async function encrypt(plainText, secret, versionTag) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

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
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plainText)
  );

  const encryptedBytes = new Uint8Array([
    ...salt,
    ...iv,
    ...new Uint8Array(encrypted),
  ]);

  const encryptedBase64 = btoa(String.fromCharCode(...encryptedBytes));
  return `${encryptedBase64}_${versionTag}`;
}

async function logUpdateToDB(env, request, recordIdentifier = '', logs = null, action = 'updated') {
  try {
    const timestamp = new Date().toISOString();
    const userAgent = request.headers.get('User-Agent') || 'Unknown';
    const method = request.method;
    const path = new URL(request.url).pathname;

    const errorType = logs?.ERROR_TYPE || 'API';
    const workerName = logs?.ERROR_WORKER_NAME || 'save';
    const message = logs?.ERROR_MESSAGE || 
      `API ${action} ${recordIdentifier || 'record'} | Method: ${method} | URI: ${path} | User Agent: ${userAgent}`;

    await env.DB_PRIMARY.prepare(
      `INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
       VALUES (?, ?, ?, ?)`
    ).bind(timestamp, workerName, message, errorType).run();
  } catch {
    // Optional: silently fail or add internal logging
  }
}

async function validateUserAuth(auth, env) {
  if (!auth?.SLACK_USER_ID || !auth?.SESSION_TOKEN) {
    return { valid: false, status: 400, message: 'Bad Request: Missing auth fields' };
  }
  const user = await env.DB_PRIMARY.prepare(
    `SELECT SESSION_TOKEN, USER_ROLE FROM User WHERE SLACK_USER_ID = ?`
  ).bind(auth.SLACK_USER_ID).first();
  if (!user) {
    return { valid: false, status: 404, message: 'You are not authorized to peform this action.' };
  }
  if (user.USER_ROLE === 'Inactive') {
    return { valid: false, status: 403, message: 'You are not authorized to peform this action.' };
  }
  if (user.SESSION_TOKEN !== auth.SESSION_TOKEN) {
    return { valid: false, status: 401, message: 'You are not authorized to peform this action.' };
  }
  return {
    valid: true,
    userRole: user.USER_ROLE
  };
}

export default {
  async fetch(request, env, ctx) {

    const host = request.headers.get('host');
    if (host && host.endsWith('.workers.dev')) {
      return new Response('Forbidden', { status: 403 });
    }
    
    const allowedRoutes = {
      'PATCH:/api/v1/save/settings': 'handleSettingsPatch',
      'PATCH:/api/v1/save/users': 'handleUsersPatch',
      'POST:/api/v1/save/users': 'handleUsersPost',
      'POST:/api/v1/save/users/reset': 'handleUsersReset',
      'PATCH:/api/v1/save/credentials': 'handleCredentialsPatch',
      'PATCH:/api/v1/save/credentials/rotate': 'handleCredentialRotatePatch',
      'PATCH:/api/v1/save/dashboard': 'handleDashboardPatch',
      'DELETE:/api/v1/save/dashboard': 'handleDashboardDelete',
      'POST:/api/v1/save/help': 'handleHelpPost',
      'PATCH:/api/v1/save/help': 'handleHelpPatch',
      'DELETE:/api/v1/save/help': 'handleHelpDelete',
      'POST:/api/v1/save/users/nuke': 'handleUsersNuke',
    };    

    const url = new URL(request.url);
    const path = url.pathname;
    const normalizedPath = path.toLowerCase();
    const blockedPaths = new Set(['/.git', '/.git/config', '/favicon.ico']);
    if (blockedPaths.has(normalizedPath) || normalizedPath.includes('/.git')) {
      return new Response('Not Found', { status: 404 });
    }
    
    const routeKey = `${request.method}:${url.pathname}`;

    if (!allowedRoutes.hasOwnProperty(routeKey)) {
      return new Response('Not Found: Route not allowed', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }    

    const contentType = request.headers.get('Content-Type');
    const authHeader = request.headers.get('Authorization') || '';

    if (!contentType || contentType !== 'application/json') {
      return new Response('Bad Request: Content-Type must be application/json', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    try {
      let body;

      try {
        body = await request.json();
      } catch {
        return new Response('Bad Request: Missing or invalid JSON body', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      let authCheck = null;

      if (body.auth) {
        // Logged-in portal user
        authCheck = await validateUserAuth(body.auth, env);

        if (!authCheck.valid) {
          return new Response(authCheck.message, {
            status: authCheck.status,
            headers: { 'Content-Type': 'text/plain' },
          });
        }

      } else {
        // Internal API / service request
        if (!authHeader.startsWith('Bearer ')) {
          return new Response('Unauthorized', {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer realm="Access to the internal API"'
            },
          });
        }

        const result = await env.DB_PRIMARY.prepare(
          "SELECT SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME = ?"
        ).bind('internal_api_key').first();

        if (!result || !result.SETTING_VALUE) {
          throw new Error('Internal API key not found in settings.');
        }

        const decryptedKey = await decrypt(result.SETTING_VALUE, env);
        const token = authHeader.slice(7);

        if (token !== decryptedKey) {
          return new Response('Unauthorized', {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer realm="Access to the internal API"'
            },
          });
        }
      }

      // Block guests from all cases
        if (authCheck?.userRole === 'Guest') {
          return new Response('Forbidden', {
            status: 403,
            headers: { 'Content-Type': 'text/plain' },
          });
        }

      // Route handling
      switch (routeKey) {
        case 'PATCH:/api/v1/save/settings': {
          if (authCheck && !['Developer', 'Manager'].includes(authCheck.userRole)) {
            return new Response('Forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          const { table, db_setting_name, updates } = body;
        
          if (table !== 'Settings') {
            return new Response('Bad Request: Table must be "Settings"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          if (!db_setting_name || typeof db_setting_name !== 'string') {
            return new Response('Bad Request: Missing or invalid "db_setting_name"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            return new Response('Bad Request: "updates" must be a non-empty object', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          const validColumns = ['SETTING_LABEL', 'SETTING_VALUE', 'PAGE_NAME', 'SETTING_DESCRIPTION', 'CATEGORY_NAME'];
          const updateKeys = Object.keys(updates);
        
          if (updateKeys.length === 0) {
            return new Response('Bad Request: No updates provided', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          // Add LAST_UPDATED timestamp in UTC ISO 8601 format (no milliseconds)
          const isoUtcTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
          updateKeys.push('LAST_UPDATED');
          updates['LAST_UPDATED'] = isoUtcTimestamp;
        
          // Check if SETTING_VALUE is being updated
        if (updateKeys.includes('SETTING_VALUE')) {
          try {
            const inputTypeCheck = await env.DB_PRIMARY.prepare(
              `SELECT INPUT_TYPE FROM Settings WHERE DB_SETTING_NAME = ?`
            ).bind(db_setting_name).first();
            
            if (!inputTypeCheck) {
              return new Response(`Bad Request: DB_SETTING_NAME \"${db_setting_name}\" not found for input type check`, {
                status: 400,
                headers: { 'Content-Type': 'text/plain' },
              });
            }
            
            if (String(inputTypeCheck.INPUT_TYPE).trim().toLowerCase() === 'masked') {
              return new Response(`Bad Request: Column \"SETTING_VALUE\" is not allowed to be updated`, {
                status: 400,
                headers: { 'Content-Type': 'text/plain' },
              });
            }      
          } catch (err) {
            return new Response(JSON.stringify({
              message: 'Internal Server Error: Failed to check INPUT_TYPE',
              error: err.message,
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }  
        }

        for (const key of updateKeys) {
          if (key === 'LAST_UPDATED') continue; // allow internal update

          if (!validColumns.includes(key)) {
            return new Response(`Bad Request: Column "${key}" is not allowed to be updated`, {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          const value = updates[key];
          if (
            value === undefined ||
            value === null ||
            (typeof value === 'string' && value.trim() === '')
          ) {
            return new Response(`Bad Request: Missing or invalid value for column "${key}"`, {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        }
        
          // Construct the SQL update statement
          const setClauses = updateKeys.map((key, i) => `${key} = ?`).join(', ');
          const values = updateKeys.map(key => updates[key]);
          values.push(db_setting_name); // for WHERE clause          
        
          const sql = `UPDATE ${table} SET ${setClauses} WHERE DB_SETTING_NAME = ?`;
        
          try {
            const result = await env.DB_PRIMARY.prepare(sql).bind(...values).run();
            const changes = result?.meta?.changes ?? 0;
          
            if (changes === 0) {
              return new Response(JSON.stringify({
                message: `No settings updated. DB_SETTING_NAME "${db_setting_name}" not found.`,
                result,
              }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          
            await logUpdateToDB(env, request, db_setting_name, body.logs);
            return new Response(JSON.stringify({
              message: 'Settings updated successfully.',
              changes,
              result,
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            return new Response(JSON.stringify({
              message: 'Internal Server Error: Failed to update settings',
              error: err.message,
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }                       
        }
        
        case 'PATCH:/api/v1/save/credentials': {
          if (authCheck && authCheck.userRole !== 'Developer') {
            return new Response('Forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          const { table, db_setting_name, updates } = body;
        
          if (table !== 'Settings') {
            return new Response('Bad Request: Table must be "Settings"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          if (!db_setting_name || typeof db_setting_name !== 'string') {
            return new Response('Bad Request: Missing or invalid "db_setting_name"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            return new Response('Bad Request: "updates" must be a non-empty object', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          const updateKeys = Object.keys(updates);
        
          if (updateKeys.length !== 1 || !updateKeys.includes('SETTING_VALUE')) {
            return new Response('Bad Request: Only "SETTING_VALUE" can be updated', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          const value = updates['SETTING_VALUE'];
          if (
            value === undefined ||
            value === null ||
            (typeof value === 'string' && value.trim() === '')
          ) {
            return new Response('Bad Request: Missing or invalid value for "SETTING_VALUE"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          // Fetch dynamic secret versions from Settings
          const secretVersionKeys = [
            'internal_api_secret_version',
            'salesforce_api_secret_version',
            'slack_api_secret_version',
            'google_api_secret_version',
          ];
        
          const secretVersions = {};
          for (const key of secretVersionKeys) {
            const result = await env.DB_PRIMARY.prepare(
              "SELECT SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME = ?"
            ).bind(key).first();
        
            if (!result || !result.SETTING_VALUE) {
              return new Response(`Internal Server Error: Missing setting value for ${key}`, {
                status: 500,
                headers: { 'Content-Type': 'text/plain' },
              });
            }
        
            secretVersions[key] = result.SETTING_VALUE;
          }
        
          // Map db_setting_name to the correct secret name
          const secretMap = {
            // internal_api_secret_version
            'internal_api_key': `${secretVersions.internal_api_secret_version}`,
          
            // salesforce_api_secret_version
            'external_api_key_salesforce': `${secretVersions.salesforce_api_secret_version}`,
            'salesforce_developer_app_client_secret': `${secretVersions.salesforce_api_secret_version}`,
            'salesforce_integration_user_password': `${secretVersions.salesforce_api_secret_version}`,
            'salesforce_access_token': `${secretVersions.salesforce_api_secret_version}`,
            'salesforce_refresh_token': `${secretVersions.salesforce_api_secret_version}`,
          
            // slack_api_secret_version
            'slack_bot_token': `${secretVersions.slack_api_secret_version}`,
            'external_api_key_slack': `${secretVersions.slack_api_secret_version}`,
            
            // google_api_secret_version
            'google_client_secret': `${secretVersions.google_api_secret_version}`,
          };
          
          const mappedSecretName = secretMap[db_setting_name];
          if (!mappedSecretName || !env[mappedSecretName]) {
            return new Response(`Internal Server Error: Missing encryption secret for "${db_setting_name}"`, {
              status: 500,
              headers: { 'Content-Type': 'text/plain' },
            });
          }          
        
          const secret = env[mappedSecretName];
          const versionMatch = mappedSecretName.match(/_v(\d+)$/);
          const versionTag = versionMatch ? `v${versionMatch[1]}` : 'v1';
          const encryptedValue = await encrypt(value, secret, versionTag);                  
        
          const isoUtcTimestamp = new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z');
          const sql = `UPDATE Settings SET SETTING_VALUE = ?, LAST_UPDATED = ? WHERE DB_SETTING_NAME = ?`;
        
          try {
            const result = await env.DB_PRIMARY.prepare(sql).bind(encryptedValue, isoUtcTimestamp, db_setting_name).run();
            const changes = result?.meta?.changes ?? 0;
        
            if (changes === 0) {
              return new Response(JSON.stringify({
                message: `No settings updated. DB_SETTING_NAME "${db_setting_name}" not found.`,
                result,
              }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              });
            }
        
            await logUpdateToDB(env, request, db_setting_name, body.logs);
            return new Response(JSON.stringify({
              message: 'Credential updated successfully.',
              changes,
              result,
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            return new Response(JSON.stringify({
              message: 'Internal Server Error: Failed to update credential',
              error: err.message,
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        case 'PATCH:/api/v1/save/credentials/rotate': {
          if (authCheck && authCheck.userRole !== 'Developer') {
            return new Response('Forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          const { table, db_setting_name, updates } = body;
          if (table !== 'Settings') {
            return new Response('Bad Request: Table must be "Settings"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          
          if (!db_setting_name || typeof db_setting_name !== 'string') {
            return new Response('Bad Request: Missing or invalid "db_setting_name"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          
          if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            return new Response('Bad Request: "updates" must be a non-empty object', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          
          const SECRET_NAME = updates['SECRET_NAME'];
          if (!SECRET_NAME || typeof SECRET_NAME !== 'string') {
            return new Response('Bad Request: Missing or invalid "SECRET_NAME" in updates', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }          
        
          if (!SECRET_NAME || typeof SECRET_NAME !== 'string') {
            return new Response('Bad Request: Missing or invalid "SECRET_NAME"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          const currentResult = await env.DB_PRIMARY.prepare(
            "SELECT SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME = ?"
          ).bind(db_setting_name).first();          
          
          if (!currentResult || !currentResult.SETTING_VALUE) {
            return new Response('Not Found: No value found for DB_SETTING_NAME "' + db_setting_name + '"', {
              status: 404,
              headers: { 'Content-Type': 'text/plain' },
            });
          }          
          
          try {
            const secretPrefixMap = {
              'internal_api_key': 'INTERNAL_APIS_ENCRYPTION_SECRET',
              'external_api_key_salesforce': 'SALESFORCE_APIS_ENCRYPTION_SECRET',
              'salesforce_developer_app_client_secret': 'SALESFORCE_APIS_ENCRYPTION_SECRET',
              'salesforce_integration_user_password': 'SALESFORCE_APIS_ENCRYPTION_SECRET',
              'salesforce_access_token': 'SALESFORCE_APIS_ENCRYPTION_SECRET',
              'salesforce_refresh_token': 'SALESFORCE_APIS_ENCRYPTION_SECRET',
              'slack_bot_token': 'SLACK_APIS_ENCRYPTION_SECRET',
              'external_api_key_slack': 'SLACK_APIS_ENCRYPTION_SECRET',
            };
          
          const decryptedValue = await decryptWithMap(currentResult.SETTING_VALUE, env, secretPrefixMap, db_setting_name);

          const newSecret = env[SECRET_NAME];
          if (!newSecret) {
            return new Response('Internal Server Error: Missing secret "' + SECRET_NAME + '" in environment', {
              status: 500,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          
          const versionMatch = SECRET_NAME.match(/_v(\d+)$/);
          const versionTag = versionMatch ? 'v' + versionMatch[1] : 'v1';
          
          const encryptedValue = await encrypt(decryptedValue, newSecret, versionTag);
          const isoUtcTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
          
          const sql = 'UPDATE Settings SET SETTING_VALUE = ?, LAST_UPDATED = ? WHERE DB_SETTING_NAME = ?';
          try {
            const result = await env.DB_PRIMARY.prepare(sql).bind(encryptedValue, isoUtcTimestamp, db_setting_name).run();
            const changes = result?.meta?.changes ?? 0;
            if (changes === 0) {
              return new Response(JSON.stringify({
                message: 'No settings updated. DB_SETTING_NAME "' + db_setting_name + '" not found.',
                result,
              }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              });
            }
            
            await logUpdateToDB(env, request, db_setting_name, body.logs, 'rotated');
            return new Response(JSON.stringify({
              message: 'Credential rotated successfully.',
              changes,
              result,
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            return new Response(JSON.stringify({
              message: 'Internal Server Error: Failed to rotate credential',
              error: err.message,
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          
          } catch (err) {
            return new Response(JSON.stringify({
              message: 'Internal Server Error: Failed to decrypt current value',
              error: err.message,
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }            
        
        case 'PATCH:/api/v1/save/dashboard': {
          if (authCheck && !['Developer', 'Manager', 'AdvancedSupport'].includes(authCheck.userRole)) {
            return new Response('Forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          const { table, message_timestamp, updates } = body;
      
          if (table !== 'Dashboard') {
            return new Response('Bad Request: Table must be "Dashboard"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
      
          if (!message_timestamp || typeof message_timestamp !== 'string') {
            return new Response('Bad Request: Missing or invalid "message_timestamp"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
      
          if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            return new Response('Bad Request: "updates" must be a non-empty object', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
      
          const updateKeys = Object.keys(updates);
          if (updateKeys.length === 0) {
            return new Response('Bad Request: No updates provided', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
      
          const isoUtcTimestamp = new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z');
          updateKeys.push('LAST_UPDATED');
          updates['LAST_UPDATED'] = isoUtcTimestamp;
      
          const setClauses = updateKeys.map(function(key) {
            return key + ' = ?';
          }).join(', ');
      
          const values = updateKeys.map(function(key) {
            const val = updates[key];
            if (typeof val === 'string' && val.trim() === '') {
              return null;
            }
            return val;
          });
          
          values.push(message_timestamp);
      
          const sql = 'UPDATE ' + table + ' SET ' + setClauses + ' WHERE MESSAGE_TIMESTAMP = ?';
      
          try {
            const result = await env.DB_PRIMARY.prepare(sql).bind(...values).run();
            const changes = result?.meta?.changes ?? 0;
      
            if (changes === 0) {
              return new Response(JSON.stringify({
                message: 'No dashboard entry updated. MESSAGE_TIMESTAMP "' + message_timestamp + '" not found.',
                result,
              }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              });
            }
      
            await logUpdateToDB(env, request, `dashboard timestamp ${message_timestamp}`, body.logs);
            return new Response(JSON.stringify({
              message: 'Dashboard updated successfully.',
              changes,
              result,
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            return new Response(JSON.stringify({
              message: 'Internal Server Error: Failed to update dashboard',
              error: err.message,
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }
        
        case 'DELETE:/api/v1/save/dashboard': {
          if (authCheck && !['Developer', 'Manager', 'AdvancedSupport'].includes(authCheck.userRole)) {
            return new Response('Forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          
          const { table, message_timestamp } = body;
        
          if (table !== 'Dashboard') {
            return new Response('Bad Request: Table must be "Dashboard"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          if (!message_timestamp || typeof message_timestamp !== 'string') {
            return new Response('Bad Request: Missing or invalid "message_timestamp"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          const sql = 'DELETE FROM ' + table + ' WHERE MESSAGE_TIMESTAMP = ?';
        
          try {
            const result = await env.DB_PRIMARY.prepare(sql).bind(message_timestamp).run();
            const changes = result?.meta?.changes ?? 0;
        
            if (changes === 0) {
              return new Response(JSON.stringify({
                message: 'No dashboard entry deleted. MESSAGE_TIMESTAMP "' + message_timestamp + '" not found.',
                result
              }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              });
            }
        
            await logUpdateToDB(env, request, `dashboard timestamp ${message_timestamp}`, body.logs, 'deleted');
            return new Response(JSON.stringify({
              message: 'Dashboard entry deleted successfully.',
              changes,
              result
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            return new Response(JSON.stringify({
              message: 'Internal Server Error: Failed to delete dashboard entry',
              error: err.message
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }  
        
        case 'POST:/api/v1/save/users/nuke': {
          if (authCheck && !['Developer', 'Manager'].includes(authCheck.userRole)) {
            return new Response('Forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
}
          const { clear_tokens, clear_passwords, slack_user_ids } = body;
          if (
            typeof clear_tokens !== 'string' ||
            typeof clear_passwords !== 'string' ||
            !Array.isArray(slack_user_ids) ||
            slack_user_ids.length === 0 ||
            slack_user_ids.some(id => typeof id !== 'string' || id.trim() === '') ||
            !['TRUE', 'FALSE'].includes(clear_tokens) ||
            !['TRUE', 'FALSE'].includes(clear_passwords)
          ) {
            return new Response('Bad Request: Missing or invalid clear_tokens, clear_passwords, or slack_user_ids', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }                    
        
          const isoUtcTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
          const fieldsToNull = [];
          if (clear_tokens === 'TRUE') fieldsToNull.push('SESSION_TOKEN');
          if (clear_passwords === 'TRUE') fieldsToNull.push('PASSWORD');
          
          if (fieldsToNull.length === 0) {
            return new Response('Bad Request: No fields selected to clear.', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          
          const setClause = fieldsToNull.map(field => `${field} = NULL`).join(', ') + ', LAST_UPDATED = ?';
          const placeholders = slack_user_ids.map(() => '?').join(', ');
          const sql = `UPDATE User SET ${setClause} WHERE SLACK_USER_ID IN (${placeholders})`;
          
          const actions = [];
          if (clear_tokens === 'TRUE') actions.push('SESSION_TOKEN');
          if (clear_passwords === 'TRUE') actions.push('PASSWORD');
          
          try {
            const result = await env.DB_PRIMARY.prepare(sql).bind(isoUtcTimestamp, ...slack_user_ids).run();
            const changes = result?.meta?.changes ?? 0;
          
            
            await logUpdateToDB(
              env,
              request,
              `SLACK_USER_IDs: {${slack_user_ids.join(', ')}}`,
              body.logs,
              `cleared ${actions.join(' and ')} for`
            );                       
        
            return new Response(JSON.stringify({
              message: `${actions.join(' and ')} cleared successfully.`,
              changes,
              result,
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            return new Response(JSON.stringify({
              message: `Internal Server Error: Failed to clear ${actions.join(' and ')}`,
              error: err.message,
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }        

        case 'PATCH:/api/v1/save/users': {
          if (authCheck && !['Developer', 'Manager'].includes(authCheck.userRole)) {
            return new Response('Forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          const { table, slack_user_id, updates } = body;
        
          if (table !== 'User') {
            return new Response('Bad Request: Table must be "User"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          if (!slack_user_id || typeof slack_user_id !== 'string') {
            return new Response('Bad Request: Missing or invalid "slack_user_id"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            return new Response('Bad Request: "updates" must be a non-empty object', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          const updateKeys = Object.keys(updates);

          if (updates.USERNAME) {
            updates.USERNAME = updates.USERNAME.toLowerCase();
          }
          if (updateKeys.length === 0) {
            return new Response('Bad Request: No updates provided', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          if (
            updateKeys.includes('SF_USER_ID') ||
            updateKeys.includes('USERNAME') ||
            updateKeys.includes('SLACK_USER_ID')
          ) {
            const newSlackId = updates.SLACK_USER_ID ?? slack_user_id;
          
            const conflictCheck = await env.DB_PRIMARY.prepare(
              `SELECT SLACK_USER_ID FROM User WHERE 
               (SF_USER_ID = ? OR USERNAME = ? OR SLACK_USER_ID = ?) AND SLACK_USER_ID != ?`
            ).bind(
              updates.SF_USER_ID ?? '',
              updates.USERNAME ?? '',
              newSlackId,
              slack_user_id
            ).first();
          
            if (conflictCheck) {
              return new Response(JSON.stringify({
                message: 'SLACK_USER_ID, SF_USER_ID, or USERNAME already belongs to another user.'
              }), {
                status: 409,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          }                  
        
          // Check if USER_ROLE is being changed from Developer to something else
          if (updates.hasOwnProperty('USER_ROLE') && updates['USER_ROLE'] !== 'Developer') {
            const currentUser = await env.DB_PRIMARY.prepare(
              `SELECT USER_ROLE FROM User WHERE SLACK_USER_ID = ?`
            ).bind(slack_user_id).first();
        
            if (!currentUser) {
              return new Response(`Bad Request: User with SLACK_USER_ID "${slack_user_id}" not found`, {
                status: 404,
                headers: { 'Content-Type': 'text/plain' },
              });
            }
        
            if (currentUser.USER_ROLE === 'Developer') {
              const devCountResult = await env.DB_PRIMARY.prepare(
                `SELECT COUNT(*) AS count FROM User WHERE USER_ROLE = 'Developer'`
              ).first();
        
              const devCount = devCountResult?.count ?? 0;
        
              if (devCount <= 2) {
                return new Response(`Bad Request: At least 2 Developers must remain in the system.`, {
                  status: 400,
                  headers: { 'Content-Type': 'text/plain' },
                });
              }
            }
          }
        
          // Add LAST_UPDATED timestamp
          const isoUtcTimestamp = new Date().toISOString().replace(/\.\\d{3}Z$/, 'Z');
          updateKeys.push('LAST_UPDATED');
          updates['LAST_UPDATED'] = isoUtcTimestamp;
        
          const setClauses = updateKeys.map(key => `${key} = ?`).join(', ');
          const values = updateKeys.map(key => updates[key]);
          values.push(slack_user_id); // for WHERE clause
        
          const sql = `UPDATE ${table} SET ${setClauses} WHERE SLACK_USER_ID = ?`;
        
          try {
            const result = await env.DB_PRIMARY.prepare(sql).bind(...values).run();
            const changes = result?.meta?.changes ?? 0;
        
            if (changes === 0) {
              return new Response(JSON.stringify({
                message: `No user updated. SLACK_USER_ID "${slack_user_id}" not found.`,
                result,
              }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              });
            }
        
            await logUpdateToDB(env, request, slack_user_id, body.logs);
            return new Response(JSON.stringify({
              message: 'User updated successfully.',
              changes,
              result,
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            return new Response(JSON.stringify({
              message: 'Internal Server Error: Failed to update user',
              error: err.message,
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }              

        case 'POST:/api/v1/save/users': {
          if (authCheck && !['Developer', 'Manager'].includes(authCheck.userRole)) {
            return new Response('Forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          const requiredFields = ['SLACK_USER_ID', 'SF_USER_ID', 'FIRST_LAST', 'USERNAME', 'USER_ROLE'];
          body.USERNAME = body.USERNAME.toLowerCase();
          const missingFields = requiredFields.filter(field => !body[field] || typeof body[field] !== 'string' || body[field].trim() === '');        
          if (missingFields.length > 0) {
            return new Response(`Bad Request: Missing or invalid fields: ${missingFields.join(', ')}`, {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          const duplicateCheck = await env.DB_PRIMARY.prepare(
            `SELECT 1 FROM User WHERE SLACK_USER_ID = ? OR SF_USER_ID = ? OR USERNAME = ?`
          ).bind(
            body.SLACK_USER_ID,
            body.SF_USER_ID,
            body.USERNAME
          ).first();
          
          if (duplicateCheck) {
            return new Response(JSON.stringify({
              message: 'User with SLACK_USER_ID, SF_USER_ID, or USERNAME already exists.'
            }), {
              status: 409,
              headers: { 'Content-Type': 'application/json' },
            });
          }          
        
          const isoUtcTimestamp = new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z');
        
          const sql = `
            INSERT INTO User (SLACK_USER_ID, SF_USER_ID, FIRST_LAST, USERNAME, USER_ROLE, LAST_UPDATED)
            VALUES (?, ?, ?, ?, ?, ?)
          `;
        
          try {
            const result = await env.DB_PRIMARY.prepare(sql).bind(
              body.SLACK_USER_ID,
              body.SF_USER_ID,
              body.FIRST_LAST,
              body.USERNAME,
              body.USER_ROLE,
              isoUtcTimestamp
            ).run();
        
            await logUpdateToDB(env, request, `user ID ${body.SLACK_USER_ID}`, body.logs, 'added');
            return new Response(JSON.stringify({ message: 'User created successfully.', result }), {
              status: 201,
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            if (err.message.includes('UNIQUE constraint failed: User.SLACK_USER_ID')) {
              return new Response(JSON.stringify({
                message: `Database INSERT error: User with SLACK_USER_ID ${body.SLACK_USER_ID} already exists.`,
              }), {
                status: 409, // Conflict
                headers: { 'Content-Type': 'application/json' },
              });
            }
          
            return new Response(JSON.stringify({
              message: 'Internal Server Error: Failed to create user',
              error: err.message,
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        case 'POST:/api/v1/save/users/reset': {
          if (authCheck && !['Developer', 'Manager'].includes(authCheck.userRole)) {
            return new Response('Forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          
          const slackUserId = body.SLACK_USER_ID;
          const resetType = body.RESET_TYPE;
          if (!slackUserId || typeof slackUserId !== 'string') {
            return new Response('Bad Request: Missing or invalid "SLACK_USER_ID"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          if (!['LOGIN_ATTEMPTS', 'GUEST_SESSION'].includes(resetType)) {
            return new Response('Bad Request: Missing or invalid "RESET_TYPE"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
        
          const sql =
            resetType === 'GUEST_SESSION'
              ? 'UPDATE User SET GUEST_SESSION_EXPIRES = ? WHERE SLACK_USER_ID = ?'
              : 'UPDATE User SET FAILED_LOGIN_ATTEMPTS = 0 WHERE SLACK_USER_ID = ?';
          try {
            const result =
              resetType === 'GUEST_SESSION'
                ? await env.DB_PRIMARY.prepare(sql)
                    .bind(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), slackUserId)
                    .run()
                : await env.DB_PRIMARY.prepare(sql)
                    .bind(slackUserId)
                    .run();
            const changes = result?.meta?.changes ?? 0;
            if (changes === 0) {
              return new Response(JSON.stringify({
                message: 'No user updated. SLACK_USER_ID "' + slackUserId + '" not found.',
                result,
              }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              });
            }
            await logUpdateToDB(
              env,
              request,
              slackUserId,
              body.logs,
              resetType === 'GUEST_SESSION'
                ? 'reset guest access for'
                : 'reset login attempts for'
            );
            return new Response(JSON.stringify({
              message:
                resetType === 'GUEST_SESSION'
                  ? 'GUEST_SESSION_EXPIRES reset successfully.'
                  : 'FAILED_LOGIN_ATTEMPTS reset successfully.',
              changes,
              result,
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            return new Response(JSON.stringify({
              message:
                resetType === 'GUEST_SESSION'
                  ? 'Internal Server Error: Failed to reset GUEST_SESSION_EXPIRES'
                  : 'Internal Server Error: Failed to reset FAILED_LOGIN_ATTEMPTS',
              error: err.message,
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }        
        
        case 'PATCH:/api/v1/save/help': {
          if (authCheck && !['Developer', 'Manager', 'AdvancedSupport'].includes(authCheck.userRole)) {
            return new Response('Forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          const { table, help_item, updates } = body;
  
          if (table !== 'Help') {
            return new Response('Bad Request: Table must be "Help"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
  
          if (!help_item || typeof help_item !== 'string') {
            return new Response('Bad Request: Missing or invalid "help_item"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
  
          if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            return new Response('Bad Request: "updates" must be a non-empty object', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
  
          const updateKeys = Object.keys(updates);
          
          if (updateKeys.length === 0) {
            return new Response('Bad Request: No updates provided', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
  
          const isoUtcTimestamp = new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z');
          updateKeys.push('LAST_UPDATED');
          updates['LAST_UPDATED'] = isoUtcTimestamp;
  
          const setClauses = updateKeys.map(function(key) {
            return key + ' = ?';
          }).join(', ');
          const values = updateKeys.map(function(key) {
            return updates[key];
          });
          values.push(help_item);
  
          const sql = 'UPDATE Help SET ' + setClauses + ' WHERE HELP_ITEM = ?';
  
          try {
            const result = await env.DB_PRIMARY.prepare(sql).bind(...values).run();
            const changes = result?.meta?.changes ?? 0;
  
            if (changes === 0) {
              return new Response(JSON.stringify({
                message: 'No help entry updated. HELP_ITEM "' + help_item + '" not found.',
                result
              }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              });
            }
  
            await logUpdateToDB(env, request, `help item ${help_item}`, body.logs);
            return new Response(JSON.stringify({
              message: 'Help entry updated successfully.',
              changes,
              result
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            return new Response(JSON.stringify({
              message: 'Internal Server Error: Failed to update help entry',
              error: err.message
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        case 'DELETE:/api/v1/save/help': {
          if (authCheck && !['Developer', 'Manager', 'AdvancedSupport'].includes(authCheck.userRole)) {
            return new Response('Forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          const { table, help_item } = body;
  
          if (table !== 'Help') {
            return new Response('Bad Request: Table must be "Help"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
  
          if (!help_item || typeof help_item !== 'string') {
            return new Response('Bad Request: Missing or invalid "help_item"', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
  
          const sql = 'DELETE FROM Help WHERE HELP_ITEM = ?';
  
          try {
            const result = await env.DB_PRIMARY.prepare(sql).bind(help_item).run();
            const changes = result?.meta?.changes ?? 0;
  
            if (changes === 0) {
              return new Response(JSON.stringify({
                message: 'No help entry deleted. HELP_ITEM "' + help_item + '" not found.',
                result
              }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              });
            }
  
            await logUpdateToDB(env, request, `help item ${help_item}`, body.logs, 'deleted');
            return new Response(JSON.stringify({
              message: 'Help entry deleted successfully.',
              changes,
              result
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            return new Response(JSON.stringify({
              message: 'Internal Server Error: Failed to delete help entry',
              error: err.message
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        } 
        
        case 'POST:/api/v1/save/help': {
          if (authCheck && !['Developer', 'Manager', 'AdvancedSupport'].includes(authCheck.userRole)) {
            return new Response('Forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          
          const { HELP_DESCRIPTION, HELP_MAIN_CATEGORY, HELP_SUB_CATEGORY, HELP_SUB_CATEGORY_ORDER } = body;
    
          if (!HELP_DESCRIPTION || !HELP_MAIN_CATEGORY) {
            return new Response('Bad Request: Missing required fields HELP_DESCRIPTION or HELP_MAIN_CATEGORY', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
    
          try {
            const maxResult = await env.DB_PRIMARY.prepare(
              "SELECT MAX(CAST(HELP_ITEM AS INTEGER)) AS max_item FROM Help"
            ).first();
    
            const nextHelpItem = ((parseInt(maxResult?.max_item || "0", 10)) + 1).toString();
    
            const isoUtcTimestamp = new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z');
    
            const sql =
              "INSERT INTO Help (HELP_ITEM, HELP_DESCRIPTION, HELP_MAIN_CATEGORY, HELP_SUB_CATEGORY, HELP_SUB_CATEGORY_ORDER, LAST_UPDATED) " +
              "VALUES (?, ?, ?, ?, ?, ?)";
    
            const result = await env.DB_PRIMARY.prepare(sql).bind(
              nextHelpItem,
              HELP_DESCRIPTION,
              HELP_MAIN_CATEGORY,
              HELP_SUB_CATEGORY || null,
              HELP_SUB_CATEGORY_ORDER || null,
              isoUtcTimestamp
            ).run();
    
            await logUpdateToDB(env, request, `help item ${nextHelpItem}`, body.logs, 'added');
            return new Response(JSON.stringify({ message: 'Help entry created successfully.', result }), {
              status: 201,
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            return new Response(JSON.stringify({
              message: 'Internal Server Error: Failed to create help entry',
              error: err.message,
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }    

        default:
          return new Response('Not Found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
          });
      }

    } catch (err) {
      console.error('Authorization error:', err);
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
      });
    }
  },
};
