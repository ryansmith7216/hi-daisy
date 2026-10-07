//Helper function to decrypt tokens and keys
async function decrypt(encryptedWithVersion, env, secretPrefix = 'SLACK_APIS_ENCRYPTION_SECRET') {
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
}

//Helper function that logs to the DB
async function logErrorToDB(env, errorMessage, errorType = 'Error') {
  try {
    const timestamp = new Date().toISOString();
    await env.DB_PRIMARY.prepare(
      `INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
       VALUES (?, ?, ?, ?)`
    ).bind(timestamp, 'dispatcher', errorMessage, errorType).run();
  } catch (dbError) {
    console.error('Failed to log error to DB:', dbError);
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

//Helper function used to send an API call to Slack to open a modal
async function openSlackModal(env, triggerId, titleText, modalText, slackToken, slackModalUrl) {
  try {
     await fetch(slackModalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${slackToken}`
      },
      body: JSON.stringify({
        trigger_id: triggerId,
        view: {
          type: 'modal',
          callback_id: "info_modal",
          title: { type: 'plain_text', text: titleText },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: modalText
              }
            }
          ]
        }
      })
    });
  } catch (err) {
    await logErrorToDB(env, `Failed to open Slack modal: ${err.message}`, "Error");
  }
}

//Helper function that decodes html encoded characters that slack added
function decodeSlackEntities(text) {
  if (!text) return '';

  // Decode only known Slack-encoded entities once
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;(?![a-zA-Z#0-9]+;)/g, '&'); // decode &amp; only if not followed by another entity
}


//-------------------- Main function that is triggered when the worker receives a request --------------------//
export default {
  async fetch(request, env, ctx) {

    const url = new URL(request.url);
    const path = url.pathname;
    const normalizedPath = path.toLowerCase();

//Allow list for paths    
    const allowedPaths = new Set([
      '/api/v1/dispatcher',
      '/health'
    ]);
    if (!allowedPaths.has(normalizedPath)) {
      return new Response('Not Found', { status: 404 });
    }

//Return an error if the url ends with .workers.dev    
    const host = request.headers.get('host');
    if (host && host.endsWith('.workers.dev')) {
      return new Response('Forbidden', { status: 403 });
    }

//Health Check Logic that runs only when the path is /health and the method is GET
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

//When path is not /health ensure the method is a POST, and reject if it's not  
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

//Validate the Content-Type is application/x-www-form-urlencoded, and reject if it's not    
    const contentType = request.headers.get('Content-Type');
    if (!contentType || contentType !== 'application/x-www-form-urlencoded') {
      return new Response('Bad Request: Content-Type must be application/x-www-form-urlencoded', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

//Validate the headers include x-slack-signature and x-slack-request-timestamp, reject if they are missing    
    const slackSignature = request.headers.get('x-slack-signature');
    const slackTimestamp = request.headers.get('x-slack-request-timestamp');
    if (!slackSignature || !slackTimestamp) {
      return new Response('Bad Request: Missing Slack signature or timestamp headers', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    //Get settings from the database
  try {
    const settingsToFetch = [
      'external_api_key_slack',
      'slack_bot_token',
      'slack_button_expiration_hours',
      'error_debug_logs',
      'debug_mode',
      'slack_api_open_modal_url',
      'slack_dashboard_lock_seconds',
      'internal_api_key',
      'internal_downstream_url',
      'bypass_salesforce_individual_post',
      'slack_api_get_replies_url',
      'slack_error_alerts_workflow_url',
      'bypass_slack_error_alerts',
    ];

    const placeholders = settingsToFetch.map(() => '?').join(', ');
    const settingsRows = await env.DB_PRIMARY.prepare(
      `SELECT DB_SETTING_NAME, SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME IN (${placeholders})`
    ).bind(...settingsToFetch).all();

    const settingsMap = {};
    for (const row of settingsRows.results) {
      settingsMap[row.DB_SETTING_NAME] = row.SETTING_VALUE;
    }

    for (const name of settingsToFetch) {
      if (!settingsMap[name]) {
        await logErrorToDB(env, `Missing or empty setting: ${name}`, "Error");
        const alertMsg = [
          "Worker: dispatcher",
          `Message: Missing or empty setting: "${name}"`,
          `Triggering Path: ${normalizedPath}`,
          "Action Needed: Ensure this setting exists on the database and is not empty to restore functionality"
        ].join('\n');
        await triggerSlackErrorAlert(env, settingsMap, alertMsg);
        return new Response(`Server configuration error: missing setting ${name}`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    }

    const slackGetRepliesUrl = settingsMap['slack_api_get_replies_url'];
    const slackModalUrl = settingsMap['slack_api_open_modal_url'];
  
      let decryptedExternalApiKeySlack;
      try {
        decryptedExternalApiKeySlack = await decrypt(settingsMap['external_api_key_slack'], env);
      } catch (e) {
        const alertMsg = [
          "Worker: dispatcher",
          "Message: Decryption failed for external_api_key_slack",
          `Error: ${e.message}`,
          "Action Needed: Update slack_api_secret_version to a valid version and readd external_api_key_slack to restore functionality"
        ].join('\n');
        await logErrorToDB(env, alertMsg);
        await triggerSlackErrorAlert(env, settingsMap, alertMsg);
        throw e;
      }
      
      let decryptedSlackBotToken;
      try {
        decryptedSlackBotToken = await decrypt(settingsMap['slack_bot_token'], env);
      } catch (e) {
        const alertMsg = [
          "Worker: dispatcher",
          "Message: Decryption failed for slack_bot_token",
          `Error: ${e.message}`,
          "Action Needed: Update slack_api_secret_version to a valid version and readd slack_bot_token to restore functionality"
        ].join('\n');
        await logErrorToDB(env, alertMsg);
        await triggerSlackErrorAlert(env, settingsMap, alertMsg);
        throw e;
      }
      
      let decryptedInternalApiKey;
      try {
        decryptedInternalApiKey = await decrypt(settingsMap['internal_api_key'], env, 'INTERNAL_APIS_ENCRYPTION_SECRET');
      } catch (e) {
        const alertMsg = [
          "Worker: dispatcher",
          "Message: Decryption failed for internal_api_key",
          `Error: ${e.message}`,
          "Action Needed: Update internal_api_secret_version to a valid version and readd internal_api_key to restore functionality"
        ].join('\n');
        await logErrorToDB(env, alertMsg);
        await triggerSlackErrorAlert(env, settingsMap, alertMsg);
        throw e;
      }           

//Construct a string to use for Slack signature verification      
      const rawBody = await request.text();


      
      const baseString = `v0:${slackTimestamp}:${rawBody}`;

//Generate a HMAC signature using the Slack app's Signing Secret. The external_api_key_slack is the signing secret
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(decryptedExternalApiKeySlack),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(baseString));
      const signatureArray = Array.from(new Uint8Array(signatureBuffer));
      const computedSignature = 'v0=' + signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');

//Compare the generated signature with the signature received in the header to validate the request came from Slack, and reject if the signatures do not match 
      function safeCompare(a, b) {
        if (a.length !== b.length) return false;
        let result = 0;
        for (let i = 0; i < a.length; i++) {
          result |= a.charCodeAt(i) ^ b.charCodeAt(i);
        }
        return result === 0;
      }

      if (!safeCompare(computedSignature, slackSignature)) {
        await logErrorToDB(env, `Invalid Slack signature: computed=${computedSignature}, received=${slackSignature}`, "Error");
        return new Response('Unauthorized: Invalid Slack signature', {
          status: 401,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

//Parse the raw request body and convert it into an object      
      const params = new URLSearchParams(rawBody);
      const body = Object.fromEntries(params.entries());

      if (settingsMap['error_debug_logs'] === 'TRUE') {
      await logErrorToDB(env, `Debug: Slack payload JSON (escaped): ${body.payload}`, "Debug");
      }

//Declare variables from the payload with empty strings for use later      
      let payload;
      let relayAlertsMessageTs = '';
      let actionName = '';
      let actionId = '';
      let caseId = '', slackPostId = '', lifecycleId = '';

      try {
        payload = JSON.parse(body.payload);
        

//Shortcut handler logic to open modal with pre-filled message starts here//
if (payload.type === 'message_action') {
  const userId = payload.user?.id;
  const userQuery = await env.DB_PRIMARY.prepare(
    `SELECT SF_USER_ID, FIRST_LAST, USER_ROLE FROM User WHERE SLACK_USER_ID = ? LIMIT 1`
  ).bind(userId).first();

  if (!userQuery || userQuery.USER_ROLE === 'Inactive' || userQuery.USER_ROLE === 'Support') {
    await logErrorToDB(env, `Unauthorized Slack user or insufficient role: ${userId}, role=${userQuery?.USER_ROLE}, action=Salesforce comment`, "Error");
    await openSlackModal(
      env,
      payload.trigger_id,
      "Permission Denied",
      "You do not have permission to perform this action.",
      decryptedSlackBotToken,
      slackModalUrl
    );
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }); 
  }

//If the shortcut is used on the parent message (not a reply), show an error modal
if (!payload.message?.thread_ts || payload.message.thread_ts === payload.message.ts) {
  await openSlackModal(
    env,
    payload.trigger_id,
    "Comment Not Allowed",
    "This action can only be used on threaded messages. Please use it on a reply.",
    decryptedSlackBotToken,
    slackModalUrl
  );
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

//If Salesforce Bypass is enabled, show an error modal 
    const bypassSalesforce = settingsMap['bypass_salesforce_individual_post'];
    if (bypassSalesforce?.trim().toUpperCase() === 'TRUE') {
      await openSlackModal(
        env,
        payload.trigger_id,
        "Salesforce Disabled",
        "Case comments are currently disabled. Please add any comments directly in Salesforce.",
        decryptedSlackBotToken,
        slackModalUrl
      );
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }); 
    }  

//Declare the reply text and detect whether it included a user or channel mention    
  const originalReplyText = payload.message?.text ?? '';
  const decodedReplyText = decodeSlackEntities(originalReplyText);
  const mentionRegex = /<@[A-Z0-9]+>|<#(?:C|G|D|W)[A-Z0-9]+\|?>/g;
  const containsMention = mentionRegex.test(decodedReplyText);

  let caseIdFromParent = '';
  if (payload.message?.thread_ts && payload.message.thread_ts !== payload.message.ts) {

// First try to get CASE_RECORD_ID from the Dashboard
    const dashboardRow = await env.DB_PRIMARY.prepare(
      `SELECT CASE_RECORD_ID FROM Dashboard WHERE MESSAGE_TIMESTAMP = ? LIMIT 1`
    ).bind(payload.message.thread_ts).first();
  
    if (dashboardRow?.CASE_RECORD_ID) {
      caseIdFromParent = dashboardRow.CASE_RECORD_ID;
    }
  
//If getting CASE_RECORD_ID fails, fall back to Slack API to get the case record Id from the message
    if (!caseIdFromParent) {
      try {
        const parentResponse = await fetch(slackGetRepliesUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Bearer ${decryptedSlackBotToken}`
          },
          body: new URLSearchParams({
            channel: payload.channel.id,
            ts: payload.message.thread_ts,
            limit: '1'
          })
        });
        const parentData = await parentResponse.json();
        const parentMessage = parentData.messages?.[0];
        const findButtonWithPrefix = (blocks, prefix) => {
          return blocks?.find(block =>
            block.type === 'actions' &&
            block.elements?.some(el =>
              el.type === 'button' && el.action_id?.startsWith(prefix)
            )
          )?.elements?.find(el =>
            el.type === 'button' && el.action_id?.startsWith(prefix)
          );
        };
        const relayButton = findButtonWithPrefix(parentMessage?.blocks, 'action_name:Relay');
        const startButton = findButtonWithPrefix(parentMessage?.blocks, 'action_name:Start');
        const buttonToUse = relayButton ?? startButton;
        if (buttonToUse?.value) {
          const match = buttonToUse.value.match(/case_id:([^,]+)/);
          if (match) {
            caseIdFromParent = match[1];
          }
        }

//Log an error if unable to get the case record Id from the dashboard or the API call        
      } catch (err) {
        await logErrorToDB(env, `Failed to fetch parent message or extract case_id: ${err.message}`, "Error");
      }
    }
  }

//Send an API call to Slack to open a modal with an error if the above logic failed  
  if (!caseIdFromParent) {
    await openSlackModal(
      env,
      payload.trigger_id,
      "Comment Not Allowed",
      "This action can only be used on a reply to a message posted by the Slack integration.",
      decryptedSlackBotToken,
      slackModalUrl
    );
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

//Construct a string for metaData to include in the Slack modal and determine if debug_mode is enabled
  const privateMetadata = `case_id:${caseIdFromParent}, FIRST_LAST:${userQuery?.FIRST_LAST ?? ''}`;
  const debugEnabled = settingsMap['debug_mode'] === 'TRUE';

//Construct the payload for an API call to Slack to open a modal  
  const modalView = {
    type: 'modal',
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: 'Add Case Comment' },
    close: { type: 'plain_text', text: 'Cancel' },
    submit: { type: 'plain_text', text: 'Submit' },
    callback_id: 'case_comment_modal',
    blocks: [
//Conditional block added only when debug mode is enabled      
      ...(debugEnabled ? [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Debug Info:*\n\`\`\`\n${privateMetadata.split(',').map(s => s.trim()).join('\n')}\n\`\`\``
        }
      }] : []),
//Conditional warning that displays if the originalReplyText (threaded reply text) contains a user or channel mention      
      ...(containsMention ? [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':warning: *Heads up!* This message contains a user or channel mention. Please note that these will appear as the literal code &lt;@UABC123&gt; or &lt;#CABC123|&gt; in your case comment.'
        }
      }] : []),
      {
        type: 'input',
        block_id: 'case_comment',
        element: {
          type: 'plain_text_input',
          action_id: 'comment_input',
          multiline: true,
          initial_value: originalReplyText
        },
        label: {
          type: 'plain_text',
          text: 'Comment'
        }
      }
    ]      
  };

//Send an API call to Slack to open a modal for the case comment  
  try {
    await fetch(slackModalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${decryptedSlackBotToken}`
      },
      body: JSON.stringify({
        trigger_id: payload.trigger_id,
        view: modalView
      })
    });
  } catch (err) {
    await logErrorToDB(env, `Failed to open shortcut modal: ${err.message}`, "Error");
  }

  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });  
}
//Shortcut handler logic to open modal with pre-filled message ends here//

//Modal submission handler logic starts here//
if (payload.type === 'view_submission') {
  const privateMetadata = payload.view?.private_metadata ?? '';
  const comment = payload.view?.state?.values?.case_comment?.comment_input?.value ?? '';

//Extract case_id and FIRST_LAST from private_metadata
  const metadataParts = Object.fromEntries(
    privateMetadata.split(',').map(pair => {
      const [key, value] = pair.split(':').map(s => s.trim());
      return [key, value];
    })
  );

  const caseId = metadataParts.case_id ?? '';
  const firstLast = metadataParts.FIRST_LAST ?? '';

//construct payload to send to the downstream worker for processing  
  const downstreamPayload = {
    caseId,
    firstLast,
    commentText: comment,
  };

//Log debug info to Error table if debug logs are enabled  
  if (settingsMap['error_debug_logs'] === 'TRUE') {
    await logErrorToDB(env, `Debug: Modal submission payload: ${JSON.stringify(downstreamPayload)}`, "Debug");
  }

//Construct url and path for the downstream worker - commented out since this uses a service binding instead  
// const baseDownstreamUrl = settingsMap['internal_downstream_url'];
// const downstreamUrl = `${baseDownstreamUrl.replace(/\/$/, '')}/comment`;

//Send a request to the downstream worker for processing the case comment logic  
  try {
    const response = await env.DOWNSTREAM_WORKER.fetch("https://internal/comment", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${decryptedInternalApiKey}`,
      },
      body: JSON.stringify(downstreamPayload),
    });    

//If an error occurs during case comment creation return a retryable or non-retryable error to Slack depending on the failure reason    
    if (!response.ok) {
      const errorText = await response.text();
      await logErrorToDB(env, `Comment API call failed: ${response.status} ${errorText}`, "Error");
    
      let errorMessage;
      if (response.status === 400) {
        errorMessage = "Salesforce rejected the comment. Do not retry........ Please create your comment in Salesforce directly";
      } else if (response.status === 500) {
        errorMessage = "Failed to create comment. Please try again or create your comment in Salesforce directly.";
      } else {
        errorMessage = "An unexpected error occurred while posting your comment.";
      }
    
      return new Response(JSON.stringify({
        response_action: "errors",
        errors: {
          case_comment: errorMessage
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }        
  } catch (err) {
    await logErrorToDB(env, `Exception during comment API call: ${err.message}`, "Error");
  }  

//Respond to Slack to acknowledge the modal submission
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
// Modal submission handler logic ends here//

        
        actionId = payload.actions?.[0]?.action_id ?? '';
        if (actionId.startsWith('action_name:')) {
          actionName = actionId.split('action_name:')[1];
        }

        const actionValue = payload.actions?.[0]?.value ?? '';
        actionValue.split(',').forEach(pair => {
          const [key, value] = pair.split(':').map(s => s.trim());
          if (key === 'case_id') caseId = value;
          if (key === 'slack_post_id') slackPostId = value;
          if (key === 'lifecycle_id') lifecycleId = value;
          if (key === 'relay_message_ts') relayAlertsMessageTs = value;
        });


      
        if (actionName === 'Accept') {
          relayAlertsMessageTs = payload.container?.message_ts ?? '';
        }
      } catch (e) {
        await logErrorToDB(env, `Failed to parse Slack payload: ${e.message}`, "Error");
        return new Response('Bad Request: Invalid Slack payload', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        });
      }      

// Step 2: Check Slack button expiration
const expirationHours = parseFloat(settingsMap['slack_button_expiration_hours']);
if (isNaN(expirationHours)) {
  throw new Error('Invalid expiration setting value.');
}

let supportMessageTs;
if (actionName === 'Accept') {
  const actionValue = payload.actions?.[0]?.value ?? '';
  const match = actionValue.match(/message_ts:([\d.]+)/);
  if (match) {
    supportMessageTs = parseFloat(match[1]);
  } else {
    return new Response('Bad Request: message_ts not found in Accept button value', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
} else {
  supportMessageTs = parseFloat(payload.container?.message_ts);
}

if (isNaN(supportMessageTs)) {
  return new Response('Bad Request: Invalid message_ts', {
    status: 400,
    headers: { 'Content-Type': 'text/plain' },
  });
}

const messageDate = new Date(supportMessageTs * 1000); // Slack timestamps are in seconds
const now = new Date();

// debugging to log the message_ts from the Slack payload in the Error DB table
if (settingsMap['error_debug_logs'] === 'TRUE') {
  await logErrorToDB(env, `Debug: message_ts=${supportMessageTs}, now=${now.toISOString()}, messageDate=${messageDate.toISOString()}`, "Debug");
}

//Check if buttons are expired and display a modal if true
const hoursElapsed = (now.getTime() - messageDate.getTime()) / (1000 * 60 * 60);
if (hoursElapsed >= expirationHours) {
  await logErrorToDB(env, `Slack button expired. message_ts=${supportMessageTs}, hoursElapsed=${hoursElapsed.toFixed(2)}, expirationHours=${expirationHours}`, "Error");

  await openSlackModal(
    env,
    payload.trigger_id,
    "Message Expired",
    `This message is too old. The buttons have been disabled.`,
    decryptedSlackBotToken,
    slackModalUrl
  );  

  return new Response('Slack button expired, but acknowledged.', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });  
}

//Validate User has permission to click buttons and display a modal if false
const userId = payload.user?.id;
const userQuery = await env.DB_PRIMARY.prepare(
  `SELECT SF_USER_ID, FIRST_LAST, USER_ROLE FROM User WHERE SLACK_USER_ID = ? LIMIT 1`
).bind(userId).first();

if (!userQuery || userQuery.USER_ROLE === 'Inactive' || userQuery.USER_ROLE === 'Support') {
  await logErrorToDB(env, `Unauthorized Slack user or insufficient role: ${userId}, role=${userQuery?.USER_ROLE}, action=Button Click`, "Error");
  await openSlackModal(
    env,
    payload.trigger_id,
    "Permission Denied",
    "You do not have permission to perform this action.",
    decryptedSlackBotToken,
    slackModalUrl
  );
  return new Response('User not authorized, but acknowledged.', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

//Debug log the actionName when debug logs are enabled
if (settingsMap['error_debug_logs'] === 'TRUE') {
  await logErrorToDB(env, `Debug: Action triggered: ${actionName}`, "Debug");
}

// Always check if the dashboard row exists and display a modal with various messages depending on path if row does not exist
const dashboardRow = await env.DB_PRIMARY.prepare(
  `SELECT 1 FROM Dashboard WHERE MESSAGE_TIMESTAMP = ? LIMIT 1`
).bind(supportMessageTs.toString()).first();

if (!dashboardRow) {
  const modalTitle = actionName === 'Start' ? "Still Processing" : "Oops I'm Broken";
  const modalMessage = actionName === 'Start'
    ? "We're still setting things up. Please wait a moment and try again."
    : `The message with ${supportMessageTs} wasn't found on the dashboard. Buttons will not work on this post.`;

  await logErrorToDB(env, `Dashboard row not found for action=${actionName}, message_ts=${supportMessageTs}`, "Error");
  await openSlackModal(
    env,
    payload.trigger_id,
    modalTitle,
    modalMessage,
    decryptedSlackBotToken,
    slackModalUrl
  );

  return new Response('Dashboard row not found, user notified.', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

// Acquire lock using configured duration
const lockDurationSeconds = parseInt(settingsMap['slack_dashboard_lock_seconds'], 10);
if (isNaN(lockDurationSeconds)) {
  throw new Error('Invalid lock duration setting value.');
}
const currentUnixTime = Date.now(); // now in milliseconds
const lockUntil = currentUnixTime + lockDurationSeconds * 1000;

const lockToken = lockUntil.toString();

const result = await env.DB_PRIMARY.prepare(
  `UPDATE Dashboard
   SET LOCKED_UNIX_TIMESTAMP = ?
   WHERE MESSAGE_TIMESTAMP = ?
     AND (LOCKED_UNIX_TIMESTAMP IS NULL OR LOCKED_UNIX_TIMESTAMP < ?)`
).bind(lockUntil, supportMessageTs.toString(), currentUnixTime).run();

if (result.meta.changes === 0) {
  await logErrorToDB(env, `A button click occurred while lock already active for message_ts=${supportMessageTs}`, "Error");
  await openSlackModal(
    env,
    payload.trigger_id,
    "Already Clicked",
    `A button was clicked recently (within ${lockDurationSeconds} seconds). Please wait and try again if needed.`,
    decryptedSlackBotToken,
    slackModalUrl
  );
  return new Response('Lock already active, user notified.', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

// Continue with normal processing
try {
// Commented out since this uses a service binding instead 
//const baseDownstreamUrl = settingsMap['internal_downstream_url'];
//const downstreamUrl = `${baseDownstreamUrl.replace(/\/$/, '')}/${actionName.toLowerCase()}`;
  
// Extract the first section block's text.text value when the action name is Accept
let relayMessageText = '';

if (actionName === 'Accept') {
  const firstSectionBlock = payload.message?.blocks?.find(
    block => block.type === 'section' && block.text?.text
  );
  const rawRelayText = firstSectionBlock?.text.text ?? '';
  relayMessageText = decodeSlackEntities(rawRelayText);
}

//Extract rich text blocks if action name is not Accept
const richTextBlockValues = {};
const richTextBlocks = payload.message?.blocks?.filter(
  block => block.type === 'rich_text'
);

if (richTextBlocks?.length) {
  for (const block of richTextBlocks) {
    const blockId = block.block_id;
    const sections = block.elements?.filter(el => el.type === 'rich_text_section') ?? [];

    let combinedText = '';

    for (const section of sections) {
      for (const element of section.elements ?? []) {
        if (element.type === 'text' && element.text) {
          combinedText += element.text;
        }
        if (element.type === 'link' && element.url) {
          combinedText += ` ${element.url}`;
        }
      }
    }
    
    richTextBlockValues[`${blockId}_block`] = block;
  }
}

const actionValue = payload.actions?.[0]?.value || '';
const actionTimestamp = payload.actions?.[0]?.action_ts || '';

if (settingsMap['error_debug_logs'] === 'TRUE') {
  const debugPayload = {
    ...(actionName === 'Accept' && { relayMessageText }),
    ...richTextBlockValues,
    supportMessageTs: supportMessageTs.toString(),
    relayAlertsMessageTs: relayAlertsMessageTs.toString(),
    actionValue,
    actionTimestamp,
    actionId,
    sfUserId: userQuery?.SF_USER_ID || '',
    firstLast: userQuery?.FIRST_LAST || '',
    userId: userId || '',
    caseId,
    slackPostId,
    lifecycleId,
    lockToken
  };
  await logErrorToDB(env, `Debug: Downstream payload = ${JSON.stringify(debugPayload)}`, "Debug");
}
ctx.waitUntil(
  (async () => {
    try {
      const apiResponse = await env.DOWNSTREAM_WORKER.fetch(`https://internal/${actionName.toLowerCase()}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${decryptedInternalApiKey}`
        },
        body: JSON.stringify({
          ...(actionName === 'Accept' && { relayMessageText }),
          ...richTextBlockValues,
          supportMessageTs: supportMessageTs.toString(),
          relayAlertsMessageTs: relayAlertsMessageTs.toString(),
          actionValue,
          actionTimestamp,
          actionId,
          sfUserId: userQuery?.SF_USER_ID || '',
          firstLast: userQuery?.FIRST_LAST || '',
          userId: userId || '',
          caseId,
          slackPostId,
          lifecycleId,
          lockToken
        })
      });
      if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        await logErrorToDB(env, `API call failed: ${apiResponse.status} ${errorText}`, "Error");
      }
    } catch (apiErr) {
      await logErrorToDB(env, `Exception during API call: ${apiErr.message}`, "Error");
    }
  })()
);
} catch (apiErr) {
  await logErrorToDB(env, `Exception during API call: ${apiErr.message}`, "Error");
}

return new Response(`Received a valid ${request.method} request with JSON body`, {
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
};
