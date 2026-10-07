//Helper function to decrypt tokens
async function decrypt(encryptedWithVersion, env, prefix = 'SALESFORCE_APIS_ENCRYPTION_SECRET') {
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

//Helper function to add errors or debug logs to the Database
async function logErrorToDB(env, errorMessage, errorType = 'Error') {
  try {
    const timestamp = new Date().toISOString();
    await env.DB_PRIMARY.prepare(
      `INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
      VALUES (?, ?, ?, ?)`
    ).bind(timestamp, 'new', errorMessage, errorType).run();
  } catch (dbError) {
    console.error('Failed to log error to DB:', dbError);
  }
}

// Helper function to alert in Slack
  async function triggerSlackErrorAlert(env, settings, alertMessageBody) {

    if (settings['bypass_slack_error_alerts']?.trim().toUpperCase() === 'TRUE') {
      await logErrorToDB(env, "Slack alert bypassed due to setting", "Debug");
      return;
    }
    
  try {
    const result = await env.DB_PRIMARY.prepare(
      "SELECT SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME = ?"
    ).bind("slack_error_alerts_workflow_url").first();

    if (!result || !result.SETTING_VALUE) {
      await logErrorToDB(env, "Missing slack_error_alerts_workflow_url setting", "Error");
      return;
    }

  const payload = JSON.stringify({ message: alertMessageBody });

  const response = await fetch(result.SETTING_VALUE, {
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

//Helper function to identifiy Urls and emoji's in text and separate them into their own elements within the same rich_text_section
function parseSlackRichText(text) {
  if (!text) return [];

//Trim leading/trailing whitespace including spaces, tabs, and newlines
const cleanedText = text.replace(/^\s+|\s+$/g, '');

const elements = [];
const emojiRegex = /:([a-z0-9_+-]+):/gi;

// Match URLs only if surrounded by whitespace or at string boundaries
const urlRegex = /(?<=\s|^)(https?:\/\/[a-zA-Z0-9\-._~:/?#@!$&'()*+,;=%]+)(?=\s|$)/g;

let remaining = cleanedText;
let match;

// Extract URLs
while ((match = urlRegex.exec(remaining)) !== null) {
  const [url] = match;
  const index = match.index;

  if (index > 0) {
    elements.push({ type: "text", text: remaining.slice(0, index) });
  }

  const cleanedUrl = url.replace(/\.+$/, '');
  elements.push({ type: "link", url: cleanedUrl });
  remaining = remaining.slice(index + url.length);
  urlRegex.lastIndex = 0;
}

if (remaining) {
  elements.push({ type: "text", text: remaining });
}

// Extract emojis from text elements
const finalElements = [];
for (const el of elements) {
  if (el.type === "text") {
    let lastIndex = 0;
    let emojiMatch;
    while ((emojiMatch = emojiRegex.exec(el.text)) !== null) {
      const emojiName = emojiMatch[1];
      const emojiStart = emojiMatch.index;

      if (emojiStart > lastIndex) {
        finalElements.push({ type: "text", text: el.text.slice(lastIndex, emojiStart) });
      }

      finalElements.push({ type: "emoji", name: emojiName });
      lastIndex = emojiStart + emojiMatch[0].length;
    }

    if (lastIndex < el.text.length) {
      finalElements.push({ type: "text", text: el.text.slice(lastIndex) });
    }
  } else {
    finalElements.push(el);
  }
}

return finalElements;
}

// Validate user when request comes from the compose tab
async function validateUserAuth(auth, env) {
  if (!auth?.SLACK_USER_ID || !auth?.SESSION_TOKEN) {
    return { valid: false, status: 400, message: 'Bad Request: Missing auth fields' };
  }

  const user = await env.DB_PRIMARY.prepare(
    `SELECT SESSION_TOKEN, USER_ROLE FROM User WHERE SLACK_USER_ID = ?`
  ).bind(auth.SLACK_USER_ID).first();

  if (!user) {
    return { valid: false, status: 404, message: 'You are not authorized to perform this action.' };
  }

  if (user.USER_ROLE === 'Inactive') {
    return { valid: false, status: 403, message: 'You are not authorized to perform this action.' };
  }

  if (user.SESSION_TOKEN !== auth.SESSION_TOKEN) {
    return { valid: false, status: 401, message: 'You are not authorized to perform this action.' };
  }

  return {
    valid: true,
    userRole: user.USER_ROLE
  };
}

//Main function called when worker URL is sent a request
export default {
  async fetch(request, env, ctx) {

    const host = request.headers.get('host');
    if (host && host.endsWith('.workers.dev')) {
      return new Response('Forbidden', { status: 403 });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const normalizedPath = path.toLowerCase();

//Allowed paths list    
const allowedPaths = new Set([
  '/api/v1/new',
  '/health']);
if (!allowedPaths.has(normalizedPath)) {
  return new Response('Not Found', { status: 404 });
}

// Handle CORS preflight for the Compose form
if (request.method === 'OPTIONS') {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

//Health check logic that runs when the path includes /health. Only GET methods are accepted here
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
  
//Logic that only allows POST requests and rejects others
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
  
//Logic that validates the Content-Type Header is application/json and rejects if it's missing   
const contentType = request.headers.get('Content-Type');
if (!contentType || contentType !== 'application/json') {
  await logErrorToDB(env, `Invalid or missing Content-Type: ${contentType}`);
  return new Response('Bad Request: Content-Type must be application/json', {
    status: 400,
    headers: { 'Content-Type': 'text/plain' },
  });
}

//Ensure the body received is valid JSON
let body;
try {
  body = await request.json();
} catch (e) {
  await logErrorToDB(env, `Invalid JSON body: ${e.message}`);
  return new Response('Bad Request: Missing or invalid JSON body', {
    status: 400,
    headers: { 'Content-Type': 'text/plain' },
  });
}
  
//Logic that validates the Authorization Header with a Bearer token was included and rejects if it's missing    
const authHeader = request.headers.get('Authorization') || '';
let authCheck = null;

if (body.auth) {
  authCheck = await validateUserAuth(body.auth, env);

  if (!authCheck.valid) {
    return new Response(authCheck.message, {
      status: authCheck.status,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
} else {
  if (!authHeader.startsWith('Bearer ')) {
    await logErrorToDB(env, `Missing or invalid Authorization header`);
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
    });
  }
}

if (
  authCheck &&
  !['Developer', 'Manager', 'AdvancedSupport', 'Support'].includes(authCheck.userRole)
) {
  return new Response('Forbidden', {
    status: 403,
    headers: { 'Content-Type': 'text/plain' },
  });
}
  
try {
//Gets settings from Database      
  const settingNames = [
    'external_api_key_salesforce',
    'slack_api_post_message_url',
    'slack_bot_token',
    'slack_channel_id_support',
    'slack_message_base_url',
    'slack_error_alerts_workflow_url',
    'bypass_slack_error_alerts',
    'salesforce_api_slack_post_endpoint_url',
    'salesforce_access_token',
    'bypass_salesforce_individual_post',
    'auto_responder_toggle',
    'auto_responder_type',
    'auto_responder_after_hours',
    'auto_responder_meeting',
    'auto_responder_custom_1',
    'auto_responder_custom_2',
    'auto_responder_custom_3',
    'error_debug_logs',
    'debug_mode'
  ];
  
  const settings = {};
  
  for (const name of settingNames) {
    const result = await env.DB_PRIMARY.prepare(
      "SELECT SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME = ?"
      ).bind(name).first();
      
  if (!result || !result.SETTING_VALUE) {
    const errorMsg = `Missing or empty setting: ${name}`;
    await logErrorToDB(env, errorMsg);

  const alertMsg = [
    "Worker: new",
    `Message: Missing or empty setting: "${name}"`,
    "Action Needed: Ensure this setting exists on the database and is not empty to restore functionality"
  ].join('\n');

  await triggerSlackErrorAlert(env, settings, alertMsg);
  throw new Error(errorMsg);
}

settings[name] = result.SETTING_VALUE;
}
    
//Decrypt the External Salesforce API Key      
  let decryptedKey;
  try {
    decryptedKey = await decrypt(settings['external_api_key_salesforce'], env, 'SALESFORCE_APIS_ENCRYPTION_SECRET');
  } catch (e) {
    const alertMsg = [
      "Worker: new",
      "Message: Decryption failed for external_api_key_salesforce",
      `Error: ${e.message}`,
      "Action Needed: Update salesforce_api_secret_version to a valid version and readd external_api_key_salesforce to restore functionality"
    ].join('\n');
    
    await logErrorToDB(env, alertMsg);
    await triggerSlackErrorAlert(env, settings, alertMsg);
    throw e;
    
  }
    
//Decrypt Slack bot token      
  const token = authHeader.slice(7);      
  let decryptedSlackToken;
  try {
    decryptedSlackToken = await decrypt(settings['slack_bot_token'], env, 'SLACK_APIS_ENCRYPTION_SECRET');
  } catch (e) {
    const alertMsg = [
      "Worker: new",
      "Message: Decryption failed for slack_bot_token",
      `Error: ${e.message}`,
      "Action Needed: Update slack_api_secret_version to a valid version and readd slack_bot_token to restore functionality"
    ].join('\n');
    await logErrorToDB(env, alertMsg);
    await triggerSlackErrorAlert(env, settings, alertMsg);
    throw e;
  }      

//Decrypt the Salesforce OAuth Token      
  let decryptedSalesforceToken;
  try {
    decryptedSalesforceToken = await decrypt(settings['salesforce_access_token'], env, 'SALESFORCE_APIS_ENCRYPTION_SECRET');
  } catch (e) {
    const alertMsg = [
      "Worker: new",
      "Message: Decryption failed for salesforce_access_token",
      `Error: ${e.message}`,
      "Action Needed: Update salesforce_api_secret_version to a valid version and reconnect Salesforce to restore functionality"
    ].join('\n');
    await logErrorToDB(env, alertMsg);
    await triggerSlackErrorAlert(env, settings, alertMsg);
    throw e;
  }
  
 // body.auth sent from compose tab should be enough for auth, if no body.auth then there needs to be a token
  if (!body.auth && token !== decryptedKey) {
    await logErrorToDB(env, `Invalid token provided in Authorization header`);
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
    });
  }      

//Define headers for the API call to Slack which creates the message
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Authorization": `Bearer ${decryptedSlackToken}`,
};

  
//Define the request body for the API call to Slack which creates the message    
const formattedBody = {
channel: settings['slack_channel_id_support'],
blocks: [
  {
    type: "rich_text",
    block_id: "post_info",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: body.salesforce_rep },
          { type: "text", text: "\n" },
          { type: "text", text: "Asset: ", style: { bold: true } },
          { type: "text", text: body.salesforce_asset ? body.salesforce_asset : "Not Provided" },
          { type: "text", text: "\n" },
          { type: "text", text: "Customer: ", style: { bold: true } },
          { type: "text", text: body.customer },
          { type: "text", text: "\n" },
          { type: "text", text: "Case: ", style: { bold: true } },
          { type: "text", text: body.case_number }
        ]
      }
    ]
  },
  {
    type: "rich_text",
    block_id: "issue_summary",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Summarize the issue:", style: { bold: true } },
          { type: "text", text: "\n" },
          ...parseSlackRichText(body.issue_summary)
        ]
      }
    ]
  },
  {
    type: "rich_text",
    block_id: "duplication_steps",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Explain how someone else can see or duplicate the issue:", style: { bold: true } },
          { type: "text", text: "\n" },
          ...parseSlackRichText(body.duplication_steps)
        ]
      }
    ]
  },
  {
    type: "rich_text",
    block_id: "examples",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Provide examples (links are preferred):", style: { bold: true } },
          { type: "text", text: "\n" },
          ...parseSlackRichText(body.examples)
        ]
      }
    ]
  },
  {
    type: "rich_text",
    block_id: "rep_question",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "How can we help you:", style: { bold: true } },
          { type: "text", text: "\n" },
          ...parseSlackRichText(body.rep_question)
        ]
      }
    ]
  },
  { type: "divider" },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Status:* New :newgreen:\n*Owner:* Pending Assignment"
    }
  },
  {
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Start",
          emoji: true
        },
        style: "primary",
        value: body.value,
        action_id: "action_name:Start"
      }
    ]
  }
]
};

//Declare a variable for only the rich text blocks as these contain the actual message
const richTextBlocks = formattedBody.blocks.filter(
block => block.type === "rich_text"
);

//Log richTextBlocks JSON when debug logs are enabled
if (settings['error_debug_logs'] === 'TRUE') {
await logErrorToDB(env, `richTextBlocks preview: ${JSON.stringify(richTextBlocks)}`, "Debug");
}

//Parse body.value into a key-value object called dynamicIds and declare them to use later
const dynamicIds = {};
if (body.value) {
  body.value.split(',').forEach(pair => {
    const [key, val] = pair.split(':');
    if (key && val) dynamicIds[key.trim()] = val.trim();
  });
}

//Define the Slack Post Record Id and the Case Record Id
const slackPostId = dynamicIds.slack_post_id ?? null;
const caseId = dynamicIds.case_id ?? null;


//Inserts a debug block before the actions block if debug mode is enabled
if (settings['debug_mode'] === 'TRUE') {
  formattedBody.blocks.splice(7, 0, {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Debug Info:*\n\`\`\`\n${Object.entries(dynamicIds).map(([k, v]) => `${k}:${v}`).join('\n')}\n\`\`\``
    }
  });
}

//Log the size of the payload when debug logs are enabled  
if (settings['error_debug_logs'] === 'TRUE') {
  const payloadSizeBytes = new TextEncoder().encode(JSON.stringify(formattedBody)).length;
  await logErrorToDB(env, `Slack payload size: ${payloadSizeBytes} bytes`, "Debug");
}  

//Sends the API call to Slack to create a new message, parses the response, and logs errors
let slackResponseBody;
try {
const slackResponse = await fetch(settings['slack_api_post_message_url'], {
  method: "POST",
  headers,
  body: JSON.stringify(formattedBody),
});

slackResponseBody = await slackResponse.json();

const slackFailed =
  !slackResponse.ok ||
  !slackResponseBody.ok ||
  !slackResponseBody.ts;

if (slackFailed) {
  const errorText = slackResponseBody.error || `HTTP ${slackResponse.status}`;
  await logErrorToDB(env, `Slack API POST failed: ${slackResponse.status} - ${errorText}`);
  await triggerSlackErrorAlert(env, settings, [
    `Worker: new`,
    `Message: Slack API call to create message failed for Case ${body.case_number}`,
    `Slack API Response: ${errorText}`,
    `Action Needed: Investigate and fix cause as needed. Review the dashboard and Salesforce case to update/remove orphaned data.`
  ].join('\n'));    

  throw new Error(`Slack API POST failed with status ${slackResponse.status} - ${errorText}`);
}

} catch (e) {
await logErrorToDB(env, `Slack POST error: ${e.message}`);
throw e;
}

//Defines the timestamp of the created message and builds a link to the message    
  const slackTimestamp = slackResponseBody.ts;
  const slackLink = `${settings['slack_message_base_url']}/${settings['slack_channel_id_support']}/p${slackTimestamp.replace('.', '')}`;       
  
//Convert Slack timestamp (in seconds) to ISO UTC format without milliseconds
  const postedDateTime = new Date(parseFloat(slackTimestamp) * 1000)
    .toISOString()
    .split('.')[0] + 'Z';
  
//Send an API call to update the Slack Post Record in Salesforce only if the Salesforce Bypass setting is disabled      
    ctx.waitUntil((async () => {
      try {
        if (settings['bypass_salesforce_individual_post'] === 'TRUE') {
          console.log("Bypassing Salesforce PATCH due to setting.");
        } else {
          if (!slackPostId) {
            throw new Error("Missing slackPostId for Salesforce PATCH request.");
          }
    
          const salesforcePatchUrl = `${settings['salesforce_api_slack_post_endpoint_url']}/${slackPostId}`;
    
          await fetch(salesforcePatchUrl, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${decryptedSalesforceToken}`,
            },
            body: JSON.stringify({
              Slack_Message_Timestamp__c: slackTimestamp,
              Posted_Date_Time__c: postedDateTime,
              Slack_Link__c: slackLink,
            }),
          });
        }
      } catch (e) {
        console.error("Failed to PATCH Salesforce:", e);
        await logErrorToDB(env, e.message);
      }

//Determine the correct auto-responder message
      let autoResponderText = '';
      const responderType = settings['auto_responder_type'];

        if (settings['auto_responder_toggle'] === 'TRUE') {
          const validTypes = [
            'auto_responder_after_hours',
            'auto_responder_meeting',
            'auto_responder_custom_1',
            'auto_responder_custom_2',
            'auto_responder_custom_3'
            ];

        if (validTypes.includes(responderType)) {
          autoResponderText = settings[responderType];
        } else {
          console.warn(`Invalid auto_responder_type: ${responderType}`);
          await logErrorToDB(env, `Invalid auto_responder_type: ${responderType}`);
        }
      }

//Send an API call to Slack to create a threaded message if auto-responder is enabled
      if (settings['auto_responder_toggle'] === 'TRUE' && autoResponderText) {
        try {
          const threadMessageBody = {
          channel: slackResponseBody.channel,
          thread_ts: slackTimestamp,
          blocks: [
            {
              type: "section",
              text: {
              type: "mrkdwn",
              text: autoResponderText
            } 
          }
        ]
      };

      await fetch(settings['slack_api_post_message_url'], {
        method: "POST",
        headers,
        body: JSON.stringify(threadMessageBody),
      });
      } catch (e) {
        console.error("Failed to post threaded message:", e);
        await logErrorToDB(env, `Threaded Slack message error: ${e.message}`);
        }
      }
    
//Create new row on the dashboard table
      try {
        const currentTimestamp = new Date().toISOString().split('.')[0] + 'Z';
    
        await env.DB_PRIMARY.prepare(
          `INSERT INTO Dashboard (
            MESSAGE_TIMESTAMP,
            CASE_NUMBER,
            SALESFORCE_ASSET,
            REP_NAME,
            HELPER_NAME,
            STATUS,
            URL,
            BYPASS_SALESFORCE,
            LAST_UPDATED,
            CASE_RECORD_ID
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          slackTimestamp,
          body.case_number,
          body.salesforce_asset,
          body.salesforce_rep,
          'Pending',
          'New',
          slackLink,
          settings['bypass_salesforce_individual_post'],
          currentTimestamp,
          caseId
        ).run();
        
//Catch errors from the dashboard row creation          
      } catch (e) {
        console.error("Failed to insert into Dashboard table:", e);
        await logErrorToDB(env, `Dashboard insert error: ${e.message}`);
      }
    })());                                 
  
    return new Response(JSON.stringify({ message: "success" }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
    });
    
//Catch errors in the try block that starts above the settings query      
  } catch (err) {
    await logErrorToDB(env, err.message,);
    return new Response(JSON.stringify({
      error: 'Internal Server Error',
      message: err.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }        
},
};
