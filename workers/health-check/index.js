// Shared helper function to decrypt tokens using a versioned secret
async function decrypt(encryptedWithVersion, env, prefix = 'INTERNAL_APIS_ENCRYPTION_SECRET') {
  const [encryptedBase64, version] = encryptedWithVersion.split('_v');
  if (!encryptedBase64 || !version) {
    throw new Error('Invalid encrypted format or missing version.');
  }

  const secretName = `${prefix}_v${version}`;
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

//Helper function to assist in creating the values for Slack alerts
function getStatusLabel(response) {
  if (!response || typeof response.status !== "number") {
    return "No Response :grey_question:";
  }

  const statusText = response.statusText || `Status ${response.status}`;
  const emoji = response.status === 200 ? ":heavy_check_mark:" : ":x:";

  return `${statusText} ${emoji}`;
}

//Helper function that sends to a slack workflow url
async function sendSlackAlert(slackWorkflowUrl, statuses) {
  const healthResults = [
    `Completed in ${statuses.runTime}`,
    `New Worker Alive: ${statuses.new}`,
    `Downstream Worker Alive: ${statuses.downstream}`,
    `Dispatcher Worker Alive: ${statuses.dispatcher}`,
    `Slack Users Sync Worker Alive: ${statuses.slackUsers}`,
    `Slack Users Sync Bypass Setting: ${statuses.bypassSlackSync}`,
    `Slack Token Valid: ${statuses.slack}`,
    `SF Access Token Valid: ${statuses.salesforce}`,
    `SF Refresh Token Last Updated: ${statuses.refreshToken}`,
    `SF Outgoing API Bypass Setting: ${statuses.bypassSalesforcePost} `
  ].join('\n');

  const payload = JSON.stringify({
    health_results: healthResults
  });

  const response = await fetch(slackWorkflowUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: payload
  });

  if (!response.ok) {
    console.error(`Slack alert failed: ${response.status} ${await response.text()}`);
  }
}

// Helper function that sends to the New worker
async function sendHealthCheckNew(env) {
  const maxAttempts = 2;
  const delayMs = 200;
  let response;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    response = await env.NEW_WORKER.fetch("https://internal/health", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (response.status !== 503) break;
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
  }

  return response;
}

// Helper function that sends to the Downstream worker
async function sendHealthCheckDownstream(env) {
  const maxAttempts = 2;
  const delayMs = 200;
  let response;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    response = await env.DOWNSTREAM_WORKER.fetch("https://internal/health", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (response.status !== 503) break;
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
  }

  return response;
}

//Helper function that sends to the Dispatcher worker
async function sendHealthCheckDispatcher(env) {
  const maxAttempts = 2;
  const delayMs = 200;
  let response;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    response = await env.DISPATCHER_WORKER.fetch("https://internal/health", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (response.status !== 503) break;
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
  }

  return response;
}

// Helper function that sends to the Slack User Sync worker
async function sendHealthCheckSlackUsers(env) {
  const maxAttempts = 2;
  const delayMs = 200;
  let response;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    response = await env.SLACK_USER_SYNC_WORKER.fetch("https://internal/health", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (response.status !== 503) break;
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
  }

  return response;
}

// Helper function that sends a GET to the Salesforce user info endpoint
async function sendSalesforceUserInfo(env) {
  const salesforceGetUserInfoEndpointURL = env['salesforce_api_get_user_info_endpoint_url'];
  const encryptedSalesforceAccessToken = env['salesforce_access_token'];

  if (!salesforceGetUserInfoEndpointURL || !encryptedSalesforceAccessToken) {
    throw new Error('Missing Salesforce endpoint or encrypted access token.');
  }

  const decryptedSalesforceAccessToken = await decrypt(
    encryptedSalesforceAccessToken,
    env,
    'SALESFORCE_APIS_ENCRYPTION_SECRET'
  );

  const response = await fetch(salesforceGetUserInfoEndpointURL, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${decryptedSalesforceAccessToken}`,
      "Content-Type": "application/json"
    }
  });

  return response;
}

//Helper function that checks the age of the refresh token
function checkRefreshTokenAge(settingsResults) {
  const tokenRow = settingsResults.find(
    row => row.DB_SETTING_NAME === 'salesforce_refresh_token'
  );
  const thresholdRow = settingsResults.find(
    row => row.DB_SETTING_NAME === 'health_check_refresh_hours_warn'
  );

  if (!tokenRow || !tokenRow.LAST_UPDATED) {
    return {
      status: 'Missing LAST_UPDATED for salesforce_refresh_token :grey_question:'
    };
  }

  const thresholdHours = parseFloat(thresholdRow?.SETTING_VALUE);
  const warnThreshold = isNaN(thresholdHours) ? 4 : thresholdHours;
  const lastUpdated = new Date(tokenRow.LAST_UPDATED);
  if (isNaN(lastUpdated.getTime())) {
  return {
    status: `Invalid Date: "${tokenRow.LAST_UPDATED}" :x:`
  };
}
  const now = Date.now();
  const ageMs = now - lastUpdated.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  // Convert to GMT-7
  const formattedTime = lastUpdated.toLocaleString('en-US', {
    timeZone: 'America/Phoenix',
    hour12: true
  });

  if (ageHours > warnThreshold) {
    return {
      status: `${formattedTime} GMT-7 :warning:`
    };
  }

  return {
    status: `${formattedTime} GMT-7 :heavy_check_mark:`
  };
}

// Helper function that sends a GET to Slack's auth.test endpoint
async function sendHealthCheckSlack(env, settingsMap) {
  const slackAuthTestURL = settingsMap['slack_api_auth_test_URL'];
  const encryptedSlackBotToken = settingsMap['slack_bot_token'];

  if (!slackAuthTestURL || !encryptedSlackBotToken) {
    throw new Error('Missing Slack auth test URL or encrypted bot token.');
  }

  const decryptedSlackBotToken = await decrypt(
    encryptedSlackBotToken,
    env,
    'SLACK_APIS_ENCRYPTION_SECRET'
  );

  const response = await fetch(slackAuthTestURL, {  
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${decryptedSlackBotToken}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  return response;
}

//Helper function that logs errors to the DB
async function logErrorToDB(env, errorMessage, errorType = 'Error') {
  try {
    const timestamp = new Date().toISOString();
    await env.DB_PRIMARY.prepare(
      `INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
       VALUES (?, ?, ?, ?)`
    ).bind(timestamp, 'health-check', errorMessage, errorType).run();
  } catch {
  }
}

// Logs a full HTTP response (status, headers, body) into the Error table with ERROR_TYPE='Debug'
async function logHttpResponseToDB(env, {
  sourceLabel,
  response,
  bodyText,
  requestDetails = { method: null, url: null, headers: {}, body: null },
  runContext = 'POST'
}) {
  try {
    // Collect headers into a plain object
    const headersObj = {};
    try {
      for (const [key, value] of response.headers) {
        headersObj[key] = value;
      }
    } catch (_) {
      // If headers iteration fails, leave headersObj empty
    }

    // Truncate body if too large
    const MAX_LEN = 16000; // ~16 KB safeguard
    const safeBody =
      typeof bodyText === 'string'
        ? (bodyText.length > MAX_LEN
            ? bodyText.slice(0, MAX_LEN) + '… [truncated]'
            : bodyText)
        : String(bodyText);

    // Build payload for logging
    const payload = {
      context: runContext,
      source: sourceLabel,
      request: {
        method: requestDetails?.method || null,
        url: requestDetails?.url || null,
        headers: requestDetails?.headers || {},
        body: requestDetails?.body || null,
      },
      response: {
        status: response?.status ?? null,
        statusText: response?.statusText ?? '',
        headers: headersObj,
        body: safeBody
      }
    };

    const message = JSON.stringify(payload);

    await env.DB_PRIMARY
      .prepare(
        `INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
         VALUES (?, ?, ?, ?)`
      )
      .bind(new Date().toISOString(), 'health-check', message, 'Debug')
      .run();
  } catch (err) {
    // If logging fails, record the failure without throwing
    try {
      await env.DB_PRIMARY
        .prepare(
          `INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
           VALUES (?, ?, ?, ?)`
        )
        .bind(
          new Date().toISOString(),
          'health-check',
          `logHttpResponseToDB failed: ${err?.message ?? String(err)}`,
          'Debug'
        )
        .run();
    } catch (_) {
      // Swallow secondary failures
    }
  }
}


//Helper function that strips the emoji from the status for logging purposes
function stripEmoji(status) {
  return status.replace(/:[^:\s]*(?:::[^:\s]*)*:/g, '').trim();
}

export default {

//Triggered when URL is hit//
  async fetch(request, env) {
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
      let settingsMap = {};
      let decryptedKey = null;
      let settingsQuery;
      try {
        settingsQuery = await env.DB_PRIMARY.prepare(
          "SELECT DB_SETTING_NAME, SETTING_VALUE, LAST_UPDATED FROM Settings WHERE DB_SETTING_NAME IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          'internal_api_key',
          'internal_downstream_url',
          'internal_dispatcher_url',
          'internal_new_url',
          'internal_slack_user_sync_url',
          'bypass_slack_user_sync',
          'slack_health_alerts_workflow_url',
          'health_check_refresh_hours_warn',
          'salesforce_api_get_user_info_endpoint_url',
          'salesforce_access_token',
          'salesforce_refresh_token',
          'slack_api_auth_test_URL',
          'slack_bot_token',
          'error_debug_logs',
          'bypass_salesforce_individual_post'
        ).all();
        for (const row of settingsQuery.results) {
          settingsMap[row.DB_SETTING_NAME] = row.SETTING_VALUE;
        }
        const encryptedKey = settingsMap['internal_api_key'];
        if (!encryptedKey) {
          throw new Error('Internal API key not found in settings.');
        }
        decryptedKey = await decrypt(encryptedKey, env);
      } catch (err) {
        return new Response('Error retrieving or decrypting settings: ' + err.message, {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      
      const token = authHeader.slice(7);
      if (token !== decryptedKey) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
        });
      }            
  
      const path = new URL(request.url).pathname.toLowerCase();
      const allowedPaths = new Set([
        "/api/v1/health-check"
      ]);
      
      if (!allowedPaths.has(path)) {
        return new Response("Not Found", {
          status: 404,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      if (settingsMap['error_debug_logs'] === 'TRUE') {
        await logErrorToDB(env, "Manual health check started", "Debug");
      }
      
      const start = Date.now();

      let newWorkerStatus = "Health check failed :x:";
      let newBody = "";
      try {
  
//===============================================
        const newResponse = await sendHealthCheckNew(env);
//===============================================
        newBody = await newResponse.text();

        if (settingsMap['error_debug_logs'] === 'TRUE') {
          await logHttpResponseToDB(env, {
            sourceLabel: 'new worker',
            response: newResponse,
            bodyText: newBody,
            requestDetails: {
              method: 'GET',
              url: `service-binding: NEW_WORKER https://internal/health`,
              headers: { "X-Internal-Call": "service-binding" },
              body: null,
            },
            runContext: 'manual'
          });
        }
        
        newWorkerStatus = getStatusLabel(newResponse);
      } catch (err) {
        newBody = "Error: " + err.message;
      }
      
      let downstreamWorkerStatus = "Health check failed :x:";
      let downstreamBody = "";
      try {
        const downstreamResponse = await sendHealthCheckDownstream(env);
        downstreamBody = await downstreamResponse.text();

        if (settingsMap['error_debug_logs'] === 'TRUE') {
          await logHttpResponseToDB(env, {
            sourceLabel: 'downstream worker',
            response: downstreamResponse,
            bodyText: downstreamBody,
            requestDetails: {
              method: 'GET',
              url: `service-binding: DOWNSTREAM_WORKER https://internal/health`,
              headers: { "X-Internal-Call": "service-binding" },
              body: null,
            },
            runContext: 'manual'
          });
        }
        
        downstreamWorkerStatus = getStatusLabel(downstreamResponse);
      } catch (err) {
        downstreamBody = "Error: " + err.message;
      }
      
      let dispatcherWorkerStatus = "Health check failed :x:";
      let dispatcherBody = "";
      try {
        const dispatcherResponse = await sendHealthCheckDispatcher(env);
        dispatcherBody = await dispatcherResponse.text();

        if (settingsMap['error_debug_logs'] === 'TRUE') {
          await logHttpResponseToDB(env, {
            sourceLabel: 'dispatcher worker',
            response: dispatcherResponse,
            bodyText: dispatcherBody,
            requestDetails: {
              method: 'GET',
              url: `service-binding: DISPATCHER_WORKER https://internal/health`,
              headers: { "X-Internal-Call": "service-binding" },
              body: null,
            },
            runContext: 'manual'
          });
        }
        
        dispatcherWorkerStatus = getStatusLabel(dispatcherResponse);
      } catch (err) {
        dispatcherBody = "Error: " + err.message;
      }

      let slackUsersWorkerStatus = "Health check failed :x:";
      let slackUsersBody = "";
      try {
        const slackUsersResponse = await sendHealthCheckSlackUsers(env);
        slackUsersBody = await slackUsersResponse.text();

        if (settingsMap['error_debug_logs'] === 'TRUE') {
          await logHttpResponseToDB(env, {
            sourceLabel: 'slack users sync worker',
            response: slackUsersResponse,
            bodyText: slackUsersBody,
            requestDetails: {
              method: 'GET',
              url: `service-binding: SLACK_USER_SYNC_WORKER https://internal/health`,
              headers: { "X-Internal-Call": "service-binding" },
              body: null,
            },
            runContext: 'manual'
          });
        }
        
        slackUsersWorkerStatus = getStatusLabel(slackUsersResponse);
      } catch (err) {
        slackUsersBody = "Error: " + err.message;
      }      
      
      let bypassSlackSyncStatus = "Health check failed :x:";
      try {
        const bypassValue = settingsMap['bypass_slack_user_sync'];
        if (bypassValue === 'TRUE') {
          bypassSlackSyncStatus = "Not syncing :x:";
        } else {
          bypassSlackSyncStatus = "OK :heavy_check_mark:";
        }
      } catch (err) {
        bypassSlackSyncStatus = "Error: " + err.message;
      }
      
      let salesforceStatus = "Health check failed :x:";
      let salesforceBody = "";
      try {
        const salesforceResponse = await sendSalesforceUserInfo({ ...env, ...settingsMap });
        salesforceBody = await salesforceResponse.text();
        salesforceStatus = getStatusLabel(salesforceResponse);
      } catch (err) {
        salesforceBody = "Error: " + err.message;
      }
      
      let slackStatus = "Health check failed :x:";
      let slackBody = "";
      try {
        const slackResponse = await sendHealthCheckSlack(env, settingsMap);
        slackBody = await slackResponse.text();
        slackStatus = getStatusLabel(slackResponse);
      } catch (err) {
        slackBody = "Error: " + err.message;
      }

      let refreshTokenStatus = "Health check failed :x:";
      try {
        const refreshTokenCheck = checkRefreshTokenAge(settingsQuery.results);
        refreshTokenStatus = refreshTokenCheck.status;
      } catch (err) {
        refreshTokenStatus = "Error: " + err.message;
      }

      let bypassSalesforcePostStatus = "Health check failed :x:";
      try {
        const bypassValue = settingsMap['bypass_salesforce_individual_post'];
        if (bypassValue === 'TRUE') {
          bypassSalesforcePostStatus = "Not syncing :x:";
        } else {
          bypassSalesforcePostStatus = "OK :heavy_check_mark:";
        }
      } catch (err) {
        bypassSalesforcePostStatus = "Error: " + err.message;
      }      

      const runTime = (Date.now() - start) + "ms";
      await sendSlackAlert(settingsMap["slack_health_alerts_workflow_url"], {
        new: newWorkerStatus,
        downstream: downstreamWorkerStatus,
        dispatcher: dispatcherWorkerStatus,
        slackUsers: slackUsersWorkerStatus,
        bypassSlackSync: bypassSlackSyncStatus,
        slack: slackStatus,
        salesforce: salesforceStatus,
        refreshToken: refreshTokenStatus,
        bypassSalesforcePost: bypassSalesforcePostStatus,
        runTime: runTime
      });

      const statusSummary = JSON.stringify({
        new: stripEmoji(newWorkerStatus),
        downstream: stripEmoji(downstreamWorkerStatus),
        dispatcher: stripEmoji(dispatcherWorkerStatus),
        slackUsers: stripEmoji(slackUsersWorkerStatus),
        bypassSlackSync: stripEmoji(bypassSlackSyncStatus),
        slack: stripEmoji(slackStatus),
        salesforce: stripEmoji(salesforceStatus),
        refreshToken: stripEmoji(refreshTokenStatus),
        bypassSalesforcePost: stripEmoji(bypassSalesforcePostStatus),
        runTime: runTime
      });

      if (settingsMap['error_debug_logs'] === 'TRUE') {
        await logErrorToDB(env, `Manual health check completed: ${statusSummary}`, "Debug");
      }      
      
      const combinedBody = [
        "New Worker Response:\n" + newBody,
        "Downstream Worker Response:\n" + downstreamBody,
        "Dispatcher Worker Response:\n" + dispatcherBody,
        "Slack Users Sync Worker Response:\n" + slackUsersBody,
        "Slack Users Sync Bypass Status:\n" + bypassSlackSyncStatus,
        "Salesforce Response:\n" + salesforceBody,
        "Slack Response:\n" + slackBody,
        "Refresh Token Status:\n" + refreshTokenStatus,
        "Salesforce Post Bypass Status:\n" + bypassSalesforcePostStatus
      ].join("\n");
      
      return new Response(combinedBody, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });      
      
    } catch (err) {
      return new Response(`Error: ${err.message}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }    
  },

 //Triggers from Cron// 
 async scheduled(event, env) {
  await logErrorToDB(env, "Scheduled health check started", "Cron");
  try {
    const settingsQuery = await env.DB_PRIMARY.prepare(
      "SELECT DB_SETTING_NAME, SETTING_VALUE, LAST_UPDATED FROM Settings WHERE DB_SETTING_NAME IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      'internal_api_key',
      'internal_downstream_url',
      'internal_dispatcher_url',
      'internal_new_url',
      'internal_slack_user_sync_url',
      'bypass_slack_user_sync',
      'slack_health_alerts_workflow_url',
      'health_check_refresh_hours_warn',
      'salesforce_api_get_user_info_endpoint_url',
      'salesforce_access_token',
      'salesforce_refresh_token',
      'slack_api_auth_test_URL',
      'slack_bot_token',
      'error_debug_logs',
      'bypass_salesforce_individual_post'
    ).all();

    const settingsMap = {};
    for (const row of settingsQuery.results) {
      settingsMap[row.DB_SETTING_NAME] = row.SETTING_VALUE;
    }

    const start = Date.now();
    let newWorkerStatus = "Health check failed :x:";
    try {
//======================================================

      const newResponse = await sendHealthCheckNew(env);
      
//=======================================================
      if (settingsMap['error_debug_logs'] === 'TRUE') {
        const newBodyCron = await newResponse.text();
        await logHttpResponseToDB(env, {
          sourceLabel: 'new worker',
          response: newResponse,
          bodyText: newBodyCron,
          requestDetails: {
            method: 'GET',
            url: `service-binding: NEW_WORKER https://internal/health`,
            headers: { "X-Internal-Call": "service-binding" },
            body: null,
          },
          runContext: 'cron'
        });
      }
      
      newWorkerStatus = getStatusLabel(newResponse);
    } catch (err) {
      await logErrorToDB(env, `New worker check failed: ${err.message}`);
    }

    let downstreamWorkerStatus = "Health check failed :x:";
    try {
      const downstreamResponse = await sendHealthCheckDownstream(env);

      if (settingsMap['error_debug_logs'] === 'TRUE') {
        const downstreamBodyCron = await downstreamResponse.text();
        await logHttpResponseToDB(env, {
          sourceLabel: 'downstream worker',
          response: downstreamResponse,
          bodyText: downstreamBodyCron,
          requestDetails: {
            method: 'GET',
            url: `service-binding: DOWNSTREAM_WORKER https://internal/health`,
            headers: { "X-Internal-Call": "service-binding" },
            body: null,
          },
          runContext: 'cron'
        });
      }
      
      downstreamWorkerStatus = getStatusLabel(downstreamResponse);
    } catch (err) {
      await logErrorToDB(env, `Downstream worker check failed: ${err.message}`);
    }

    let dispatcherWorkerStatus = "Health check failed :x:";
    try {
      const dispatcherResponse = await sendHealthCheckDispatcher(env);

      if (settingsMap['error_debug_logs'] === 'TRUE') {
        const dispatcherBodyCron = await dispatcherResponse.text();
        await logHttpResponseToDB(env, {
          sourceLabel: 'dispatcher worker',
          response: dispatcherResponse,
          bodyText: dispatcherBodyCron,
          requestDetails: {
            method: 'GET',
            url: `service-binding: DISPATCHER_WORKER https://internal/health`,
            headers: { "X-Internal-Call": "service-binding" },
            body: null,
          },
          runContext: 'cron'
        });
      }
      
      dispatcherWorkerStatus = getStatusLabel(dispatcherResponse);
    } catch (err) {
      await logErrorToDB(env, `Dispatcher worker check failed: ${err.message}`);
    }

    let slackUsersWorkerStatus = "Health check failed :x:";
    let slackUsersBody = "";
    try {
      const slackUsersResponse = await sendHealthCheckSlackUsers(env);
      slackUsersBody = await slackUsersResponse.text();

      if (settingsMap['error_debug_logs'] === 'TRUE') {
        await logHttpResponseToDB(env, {
          sourceLabel: 'slack users sync worker',
          response: slackUsersResponse,
          bodyText: slackUsersBody,
          requestDetails: {
            method: 'GET',
            url: `service-binding: SLACK_USER_SYNC_WORKER https://internal/health`,
            headers: { "X-Internal-Call": "service-binding" },
            body: null,
          },
          runContext: 'cron'
        });
      }
      
      slackUsersWorkerStatus = getStatusLabel(slackUsersResponse);
    } catch (err) {
      slackUsersBody = "Error: " + err.message;
    }      
    
    let bypassSlackSyncStatus = "Health check failed :x:";
    try {
      const bypassValue = settingsMap['bypass_slack_user_sync'];
      if (bypassValue === 'TRUE') {
        bypassSlackSyncStatus = "Not syncing :x:";
      } else {
        bypassSlackSyncStatus = "OK :heavy_check_mark:";
      }
    } catch (err) {
      bypassSlackSyncStatus = "Error: " + err.message;
    }

    let salesforceStatus = "Health check failed :x:";
    try {
      const salesforceResponse = await sendSalesforceUserInfo({ ...env, ...settingsMap });
      salesforceStatus = getStatusLabel(salesforceResponse);
    } catch (err) {
      await logErrorToDB(env, `Salesforce check failed: ${err.message}`);
    }

    let slackStatus = "Health check failed :x:";
    try {
      const slackResponse = await sendHealthCheckSlack(env, settingsMap);
      slackStatus = getStatusLabel(slackResponse);
    } catch (err) {
      await logErrorToDB(env, `Slack check failed: ${err.message}`);
    }

    let refreshTokenStatus = "Health check failed :x:";
    try {
      const refreshTokenCheck = checkRefreshTokenAge(settingsQuery.results);
      refreshTokenStatus = refreshTokenCheck.status;
    } catch (err) {
      await logErrorToDB(env, `Refresh token check failed: ${err.message}`);
    }

    let bypassSalesforcePostStatus = "Health check failed :x:";
    try {
      const bypassValue = settingsMap['bypass_salesforce_individual_post'];
      if (bypassValue === 'TRUE') {
        bypassSalesforcePostStatus = "Not syncing :x:";
      } else {
        bypassSalesforcePostStatus = "OK :heavy_check_mark:";
      }
    } catch (err) {
      bypassSalesforcePostStatus = "Error: " + err.message;
    }    

    const runTime = `${Date.now() - start}ms`;

    await sendSlackAlert(settingsMap["slack_health_alerts_workflow_url"], {
      new: newWorkerStatus,
      downstream: downstreamWorkerStatus,
      dispatcher: dispatcherWorkerStatus,
      slackUsers: slackUsersWorkerStatus,
      bypassSlackSync: bypassSlackSyncStatus,
      slack: slackStatus,
      salesforce: salesforceStatus,
      refreshToken: refreshTokenStatus,
      bypassSalesforcePost: bypassSalesforcePostStatus,
      runTime: runTime
    });

    const statusSummary = JSON.stringify({
      new: stripEmoji(newWorkerStatus),
      downstream: stripEmoji(downstreamWorkerStatus),
      dispatcher: stripEmoji(dispatcherWorkerStatus),
      slackUsers: stripEmoji(slackUsersWorkerStatus),
      bypassSlackSync: stripEmoji(bypassSlackSyncStatus),    
      slack: stripEmoji(slackStatus),
      salesforce: stripEmoji(salesforceStatus),
      refreshToken: stripEmoji(refreshTokenStatus),
      bypassSalesforcePost: stripEmoji(bypassSalesforcePostStatus),
      runTime: runTime
    });    
    
    await logErrorToDB(env, `Scheduled health check completed: ${statusSummary}`, "Cron");    

  } catch (err) {
    await logErrorToDB(env, `Scheduled health check failed: ${err.message}`);
  }
}
};
