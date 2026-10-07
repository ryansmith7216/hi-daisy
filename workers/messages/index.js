//Helper function to decrypt tokens
async function decrypt(encryptedWithVersion, env, secretPrefix) {
  const [encryptedBase64, version] = encryptedWithVersion.split('_v');
  if (!encryptedBase64 || !version) {
    throw new Error('Invalid encrypted format or missing version.');
  }

  const secretName = secretPrefix + '_v' + version;
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

//Helper function to log errors to the database
async function logErrorToDB(env, errorMessage, errorType = 'Error') {
  const timestamp = new Date().toISOString();
  await env.DB_PRIMARY.prepare(`
    INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
    VALUES (?, ?, ?, ?)
  `).bind(timestamp, 'messages', errorMessage, errorType).run();
}

// Helper function write update logs to the databse
async function logUpdateToDB(env, request, recordIdentifier = '', logs = null, action = 'updated') {
  try {
    const timestamp = new Date().toISOString();
    const userAgent = request.headers.get('User-Agent') ?? 'Unknown';
    const method = request.method;
    const path = new URL(request.url).pathname;
    const errorType = logs?.ERROR_TYPE ?? 'API';
    const workerName = logs?.ERROR_WORKER_NAME ?? 'messages';
    const message = logs?.ERROR_MESSAGE ??
      `API ${action} ${recordIdentifier || 'record'}\nMethod: ${method}\nURI: ${path}\nUser Agent: ${userAgent}`;
    await env.DB_PRIMARY.prepare(`
      INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
      VALUES (?, ?, ?, ?)
    `).bind(timestamp, workerName, message, errorType).run();
  } catch {
    // Optional: silently fail or add internal logging
  }
}

//Helper function to send an API call to Slack to get a message
async function fetchSlackMessage({ slackApiUrl, slackToken, channel, ts }) {
  const bodyParams = new URLSearchParams({
    channel,
    latest: ts,
    oldest: ts,
    inclusive: 'true',
    limit: '1'
  });

  const response = await fetch(slackApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${slackToken}`
    },
    body: bodyParams.toString()
  });

  const responseBody = await response.text();
  return {
    slackResponseBody: responseBody,
    slackResponseStatus: response.status,
    slackResponseHeaders: response.headers
  };  
}

//Helper function to extract the rich text blocks from Slack's response payload
function extractRichTextValue(blocks, blockId) {
  const block = blocks.find(b => b.block_id === blockId && b.type === "rich_text");
  if (!block) return "";

  const section = block.elements?.find(e => e.type === "rich_text_section");
  if (!section) return "";

  const contentElements = section.elements?.slice(2) ?? []; // Skip label and line break
  return contentElements
    .map(el => {
      if (el.type === "text") return el.text;
      if (el.type === "link") return el.url;
      if (el.type === "emoji") return `:${el.name}:`;
      return "";
    })
    .join("")
    .trim();
}

//Helper function to extract the values from the post_info rich text block only
function extractPostInfoFields(blocks) {
  const block = blocks.find(b => b.block_id === "post_info" && b.type === "rich_text");
  if (!block) return {};

  const section = block.elements?.find(e => e.type === "rich_text_section");
  if (!section) return {};

  const elements = section.elements ?? [];

  return {
    salesforce_rep: elements[0]?.text?.trim() ?? "",
    salesforce_asset: elements[3]?.text?.trim() ?? "",
    customer: elements[6]?.text?.trim() ?? "",
    case_number: elements[9]?.text?.trim() ?? ""
  };
}

//Helper function to extract the value from the modified_by rich text block only
function extractModifiedByValue(blocks) {
  const block = blocks.find(b => b.block_id === "modified_by" && b.type === "rich_text");
  if (!block) return null;

  const section = block.elements?.find(e => e.type === "rich_text_section");
  if (!section) return null;

  const textElement = section.elements?.find(el => el.type === "text");
  const value = textElement?.text?.trim();

  return value && value.length > 0 ? value : null;
}


// Helper function to sanitize and format rich text for Slack
function parseSlackRichText(text) {
  if (!text) return [];

  // Trim leading/trailing whitespace
  const cleanedText = text.trim();

  const elements = [];
  const emojiRegex = /:([a-z0-9_+\-]+):/gi;
  const urlRegex = /\bhttps?:\/\/[a-zA-Z0-9\-._~:/?#@!$&'()*+,;=%]+/g;

  let remaining = cleanedText;
  let match;

  // Extract URLs
  while ((match = urlRegex.exec(remaining)) !== null) {
    const url = match[0];
    const index = match.index;

    if (index > 0) {
      elements.push({ type: "text", text: remaining.slice(0, index) });
    }

    const cleanedUrl = url.replace(/\.+$/, ''); // Trim trailing periods
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

//Helper function to send an API call to update the message in Slack
async function updateSlackMessage({ slackApiUrl, slackToken, channel, ts, blocks, attachments }) {
  const response = await fetch(slackApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${slackToken}`
    },
    body: JSON.stringify({
      channel,
      ts,
      blocks,
      ...(attachments !== undefined ? { attachments } : {})
    })
  });

  const responseBody = await response.text();
  return {
    slackResponseBody: responseBody,
    slackResponseStatus: response.status
  };
}

//Helper function to unicode-safe base64 encode a string
  function encodeBase64Unicode(str) {
    const utf8Bytes = new TextEncoder().encode(str);
    const binary = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('');
    return btoa(binary);
  }
// Helper function to validate user auth when request is coming from the messages tab
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

//Main function which runs when the worker is triggered
export default {
  async fetch(request, env, ctx) {

    const host = request.headers.get('host');
    if (host && host.endsWith('.workers.dev')) {
      return new Response('Forbidden', { status: 403 });
    }
    
    const allowedRoutes = {
      'POST:/api/v1/messages': 'handleMessagesPost',
      'PATCH:/api/v1/messages': 'handleMessagesPatch'
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
      authCheck = await validateUserAuth(body.auth, env);

      if (!authCheck.valid) {
        return new Response(authCheck.message, {
          status: authCheck.status,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    } else {
      if (!authHeader.startsWith('Bearer ')) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
        });
      }
    }

    if (
      authCheck &&
      !['Developer', 'Manager', 'AdvancedSupport'].includes(authCheck.userRole)
    ) {
      return new Response('Forbidden', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    try {
      const settingsResult = await env.DB_PRIMARY.prepare(
        "SELECT DB_SETTING_NAME, SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME IN (?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        'internal_api_key',
        'slack_bot_token',
        'slack_api_get_message_url',
        'slack_api_update_message_url',
        'slack_bot_id',
        'slack_dashboard_lock_seconds',
        'error_debug_logs'
        ).all();
      
      let encryptedInternalKey, encryptedSlackToken, slackApiUrl, slackBotId;
      
      for (const row of settingsResult.results) {
        if (row.DB_SETTING_NAME === 'internal_api_key') {
          encryptedInternalKey = row.SETTING_VALUE;
        } else if (row.DB_SETTING_NAME === 'slack_bot_token') {
          encryptedSlackToken = row.SETTING_VALUE;
        } else if (row.DB_SETTING_NAME === 'slack_api_get_message_url') {
          slackApiUrl = row.SETTING_VALUE;
        }
        else if (row.DB_SETTING_NAME === 'slack_bot_id') {
          slackBotId = row.SETTING_VALUE;
        }        
      }
      
      if (!encryptedInternalKey || !encryptedSlackToken) {
        throw new Error('Missing internal_api_key or slack_bot_token in settings.');
      }
      
      const decryptedKey = await decrypt(encryptedInternalKey, env, 'INTERNAL_APIS_ENCRYPTION_SECRET');
      const decryptedSlackToken = await decrypt(encryptedSlackToken, env, 'SLACK_APIS_ENCRYPTION_SECRET');      
      const token = authHeader.slice(7);

      if (!body.auth && token !== decryptedKey) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="Access to the internal API"' },
        });
      }

      const channel = body.channel_id;
      let ts = body.timestamp;
      if (typeof ts === 'string' && ts.length > 6 && !ts.includes('.')) {
        ts = ts.slice(0, ts.length - 6) + '.' + ts.slice(ts.length - 6);
      }      
           

// Route handling
  switch (routeKey) {

//POST METHOD LOGIC STARTS HERE//        
      case 'POST:/api/v1/messages': {
      
      const slackStart = Date.now();
      const slackResponse = await fetchSlackMessage({
        slackApiUrl,
        slackToken: decryptedSlackToken,
        channel,
        ts
      });
      const slackDuration = Date.now() - slackStart;
          
      const headers = slackResponse.slackResponseHeaders;
      const rateLimitRemaining = headers.get('X-RateLimit-Remaining') ?? 'N/A';
      const rateLimitReset = headers.get('X-RateLimit-Reset') ?? 'N/A';
      const retryAfter = headers.get('Retry-After') ?? 'N/A';
          
      if (settingsResult.results.find(r => r.DB_SETTING_NAME === 'error_debug_logs')?.SETTING_VALUE === 'TRUE') {
        await logErrorToDB(
          env,
          `Debug: Slack API call took ${slackDuration}ms \n Retry-After=${retryAfter} \n X-RateLimit-Remaining=${rateLimitRemaining} \n X-RateLimit-Reset=${rateLimitReset}`,
          'Debug'
        );
      }      
          
      const responseBody = slackResponse.slackResponseBody;
      const parseStart = Date.now();   
      const parsedSlackResponse = JSON.parse(responseBody);

      if (!parsedSlackResponse.ok) {
        const errorDetails = `Error searching message ID ${ts} in channel ID ${channel}. Slack responded with: ${JSON.stringify(parsedSlackResponse)}`;
        
        await logErrorToDB(env, errorDetails, 'Error');
      
        return new Response(
          JSON.stringify({ error: errorDetails }),
          {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }            
      
      const slackMessage = parsedSlackResponse.messages && parsedSlackResponse.messages[0];
      const blocks = slackMessage.blocks ?? [];

      const postInfoBlock = blocks.find(b => b.block_id === "post_info" && b.type === "rich_text");
      if (!postInfoBlock) {
        return new Response("This message is broken and it is no longer editable from this page.", {
          status: 400,
          headers: { "Content-Type": "text/plain" }
        });
      }

      const postInfo = extractPostInfoFields(blocks);
      const issueSummary = extractRichTextValue(blocks, "issue_summary");
      const duplicationSteps = extractRichTextValue(blocks, "duplication_steps");
      const examples = extractRichTextValue(blocks, "examples");
      const repQuestion = extractRichTextValue(blocks, "rep_question");
      const modifiedBy = extractModifiedByValue(blocks);

        if (!slackMessage || slackMessage.bot_id !== slackBotId) {
          return new Response('This message was not created by the Slack integration and cannot be edited.', {
            status: 403,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
          
          let dashboardRow = null;
          try {
            dashboardRow = await env.DB_PRIMARY.prepare(
              `SELECT LAST_UPDATED FROM Dashboard WHERE MESSAGE_TIMESTAMP = ? LIMIT 1`
            ).bind(slackMessage.ts).first();
          } catch (e) {
            // Optional: log error or ignore silently
            dashboardRow = null;
          }        
          
        const statusBlockText = slackMessage.blocks?.find(
          b => b.type === "section" && b.text?.text?.includes("*Status:*")
        )?.text.text ?? "";          

        const customResponse = {
          "dashboard_last_updated": dashboardRow?.LAST_UPDATED ?? null,
          "message_ts": slackMessage.ts,
          "channel_id": channel,
          "salesforce_rep": postInfo.salesforce_rep,
          "salesforce_asset": postInfo.salesforce_asset,
          "customer": postInfo.customer,
          "case_number": postInfo.case_number,
          "issue_summary": issueSummary,
          "duplication_steps": duplicationSteps,
          "examples": examples,
          "rep_question": repQuestion,
          "status_owner": statusBlockText,
          "modified_by": modifiedBy,
          "debug_info_block": slackMessage.blocks?.find(
            b => b.type === "section" && b.text?.text?.includes("*Debug Info:*")
          ) ?? null,
          "actions": slackMessage.blocks?.find(b => b.type === "actions")?.elements ?? []         
        };
          
        if (settingsResult.results.find(r => r.DB_SETTING_NAME === 'error_debug_logs')?.SETTING_VALUE === 'TRUE') {
          await logErrorToDB(
            env,
            `Slack message parsing and field extraction took ${Date.now() - parseStart}ms`,
            'Debug'
          );
        }        

          return new Response(JSON.stringify(customResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });          
        }     
//POST METHOD LOGIC ENDS HERE//        

//PATCH METHOD LOGIC STARTS HERE/
    case 'PATCH:/api/v1/messages': {
      const lockDurationSetting = settingsResult.results.find(
        r => r.DB_SETTING_NAME === 'slack_dashboard_lock_seconds'
      )?.SETTING_VALUE;
        
      const lockDurationSeconds = parseInt(lockDurationSetting, 10);
      const currentUnixTime = Date.now(); // now in milliseconds
      const lockUntil = currentUnixTime + lockDurationSeconds * 1000;
      let lockAcquired = false;
      
//Attempt to acquire a lock if the row exists, the lock isn't already owned, and if the last_updated timestamp matches  
      if (body.dashboard_last_updated) {
        const lockResult = await env.DB_PRIMARY.prepare(
          `UPDATE Dashboard
            SET LOCKED_UNIX_TIMESTAMP = ?
            WHERE MESSAGE_TIMESTAMP = ?
            AND LAST_UPDATED = ?
            AND (LOCKED_UNIX_TIMESTAMP IS NULL OR LOCKED_UNIX_TIMESTAMP < ?)`
        ).bind(lockUntil, body.message_ts, body.dashboard_last_updated, currentUnixTime).run();
        
//If failed to acquire a lock, reject update
        if (lockResult.meta.changes === 0) {
          return new Response('This message is currently being edited or was recently updated. Please search again to get the latest version.', {
            status: 409,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
        lockAcquired = true;
      }

    // Declare variable for attachments
    const clearAttachments = body.clear_attachments === true;

// Clean and validate modified_by value before inserting in formattedBody
      let modifiedByValue = body.modified_by?.replace(/^\n+/, '') ?? '';
      const includeModifiedByBlock = modifiedByValue.trim().length > 0; 
      
      const formattedBody = {
        channel: body.channel_id,
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
                  { type: "text", text: body.salesforce_asset },
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
              text: body.status_owner
            }
          },
          //Only insert the modified_by block if a value exists. This is to ensure the API call to Slack doesn't fail
          ...(includeModifiedByBlock ? [{
            type: "rich_text",
            block_id: "modified_by",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: modifiedByValue,
                    style: { italic: true }
                  }
                ]
              }
            ]
          }] : []),           
          //Only insert the debug_info block if a value exists. This is to ensure the API call doesn't fall        
          ...(body.debug_info_block ? [body.debug_info_block] : []),
          {
            type: "actions",
            elements: body.actions
          }
        ]
      };
      
        
      const slackUpdateUrl = settingsResult.results.find(
        r => r.DB_SETTING_NAME === 'slack_api_update_message_url'
      )?.SETTING_VALUE;
        
      if (!slackUpdateUrl) {
        return new Response('Missing Slack update URL in settings.', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
        
      const updateResponse = await updateSlackMessage({
        slackApiUrl: slackUpdateUrl,
        slackToken: decryptedSlackToken,
        channel: body.channel_id,
        ts: body.message_ts,
        blocks: formattedBody.blocks,
        attachments: clearAttachments ? [] : undefined
      });
      let slackErrorDetails = updateResponse.slackResponseBody;
      let slackUpdateFailed = updateResponse.slackResponseStatus !== 200;
          
      try {
        const parsedSlackResponse = JSON.parse(slackErrorDetails);
        if (parsedSlackResponse.ok === false) {
          slackUpdateFailed = true;
        }
      } catch {
// If parsing fails, assume failure only if status !== 200
      }
    
// Releases the lock and updates LAST_UPDATED even if the Slack update fails.
// Updating LAST_UPDATED prevents another request from acquiring a lock using outdated info.
// This avoids relying on perfect error handling from Slack. If an update attempt happens,
// any other user must re-fetch the message before trying to edit it again, no matter the outcome.
      if (slackUpdateFailed) {
        if (lockAcquired) {
          const now = new Date().toISOString();
          await env.DB_PRIMARY.prepare(`
            UPDATE Dashboard
            SET LOCKED_UNIX_TIMESTAMP = NULL,
                LAST_UPDATED = ?
            WHERE MESSAGE_TIMESTAMP = ?
            AND LOCKED_UNIX_TIMESTAMP = ?
          `).bind(now, body.message_ts, lockUntil).run();
        }
          
        let slackErrorDetails = updateResponse.slackResponseBody;
        let userFriendlyMessage = "Slack message update failed.";
          
        try {
          const parsedSlackError = JSON.parse(slackErrorDetails);
          if (parsedSlackError.error) {
            userFriendlyMessage += ` Reason: ${parsedSlackError.error}`;
          }
        } catch {
          userFriendlyMessage += ` Response: ${slackErrorDetails}`;
        }
          
        return new Response(
          JSON.stringify({
            error: userFriendlyMessage,
            slack_response: slackErrorDetails
          }),
          {
            status: 422, // Unprocessable Entity — suitable for validation errors like message too long
            headers: { 'Content-Type': 'application/json' }
          }
        );            
      }
          
// Only update SUPPORT_MESSAGE_TEXT if Slack succeeded
      if (lockAcquired) {
        const now = new Date().toISOString();
        const supportMessageBlocks = formattedBody.blocks.filter(block => block.type === "rich_text");
        const encodedSupportText = encodeBase64Unicode(JSON.stringify(supportMessageBlocks));

          
        await env.DB_PRIMARY.prepare(`
          UPDATE Dashboard
          SET LOCKED_UNIX_TIMESTAMP = NULL,
          LAST_UPDATED = ?,
          SUPPORT_MESSAGE_TEXT = CASE 
          WHEN SUPPORT_MESSAGE_TEXT IS NOT NULL AND SUPPORT_MESSAGE_TEXT != '' THEN ? ELSE SUPPORT_MESSAGE_TEXT END
          WHERE MESSAGE_TIMESTAMP = ?
          AND LOCKED_UNIX_TIMESTAMP = ?
        `).bind(now, encodedSupportText, body.message_ts, lockUntil).run();
      }

      await logUpdateToDB(env, request, body.message_ts, body.logs);

// Return success response
      return new Response(JSON.stringify(updateResponse), {
        status: updateResponse.slackResponseStatus,
        headers: { 'Content-Type': 'application/json' },
      });  
    }                         
//PATCH METHOD LOGIC ENDS HERE//

//CATCH ERRORS FOR THE ROUTE HANDLING//
      default:
        return new Response('Not Found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
    }

//CATCH ERRORS THAT OCCUR AFTER THE TOKEN IS VALIDATED//    
    } catch (err) {
      return new Response(err?.stack || err?.message || String(err), {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }    
  },
};
