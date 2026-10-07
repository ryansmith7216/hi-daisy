// Helper function that logs an error message with a timestamp to the database
async function logErrorToDB(env, errorMessage, errorType = 'Error') {
  try {
    const timestamp = new Date().toISOString();
    await env.DB_PRIMARY.prepare(
      `INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
       VALUES (?, ?, ?, ?)`
    ).bind(timestamp, 'salesforce-callback', errorMessage, errorType).run();
  } catch (dbError) {
  }
}

// Helper function to render a styled message page (used for both success and error)
function renderMessagePage(message, brandUrl, title, mainNavImageUrl, stylesheet) {
  return (
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>' + title + '</title>' +
    '<link rel="icon" href="' + mainNavImageUrl + '" type="image/png">' +
    '<link rel="stylesheet" href="' + stylesheet + '">' +
    '</head>' +
    '<body class="callback-page-body">' +
    '<div class="callback-page-card">' +
    '<img src="' + brandUrl + '" alt="Brand Logo" class="callback-page-logo">' +
    '<h1 class="callback-page-title">' + title + '</h1>' +
    '<p class="callback-page-message">' + message + '</p>' +
    '</div>' +
    '</body>' +
    '</html>'
  );
}

// Helper function to Decrypt Salesforce tokens
async function decrypt(encryptedWithVersion, env) {
  try {
    const [encryptedBase64, version] = encryptedWithVersion.split('_v');
    if (!encryptedBase64 || !version) throw new Error("Invalid encrypted format");
    const secretName = "SALESFORCE_APIS_ENCRYPTION_SECRET_v" + version;
    const secret = env[secretName];
    if (!secret) throw new Error("Missing secret: " + secretName);
    const encryptedBytes = Uint8Array.from(atob(encryptedBase64), function(c) {
      return c.charCodeAt(0);
    });
    const salt = encryptedBytes.slice(0, 16);
    const iv = encryptedBytes.slice(16, 28);
    const data = encryptedBytes.slice(28);
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "PBKDF2" }, false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, data);
    return new TextDecoder().decode(decrypted);
  } catch (err) {
    await logErrorToDB(env, "Decryption error: " + err.message);
    throw err;
  }
}

// Helper function to Encrypt Salesforce tokens
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
      salt: salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    enc.encode(plainText)
  );
  const encryptedBytes = new Uint8Array([
    ...salt,
    ...iv,
    ...new Uint8Array(encrypted)
  ]);
  const encryptedBase64 = btoa(String.fromCharCode(...encryptedBytes));
  return encryptedBase64 + "_v" + versionTag;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { "Allow": "GET" }
      });
    }

    // List of all settings needed from the database
    const settingsToFetch = [
      "salesforce_developer_app_client_id",
      "salesforce_developer_app_client_secret",
      "salesforce_integration_user_id",
      "salesforce_api_token_url",
      "external_pages_image",
      "salesforce_oauth_redirect_uri",
      "salesforce_api_secret_version",
      "main_nav_image",
      "css_stylesheet_url"
    ];

// Fetch required settings from the database and map them into a key-value object
    const placeholders = settingsToFetch.map(() => "?").join(", ");
    const sql = `SELECT DB_SETTING_NAME, SETTING_VALUE FROM Settings WHERE DB_SETTING_NAME IN (${placeholders})`;
    let rows;
    try {
      rows = await env.DB_PRIMARY.prepare(sql).bind(...settingsToFetch).all();
    } catch (err) {
      await logErrorToDB(env, "Failed to fetch settings from DB: " + err.message);
      const brandUrl = "#"; // fallback if brand URL isn't available yet
      return new Response(
        renderMessagePage("Internal server error while loading settings.", brandUrl, "Error"),
        { status: 500, headers: { "Content-Type": "text/html" } }
      );
    }     
    const settingsMap = {};
    for (const row of rows.results) {
      settingsMap[row.DB_SETTING_NAME] = row.SETTING_VALUE;
    }    

    // Extract database values from settingsMap
    const clientId = settingsMap["salesforce_developer_app_client_id"];
    const encryptedSecret = settingsMap["salesforce_developer_app_client_secret"];
    const salesforceUserId = settingsMap["salesforce_integration_user_id"];
    const tokenUrl = settingsMap["salesforce_api_token_url"];
    const brandUrl = settingsMap["external_pages_image"] ?? "#";
    const redirectUri = settingsMap["salesforce_oauth_redirect_uri"];
    const salesforceSecretVersion = settingsMap["salesforce_api_secret_version"];
    const mainNavImageUrl = settingsMap["main_nav_image"];
    const stylesheet = settingsMap["css_stylesheet_url"];
    
    // Validate code is in the Url
    const code = url.searchParams.get("code");
    if (!code) {
      await logErrorToDB(env, "Missing authorization code in callback URL.");
      return new Response(
        renderMessagePage("Missing authorization code.", brandUrl, "Error", mainNavImageUrl, stylesheet),
        {
          status: 400,
          headers: { "Content-Type": "text/html" }
        }
      );
    }         

    // Validate required settings exist
    if (!clientId || !encryptedSecret || !tokenUrl) {
      return new Response("Missing one or more required Salesforce settings in DB.", { status: 500 });
    }

    // Decrypt client secret
    let clientSecret;
    try {
      clientSecret = await decrypt(encryptedSecret, env);
    } catch (err) {
      await logErrorToDB(env, "Decryption failed: " + err.message);
      return new Response(
        renderMessagePage("Failed to decrypt client secret.", brandUrl, "Error", mainNavImageUrl, stylesheet),
        { status: 500, headers: { "Content-Type": "text/html" } }
      );
    }         

    // Exchange code in Url for new access and refresh tokens
    let tokenResponse;
    let tokenData;
    try {
      tokenResponse = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri
        })
      });
      tokenData = await tokenResponse.json();
      const idUrl = tokenData.id;
      let authenticatedUserId = null;
      if (idUrl && typeof idUrl === "string") {
          const parts = idUrl.split("/");
          authenticatedUserId = parts[parts.length - 1];
      }

      // Verify the authenticated Salesforce user matches the expected integration user; deny access if mismatched
      if (authenticatedUserId !== salesforceUserId) {
        await logErrorToDB(env, "Salesforce user ID mismatch. Expected: " + salesforceUserId + ", Got: " + authenticatedUserId);
        return new Response(
            renderMessagePage("Unauthorized user attempted to authenticate.", brandUrl, "Error", mainNavImageUrl, stylesheet),
            {
                status: 403,
                headers: {
                    "Content-Type": "text/html"
                }
            }
        );
    }    
      
    // Handle errors during token exchange; log the issue and show a generic authorization failure message
    } catch (err) {
      await logErrorToDB(env, "Token exchange request failed: " + err.message);
      return new Response(
        renderMessagePage("Authorization failed. Please try again.", brandUrl, "Error", mainNavImageUrl, stylesheet),
        { status: 500, headers: { "Content-Type": "text/html" } }
      );
    }      
    
    // Check if token response was unsuccessful; log full response data and return a generic error page
    if (!tokenResponse.ok) {
      await logErrorToDB(env, "Salesforce token exchange failed: " + JSON.stringify(tokenData));
      return new Response(
        renderMessagePage("Authorization failed. Please try again.", brandUrl, "Error", mainNavImageUrl, stylesheet),
        {
          status: 500,
          headers: { "Content-Type": "text/html" }
        }
      );
    }      

    // Encrypt and store the new Salesforce access token along with a timestamp in the database
    if (tokenData.access_token) {
      const encryptedAccessToken = await encrypt(
        tokenData.access_token,
        env[salesforceSecretVersion],
        salesforceSecretVersion.split("_v")[1]
      );
      const accessTokenTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      try {
        await env.DB_PRIMARY.prepare(
          "UPDATE Settings SET SETTING_VALUE = ?, LAST_UPDATED = ? WHERE DB_SETTING_NAME = ?"
        ).bind(encryptedAccessToken, accessTokenTimestamp, "salesforce_access_token").run();
      } catch (err) {
        await logErrorToDB(env, "Failed to update salesforce_access_token in DB: " + err.message);
      }
    }
    
    // Encrypt the received Salesforce refresh token using the current secret version
    if (tokenData.refresh_token) {
      const encryptedRefreshToken = await encrypt(
        tokenData.refresh_token,
        env[salesforceSecretVersion],
        salesforceSecretVersion.split("_v")[1]
      );
      const refreshTokenTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      try {
        await env.DB_PRIMARY.prepare(
          "UPDATE Settings SET SETTING_VALUE = ?, LAST_UPDATED = ? WHERE DB_SETTING_NAME = ?"
        ).bind(encryptedRefreshToken, refreshTokenTimestamp, "salesforce_refresh_token").run();
      } catch (err) {
        await logErrorToDB(env, "Failed to update salesforce_refresh_token in DB: " + err.message);
      }
    }    

    // Render confirmation page
    return new Response(
      renderMessagePage("Salesforce authorization successful. You may now close this window.", brandUrl, "Connected", mainNavImageUrl, stylesheet),
      { headers: { "Content-Type": "text/html" } }
    );    
  }
};
