//Helper function to create session token
function generateSessionToken() {
  const sessionTokenBytes = new Uint8Array(32);
  crypto.getRandomValues(sessionTokenBytes);
  return btoa(String.fromCharCode(...sessionTokenBytes));
}

//Helper function to create JWT
async function createJwtToken(env, settingsMap, SLACK_USER_ID, USER_ROLE, sessionToken) {
  const encoder = new TextEncoder();

  let jwtSecretKeyName = settingsMap['user_jwt_secret_version'];
  if (!env[jwtSecretKeyName]) {
    jwtSecretKeyName = settingsMap['jwt_fallback_secret_version'];
  }

  const versionMatch = jwtSecretKeyName?.match(/_?(v[a-z0-9]+)$/i);
  const jwtVersion = versionMatch ? versionMatch[1] : 'unknown';

  const expirationDays = parseInt(settingsMap['login_expiration_days'] ?? '1', 10);
  const maxAge = expirationDays * 86400;

  const payload = {
    User_Id: SLACK_USER_ID,
    Role: USER_ROLE,
    Expiration: Math.floor(Date.now() / 1000) + maxAge,
    Version: jwtVersion,
    SessionToken: sessionToken
  };

  const payloadStr = JSON.stringify(payload);
  const payloadBase64 = btoa(payloadStr);

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env[jwtSecretKeyName]),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadBase64));
  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

  const jwtToken = `${payloadBase64}.${signatureBase64}`;

  const cookieName = settingsMap['user_cookie_name'] ?? 'session_user';
  const cookieDomain = `.${settingsMap['user_cookie_domain']}`;

  const cookieHeader = `${cookieName}=${encodeURIComponent(jwtToken)}; Path=/; Domain=${cookieDomain}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

  return { jwtToken, cookieHeader, maxAge };
}

// Helper function that logs to the DB
async function logErrorToDB(env, errorMessage, errorType = 'Error') {
  try {
    const timestamp = new Date().toISOString();
    await env.DB_PRIMARY.prepare(
      `INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
       VALUES (?, ?, ?, ?)`
    ).bind(timestamp, 'okta-callback', errorMessage, errorType).run();
  } catch (dbError) {
    console.error('Failed to log error to DB:', dbError);
  }
}

//Helper function that sets SESSION_TOKEN, and clears STATE, NONCE, and CODE_VERIFIER fields upon success
async function updateUserFieldsOnSuccess(env, state, sessionToken) {
  await env.DB_PRIMARY.prepare(`
    UPDATE User
    SET SESSION_TOKEN = ?,
        NONCE = NULL,
        CODE_VERIFIER = NULL,
        STATE = NULL
    WHERE STATE = ?
  `).bind(sessionToken, state).run();
}

//Helper function that clears the STATE, NONCE, and CODE_VERIFIER fields upon validation failure if a row with a matching state value is found
async function clearOAuthTempFieldsOnFailure(env, state) {
  await env.DB_PRIMARY.prepare(`
    UPDATE User
    SET NONCE = NULL, CODE_VERIFIER = NULL, STATE = NULL
    WHERE STATE = ?
  `).bind(state).run();
}

//Helper function that displays an error message on the page if a redirect to the login page is not possible
function fallbackHtmlResponse(errorMessage = '') {
  const sharedStyles = `
    body {
      font-family: 'Segoe UI', sans-serif;
      margin: 0;
      background: #f0f4f8;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 10px;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.1);
      width: 100%;
      max-width: 360px;
      box-sizing: border-box;
      text-align: center;
    }
    h1 {
      color: #2c3e50;
      margin-bottom: 20px;
      font-size: 1.5em;
    }
    p {
      font-size: 0.95em;
      color: #555;
      margin: 0;
    }
    .error {
      color: #e74c3c;
      font-size: 0.95em;
      font-style: italic;
      margin-top: 10px;
    }
  `;

  const errorHtml = errorMessage
    ? `<p class="error">${errorMessage}</p>`
    : '';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Error</title>
      <style>${sharedStyles}</style>
    </head>
    <body>
      <div class="container">
        <h1>Something went wrong</h1>
        <p>An unexpected error occurred.<br>Please try again later or contact a leader if the issue persists.</p>
        ${errorHtml}
      </div>
    </body>
    </html>
  `;

  return new Response(html, {
    status: 500,
    headers: { 'Content-Type': 'text/html' },
  });
}

//Helper function to send a request to Okta to exchange the code for tokens
async function exchangeCodeForTokens(env, code, codeVerifier, tokenUrl, clientId, redirectUri) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier
  });

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      await logErrorToDB(env, `Token exchange failed: ${response.status} ${errorText}`, 'Error');
      return null;
    }

    const tokenData = await response.json();
    return tokenData;
  } catch (err) {
    await logErrorToDB(env, `Error during token exchange: ${err.message}`, 'Error');
    return null;
  }
}


//-------------------- Main function that runs when worker is triggered --------------------//
export default {
  async fetch(request, env, ctx) {
    let state;
    let userRow;
    let userRowFound = false;
    const settingsMap = {};

    try{
    const url = new URL(request.url);
    const path = url.pathname;
    const normalizedPath = path.toLowerCase();

    
    // Allowlist of valid paths
    const allowedPaths = new Set(['/okta/oauth/callback']);
    if (!allowedPaths.has(normalizedPath)) {
      return new Response('Not Found', { status: 404 });
    }
    
    // Only allow GET requests
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { 'Allow': 'GET', 'Content-Type': 'text/plain' },
      });
    }

    // Extract query parameters
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    // Gets settings from Database and logs errors if settings are missing or empty
    const settingsToFetch = [
      'login_page_url',
      'dashboard_page_url',
      'error_debug_logs',
      'okta_client_id',
      'okta_redirect_uri',
      'okta_api_token_url',
      'user_cookie_name',
      'login_expiration_days',
      'user_jwt_secret_version',
      'jwt_fallback_secret_version',
      'user_cookie_domain'
    ];    
    
    const placeholders = settingsToFetch.map(() => '?').join(', ');
    
    try {
      const settingsRows = await env.DB_PRIMARY
      .prepare(`SELECT DB_SETTING_NAME, SETTING_VALUE FROM settings WHERE DB_SETTING_NAME IN (${placeholders})`)
      .bind(...settingsToFetch)
      .all();
      
      for (const row of settingsRows.results) {
        settingsMap[row.DB_SETTING_NAME] = row.SETTING_VALUE;
      }

      for (const name of settingsToFetch) {
        if (!settingsMap[name]) {
          await logErrorToDB(env, `Missing or empty setting: ${name}`, 'Error');
          if (settingsMap['login_page_url']) {
            return Response.redirect(`${settingsMap['login_page_url']}?error=oops`, 302);
          }
          return fallbackHtmlResponse(`Error: Missing or empty setting ${name}`);
        }        
    }
  } catch (err) {
    await logErrorToDB(env, `Error retrieving settings: ${err.message}`, 'Error');
    if (settingsMap['login_page_url']) {
      return Response.redirect(`${settingsMap['login_page_url']}?error=oops`, 302);
    }
    return fallbackHtmlResponse(`Error retrieving settings: ${err.message}`);
  }

    // Validate presence of code and state and redirect to login page with error if missing
    if (!code && !state) {
      await logErrorToDB(env, `Missing code and state in redirect URL: ${url.toString()}`, 'Error');
      return Response.redirect(`${settingsMap['login_page_url']}?error=oops`, 302); 
    }

    if (!code) {
      await logErrorToDB(env, `Missing code in redirect URL: ${url.toString()}`, 'Error');
      return Response.redirect(`${settingsMap['login_page_url']}?error=oops`, 302); 
    }
    
    if (!state) {
      await logErrorToDB(env, `Missing state in redirect URL: ${url.toString()}`, 'Error');
      return Response.redirect(`${settingsMap['login_page_url']}?error=oops`, 302);
    }
    
//Declare variables and fetch values from User table  
    let nonce, codeVerifier, username;
    try {
      userRow = await env.DB_PRIMARY
        .prepare(`SELECT USER_ROLE, NONCE, CODE_VERIFIER, USERNAME, SLACK_USER_ID FROM User WHERE STATE = ?`)
        .bind(state)
        .first();

//Verify if state exists on the user table and redirect if not found
      if (!userRow) {
        await logErrorToDB(env, `State not found in User table: ${state}`, 'Error');
        return Response.redirect(`${settingsMap['login_page_url']}?error=oops`, 302);
      }
//Declare a variable for row is found to be able to use later for cleanup
      userRowFound = true;      

//Verify if user role is inactive on found row      
      if (userRow.USER_ROLE === 'Inactive') {
        await logErrorToDB(env, `User with state ${state} is inactive`, 'Error');
        await clearOAuthTempFieldsOnFailure(env, state); 
        return Response.redirect(`${settingsMap['login_page_url']}?error=unauthorized`, 302);
      }
    
// Store values for later use
      nonce = userRow.NONCE;
      codeVerifier = userRow.CODE_VERIFIER;
      username = userRow.USERNAME;

// Verify nonce code_verifier, and username are not empty on same row state was found      
    if (!nonce || !codeVerifier || !username) {
      await logErrorToDB(env, `Missing nonce, code_verifier, or username on User table for state: ${state}`, 'Error');
      await clearOAuthTempFieldsOnFailure(env, state); 
      return Response.redirect(`${settingsMap['login_page_url']}?error=oops`, 302);
    }
  
  } catch (err) {
    await logErrorToDB(env, `Database error while retrieving user data for state=${state}: ${err.message}`, 'Error');
    return Response.redirect(`${settingsMap['login_page_url']}?error=oops`, 302);
  }
  
    
// Use helper function to send request to Okta
    const tokenData = await exchangeCodeForTokens(
      env,
      code,
      codeVerifier,
      settingsMap['okta_api_token_url'],
      settingsMap['okta_client_id'],
      settingsMap['okta_redirect_uri']
      );
    if (!tokenData) {
      await clearOAuthTempFieldsOnFailure(env, state); 
      return Response.redirect(`${settingsMap['login_page_url']}?error=oops`, 302);
    }

// Decode the ID token (JWT)
  const [headerB64, payloadB64] = tokenData.id_token.split('.');
  const payloadJson = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
  const claims = JSON.parse(payloadJson);

// Validate claims
  const expectedIssuer = settingsMap['okta_api_token_url'].replace(/\/v1\/token$/, '');
  const now = Math.floor(Date.now() / 1000);

  if (
    claims.aud !== settingsMap['okta_client_id'] ||
    claims.iss !== expectedIssuer ||
    claims.exp < now ||
    claims.iat > now ||
    claims.nonce !== nonce ||
    !claims.Email_Address || claims.Email_Address.toLowerCase() !== username.toLowerCase()
  ) {
    await logErrorToDB(env, `ID token validation failed for user=${username}, state=${state}`, 'Error');
    await clearOAuthTempFieldsOnFailure(env, state); 
    return Response.redirect(`${settingsMap['login_page_url']}?error=oops`, 302);
  }

// Generate session token
const sessionToken = generateSessionToken();

// Update user record with session token and clear temp fields
await updateUserFieldsOnSuccess(env, state, sessionToken);

// Create JWT and get cookie header
const { cookieHeader } = await createJwtToken(
  env,
  settingsMap,
  userRow.SLACK_USER_ID,
  userRow.USER_ROLE,
  sessionToken
);

// Redirect to dashboard with JWT cookie
const dashboardUrl = settingsMap['dashboard_page_url'] ?? '/';
const headers = new Headers({
  'Set-Cookie': cookieHeader,
  'Location': dashboardUrl
});

return new Response(null, {
  status: 302,
  headers
});

//Catches unexpected errors
    } catch (err) {
    await logErrorToDB(env, `Unexpected error occurred: ${err.message}`, 'Error');

  // Only attempt cleanup if state was successfully used to find a row earlier
    if (state && userRowFound) {
      await clearOAuthTempFieldsOnFailure(env, state);
    }

    if (settingsMap['login_page_url']) {
      return Response.redirect(`${settingsMap['login_page_url']}?error=oops`, 302);
    }
    return fallbackHtmlResponse(`Unexpected error: ${err.message}`);
  }
}
};
