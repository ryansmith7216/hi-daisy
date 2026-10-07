// Logs callback errors to D1 and includes additional diagnostic details when debug logging is enabled
async function logErrorToDB(env, errorMessage, debugMessage = null, debugEnabled = false) {
  try {
    const timestamp = new Date().toISOString();

    await env.DB_PRIMARY.prepare(
      `INSERT INTO Error (
        ERROR_TIMESTAMP_UTC,
        ERROR_WORKER_NAME,
        ERROR_MESSAGE,
        ERROR_TYPE
      )
      VALUES (?, ?, ?, ?)`
    )
    .bind(
      timestamp,
      'google-callback',
      debugEnabled && debugMessage
        ? `${errorMessage} | Debug: ${debugMessage}`
        : errorMessage,
      'Error'
    )
    .run();

  } catch (dbError) {
    console.error('Failed to log error to DB:', dbError);
  }
}

// Decrypts the Google client secret using the version suffix stored with the encrypted value
async function decryptGoogleSecret(encryptedWithVersion, env) {
  const [encryptedBase64, version] = encryptedWithVersion.split('_v');

  if (!encryptedBase64 || !version) {
    throw new Error('Invalid encrypted format or missing version.');
  }

  const secretName = `GOOGLE_APIS_ENCRYPTION_SECRET_v${version}`;
  const secret = env[secretName];

  if (!secret) {
    throw new Error(`Missing secret: ${secretName}`);
  }

  const encryptedBytes = Uint8Array.from(
    atob(encryptedBase64),
    c => c.charCodeAt(0)
  );

  const salt = encryptedBytes.slice(0, 16);
  const iv = encryptedBytes.slice(16, 28);
  const data = encryptedBytes.slice(28);

  const enc = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return new TextDecoder().decode(decrypted);
}

// Creates a random session token for the authenticated Guest user
function generateSessionToken() {
  const sessionTokenBytes = new Uint8Array(32);
  crypto.getRandomValues(sessionTokenBytes);

  return btoa(
    String.fromCharCode(...sessionTokenBytes)
  );
}

// Creates the signed JWT and authentication cookie for the Guest user
async function createJwtToken(env, settingsMap, SLACK_USER_ID, USER_ROLE, sessionToken) {
  try {
    const encoder = new TextEncoder();

    let jwtSecretKeyName = settingsMap['user_jwt_secret_version'];

    if (!env[jwtSecretKeyName]) {
      jwtSecretKeyName = settingsMap['jwt_fallback_secret_version'];
    }

    if (!jwtSecretKeyName || !env[jwtSecretKeyName]) {
      throw new Error('No valid JWT signing secret was found.');
    }

    const versionMatch = jwtSecretKeyName.match(/_?(v[a-z0-9]+)$/i);
    const jwtVersion = versionMatch ? versionMatch[1] : 'unknown';

    const expirationDays = parseInt(
      settingsMap['login_expiration_days'] ?? '1',
      10
    );

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

    const signatureBuffer = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(payloadBase64)
    );

    const signatureBase64 = btoa(
      String.fromCharCode(...new Uint8Array(signatureBuffer))
    );

    const jwtToken = `${payloadBase64}.${signatureBase64}`;
    const cookieName = settingsMap['user_cookie_name'] ?? 'session_user';
    const cookieDomain = `.${settingsMap['user_cookie_domain']}`;

    const cookieHeader =
      `${cookieName}=${encodeURIComponent(jwtToken)}; Path=/; Domain=${cookieDomain}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

    return {
      cookieHeader,
      maxAge
    };

  } catch (error) {
    throw new Error(`JWT creation failed: ${error.message}`);
  }
}

export default {
  async fetch(request, env, ctx) {

    // Parse and validate the callback route
    const url = new URL(request.url);
    const path = url.pathname;
    const normalizedPath = path.toLowerCase();

    const allowedPaths = new Set([
      '/google/oauth/callback'
    ]);

    if (!allowedPaths.has(normalizedPath)) {
      return new Response('Not Found', {
        status: 404,
        headers: {
          'Content-Type': 'text/plain'
        }
      });
    }

    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          'Allow': 'GET',
          'Content-Type': 'text/plain'
        }
      });
    }

    // Load the debug logging setting before validating OAuth callback parameters
    const debugSetting = await env.DB_PRIMARY
      .prepare(
        `SELECT SETTING_VALUE
        FROM Settings
        WHERE DB_SETTING_NAME = ?`
      )
      .bind('error_debug_logs')
      .first();

    const debugEnabled = debugSetting?.SETTING_VALUE === 'TRUE';

    // Read OAuth callback parameters
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
      await logErrorToDB(
        env,
        'Missing required state or code in URL parameters.',
        `path=${url.pathname}, code=${code ? 'present' : 'missing'}, state=${state ? 'present' : 'missing'}, iss=${url.searchParams.get('iss') || 'missing'}, error=${url.searchParams.get('error') || 'none'}`,
        debugEnabled
      );

      // Log and reject callbacks that are missing the required OAuth parameters
      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Validate OAuth state against the temporary state cookie
    const cookieHeader = request.headers.get('Cookie') || '';

    const googleStateCookie = cookieHeader
      .split(';')
      .map(cookie => cookie.trim())
      .find(cookie => cookie.startsWith('google_oauth_state='));

    const savedState = googleStateCookie
      ? decodeURIComponent(googleStateCookie.split('=').slice(1).join('='))
      : null;

    // Log and reject callbacks when the OAuth state cookie is missing or does not match
    if (!savedState || savedState !== state) {
      await logErrorToDB(
        env,
        'OAuth state validation failed.',
        `state_parameter=${state ? 'present' : 'missing'}, state_cookie=${savedState ? 'present' : 'missing'}, match=${savedState === state}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Prepare the temporary OAuth state cookie for deletion after success
    const clearStateCookie =
      'google_oauth_state=; Path=/google/oauth/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax';

    // Load required Google OAuth settings from D1
    const settingsToFetch = [
      'google_client_id',
      'google_client_secret',
      'google_redirect_uri',
      'google_token_uri',
      'google_userinfo_uri',
      'user_jwt_secret_version',
      'jwt_fallback_secret_version',
      'login_expiration_days',
      'user_cookie_name',
      'user_cookie_domain',
      'dashboard_page_url'
    ];

    const placeholders = settingsToFetch.map(() => '?').join(', ');

    const settingsRows = await env.DB_PRIMARY
      .prepare(
        `SELECT DB_SETTING_NAME, SETTING_VALUE
        FROM Settings
        WHERE DB_SETTING_NAME IN (${placeholders})`
      )
      .bind(...settingsToFetch)
      .all();

    const settingsMap = Object.fromEntries(
      settingsRows.results.map(row => [
        row.DB_SETTING_NAME,
        row.SETTING_VALUE
      ])
    );

    // Log and reject callbacks when required Google OAuth settings are missing
    for (const name of settingsToFetch) {
      if (!settingsMap[name]) {
        await logErrorToDB(
          env,
          'Missing required Google OAuth setting.',
          `setting=${name}`,
          debugEnabled
        );

        return Response.redirect(
          new URL('/login?error=oops', request.url).toString(),
          302
        );
      }
    }

    // Decrypt the Google OAuth client secret
    let googleClientSecret;

    // Log and reject callbacks when the Google client secret cannot be decrypted
    try {
      googleClientSecret = await decryptGoogleSecret(
        settingsMap['google_client_secret'],
        env
      );
    } catch (error) {
      await logErrorToDB(
        env,
        'Failed to decrypt Google OAuth client secret.',
        `error=${error.message}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Exchange the authorization code for Google OAuth tokens
    const tokenBody = new URLSearchParams({
      code,
      client_id: settingsMap['google_client_id'],
      client_secret: googleClientSecret,
      redirect_uri: settingsMap['google_redirect_uri'],
      grant_type: 'authorization_code'
    });

    // Send the token request and log network-level failures
    let tokenResponse;

    try {
      tokenResponse = await fetch(
        settingsMap['google_token_uri'],
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: tokenBody
        }
      );
    } catch (error) {
      await logErrorToDB(
        env,
        'Google OAuth token request failed.',
        `error=${error.message}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Log and reject failed Google token exchanges
    if (!tokenResponse.ok) {
      const tokenErrorText = await tokenResponse.text();

      await logErrorToDB(
        env,
        'Google OAuth token exchange failed.',
        `status=${tokenResponse.status}, response=${tokenErrorText}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Parse the token response and log invalid JSON responses
    let tokenData;

    try {
      tokenData = await tokenResponse.json();
    } catch (error) {
      await logErrorToDB(
        env,
        'Google OAuth token response could not be parsed.',
        `error=${error.message}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Log and reject token responses that do not include an access token
    if (!tokenData.access_token) {
      await logErrorToDB(
        env,
        'Google OAuth token response did not include an access token.',
        `token_type=${tokenData.token_type || 'missing'}, expires_in=${tokenData.expires_in ?? 'missing'}, id_token=${tokenData.id_token ? 'present' : 'missing'}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Request the Google user profile and log network-level failures
    let userInfoResponse;

    try {
      userInfoResponse = await fetch(
        settingsMap['google_userinfo_uri'],
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${tokenData.access_token}`
          }
        }
      );
    } catch (error) {
      await logErrorToDB(
        env,
        'Google user profile request failed.',
        `error=${error.message}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Log and reject failed Google user profile requests
    if (!userInfoResponse.ok) {
      const userInfoErrorText = await userInfoResponse.text();

      await logErrorToDB(
        env,
        'Google user profile request failed.',
        `status=${userInfoResponse.status}, response=${userInfoErrorText}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Parse the Google user profile response and log invalid JSON responses
    let userInfo;

    try {
      userInfo = await userInfoResponse.json();
    } catch (error) {
      await logErrorToDB(
        env,
        'Google user profile response could not be parsed.',
        `error=${error.message}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Validate the Google user profile contains the required identity fields
    if (!userInfo.sub || !userInfo.name) {
      await logErrorToDB(
        env,
        'Google user profile did not include required identity fields.',
        `sub=${userInfo.sub ? 'present' : 'missing'}, name=${userInfo.name ? 'present' : 'missing'}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Look up an existing Guest user by Google's stable subject ID
    let existingGuest;

    try {
      existingGuest = await env.DB_PRIMARY
        .prepare(
          `SELECT
            SLACK_USER_ID,
            FIRST_LAST,
            USER_ROLE,
            GOOGLE_SUB,
            GUEST_SESSION_EXPIRES
          FROM User
          WHERE GOOGLE_SUB = ?`
        )
        .bind(userInfo.sub)
        .first();

    } catch (error) {
      await logErrorToDB(
        env,
        'Failed to look up Google Guest user.',
        `error=${error.message}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Log and reject returning Guest users whose demo access has expired
    if (
      existingGuest &&
      existingGuest.GUEST_SESSION_EXPIRES &&
      new Date(existingGuest.GUEST_SESSION_EXPIRES) <= new Date()
    ) {
      await logErrorToDB(
        env,
        'Google Guest access expired.',
        `guest_user=${existingGuest.SLACK_USER_ID}, expires=${existingGuest.GUEST_SESSION_EXPIRES}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=guest_expired', request.url).toString(),
        302
      );
    }

    // Build stable internal IDs for a new Google Guest
    const googleSubHashBuffer = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(userInfo.sub)
    );

    const googleSubHash = Array.from(new Uint8Array(googleSubHashBuffer))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);

    const guestSlackUserId = `guest_slack_${googleSubHash}`;
    const guestSfUserId = `guest_sf_${googleSubHash}`;
    const guestUsername = `guest_user_${googleSubHash}`;
    const guestSessionExpires = new Date(
      Date.now() + 24 * 60 * 60 * 1000
    ).toISOString();

    // Use the existing Guest user when available, otherwise use the new Guest values
    const guestUser = existingGuest || {
      SLACK_USER_ID: guestSlackUserId,
      FIRST_LAST: userInfo.name,
      USER_ROLE: 'Guest',
      GOOGLE_SUB: userInfo.sub,
      GUEST_SESSION_EXPIRES: guestSessionExpires
    };

    // Create a new Guest user when this Google account has not logged in before
    if (!existingGuest) {
      try {
        await env.DB_PRIMARY
          .prepare(
            `INSERT INTO User (
              GOOGLE_SUB,
              FIRST_LAST,
              USER_ROLE,
              SLACK_USER_ID,
              SF_USER_ID,
              USERNAME,
              GUEST_SESSION_EXPIRES,
              LAST_UPDATED
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            userInfo.sub,
            userInfo.name,
            'Guest',
            guestSlackUserId,
            guestSfUserId,
            guestUsername,
            guestSessionExpires,
            new Date().toISOString()
          )
          .run();

      } catch (error) {
        await logErrorToDB(
          env,
          'Failed to create Google Guest user.',
          `error=${error.message}`,
          debugEnabled
        );

        return Response.redirect(
          new URL('/login?error=oops', request.url).toString(),
          302
        );
      }
    }

    // Create and save the Guest session token
    let sessionToken;

    try {
      sessionToken = generateSessionToken();

      await env.DB_PRIMARY
        .prepare(
          `UPDATE User
          SET SESSION_TOKEN = ?
          WHERE SLACK_USER_ID = ?`
        )
        .bind(
          sessionToken,
          guestUser.SLACK_USER_ID
        )
        .run();

    } catch (error) {
      await logErrorToDB(
        env,
        'Failed to create or save Google Guest session token.',
        `error=${error.message}, guest_user=${guestUser.SLACK_USER_ID}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Create the Guest JWT and authentication cookie
    let jwtCookieHeader;

    try {
      const jwtResult = await createJwtToken(
        env,
        settingsMap,
        guestUser.SLACK_USER_ID,
        guestUser.USER_ROLE,
        sessionToken
      );

      jwtCookieHeader = jwtResult.cookieHeader;

    } catch (error) {
      await logErrorToDB(
        env,
        'Failed to create Google Guest JWT.',
        `error=${error.message}, guest_user=${guestUser.SLACK_USER_ID}`,
        debugEnabled
      );

      return Response.redirect(
        new URL('/login?error=oops', request.url).toString(),
        302
      );
    }

    // Redirect the authenticated Guest to the dashboard with the JWT cookie
    const headers = new Headers();

    headers.append('Set-Cookie', jwtCookieHeader);
    headers.append('Set-Cookie', clearStateCookie);
    headers.set(
      'Location',
      settingsMap['dashboard_page_url']
    );

    return new Response(null, {
      status: 302,
      headers
    });
  }
};
