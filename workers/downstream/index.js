// Helper function used to decrypt a versioned base64 string using a secret from the environment
async function decrypt(encryptedWithVersion, env, secretPrefix = 'INTERNAL_APIS_ENCRYPTION_SECRET') {
  try {
    const [encryptedBase64, version] = encryptedWithVersion.split('_v');
    if (!encryptedBase64 || !version) {
      throw new Error('Invalid encrypted format or missing version.');
    }
    const secretName = `${secretPrefix}_v${version}`;
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
  } catch (err) {
    await logErrorToDB(env, `Decryption error: ${err.message ?? err.toString()}`, "Error");
    throw err;
  }
}

// Helper function that logs an error message with a timestamp to the database
async function logErrorToDB(env, errorMessage, errorType = 'Error') {
  try {
    const timestamp = new Date().toISOString();
    await env.DB_PRIMARY.prepare(
      `INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
       VALUES (?, ?, ?, ?)`
    ).bind(timestamp, 'downstream', errorMessage, errorType).run();
  } catch (dbError) {
  }
}

// Helper function to alert in Slack
async function triggerSlackErrorAlert(env, settingsMap, alertMessageBody) {
  if (settingsMap['bypass_slack_error_alerts']?.trim().toUpperCase() === 'TRUE') {
    await logErrorToDB(env, "Slack alert bypassed due to setting", "Debug");
    return;
  }
  const slackAlertUrl = settingsMap['slack_error_alerts_workflow_url'];
  if (!slackAlertUrl) {
    await logErrorToDB(env, "Missing slack_error_alerts_workflow_url setting", "Error");
    return;
  }

  try {
    const payload = JSON.stringify({ message: alertMessageBody });
    const response = await fetch(slackAlertUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });

    if (!response.ok) {
      const errorText = await response.text();
      await logErrorToDB(env, `Slack alert POST failed: ${response.status} - ${errorText}`, "Error");
    }
  } catch (err) {
    await logErrorToDB(env, `Failed to send Slack error alert: ${err.message}`, "Error");
  }
}

// Helper function to build the alert message for Salesforce failures
function buildSalesforceFailureAlertMessage({
  path,
  firstLast,
  slackLink,
  slackPostId,
  settingsMap,
  failedOperationName,
  failedPayload,
  failedRecordId,
  failedRecordType,
  skippedOperations,
  errorMessage
}) {
  const slackPostUrl = `${settingsMap['salesforce_base_url_slack_post']}/${slackPostId}/view`;
  const recordTypeToSettingKey = {
    SlackPost: 'salesforce_base_url_slack_post',
    LifecycleHistory: 'salesforce_base_url_lifecycle_history',
    Case: 'salesforce_base_url_case'
  };
  const recordUrlBase = settingsMap[recordTypeToSettingKey[failedRecordType]] ?? 'undefined';

  const alertMessageParts = [
    '=== SALESFORCE API FAILURE ALERT ===',
    '',
    `Worker: downstream`,
    `Button Clicked: ${path.replace('/', '').charAt(0).toUpperCase() + path.slice(2)}`,
    `Clicked By: ${firstLast ?? 'Unknown'}`,
    `Slack Message: ${slackLink.replace('https://', 'https://\u200B')}`,
    `Slack Post Record (Salesforce): ${slackPostUrl}`,
    '',
    'FAILED OPERATION:',
    `- Name: ${failedOperationName}`,
    `- Record URL: ${failedRecordId !== 'N/A' ? `${recordUrlBase}/${failedRecordId}/view` : 'N/A'}`,
    `- Fields Attempted:`,
    ...Object.entries(failedPayload).map(([key, val]) => {
      const value = key === 'Slack_Link__c'
        ? JSON.stringify(val).replace('https://', 'https://\u200B')
        : JSON.stringify(val);
      return `   > ${key} = ${value}`;
    }),
    `- Error: ${errorMessage ?? 'Unknown error occurred'} >>>> review logs for more information`,
    '',
    'SKIPPED OPERATIONS:'
  ];

  if (skippedOperations.length > 0) {
    skippedOperations.forEach((op, index) => {
      alertMessageParts.push(`${index + 1}. ${op.name}`);
      alertMessageParts.push(` - Record URL: ${op.recordUrl}`);
      alertMessageParts.push(` - Fields:`);
      Object.entries(op.fields).forEach(([key, val]) => {
        alertMessageParts.push(`   > ${key} = ${JSON.stringify(val)}`);
      });
      alertMessageParts.push('');
    });
  } else {
    alertMessageParts.push('- No additional Salesforce updates were skipped.\n');
  }

  alertMessageParts.push(
    'Salesforce bypass has been enabled for this message. No further updates to Salesforce will occur for this Slack message. Please manually update or create Salesforce records using the information in this alert.'
  );

  return alertMessageParts.join('\n');
}

// Helper function that updates the Dashboard and releases the lock
  async function updateDashboardRow(env, settingsMap, messageTimestamp, lockToken, helperName, status, supportMessageText = null) {
    const now = new Date().toISOString();

  try {
    const result = await env.DB_PRIMARY.prepare(
      `UPDATE Dashboard
       SET HELPER_NAME = ?, STATUS = ?, LAST_UPDATED = ?, LOCKED_UNIX_TIMESTAMP = NULL, RELAY_MESSAGE_TEXT = NULL, SUPPORT_MESSAGE_TEXT = ?
       WHERE MESSAGE_TIMESTAMP = ? AND LOCKED_UNIX_TIMESTAMP = ?`
    ).bind(helperName, status, now, supportMessageText, messageTimestamp, Number(lockToken)).run();

    if (settingsMap['error_debug_logs'] === 'TRUE') {
      if (result.meta.changes === 1) {
        await logErrorToDB(env, `Debug: Dashboard updated and lock released for message_ts=${messageTimestamp}`, "Debug");
      } else {
        await logErrorToDB(env, `Debug: Dashboard update skipped — lock mismatch for message_ts=${messageTimestamp}`, "Debug");
      }
    }

    return result.meta.changes === 1;
  } catch (err) {
    await logErrorToDB(env, `Error updating Dashboard row: ${err.message ?? err.toString()}`, "Error");
    return false;
  }
}

// Helper function that builds a Slack message payload for the support channel based on action path and user data
function buildSupportChannelPayload(dispatcherPayload, path, settings, dynamicIds, bypassSalesforce = false) {
  const supportChannelId = settings['slack_channel_id_support'] ?? 'placeholder_channel_id';
  const supportMessageTs = dispatcherPayload.supportMessageTs ?? 'placeholder_ts';
  const userId = dispatcherPayload.userId ?? 'U0000000000';

  const statusTextMap = {
    '/start': `*Status:* In Progress :hourglass:\n*Owner:* <@${userId}>`,
    '/stop': `*Status:* Closed :lock:\n*Stopped By:* <@${userId}>`,
    '/relay': `*Status:* Relayed :warning:\n*Owner:* Pending Assignment`,
    '/accept': `*Status:* In Progress :hourglass:\n*Owner:* <@${userId}>`,
    '/escalate': `*Status:* Escalated :upvote:\n*Escalated By:* <@${userId}>`
  };

  const valueString = Object.entries(dynamicIds)
    .map(([key, val]) => `${key}:${val}`)
    .join(', ');

  const buttonMap = {
    '/start': ['Relay', 'Stop', 'Escalate'],
    '/stop': ['Relay'],
    '/relay': ['Relay', 'Stop', 'Escalate'],
    '/accept': ['Relay', 'Stop', 'Escalate'],
    '/escalate': ['Relay']
  };

  const buttonLabels = buttonMap[path] ?? [];
  const buttons = buttonLabels.map(label => ({
    type: 'button',
    text: { type: 'plain_text', text: label, emoji: true },
    style: ['Start', 'Stop'].includes(label) ? 'primary' : label === 'Escalate' ? 'danger' : undefined,
    value: valueString,
    action_id: `action_name:${label}`
  }));

  // Sort rich text blocks by expected order
  const expectedOrder = ['fallback_message','post_info', 'issue_summary', 'duplication_steps', 'examples', 'rep_question'];
  const richTextBlocks = dispatcherPayload.richTextBlocks ?? [];

  const sortedRichTextBlocks = expectedOrder
    .map(blockId => richTextBlocks.find(block => block.block_id === blockId))
    .filter(Boolean); // remove undefined if any block is missing

  const modifiedByBlock = richTextBlocks.find(block => block.block_id === 'modified_by');

  return {
    channel: supportChannelId,
    ts: supportMessageTs,
    blocks: [
      ...sortedRichTextBlocks,
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: (bypassSalesforce ? '`Salesforce updates are disabled on this message`\n\n' : '') + (statusTextMap[path] ?? '*Status:* Unknown')
        }        
      },
      ...(modifiedByBlock ? [modifiedByBlock] : []),
      ...(settings['debug_mode'] === 'TRUE'
        ? [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Debug Info:*\n\`\`\`\n${Object.entries(dynamicIds).map(([k, v]) => `${k}:${v}`).join('\n')}\n\`\`\``
            }
          }]
        : []),
      {
        type: 'actions',
        elements: buttons
      }
    ]
  };
}


// Helper function that builds a Slack relay alert message with an Accept button linking to the original post
function buildRelayAlertsPayload(userId, supportChannel, supportMessageTs, dynamicIds, relayChannel, settingsMap) {
  return {
    channel: relayChannel,
    unfurl_links: false,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `<@${userId}> relayed this post: \n${settingsMap['slack_message_base_url']}/${supportChannel}/p${supportMessageTs.replace('.', '')}`
        }
      },

      //Optional debug info
      ...(settingsMap['debug_mode'] === 'TRUE' ? [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Debug Info:*\n\`\`\`\nmessage_ts:${supportMessageTs}\n${Object.entries(dynamicIds).map(([k, v]) => `${k}:${v}`).join('\n')}\n\`\`\``
        }
      }] : []),
      
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Accept',
              emoji: true
            },
            value: `message_ts:${supportMessageTs}, case_id:${dynamicIds.case_id}, slack_post_id:${dynamicIds.slack_post_id}, lifecycle_id:${dynamicIds.lifecycle_id}`,
            action_id: 'action_name:Accept'
          }
        ]
      }
    ]
  };
}

// Helper function that builds a Slack message showing that a user accepted a relayed alert
function buildAcceptAlertsPayload(userId, relayChannel, relayAlertsMessageTs, relayMessageText) {
  return {
    channel: relayChannel,
    ts: relayAlertsMessageTs,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: relayMessageText
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `<@${userId}> clicked *Accept*`
        }
      }
    ],
    text: 'Accepted by user'
  };
}

// Helper function that sends API calls to Slack to create or update Slack messages for relay alerts and support
async function postToSlack(url, token, payload, env, settingsMap, firstLast = 'Unknown') {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    let responseBody = null;

    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // If not JSON, leave responseBody as null
    }

    if (!response.ok || (responseBody && responseBody.ok === false)) {
      await logErrorToDB(
        env,
        `Slack API error (${response.status}): ${responseText}`,
        "Error"
      );
      
      const actionName = env?.PATH ? env.PATH.replace('/', '').charAt(0).toUpperCase() + env.PATH.slice(2) : 'Unknown';
      const userName = firstLast ?? 'Unknown';
      const messageTs = payload?.ts ?? 'unknown';
      const channelId = payload?.channel ?? 'unknown';
      const slackMessageUrl = `${settingsMap['slack_message_base_url'].replace('https://', 'https://\u200B')}/${channelId}/p${messageTs.replace('.', '')}`;
      
      const alertMessage = [
        `Worker: downstream`,
        `Message: Slack API call to ${url.includes('update') ? 'update' : 'create'} message ${slackMessageUrl} failed after ${userName} clicked ${actionName}`,
        `Error: ${responseBody?.error ?? `HTTP ${response.status}`}`,
        `Action Needed: Review logs and investigate why the ${url.includes('update') ? 'update' : 'creation'} failed if needed.\nSalesforce bypass will be enabled. Any further updates to Salesforce will need to be completed manually.`
      ].join('\n');
      
      await triggerSlackErrorAlert(env, settingsMap, alertMessage);      
    }

    return {
      status: response.status,
      responseBody: responseBody ?? responseText
    };
  } catch (err) {
    await logErrorToDB(env, `Slack post failed: ${err.message ?? err.toString()}`, "Error");
    throw err;
  }
}

// Helper function that retries a Salesforce api call on temporary failure
async function withSalesforceRetry(operationFn, env, settingsMap, operationName = 'Salesforce Operation') {
  const retrySetting = parseInt(settingsMap['downstream_salesforce_retries'], 10);
  const maxAttempts = isNaN(retrySetting) ? 3 : 1 + Math.max(0, retrySetting);
  const delayMs = 250;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operationFn();
    } catch (err) {
      const status = err?.response?.status ?? err?.status ?? null;
      const message = err?.message ?? err.toString();

      // Log the error
      await logErrorToDB(env, `Attempt ${attempt} failed for ${operationName}: ${message}`, "Error");

      // Determine if the error is permanent
      const isPermanentError = status && [400, 401, 403, 404].includes(status);
      const isLastAttempt = attempt === maxAttempts;

      if (isPermanentError) {
        await logErrorToDB(env, `${operationName} failed permanently with status ${status}. Skipping retries.`, "Error");
        throw err;
      }

      if (isLastAttempt) {
        await logErrorToDB(env, `${operationName} failed after Max ${maxAttempts} attempts. Giving up.`, "Error");
        throw err;
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

// Helper function that converts a Unix timestamp value into ISO 8601 without milliseconds
function formatUnixTimestampToIsoWithoutMilliseconds(unixTimestampMs) {
  const date = new Date(Number(unixTimestampMs));
  return date.toISOString().split('.')[0] + 'Z';
}

// Helper function to calculate SLA seconds between a Slack message timestamp and an action timestamp (It should work with both start and accept, but only tested with start so far)
function calculateSlaSeconds(messageTs, actionTimestamp) {
  try {
    const messageUnixSeconds = parseInt(messageTs.split('.')[0], 10); // Slack timestamp in seconds
    const actionUnixSeconds = parseInt(actionTimestamp, 10); // Already in seconds
    if (isNaN(messageUnixSeconds) || isNaN(actionUnixSeconds)) {
      throw new Error('Invalid timestamp input');
    }
    const slaSeconds = Math.max(0, actionUnixSeconds - messageUnixSeconds);
    return slaSeconds;
  } catch (err) {
    // Optionally log or handle error
    return 0;
  }
}

//Helper function that unicode-safe base64 encodes a string
function encodeBase64Unicode(str) {
  const utf8Bytes = new TextEncoder().encode(str);
  const binary = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('');
  return btoa(binary);
}

//Helper function that decodes a unicode-safe base64 string from the database
function decodeBase64Unicode(str) {
  const binary = atob(str);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Helper function that updates a Salesforce Slack Post Record
async function updateSalesforceSlackPostRecord(payload, decryptedSalesforceToken, salesforceApiSlackPostUrl, env) {
  try {
    const response = await fetch(salesforceApiSlackPostUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${decryptedSalesforceToken}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Update Salesforce Slack Post Record failed with status ${response.status}`);
      error["status"] = response.status;
      await logErrorToDB(env, `Update Salesforce Slack Post Record error (${response.status}): ${errorText}`, "Error");
      throw error;
    }

    if (response.status === 204) {
      return {}; // No content, but successful
    }
    
    const text = await response.text();
    return text ? JSON.parse(text) : {};    
  } catch (err) {
    await logErrorToDB(env, `Update Salesforce Slack Post Record failed: ${err.message ?? err.toString()}`, "Error");
    throw err;
  }
}

// Helper function that updates a Salesforce Lifecycle History record
async function updateSalesforceLifecycleHistoryRecord(payload, decryptedSalesforceToken, salesforceApiLifecycleHistoryUrl, env) {
  try {
    const response = await fetch(salesforceApiLifecycleHistoryUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${decryptedSalesforceToken}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Update Salesforce Lifecycle History Record failed with status ${response.status}`);
      error["status"] = response.status;
      await logErrorToDB(env, `Update Salesforce Lifecycle History Record error (${response.status}): ${errorText}`, "Error");
      throw error;
    }

    if (response.status === 204) {
      return {}; // No content, but successful
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    await logErrorToDB(env, `Update Salesforce Lifecycle History Record failed: ${err.message ?? err.toString()}`, "Error");
    throw err;
  }
}

// Helper function that creates a new Salesforce Lifecycle History record
async function createSalesforceLifecycleHistoryRecord(payload, decryptedSalesforceToken, salesforceApiLifecycleHistoryUrl, env) {
  try {
    const response = await fetch(salesforceApiLifecycleHistoryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${decryptedSalesforceToken}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Create Salesforce Lifecycle History Record failed with status ${response.status}`);
      error["status"] = response.status;
      await logErrorToDB(env, `Create Salesforce Lifecycle History Record error (${response.status}): ${errorText}`, "Error");
      throw error;
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    await logErrorToDB(env, `Create Salesforce Lifecycle History Record failed: ${err.message ?? err.toString()}`, "Error");
    throw err;
  }
}

// Helper function that updates the Chasm__c field on a Salesforce Case record
async function updateChasmField(payload, decryptedSalesforceToken, salesforceApiCaseUpdateUrl, env) {
  try {
    const response = await fetch(salesforceApiCaseUpdateUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${decryptedSalesforceToken}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Update Chasm__c field failed with status ${response.status}`);
      error["status"] = response.status;
      await logErrorToDB(env, `Update Chasm__c field error (${response.status}): ${errorText}`, "Error");
      throw error;
    }

    if (response.status === 204) {
      return {}; // No content, but successful
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    await logErrorToDB(env, `Update Chasm__c field failed: ${err.message ?? err.toString()}`, "Error");
    throw err;
  }
}

// Helper function that sends an api request to create a Case Comment in Salesforce
async function postCaseCommentToSalesforce(payload, decryptedSalesforceToken, salesforceApiCommentUrl, env) {
  const url = salesforceApiCommentUrl;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${decryptedSalesforceToken}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Salesforce API request failed with status ${response.status}`);
      error["status"] = response.status;
      await logErrorToDB(env, `Salesforce API error (${response.status}): ${errorText}`, "Error");
      throw error;
    }
    

    return await response.json();
  } catch (err) {
    await logErrorToDB(env, `Salesforce post failed: ${err.message ?? err.toString()}`, "Error");
    throw err;
  }
}

//-------------------- Main function that triggers when a request sends to the worker --------------------//
export default {
  async fetch(request, env, ctx) {
    let supportMessageTs = '';
    let lockToken = '';


    const host = request.headers.get('host');
    if (host && host.endsWith('.workers.dev')) {
      return new Response('Forbidden', { status: 403 });
    }

    const url = new URL(request.url);
      const path = url.pathname;
      const normalizedPath = path.toLowerCase();
      env.PATH = normalizedPath

      const allowedPaths = new Set([
        '/start',
        '/stop',
        '/relay',
        '/accept',
        '/escalate',
        '/comment',
        '/health'
      ]);
      
      if (!allowedPaths.has(normalizedPath)) {
        return new Response('Not Found', { status: 404 });
      }

//Health Check Logic Starts Here
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
        headers: {
          'Allow': allowedMethods.join(', '),
          'Content-Type': 'text/plain',
        },
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
      const settingNames = [
        'internal_api_key',
        'slack_bot_token',
        'bypass_salesforce_individual_post',
        'salesforce_access_token',
        'salesforce_api_case_comment_endpoint_url',
        'salesforce_api_slack_post_endpoint_url',
        'salesforce_api_lifecycle_history_endpoint_url',
        'salesforce_api_case_update_endpoint_url',
        'downstream_salesforce_retries',
        'slack_channel_id_support',
        'slack_channel_id_relay_alerts',
        'slack_api_post_message_url',
        'slack_api_update_message_url',
        'error_debug_logs',
        'debug_mode',
        'slack_message_base_url',
        'slack_error_alerts_workflow_url',
        'bypass_slack_error_alerts',
        'salesforce_base_url_slack_post',
        'salesforce_base_url_lifecycle_history',
        'salesforce_base_url_case'
      ];      
      const placeholders = settingNames.map(() => '?').join(', ');
      const settingsResult = await env.DB_PRIMARY.prepare(
        `SELECT DB_SETTING_NAME, SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME IN (${placeholders})`
      ).bind(...settingNames).all();
      
      const settingsMap = {};
      for (const row of settingsResult.results) {
        settingsMap[row.DB_SETTING_NAME] = row.SETTING_VALUE;
      }

      for (const name of settingNames) {
        if (!settingsMap[name]) {
          await logErrorToDB(env, `Missing or empty setting: ${name}`, "Error");

          const alertMsg = [
            "Worker: downstream",
            `Message: Missing or empty setting: "${name}"`,
            `Triggering Path: ${env.PATH}`,
            "Action Needed: Ensure this setting exists on the database and is not empty to restore functionality"
          ].join('\n');
          await triggerSlackErrorAlert(env, settingsMap, alertMsg);
          
          return new Response(`Server configuration error: missing setting ${name}`, {
            status: 500,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
      }      
      
      let decryptedKey;
      try {
        decryptedKey = await decrypt(settingsMap['internal_api_key'], env, 'INTERNAL_APIS_ENCRYPTION_SECRET');
      } catch (e) {
        const alertMsg = [
          "Worker: downstream",
          "Message: Decryption failed for internal_api_key",
          `Error: ${e.message}`,
          "Action Needed: Update internal_api_secret_version to a valid version and readd internal_api_key to restore functionality"
        ].join('\n');
        await logErrorToDB(env, alertMsg);
        await triggerSlackErrorAlert(env, settingsMap, alertMsg);
        throw e;
      }

      if (settingsMap['error_debug_logs'] === 'TRUE') {
        await logErrorToDB(env, 'Debug: Decrypted internal_api_key successfully', "Debug");
      }
         
      let decryptedSlackBotToken;
      try {
        decryptedSlackBotToken = await decrypt(settingsMap['slack_bot_token'], env, 'SLACK_APIS_ENCRYPTION_SECRET');
      } catch (e) {
        const alertMsg = [
          "Worker: downstream",
          "Message: Decryption failed for slack_bot_token",
          `Error: ${e.message}`,
          "Action Needed: Update slack_api_secret_version to a valid version and readd slack_bot_token to restore functionality"
        ].join('\n');
        await logErrorToDB(env, alertMsg);
        await triggerSlackErrorAlert(env, settingsMap, alertMsg);
        throw e;
      }
      
      let decryptedSalesforceToken;
      try {
        decryptedSalesforceToken = await decrypt(settingsMap['salesforce_access_token'], env, 'SALESFORCE_APIS_ENCRYPTION_SECRET');
      } catch (e) {
        const alertMsg = [
          "Worker: downstream",
          "Message: Decryption failed for salesforce_access_token",
          `Error: ${e.message}`,
          "Action Needed: Update salesforce_api_secret_version to a valid version and reconnect Salesforce to restore functionality"
        ].join('\n');
        await logErrorToDB(env, alertMsg);
        await triggerSlackErrorAlert(env, settingsMap, alertMsg);
        throw e;
      }
      
      const salesforceApiSlackPostUrl = settingsMap['salesforce_api_slack_post_endpoint_url'];
      const salesforceAPILifecycleUrl = settingsMap['salesforce_api_lifecycle_history_endpoint_url'];           

      const token = authHeader.slice(7);
      if (token !== decryptedKey) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
        });
      }


// CASE COMMENT LOGIC STARTS HERE //
      if (path === '/comment') {
        let rawBody;
        try {
          rawBody = await request.json();

      if (settingsMap['error_debug_logs'] === 'TRUE') {
        await logErrorToDB(env, `Debug: Received comment submission: ${JSON.stringify(rawBody)}`, "Debug");
      }

      const { caseId, firstLast, commentText } = rawBody;

      const salesforcePayload = {
        ParentId: caseId,
        CommentBody: `**${firstLast} created a comment from Slack**\n\n${commentText}`,
        IsPublished: false
      };
      const salesforceApiCommentUrl = settingsMap['salesforce_api_case_comment_endpoint_url'];
      
      try {
        await postCaseCommentToSalesforce(salesforcePayload, decryptedSalesforceToken, salesforceApiCommentUrl, env);

        return new Response("Comment received", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      } catch (err) {
        const status = err?.response?.status ?? err?.status ?? null;
      
        if ([400, 401, 403, 404].includes(status)) {
          // Permanent error
          return new Response("Permanent error occured posting comment", {
            status: 400,
            headers: { "Content-Type": "text/plain" },
          });
        }
      
        // Retry-exhausted or unknown error
        return new Response("Exhausted all retries while attempting to post comment", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        });
      }                     

    } catch (err) {
      await logErrorToDB(env, `Comment path JSON parse error: ${err.message ?? err.toString()}`, "Error");
      return new Response('Bad Request: Invalid JSON body', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  }
// CASE COMMENT LOGIC ENDS HERE //


// Parses the payload to get the lockToken, gets values from the DB and verifies the lockTokens match before continuing
      let rawBody;
      let dashboardRow;
      try {
        rawBody = await request.json();


        if (settingsMap['error_debug_logs'] === 'TRUE') {
          await logErrorToDB(env, `Debug: Parsed request body: ${JSON.stringify(rawBody)}`, "Debug");
        }
        lockToken = rawBody.lockToken;
        supportMessageTs = rawBody.supportMessageTs;
        
        dashboardRow = await env.DB_PRIMARY.prepare(
          `SELECT LOCKED_UNIX_TIMESTAMP, STATUS, BYPASS_SALESFORCE, SUPPORT_MESSAGE_TEXT, RELAY_MESSAGE_TEXT FROM Dashboard WHERE MESSAGE_TIMESTAMP = ? LIMIT 1`
        ).bind(supportMessageTs).first();        
          
        if (!dashboardRow || dashboardRow.LOCKED_UNIX_TIMESTAMP !== Number(lockToken)) {
            await logErrorToDB(env, `Lock mismatch or expired for message_ts=${supportMessageTs}. Expected=${lockToken}, Found=${dashboardRow?.LOCKED_UNIX_TIMESTAMP}`, "Error");
            return new Response('Lock expired or taken by another worker.', { status: 409 });
          }

// SPECIAL LOGIC TO REMOVE THE ACCEPT BUTTON STARTS HERE //
if (path !== '/accept' && dashboardRow?.STATUS === 'Relayed') {
  const relayChannel = settingsMap['slack_channel_id_relay_alerts'] ?? 'RELAY_CHANNEL_ID';
  const relayMessageTs = rawBody.relayAlertsMessageTs ?? 'unknown';
  try {

    let originalRelayText;
    try {
      const encodedRelayText = dashboardRow?.RELAY_MESSAGE_TEXT;
      if (!encodedRelayText || encodedRelayText.trim() === '') {
        throw new Error('RELAY_MESSAGE_TEXT is null or empty');
      }
      originalRelayText = decodeBase64Unicode(encodedRelayText);
      if (!originalRelayText || originalRelayText.trim() === '') {
        throw new Error('Decoded relay text is empty');
      }
    } catch (e) {
      originalRelayText = "_An unexpected error occurred and the original message text was lost_";
      const alertMsg = [
        "Worker: downstream",
        "Message: Failed to decode RELAY_MESSAGE_TEXT from Dashboard",
        `Error: ${e.message}`,
        `Triggering Path: ${env.PATH}`,
        "Action Needed: Investigate why the stored message text is corrupted or missing"
      ].join('\n');
      await logErrorToDB(env, alertMsg, "Error");
      await triggerSlackErrorAlert(env, settingsMap, alertMsg);
    }    

    const updatedRelayPayload = {
      channel: relayChannel,
      ts: relayMessageTs,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: originalRelayText }
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Another button was clicked. The *Accept* button has been removed' }
        }
      ],
      text: 'Accept button removed due to other action'
    };
    if (settingsMap['error_debug_logs'] === 'TRUE') {
      await logErrorToDB(env, `Debug: Relay cleanup payload: ${JSON.stringify(updatedRelayPayload)}`, "Debug");
    }
    const response = await postToSlack(settingsMap['slack_api_update_message_url'], decryptedSlackBotToken, updatedRelayPayload, env, settingsMap, rawBody.firstLast);

    // Check for Slack failure
    const slackFailed =
    response.status !== 200 ||
    (typeof response.responseBody === 'object' && response.responseBody.ok === false);
    
    if (slackFailed) {
      await env.DB_PRIMARY.prepare(
        `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
        ).bind(supportMessageTs).run();
      }
    } catch (err) {
      await logErrorToDB(env, `Relay cleanup failed: ${err.message ?? err.toString()}`, "Error");
    }
  }
// SPECIAL LOGIC TO REMOVE THE ACCEPT BUTTON ENDS HERE //


//Catches errors from parsing logic just above the Special logic block        
} catch (err) {
  await logErrorToDB(env, `JSON parse error: ${err.message ?? err.toString()}`, "Error");

  const alertMsg = [
    "Worker: downstream",
    "Message: Failed to parse JSON body from incoming request",
    `Path: ${env.PATH}`,
    `Error: ${err.message ?? err.toString()}`,
    "Action Needed: Ensure the request body being sent by the dispacther is valid JSON and matches expected structure"
  ].join('\n');
  await triggerSlackErrorAlert(env, settingsMap, alertMsg);

  return new Response('Bad Request: Missing or invalid JSON body', {
    status: 400,
    headers: { 'Content-Type': 'text/plain' },
  });
}    

//Creates values from buttons that can be used later      
      const dynamicIds = {
        relay_message_ts: rawBody.relayAlertsMessageTs ?? 'unknown',
        case_id: rawBody.caseId ?? 'placeholder_case_id',
        slack_post_id: rawBody.slackPostId ?? 'placeholder_post_id',
        lifecycle_id: rawBody.lifecycleId ?? 'placeholder_lifecycle_id',
        ...(rawBody.extra_ids || {}) // allows for any additional dynamic keys
      };      
      
// RELAY PATH LOGIC STARTS HERE //
if (path === '/relay') {
  const relayChannel = settingsMap['slack_channel_id_relay_alerts'] ?? 'RELAY_CHANNEL_ID';
  const supportChannel = settingsMap['slack_channel_id_support'] ?? 'CHANNEL_ID';
  const userId = rawBody.userId ?? 'SLACK_USER_ID';

  let bypassSalesforce = false;
  const bypassSalesforceSetting = settingsMap['bypass_salesforce_individual_post'] === 'TRUE';

  if (bypassSalesforceSetting) {
    bypassSalesforce = true;
    await env.DB_PRIMARY.prepare(
      `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
    ).bind(supportMessageTs).run();
  } else if (dashboardRow?.BYPASS_SALESFORCE === 'TRUE') {
    bypassSalesforce = true;
  }
  const slackLink = `${settingsMap['slack_message_base_url']}/${settingsMap['slack_channel_id_support']}/p${supportMessageTs.replace('.', '')}`;

  //Declare variables and payloads for Salesforce updates
    const slackPostId = dynamicIds.slack_post_id;
    const slackPostRecordUrl = `${salesforceApiSlackPostUrl}/${slackPostId}`;
    const startedDateTime = formatUnixTimestampToIsoWithoutMilliseconds(Number(rawBody.actionTimestamp) * 1000);
    const slackPostRecordPayload = {
      Stopped_By__c: '',
      Stopped_Date_Time__c: '',
      Status__c: 'In Progress',
      Post_was_Relayed__c: true
    };
    const lifecycleHistoryId = dynamicIds.lifecycle_id;
    const lifecycleHistoryUrl = `${salesforceAPILifecycleUrl}/${lifecycleHistoryId}`;
    const lifecycleHistoryPayload = {
        End_Time__c: startedDateTime
    };
    const lifecycleHistoryCreatePayload = {
      Case__c: dynamicIds.case_id,
      Slack_Post__c: dynamicIds.slack_post_id,
      Name: `${rawBody.firstLast ?? 'Unknown'} - Slack Relayed`,
      Owner__c: rawBody.sfUserId,
      Status__c: 'New',
      Start_Time__c: startedDateTime
    };

    let failedOperationName = '';
    let failedPayload = {};
    let failedRecordId = '';
    let failedRecordType = '';

  try {
    if (!bypassSalesforce) {

      // Update Slack Post Record
      failedOperationName = 'Update Slack Post Record';
      failedPayload = slackPostRecordPayload;
      failedRecordId = slackPostId;
      failedRecordType = 'SlackPost';

      await withSalesforceRetry(
        () => updateSalesforceSlackPostRecord(slackPostRecordPayload, decryptedSalesforceToken, slackPostRecordUrl, env),
        env,
        settingsMap,
        `Update Salesforce Slack Post Record with Id ${slackPostId}`
      );

      // Update existing Lifecycle History Record
      failedOperationName = 'Update Lifecycle History Record';
      failedPayload = lifecycleHistoryPayload;
      failedRecordId = lifecycleHistoryId;
      failedRecordType = 'LifecycleHistory';

      await withSalesforceRetry(
        () => updateSalesforceLifecycleHistoryRecord(lifecycleHistoryPayload, decryptedSalesforceToken, lifecycleHistoryUrl, env),
        env,
        settingsMap,
        `Update Salesforce Lifecycle History Record with Id ${lifecycleHistoryId}`
      );

      // Create new Lifecycle History Record
      failedOperationName = 'Create Lifecycle History Record';
      failedPayload = lifecycleHistoryCreatePayload;
      failedRecordId = 'N/A';
      failedRecordType = 'LifecycleHistory';

      const lifecycleCreateResponse = await withSalesforceRetry(
        () => createSalesforceLifecycleHistoryRecord(lifecycleHistoryCreatePayload, decryptedSalesforceToken, salesforceAPILifecycleUrl, env),
        env,
        settingsMap,
        `Create Salesforce Lifecycle History Record for Slack Post Id ${slackPostId}`
      );

      // Overwrite lifecycle_id
      dynamicIds.lifecycle_id = lifecycleCreateResponse?.id ?? 'undefined';
    }
  }
  catch (err) {
    await env.DB_PRIMARY.prepare(
      `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
    ).bind(supportMessageTs).run();
    bypassSalesforce = true;
  
    const skippedOperations = [];
  
    if (failedOperationName === 'Update Slack Post Record') {
      skippedOperations.push({
        name: 'Update Lifecycle History Record',
        recordUrl: `${settingsMap['salesforce_base_url_lifecycle_history']}/${lifecycleHistoryId}/view`,
        fields: lifecycleHistoryPayload
      });
      skippedOperations.push({
        name: 'Create Lifecycle History Record',
        recordUrl: 'N/A',
        fields: lifecycleHistoryCreatePayload
      });
    } else if (failedOperationName === 'Update Lifecycle History Record') {
      skippedOperations.push({
        name: 'Create Lifecycle History Record',
        recordUrl: 'N/A',
        fields: lifecycleHistoryCreatePayload
      });
    }
  
    const alertMessage = buildSalesforceFailureAlertMessage({
      path: '/relay',
      firstLast: rawBody.firstLast,
      slackLink,
      slackPostId,
      settingsMap,
      failedOperationName,
      failedPayload,
      failedRecordId,
      failedRecordType,
      skippedOperations,
      errorMessage: err.message
    });
  
    await triggerSlackErrorAlert(env, settingsMap, alertMessage);
  }
  
  
  finally {
// Build payload and create the relay message
    const relayPayload = buildRelayAlertsPayload(
      userId,
      supportChannel,
      supportMessageTs,
      dynamicIds,
      relayChannel,
      settingsMap
    );

    const { responseBody } = await postToSlack(settingsMap['slack_api_post_message_url'], decryptedSlackBotToken, relayPayload, env, settingsMap, rawBody.firstLast);
    

    let relayMessageTs = 'unknown';
    if (responseBody && typeof responseBody === 'object' && responseBody.ts) {
      relayMessageTs = responseBody.ts;
    } else {
      await logErrorToDB(env, `Failed to extract ts from Slack response`, "Error");
    }
    if (!responseBody || typeof responseBody !== 'object' || responseBody.ok === false) {
      await env.DB_PRIMARY.prepare(
        `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
      ).bind(supportMessageTs).run();
      bypassSalesforce = true;
    }    

    dynamicIds.relay_message_ts = relayMessageTs;

// Build payload and update support channel message
    const richTextBlocks = Object.entries(rawBody)
  .filter(([key, value]) => key.endsWith('_block') && value?.type === 'rich_text')
  .map(([_, block]) => block);
  
  const supportChannelPayload = buildSupportChannelPayload(
    {
      ...rawBody,
      supportMessageTs,
      richTextBlocks,
      userId: rawBody.userId ?? 'U0000000000'
    },
    path,
    settingsMap,
    dynamicIds,
    bypassSalesforce
  );

  const supportResponse = await postToSlack(settingsMap['slack_api_update_message_url'], decryptedSlackBotToken, supportChannelPayload, env, settingsMap, rawBody.firstLast);
  const slackFailedSupport = supportResponse.status !== 200 ||
  (typeof supportResponse.responseBody === 'object' && supportResponse.responseBody.ok === false);

  if (slackFailedSupport) {
    await env.DB_PRIMARY.prepare(
      `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
    ).bind(supportMessageTs).run();
    bypassSalesforce = true;
  }

  // Declare values for the dashboard update
    const helperName = 'Pending';
    const status = 'Relayed';
    const now = new Date().toISOString().split('.')[0] + 'Z';

  //Encode Relay Message
    const relayMainText = relayPayload.blocks?.[0]?.text?.text ?? '';
    let encodedRelayText = null;
    try {
      encodedRelayText = encodeBase64Unicode(relayMainText);
    } catch (e) {
      await logErrorToDB(env, `Encoding failed for RELAY_MESSAGE_TEXT: ${e.message}`, "Error");
    }

  //Encode Support Message
    const supportMessageBlocks = supportChannelPayload.blocks?.filter(block => block.type === 'rich_text') ?? [];
    let encodedSupportMessageText = null;
    try {
      encodedSupportMessageText = encodeBase64Unicode(JSON.stringify(supportMessageBlocks));
    } catch (e) {
      await logErrorToDB(env, `Encoding failed for SUPPORT_MESSAGE_TEXT: ${e.message}`, "Error");
    }

// Update the Dashboard with all relevant fields including SUPPORT_MESSAGE_TEXT
  await env.DB_PRIMARY.prepare(`
    UPDATE Dashboard 
    SET HELPER_NAME = ?, STATUS = ?, LAST_UPDATED = ?, LOCKED_UNIX_TIMESTAMP = NULL, RELAY_MESSAGE_TEXT = ?, SUPPORT_MESSAGE_TEXT = ?
    WHERE MESSAGE_TIMESTAMP = ? AND LOCKED_UNIX_TIMESTAMP = ?
  `).bind(
    helperName,
    status,
    now,
    encodedRelayText,
    encodedSupportMessageText,
    supportMessageTs,
    Number(lockToken)
  ).run();
   }
}
// RELAY PATH LOGIC ENDS HERE //    

// ACCEPT PATH LOGIC STARTS HERE //   
if (path === '/accept') {
  const relayChannel = settingsMap['slack_channel_id_relay_alerts'] ?? 'RELAY_CHANNEL_ID';
  const relayAlertsMessageTs = rawBody.relayAlertsMessageTs ?? 'RELAY_ALERTS_MESSAGE_TS';
  const userId = rawBody.userId ?? 'SLACK_USER_ID';
  const slackPostId = dynamicIds.slack_post_id;

  // Check Salesforce bypass settings
  let bypassSalesforce = false;
  const bypassSalesforceSetting = settingsMap['bypass_salesforce_individual_post'] === 'TRUE';
  if (bypassSalesforceSetting) {
    bypassSalesforce = true;
    await env.DB_PRIMARY.prepare(
      `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
    ).bind(supportMessageTs).run();
  } else if (dashboardRow?.BYPASS_SALESFORCE === 'TRUE') {
    bypassSalesforce = true;
  }

    const slackLink = `${settingsMap['slack_message_base_url']}/${settingsMap['slack_channel_id_support']}/p${supportMessageTs.replace('.', '')}`;

  //Declare values and payloads for Salesforce updates
    const startedDateTime = formatUnixTimestampToIsoWithoutMilliseconds(Number(rawBody.actionTimestamp) * 1000);
    const slaSeconds = calculateSlaSeconds(dynamicIds.relay_message_ts, rawBody.actionTimestamp);
    const lifecycleHistoryId = dynamicIds.lifecycle_id;
    const lifecycleHistoryUrl = `${salesforceAPILifecycleUrl}/${lifecycleHistoryId}`;
    const lifecycleHistoryPayload = {
      End_Time__c: startedDateTime
    };
    const lifecycleHistoryCreatePayload = {
      Case__c: dynamicIds.case_id,
      Slack_Post__c: dynamicIds.slack_post_id,
      Name: `${rawBody.firstLast ?? 'Unknown'} - Slack Accepted`,
      Owner__c: rawBody.sfUserId,
      Status__c: 'In Progress',
      Start_Time__c: startedDateTime,
      SLA_Seconds__c: slaSeconds
    };

    let failedOperationName = '';
    let failedPayload = {};
    let failedRecordId = '';
    let failedRecordType = '';


  try {
    if (!bypassSalesforce) {

      // Update existing Lifecycle History record   
    failedOperationName = 'Update Lifecycle History Record';
    failedPayload = lifecycleHistoryPayload;
    failedRecordId = lifecycleHistoryId;
    failedRecordType = 'LifecycleHistory';

      await withSalesforceRetry(
        () => updateSalesforceLifecycleHistoryRecord(lifecycleHistoryPayload, decryptedSalesforceToken, lifecycleHistoryUrl, env),
        env,
        settingsMap,
        `Update Salesforce Lifecycle History Record with Id ${lifecycleHistoryId}`
      );

      // Create new Lifecycle History record      
    failedOperationName = 'Create Lifecycle History Record';
    failedPayload = lifecycleHistoryCreatePayload;
    failedRecordId = 'N/A';
    failedRecordType = 'LifecycleHistory';

      const lifecycleCreateResponse = await withSalesforceRetry(
        () => createSalesforceLifecycleHistoryRecord(lifecycleHistoryCreatePayload, decryptedSalesforceToken, salesforceAPILifecycleUrl, env),
        env,
        settingsMap,
        `Create Salesforce Lifecycle History Record for Slack Post Id ${slackPostId}`
      );

      // Overwrite lifecycle_id
      dynamicIds.lifecycle_id = lifecycleCreateResponse?.id ?? 'undefined';
    }
  }
  catch (err) {
    await env.DB_PRIMARY.prepare(
      `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
    ).bind(supportMessageTs).run();
    bypassSalesforce = true;
  
    const skippedOperations = [];
  
    if (failedOperationName === 'Update Slack Post Record') {
      skippedOperations.push({
        name: 'Update Lifecycle History Record',
        recordUrl: `${settingsMap['salesforce_base_url_lifecycle_history']}/${lifecycleHistoryId}/view`,
        fields: lifecycleHistoryPayload
      });
      skippedOperations.push({
        name: 'Create Lifecycle History Record',
        recordUrl: 'N/A',
        fields: lifecycleHistoryCreatePayload
      });
    } else if (failedOperationName === 'Update Lifecycle History Record') {
      skippedOperations.push({
        name: 'Create Lifecycle History Record',
        recordUrl: 'N/A',
        fields: lifecycleHistoryCreatePayload
      });
    }
  
    const alertMessage = buildSalesforceFailureAlertMessage({
      path: '/accept',
      firstLast: rawBody.firstLast,
      slackLink,
      slackPostId,
      settingsMap,
      failedOperationName,
      failedPayload,
      failedRecordId,
      failedRecordType,
      skippedOperations,
      errorMessage: err.message
    });
  
    await triggerSlackErrorAlert(env, settingsMap, alertMessage);
  }
  
  finally {
// Build and update relay message
    const relayUpdatePayload = buildAcceptAlertsPayload(
      userId, 
      relayChannel, 
      relayAlertsMessageTs, 
      rawBody.relayMessageText);

    const relayUpdateResponse = await postToSlack(settingsMap['slack_api_update_message_url'], decryptedSlackBotToken, relayUpdatePayload, env, settingsMap, rawBody.firstLast);
    const slackFailedRelayUpdate = relayUpdateResponse.status !== 200 ||
    (typeof relayUpdateResponse.responseBody === 'object' && relayUpdateResponse.responseBody.ok === false);
    
    if (slackFailedRelayUpdate) {
      await env.DB_PRIMARY.prepare(
        `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
        ).bind(supportMessageTs).run();
        bypassSalesforce = true;
      }

// Fetch original message text from dashboard support channel update
  let richTextBlocks = [];
  try {
    const encodedMessageText = dashboardRow?.SUPPORT_MESSAGE_TEXT ?? '';
    const decoded = decodeBase64Unicode(encodedMessageText);
    if (!decoded || decoded.trim() === '' || decoded.trim() === '[]') {
      throw new Error('Decoded SUPPORT_MESSAGE_TEXT is empty or invalid');
    }    
    richTextBlocks = JSON.parse(decoded); // Now parsed as array of blocks
  } catch (e) {
    richTextBlocks = [{
      type: 'rich_text',
      block_id: 'fallback_message',
      elements: [{
        type: 'rich_text_section',
        elements: [{
          type: 'text',
          text: "An unexpected error occurred and the original message text was lost",
          style: {
            italic: true
          }
        }]
      }]
    }];        
    const alertMsg = [
      "Worker: downstream",
      "Message: Failed to decode SUPPORT_MESSAGE_TEXT from Dashboard",
      `Error: ${e.message}`,
      `Triggering Path: ${env.PATH}`,
      "Action Needed: Investigate why the stored message text is corrupted or missing"
    ].join('\n');
    await logErrorToDB(env, alertMsg, "Error");
    await triggerSlackErrorAlert(env, settingsMap, alertMsg);
  }
    
    const rawBodyCopyTemporary = {
      ...rawBody,
      supportMessageTs,
      richTextBlocks,
      userId: rawBody.userId ?? 'U0000000000'
    };
    
    const supportChannelUpdatePayload = buildSupportChannelPayload(
      rawBodyCopyTemporary,
      path,
      settingsMap,
      dynamicIds,
      bypassSalesforce
    );
    
    const supportResponse = await postToSlack(settingsMap['slack_api_update_message_url'], decryptedSlackBotToken, supportChannelUpdatePayload, env, settingsMap, rawBody.firstLast);
    const slackFailedSupport = supportResponse.status !== 200 ||
    (typeof supportResponse.responseBody === 'object' && supportResponse.responseBody.ok === false);
    
    if (slackFailedSupport) {
      await env.DB_PRIMARY.prepare(
        `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
        ).bind(supportMessageTs).run();
        bypassSalesforce = true;
      }

      // Add a delay of 3 seconds before updating the dashboard. This is to keep the lock in place for a few extra seconds before buttons are clickable again
    await new Promise(resolve => setTimeout(resolve, 3000));
    
      // Update dashboard
    const helperName = rawBody.firstLast ?? 'Unknown';
    const status = 'In Progress';
    await updateDashboardRow(env, settingsMap, supportMessageTs, lockToken, helperName, status, null);
  }
}
// ACCEPT PATH LOGIC ENDS HERE //                

// START PATH LOGIC STARTS HERE //
if (path === '/start') {
  let bypassSalesforce = false;
  const bypassSalesforceSetting = settingsMap['bypass_salesforce_individual_post'] === 'TRUE';
  let body;

if (bypassSalesforceSetting) {
  bypassSalesforce = true;
  await env.DB_PRIMARY.prepare(
    `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
  ).bind(supportMessageTs).run();
} else if (dashboardRow?.BYPASS_SALESFORCE === 'TRUE') {
  bypassSalesforce = true;
}

  //Define variables and build payloads for Salesforce updates
    const startedBy = rawBody.firstLast ?? 'Unknown';
    const startedDateTime = formatUnixTimestampToIsoWithoutMilliseconds(Number(rawBody.actionTimestamp) * 1000);
    const postedDateTime = formatUnixTimestampToIsoWithoutMilliseconds(Number(supportMessageTs.split('.')[0]) * 1000);
    const slackLink = `${settingsMap['slack_message_base_url']}/${settingsMap['slack_channel_id_support']}/p${supportMessageTs.replace('.', '')}`;
    const slackPostId = dynamicIds.slack_post_id;
    const slackPostRecordPayload = {
      Started_By__c: startedBy,
      Started_Date_Time__c: startedDateTime,
      Status__c: 'In Progress',
      Posted_Date_Time__c: postedDateTime,
      Slack_Link__c: slackLink,
      Slack_Message_Timestamp__c: supportMessageTs
    };
    const lifecycleHistoryId = dynamicIds.lifecycle_id;
    const lifecycleHistoryUrl = `${salesforceAPILifecycleUrl}/${lifecycleHistoryId}`;
    const lifecycleHistoryPayload = {
      End_Time__c: startedDateTime
    };
    const slaSeconds = calculateSlaSeconds(supportMessageTs, rawBody.actionTimestamp);
      const lifecycleHistoryCreatePayload = {
        Case__c: dynamicIds.case_id,
        Slack_Post__c: dynamicIds.slack_post_id,
        Name: `${rawBody.firstLast ?? 'Unknown'} - Slack Started`,
        Owner__c: rawBody.sfUserId,
        Status__c: 'In Progress',
        Start_Time__c: startedDateTime,
        SLA_Seconds__c: slaSeconds
      };

      let failedOperationName = '';
      let failedPayload = {};
      let failedRecordId = '';
      let failedRecordType = '';

  try {
    if (!bypassSalesforce) {

      // Salesforce API Call to update Slack Post Record
      failedOperationName = 'Update Slack Post Record';
      failedPayload = slackPostRecordPayload;
      failedRecordId = slackPostId;
      failedRecordType = 'SlackPost';

      const slackPostRecordUrl = `${salesforceApiSlackPostUrl}/${slackPostId}`;
      await withSalesforceRetry(
        () => updateSalesforceSlackPostRecord(slackPostRecordPayload, decryptedSalesforceToken, slackPostRecordUrl, env),
        env,
        settingsMap,
        `Update Salesforce Slack Post Record with Id ${slackPostId}`
      );

      // Salesforce API Call to update Lifecycle History Record 
      failedOperationName = 'Update Lifecycle History Record';
      failedPayload = lifecycleHistoryPayload;
      failedRecordId = lifecycleHistoryId;
      failedRecordType = 'LifecycleHistory';
     
    await withSalesforceRetry(
      () => updateSalesforceLifecycleHistoryRecord(lifecycleHistoryPayload, decryptedSalesforceToken, lifecycleHistoryUrl, env),
        env,
        settingsMap,
        `Update Salesforce Lifecycle History Record with Id ${lifecycleHistoryId}`
        );

      // Salesforce API call to create a Lifecycle History record
      failedOperationName = 'Create Lifecycle History Record';
      failedPayload = lifecycleHistoryCreatePayload;
      failedRecordId = 'N/A';
      failedRecordType = 'LifecycleHistory';

      const lifecycleCreateResponse = await withSalesforceRetry(
        () => createSalesforceLifecycleHistoryRecord(lifecycleHistoryCreatePayload, decryptedSalesforceToken, salesforceAPILifecycleUrl, env),
        env,
        settingsMap,
        `Create Salesforce Lifecycle History Record for Slack Post Id ${slackPostId}`
      );
      
      // Overwrite dynamicIds.lifecycle_id with the newly created lifecycle history record id
      dynamicIds.lifecycle_id = lifecycleCreateResponse?.id ?? 'undefined';
  
    }
  } catch (err) {
    if (!bypassSalesforce) {

    const skippedOperations = [];
    if (failedOperationName === 'Update Slack Post Record') {
      skippedOperations.push({
        name: 'Update Lifecycle History Record',
        recordUrl: `${settingsMap['salesforce_base_url_lifecycle_history']}/${lifecycleHistoryId}/view`,
        fields: lifecycleHistoryPayload
        });
      skippedOperations.push({
        name: 'Create Lifecycle History Record',
        recordUrl: 'N/A',
        fields: lifecycleHistoryCreatePayload
      });
    } else if (failedOperationName === 'Update Lifecycle History Record') {
      skippedOperations.push({
        name: 'Create Lifecycle History Record',
        recordUrl: 'N/A',
        fields: lifecycleHistoryCreatePayload
      });
    }

    const alertMessage = buildSalesforceFailureAlertMessage({
      path: '/start',
      firstLast: rawBody.firstLast,
      slackLink,
      slackPostId,
      settingsMap,
      failedOperationName,
      failedPayload,
      failedRecordId,
      failedRecordType,
      skippedOperations,
      errorMessage: err.message
    });

    await triggerSlackErrorAlert(env, settingsMap, alertMessage);
    }
  
    await env.DB_PRIMARY.prepare(
      `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
    ).bind(supportMessageTs).run();
    bypassSalesforce = true;
  }  
  
    finally {

      // Rebuild the payload for Slack
      const richTextBlocks = Object.entries(rawBody)
      .filter(([key, value]) => key.endsWith('_block') && value?.type === 'rich_text')
      .map(([_, block]) => block);

      const supportChannelPayload = buildSupportChannelPayload(
        {
          ...rawBody,
          supportMessageTs,
          richTextBlocks,
          userId: rawBody.userId ?? 'U0000000000'
        },
        path,
        settingsMap,
        dynamicIds,
        bypassSalesforce
      );
      
      const supportResponse = await postToSlack(settingsMap['slack_api_update_message_url'], decryptedSlackBotToken, supportChannelPayload, env, settingsMap, rawBody.firstLast);
      const slackFailedSupport = supportResponse.status !== 200 ||
      (typeof supportResponse.responseBody === 'object' && supportResponse.responseBody.ok === false);
      
      if (slackFailedSupport) {
        await env.DB_PRIMARY.prepare(
          `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
          ).bind(supportMessageTs).run();
          bypassSalesforce = true;
        }

   // Add a delay of 3 seconds before updating the dashboard. This is to keep the lock in place for a few extra seconds before buttons are clickable again
    await new Promise(resolve => setTimeout(resolve, 3000));
 
    const helperName = rawBody.firstLast ?? 'Unknown';
    const status = 'In Progress';
    await updateDashboardRow(env, settingsMap, supportMessageTs, lockToken, helperName, status);
  }
}
// START PATH LOGIC ENDS HERE //    
    
// STOP PATH LOGIC STARTS HERE //    
if (path === '/stop') {
  let bypassSalesforce = false;
  const bypassSalesforceSetting = settingsMap['bypass_salesforce_individual_post'] === 'TRUE';
  let body;

  if (bypassSalesforceSetting) {
    bypassSalesforce = true;
    await env.DB_PRIMARY.prepare(
      `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
    ).bind(supportMessageTs).run();
  } else if (dashboardRow?.BYPASS_SALESFORCE === 'TRUE') {
    bypassSalesforce = true;
  }

  //Declare variables and payloads for Salesforce updates
    const stoppedBy = rawBody.firstLast ?? 'Unknown';
    const stoppedDateTime = formatUnixTimestampToIsoWithoutMilliseconds(Number(rawBody.actionTimestamp) * 1000);
    const slackPostId = dynamicIds.slack_post_id;
    const slackLink = `${settingsMap['slack_message_base_url']}/${settingsMap['slack_channel_id_support']}/p${supportMessageTs.replace('.', '')}`;
    const slackPostRecordUrl = `${salesforceApiSlackPostUrl}/${slackPostId}`;
    const slackPostRecordPayload = {
      Stopped_By__c: stoppedBy,
      Stopped_Date_Time__c: stoppedDateTime,
      Status__c: 'Closed'
    };
    const lifecycleHistoryId = dynamicIds.lifecycle_id;
    const lifecycleHistoryUrl = `${salesforceAPILifecycleUrl}/${lifecycleHistoryId}`;
    const lifecycleHistoryPayload = {
      End_Time__c: stoppedDateTime
    };
    const lifecycleHistoryCreatePayload = {
      Case__c: dynamicIds.case_id,
      Slack_Post__c: dynamicIds.slack_post_id,
      Name: `${stoppedBy} - Slack Stopped`,
      Owner__c: rawBody.sfUserId,
      Status__c: 'Closed',
      Start_Time__c: stoppedDateTime
    };

    let failedOperationName = '';
    let failedPayload = {};
    let failedRecordId = '';
    let failedRecordType = '';

  try {
    if (!bypassSalesforce) {
      

    // Update Salesforce Slack Post Record
      failedOperationName = 'Update Slack Post Record';
      failedPayload = slackPostRecordPayload;
      failedRecordId = slackPostId;
      failedRecordType = 'SlackPost';
      await withSalesforceRetry(
        () => updateSalesforceSlackPostRecord(slackPostRecordPayload, decryptedSalesforceToken, slackPostRecordUrl, env),
        env,
        settingsMap,
        `Update Salesforce Slack Post Record with Id ${slackPostId}`
      );

      // Update existing Lifecycle History record   
      failedOperationName = 'Update Lifecycle History Record';
      failedPayload = lifecycleHistoryPayload;
      failedRecordId = lifecycleHistoryId;
      failedRecordType = 'LifecycleHistory';  
      await withSalesforceRetry(
        () => updateSalesforceLifecycleHistoryRecord(lifecycleHistoryPayload, decryptedSalesforceToken, lifecycleHistoryUrl, env),
        env,
        settingsMap,
        `Update Salesforce Lifecycle History Record with Id ${lifecycleHistoryId}`
      );

      // Create new Lifecycle History record
      failedOperationName = 'Create Lifecycle History Record';
      failedPayload = lifecycleHistoryCreatePayload;
      failedRecordId = 'N/A';
      failedRecordType = 'LifecycleHistory';
      const lifecycleCreateResponse = await withSalesforceRetry(
        () => createSalesforceLifecycleHistoryRecord(lifecycleHistoryCreatePayload, decryptedSalesforceToken, salesforceAPILifecycleUrl, env),
        env,
        settingsMap,
        `Create Salesforce Lifecycle History Record for Slack Post Id ${slackPostId}`
      );

      // Overwrite lifecycle_id
      dynamicIds.lifecycle_id = lifecycleCreateResponse?.id ?? 'undefined';
    }
  } catch (err) {
    if (!bypassSalesforce) {

    const skippedOperations = [];
    if (failedOperationName === 'Update Slack Post Record') {
      skippedOperations.push({
        name: 'Update Lifecycle History Record',
        recordUrl: `${settingsMap['salesforce_base_url_lifecycle_history']}/${lifecycleHistoryId}/view`,
        fields: lifecycleHistoryPayload
        });
      skippedOperations.push({
        name: 'Create Lifecycle History Record',
        recordUrl: 'N/A',
        fields: lifecycleHistoryCreatePayload
      });
    } else if (failedOperationName === 'Update Lifecycle History Record') {
      skippedOperations.push({
        name: 'Create Lifecycle History Record',
        recordUrl: 'N/A',
        fields: lifecycleHistoryCreatePayload
      });
    }

    const alertMessage = buildSalesforceFailureAlertMessage({
      path: '/stop',
      firstLast: rawBody.firstLast,
      slackLink,
      slackPostId,
      settingsMap,
      failedOperationName,
      failedPayload,
      failedRecordId,
      failedRecordType,
      skippedOperations,
      errorMessage: err.message
    });

    await triggerSlackErrorAlert(env, settingsMap, alertMessage);
    }
  
    await env.DB_PRIMARY.prepare(
      `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
    ).bind(supportMessageTs).run();
    bypassSalesforce = true;
  }
  finally {
    // Build and update support channel message
    const richTextBlocks = Object.entries(rawBody)
  .filter(([key, value]) => key.endsWith('_block') && value?.type === 'rich_text')
  .map(([_, block]) => block);
  
  const supportChannelPayload = buildSupportChannelPayload(
    {
      ...rawBody,
      supportMessageTs,
      richTextBlocks,
      userId: rawBody.userId ?? 'U0000000000'
    },
    path,
    settingsMap,
    dynamicIds,
    bypassSalesforce
  );

    const supportResponse = await postToSlack(settingsMap['slack_api_update_message_url'], decryptedSlackBotToken, supportChannelPayload, env, settingsMap, rawBody.firstLast);
    const slackFailedSupport = supportResponse.status !== 200 ||
    (typeof supportResponse.responseBody === 'object' && supportResponse.responseBody.ok === false);
    
    if (slackFailedSupport) {
      await env.DB_PRIMARY.prepare(
        `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
        ).bind(supportMessageTs).run();
        bypassSalesforce = true;
      }

    // Update dashboard
    const helperName = rawBody.firstLast ?? 'Unknown';
    const status = 'Closed';

    await updateDashboardRow(env, settingsMap, supportMessageTs, lockToken, helperName, status, null);
  }
}
// STOP PATH LOGIC ENDS HERE //    
    
// ESCALATE PATH LOGIC STARTS HERE //    
if (path === '/escalate') {
  const bypassSalesforceSetting = settingsMap['bypass_salesforce_individual_post'] === 'TRUE';
  let bypassSalesforce = false;
  let body;

  if (bypassSalesforceSetting) {
    bypassSalesforce = true;
    await env.DB_PRIMARY.prepare(
      `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
    ).bind(supportMessageTs).run();
  } else if (dashboardRow?.BYPASS_SALESFORCE === 'TRUE') {
    bypassSalesforce = true;
  }

  //Declare variables and payloads for Salesforce updates
    const slackLink = `${settingsMap['slack_message_base_url']}/${settingsMap['slack_channel_id_support']}/p${supportMessageTs.replace('.', '')}`;  
    const caseId = dynamicIds.case_id;
    const caseUpdateUrl = `${settingsMap['salesforce_api_case_update_endpoint_url']}/${dynamicIds.case_id}`;
    const chasmPayload = {
      Chasm__c: rawBody.firstLast ?? 'Unknown'
    };
    const stoppedBy = rawBody.firstLast ?? 'Unknown';
    const stoppedDateTime = formatUnixTimestampToIsoWithoutMilliseconds(Number(rawBody.actionTimestamp) * 1000);
    const slackPostId = dynamicIds.slack_post_id;
    const slackPostRecordUrl = `${salesforceApiSlackPostUrl}/${slackPostId}`;
    const slackPostRecordPayload = {
      Stopped_By__c: stoppedBy,
      Stopped_Date_Time__c: stoppedDateTime,
      Status__c: 'Closed'
    };
    const lifecycleHistoryId = dynamicIds.lifecycle_id;
    const lifecycleHistoryUrl = `${salesforceAPILifecycleUrl}/${lifecycleHistoryId}`;
    const lifecycleHistoryPayload = {
      End_Time__c: stoppedDateTime
    };
    const lifecycleHistoryCreatePayload = {
      Case__c: dynamicIds.case_id,
      Slack_Post__c: dynamicIds.slack_post_id,
      Name: `${stoppedBy} - Slack Escalated`,
      Owner__c: rawBody.sfUserId,
      Status__c: 'Closed',
      Start_Time__c: stoppedDateTime
    };

    let failedOperationName = '';
    let failedPayload = {};
    let failedRecordId = '';
    let failedRecordType = '';

  try {
    if (!bypassSalesforce) {
  
  //Update Case Record to set Chasm field
      failedOperationName = 'Update Case Chasm__c Field';
      failedPayload = chasmPayload;
      failedRecordId = caseId;
      failedRecordType = 'Case';
      await withSalesforceRetry(
        () => updateChasmField(chasmPayload, decryptedSalesforceToken, caseUpdateUrl, env),
        env,
        settingsMap,
        `Update Salesforce Case Chasm__c Field on Case Record Id ${caseId}`
      );
      
  //Update Slack Post Record
      failedOperationName = 'Update Slack Post Record';
      failedPayload = slackPostRecordPayload;
      failedRecordId = slackPostId;
      failedRecordType = 'SlackPost';
      await withSalesforceRetry(
        () => updateSalesforceSlackPostRecord(slackPostRecordPayload, decryptedSalesforceToken, slackPostRecordUrl, env),
        env,
        settingsMap,
        `Update Salesforce Slack Post Record with Id ${slackPostId}`
      );

  //Update Lifecycle History Record
      failedOperationName = 'Update Lifecycle History Record';
      failedPayload = lifecycleHistoryPayload;
      failedRecordId = lifecycleHistoryId;
      failedRecordType = 'LifecycleHistory'; 
      await withSalesforceRetry(
        () => updateSalesforceLifecycleHistoryRecord(lifecycleHistoryPayload, decryptedSalesforceToken, lifecycleHistoryUrl, env),
        env,
        settingsMap,
        `Update Salesforce Lifecycle History Record with Id ${lifecycleHistoryId}`
      );

  //Create Lifecycle History Record
      failedOperationName = 'Create Lifecycle History Record';
      failedPayload = lifecycleHistoryCreatePayload;
      failedRecordId = 'N/A';
      failedRecordType = 'LifecycleHistory';
      const lifecycleCreateResponse = await withSalesforceRetry(
        () => createSalesforceLifecycleHistoryRecord(lifecycleHistoryCreatePayload, decryptedSalesforceToken, salesforceAPILifecycleUrl, env),
        env,
        settingsMap,
        `Create Salesforce Lifecycle History Record for Slack Post Id ${slackPostId}`
      );

      dynamicIds.lifecycle_id = lifecycleCreateResponse?.id ?? 'undefined';
    }
  } catch (err) {
    if (!bypassSalesforce) {

      const skippedOperations = [];
      if (failedOperationName === 'Update Case Chasm__c Field') {
        skippedOperations.push({
          name: 'Update Slack Post Record',
          recordUrl: `${settingsMap['salesforce_base_url_slack_post']}/${slackPostId}/view`,
          fields: slackPostRecordPayload
        });
        skippedOperations.push({
          name: 'Update Lifecycle History Record',
          recordUrl: `${settingsMap['salesforce_base_url_lifecycle_history']}/${lifecycleHistoryId}/view`,
          fields: lifecycleHistoryPayload
        });
        skippedOperations.push({
          name: 'Create Lifecycle History Record',
          recordUrl: 'N/A',
          fields: lifecycleHistoryCreatePayload
        });
      } else if (failedOperationName === 'Update Slack Post Record') {
        skippedOperations.push({
          name: 'Update Lifecycle History Record',
          recordUrl: `${settingsMap['salesforce_base_url_lifecycle_history']}/${lifecycleHistoryId}/view`,
          fields: lifecycleHistoryPayload
        });
        skippedOperations.push({
          name: 'Create Lifecycle History Record',
          recordUrl: 'N/A',
          fields: lifecycleHistoryCreatePayload
        });
      } else if (failedOperationName === 'Update Lifecycle History Record') {
        skippedOperations.push({
          name: 'Create Lifecycle History Record',
          recordUrl: 'N/A',
          fields: lifecycleHistoryCreatePayload
        });
      }      

    const alertMessage = buildSalesforceFailureAlertMessage({
      path: '/escalate',
      firstLast: rawBody.firstLast,
      slackLink,
      slackPostId,
      settingsMap,
      failedOperationName,
      failedPayload,
      failedRecordId,
      failedRecordType,
      skippedOperations,
      errorMessage: err.message
    });

    await triggerSlackErrorAlert(env, settingsMap, alertMessage);
    }
  
    await env.DB_PRIMARY.prepare(
      `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
    ).bind(supportMessageTs).run();
    bypassSalesforce = true;
  }
  
  finally {
    const richTextBlocks = Object.entries(rawBody)
  .filter(([key, value]) => key.endsWith('_block') && value?.type === 'rich_text')
  .map(([_, block]) => block);

  const supportChannelPayload = buildSupportChannelPayload(
    {
      ...rawBody,
      supportMessageTs,
      richTextBlocks,
      userId: rawBody.userId ?? 'U0000000000'
    },
    path,
    settingsMap,
    dynamicIds,
    bypassSalesforce
  );

    const supportResponse = await postToSlack(settingsMap['slack_api_update_message_url'], decryptedSlackBotToken, supportChannelPayload, env, settingsMap, rawBody.firstLast);
    const slackFailedSupport = supportResponse.status !== 200 ||
    (typeof supportResponse.responseBody === 'object' && supportResponse.responseBody.ok === false);
    
    if (slackFailedSupport) {
      await env.DB_PRIMARY.prepare(
        `UPDATE Dashboard SET BYPASS_SALESFORCE = 'TRUE' WHERE MESSAGE_TIMESTAMP = ?`
        ).bind(supportMessageTs).run();
        bypassSalesforce = true;
      }


    const helperName = rawBody.firstLast ?? 'Unknown';
    const status = 'Closed';
    await updateDashboardRow(env, settingsMap, supportMessageTs, lockToken, helperName, status, null);
  }
}
// ESCALATE PATH LOGIC ENDS HERE //     

    if (settingsMap['error_debug_logs'] === 'TRUE') {
      await logErrorToDB(env, 'Debug: Successfully completed downstream processing', "Debug");
    }
    
    return new Response(`Received a valid ${request.method} request with JSON body`, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });

    } catch (err) {
      console.error('Authorization error:', err);
      await logErrorToDB(env, `Authorization error: ${err.message || err.toString()}`, "Error");
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
      });
    }    
  },
};
