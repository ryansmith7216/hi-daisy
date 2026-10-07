export default {
  async fetch(request, env, ctx) {

    // ─── Block Prerender/Prefetch ─────────────────────────────────────────

    const secPurpose = request.headers.get('Sec-Purpose') || '';
    const purpose = request.headers.get('Purpose') || '';
    if (
      secPurpose.toLowerCase() === 'prefetch' ||
      secPurpose.toLowerCase() === 'prerender' ||
      purpose.toLowerCase() === 'prefetch' ||
      purpose.toLowerCase() === 'prerender'
    ) {
      return new Response('Blocked prefetch/prerender', { status: 403 });
    }

    // ─── Logging Helpers ─────────────────────────────────────────────────────

    // Logs an error message to the Error table with user info and dynamic path
    async function logErrorToDB(env, errorMessage, errorType = 'Error', loggedPath = '', userId = '', username = '') {
      try {
        const timestamp = new Date().toISOString();
        const workerName = `pages${loggedPath ? `/${loggedPath}` : ''}`;
        const fullMessage = `${errorMessage} | User ID: ${userId} | Username: ${username}`;
        await env.DB_PRIMARY.prepare(
          `INSERT INTO Error (ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_MESSAGE, ERROR_TYPE)
          VALUES (?, ?, ?, ?)`
        ).bind(timestamp, workerName, fullMessage, errorType).run();
      } catch {
        // Optional: silently fail or add internal logging
      }
    }

    // ─── Database Loaders ──────────────────────────────────────────────────
    
    // Loads a predefined set of global settings from the database and returns both a key-value map and raw result rows.
    async function loadGlobalSettings(env) {
      const settingKeys = [
        'user_cookie_name',
        'login_page_url',
        'css_stylesheet_url',
        'main_nav_image',
        'internal_api_key',
        'external_api_key_salesforce',
        'internal_api_save_url',
        'internal_api_save_url_fallback',
        'internal_api_messages_url',
        'internal_new_url',
        'salesforce_oauth_base_url',
        'salesforce_developer_app_client_id',
        'salesforce_oauth_redirect_uri',
        'salesforce_oauth_scope',
        'salesforce_integration_user_username',
        'salesforce_integration_user_password',
        'auto_responder_toggle',
        'auto_responder_type',
        'auto_responder_after_hours',
        'auto_responder_meeting',
        'auto_responder_custom_1',
        'auto_responder_custom_2',
        'auto_responder_custom_3',
        'slack_channel_id_support',
        'log_access_dashboard_page',
        'log_access_messages_page',
        'log_access_users_page',
        'log_access_auto_responder_page',
        'log_access_settings_page',
        'log_access_credentials_page',
        'log_access_help_page',
        'log_access_errors_page',
        'lock_user_failed_attempts',
        'allow_post_from_compose'    
      ];
      const result = await env.DB_PRIMARY.prepare(
        `SELECT DB_SETTING_NAME, SETTING_LABEL, SETTING_VALUE, SETTING_DESCRIPTION, LAST_UPDATED FROM Settings
        WHERE DB_SETTING_NAME IN (${settingKeys.map(() => '?').join(', ')})`
      ).bind(...settingKeys).all();
      const settingsMap = Object.fromEntries(
        result.results.map(row => [row.DB_SETTING_NAME, row.SETTING_VALUE])
      );
      return { settingsMap, rawResults: result.results };
    }

    // Retrieves all secret versions from the database, including their names, types, and deletion status.
    async function loadSecretVersions(env) {
      const result = await env.DB_PRIMARY.prepare(
        `SELECT SECRET_NAME, SECRET_TYPE, DELETED FROM SecretVersion`
      ).all();
      return result;
    }

    // Fetches all settings associated with a specific page, including metadata like input types, categories, and options.
    async function loadPageSettings(env, pageName) {
      const result = await env.DB_PRIMARY.prepare(
        `SELECT DB_SETTING_NAME, SETTING_LABEL, SETTING_VALUE, SETTING_DESCRIPTION, INPUT_TYPE, CATEGORY_NAME, PAGE_NAME, OPTIONS, OPTIONS_SOURCE, LAST_UPDATED
        FROM Settings
        WHERE PAGE_NAME = ?`
      ).bind(pageName).all();
      return result;
    }

    // Loads error logs from the database, optionally filtered by type, worker, and time range.
    async function loadErrorLogs(env, typeFilter = null, workerFilter = null, timeFilter = null) {
      let query = `
        SELECT ERROR_TIMESTAMP_UTC, ERROR_WORKER_NAME, ERROR_TYPE, ERROR_MESSAGE
        FROM Error
      `;
      const conditions = [];
      const bindings = [];
      if (typeFilter) {
        conditions.push("ERROR_TYPE = ?");
        bindings.push(typeFilter);
      }
      if (workerFilter) {
        conditions.push("ERROR_WORKER_NAME = ?");
        bindings.push(workerFilter);
      }
      if (timeFilter) {
        const now = new Date();
        let cutoff = new Date(now);
        switch (timeFilter) {
          case '5m': cutoff.setMinutes(now.getMinutes() - 5); break;
          case '30m': cutoff.setMinutes(now.getMinutes() - 30); break;
          case '1h': cutoff.setHours(now.getHours() - 1); break;
          case '3h': cutoff.setHours(now.getHours() - 3); break;
          case '1d': cutoff.setDate(now.getDate() - 1); break;
          case '3d': cutoff.setDate(now.getDate() - 3); break;
          case '7d': cutoff.setDate(now.getDate() - 7); break;
          case '14d': cutoff.setDate(now.getDate() - 14); break;
        }
        conditions.push("ERROR_TIMESTAMP_UTC >= ?");
        bindings.push(cutoff.toISOString());
      }      
      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY ERROR_TIMESTAMP_UTC DESC";
      const logsResult = await env.DB_PRIMARY.prepare(query).bind(...bindings).all();
      const typesResult = await env.DB_PRIMARY.prepare(`
        SELECT DISTINCT ERROR_TYPE FROM Error ORDER BY ERROR_TYPE
      `).all();
      const workersResult = await env.DB_PRIMARY.prepare(`
        SELECT DISTINCT ERROR_WORKER_NAME FROM Error ORDER BY ERROR_WORKER_NAME
      `).all();
      return {
        logs: logsResult.results,
        types: typesResult.results.map(r => r.ERROR_TYPE).filter(Boolean),
        workers: workersResult.results.map(r => r.ERROR_WORKER_NAME).filter(Boolean)
      };
    }   

    // Retrieves all help items from the database, ordered by main category and subcategory order.  
    async function loadHelpData(env) {
      const result = await env.DB_PRIMARY.prepare(`
        SELECT HELP_ITEM, HELP_MAIN_CATEGORY, HELP_SUB_CATEGORY, HELP_DESCRIPTION, HELP_SUB_CATEGORY_ORDER, LAST_UPDATED
        FROM Help
        ORDER BY HELP_MAIN_CATEGORY, HELP_SUB_CATEGORY_ORDER
      `).all();
      return result.results;
    }    

    // ─── Auth & Security Helpers ──────────────────────────────────────────

    // Parses the 'Cookie' header from the request and returns an object mapping cookie names to values.
    function parseCookies(request) {
      const cookieHeader = request.headers.get('Cookie') || '';
      return Object.fromEntries(
        cookieHeader.split(';').map(cookie => {
          const [name, ...rest] = cookie.trim().split('=');
          return [name, rest.join('=')];
        })
      );
    }
    
    // Verifies the JWT token by checking its signature and expiration.
    async function verifyToken(token, env) {
      const [payloadBase64, signatureBase64] = decodeURIComponent(token).split('.');
      if (!payloadBase64 || !signatureBase64) return null;
      const payload = JSON.parse(atob(payloadBase64));
      const version = payload.Version;
      const secret = env[`USER_JWT_ENCRYPTION_SECRET_${version}`];
      if (!secret) return null;
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const expectedSignatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadBase64));
      const expectedSignatureBase64 = btoa(String.fromCharCode(...new Uint8Array(expectedSignatureBuffer)));
      if (signatureBase64 !== expectedSignatureBase64) return null;
      if (payload.Expiration < Math.floor(Date.now() / 1000)) return null;
      return payload;
    }    

    // Constructs a redirect URL to the login page with an 'expired' error query parameter.
    function buildExpiredRedirect(loginPageUrl) {
      const redirectUrl = loginPageUrl.includes('?')
        ? `${loginPageUrl}&error=expired`
        : `${loginPageUrl}?error=expired`;
      return Response.redirect(redirectUrl, 302);
    }

    // Decrypts a value that includes a version suffix (e.g., "_v2") using AES-GCM.
    // Looks up the correct secret key based on the version and decrypts the payload.
    async function decryptWithVersion(encryptedWithVersion, env, secretPrefix = 'INTERNAL_APIS_ENCRYPTION_SECRET') {
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

    // Authenticates the user by verifying their JWT token from cookies.
    // Then checks if the user has permission to access the current section based on their role.
    // Returns user payload and role info if authorized, or a redirect/403 response if not.
    async function authenticateAndAuthorize(request, env, url, cookieName, loginPageUrl) {
      const cookies = parseCookies(request);
      const token = cookies[cookieName];
      if (!token) return { error: 'unauthorized', redirect: buildExpiredRedirect(loginPageUrl) };
      const payload = await verifyToken(token, env);
      if (!payload) return { error: 'unauthorized', redirect: buildExpiredRedirect(loginPageUrl) };
      
      const sessionTokenFromJwt = payload.SessionToken;
      const sessionTokenResult = await env.DB_PRIMARY.prepare(
        "SELECT SESSION_TOKEN, USER_ROLE, GUEST_SESSION_EXPIRES FROM User WHERE SLACK_USER_ID = ?"
      ).bind(payload.User_Id).first();
      
      if (!sessionTokenResult || sessionTokenResult.SESSION_TOKEN !== sessionTokenFromJwt) {
        const origin = new URL(request.url).origin;
        return { error: 'unauthorized', redirect: Response.redirect(origin + '/logout', 302) };
      }

    if (
      sessionTokenResult.USER_ROLE === 'Guest' &&
      sessionTokenResult.GUEST_SESSION_EXPIRES &&
      new Date(sessionTokenResult.GUEST_SESSION_EXPIRES) <= new Date()
    ) {
      const origin = new URL(request.url).origin;
      return {
        error: 'unauthorized',
        redirect: Response.redirect(origin + '/logout?error=guest_expired', 302)
      };
    }
      
      const userRole = payload.Role;
      const allowedSections = rolePermissions[userRole] ?? [];
      const currentSection = pathToSection[url.pathname];
      if (currentSection && !allowedSections.includes(currentSection)) {
        return { error: 'forbidden', response: new Response('Access Denied', { status: 403 }) };
      }
      return { payload, userRole, currentSection, allowedSections };
    }

    // ─── UI & Data Helpers ────────────────────────────────────────────────

    // Renders a navigation link if the user has access to the specified section
    function renderNavLink(section, label, currentSection, allowedSections, effectiveAllowedSections) {
      if (!effectiveAllowedSections.includes(section)) return '';
      const activeClass = currentSection === section ? ' class="active"' : '';
      return `<a href="/${section}"${activeClass}>${label}</a>`;
    }

    // Renders the left sidebar navigation with user info, links, logo, and logout
    function renderNavBar(mainNavImageUrl, navLinksHtml, userName, userUsername, userRole) {
      return `
      <nav>
        <div class="user-info">
          <div class="user-name">${userName}</div>
          <div class="user-role">${userRole}</div>
          ${userRole === 'Guest' ? '' : `<div class="user-username">${userUsername}</div>`}
        </div>

        <div class="nav-links">
          ${navLinksHtml}
        </div>

        <div class="nav-footer">
          <div class="nav-avatar">
            <img src="${mainNavImageUrl}" alt="hi.Daisy" class="logo" />
          </div>

          <div class="logout-button">
            <a href="/logout">LOGOUT</a>
          </div>
        </div>
      </nav>
      `;
    }

    // Loads dashboard data from the database and renders it into categorized sections.
    // Grants edit access based on the user's role.
    async function renderDashboardSection(env, userRole, helperOptionsString) {
      let dashboardData;

      if (userRole === 'Guest') {
        dashboardData = [
        {
          MESSAGE_TIMESTAMP: 'demo-001',
          CASE_NUMBER: '100245',
          SALESFORCE_ASSET: 'abc',
          REP_NAME: 'Alex Morgan',
          HELPER_NAME: 'Pending',
          STATUS: 'New',
          URL: 'https://slack.com/demo/message-001',
          BYPASS_SALESFORCE: 'FALSE',
          LOCKED_UNIX_TIMESTAMP: '',
          LAST_UPDATED: '2026-10-03T15:42:00.000Z'
        },
        {
          MESSAGE_TIMESTAMP: 'demo-002',
          CASE_NUMBER: '100246',
          SALESFORCE_ASSET: 'def',
          REP_NAME: 'Jordan Lee',
          HELPER_NAME: 'Taylor Reed',
          STATUS: 'In Progress',
          URL: 'https://slack.com/demo/message-002',
          BYPASS_SALESFORCE: 'FALSE',
          LOCKED_UNIX_TIMESTAMP: '',
          LAST_UPDATED: '2026-10-03T18:17:00.000Z'
        },
        {
          MESSAGE_TIMESTAMP: 'demo-003',
          CASE_NUMBER: '100247',
          SALESFORCE_ASSET: 'ghi',
          REP_NAME: 'Casey Parker',
          HELPER_NAME: 'Morgan Hayes',
          STATUS: 'Closed',
          URL: 'https://slack.com/demo/message-003',
          BYPASS_SALESFORCE: 'FALSE',
          LOCKED_UNIX_TIMESTAMP: '',
          LAST_UPDATED: '2026-10-03T20:51:00.000Z'
        }
      ];
      } else {
        const dashboardResult = await env.DB_PRIMARY.prepare(
          `SELECT MESSAGE_TIMESTAMP, CASE_NUMBER, SALESFORCE_ASSET, REP_NAME, HELPER_NAME, STATUS, URL, BYPASS_SALESFORCE, LOCKED_UNIX_TIMESTAMP, LAST_UPDATED FROM Dashboard`
        ).all();

        dashboardData = dashboardResult.results;
      }

      const canEdit = ['Developer', 'Manager', 'AdvancedSupport', 'Guest'].includes(userRole);
      return generateDashboardSections(dashboardData, canEdit, helperOptionsString, userRole);
    }   

    // Used for the user management interface, including role-based display and edit options.
    async function renderUsersSection(env, globalSettings, userRole, currentUserSlackId) {
      let usersResult;

      if (userRole === 'Guest') {
        usersResult = {
          results: [
            {
              SLACK_USER_ID: 'UDEMO001',
              SF_USER_ID: '005DEMO001',
              FIRST_LAST: 'Alex Morgan',
              USERNAME: 'alex.morgan@test.com',
              USER_ROLE: 'Developer',
              LAST_UPDATED: '2026-10-03T16:15:00.000Z',
              FAILED_LOGIN_ATTEMPTS: 0
            },
            {
              SLACK_USER_ID: 'UDEMO002',
              SF_USER_ID: '005DEMO002',
              FIRST_LAST: 'Jordan Lee',
              USERNAME: 'jordan.lee@test.com',
              USER_ROLE: 'Manager',
              LAST_UPDATED: '2026-10-03T18:40:00.000Z',
              FAILED_LOGIN_ATTEMPTS: 0
            },
            {
              SLACK_USER_ID: 'UDEMO003',
              SF_USER_ID: '005DEMO003',
              FIRST_LAST: 'Taylor Reed',
              USERNAME: 'taylor.reed@test.com',
              USER_ROLE: 'AdvancedSupport',
              LAST_UPDATED: '2026-10-03T20:05:00.000Z',
              FAILED_LOGIN_ATTEMPTS: 0
            },
            {
              SLACK_USER_ID: 'UDEMO004',
              SF_USER_ID: '005DEMO004',
              FIRST_LAST: 'Morgan Hayes',
              USERNAME: 'morgan.hayes@test.com',
              USER_ROLE: 'Support',
              LAST_UPDATED: '2026-10-03T21:20:00.000Z',
              FAILED_LOGIN_ATTEMPTS: 0
            }
          ]
        };
      } else {
        usersResult = await env.DB_PRIMARY.prepare(
          `SELECT SLACK_USER_ID, SF_USER_ID, FIRST_LAST, USERNAME, USER_ROLE, LAST_UPDATED, FAILED_LOGIN_ATTEMPTS, GUEST_SESSION_EXPIRES
          FROM User`
        ).all();
      }

      return generateUsersTable(usersResult, globalSettings, userRole);
    }

    // Fetches all user Ids for the Nuke User button on the credentials page
    async function loadSlackUserIdsForCredentials(env) {
      const result = await env.DB_PRIMARY.prepare(
        `SELECT SLACK_USER_ID FROM User`
      ).all();
      return result.results.map(u => u.SLACK_USER_ID).filter(Boolean);
    }
    
    
    // Extracts unique category names from settings and sorts them alphabetically.
    function extractAndSortCategories(settingsResults) {
      return [...new Set(settingsResults.map(s => s.CATEGORY_NAME ?? 'undefined'))]
        .sort((a, b) => (a === 'undefined' ? -1 : b === 'undefined' ? 1 : a.localeCompare(b)));
    }

    // Generates HTML for displaying settings grouped by category and page.
    // Handles special formatting for masked values and auto-responder cards.
    function generateSettingsTables(pageSettingsResult, categories, pageName, globalSettings) {
      function escapeAttr(str) {
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }
      return categories.map((category, categoryIndex) => {
        const categoryAnchor = category.replace(/\s+/g, '-').toLowerCase();
        const isLastCategory = categoryIndex === categories.length - 1;
        const rows = pageSettingsResult.results
          .filter(row => row.CATEGORY_NAME === category)
          .map((row, index) => {
            let displayValue = row.SETTING_VALUE;
            if ((row.INPUT_TYPE === 'masked') && typeof displayValue === 'string') {
              const versionMatch = displayValue.match(/_v[\w\d]+$/);
              const version = versionMatch ? versionMatch[0].replace('_', '') : '';
              displayValue = '********** ' + version;
            }

            // Renders an auto-responder setting card with label, value, and an edit link; highlights the selected option.
            if (pageName === 'auto-responder') {
              return `
                <div class="setting-card" data-db-name="${row.DB_SETTING_NAME}">
                  <div class="card-content">
                    <div class="card-type">
                      <strong>${row.SETTING_LABEL}</strong>
                      ${
                        row.DB_SETTING_NAME === globalSettings['auto_responder_type']
                          ? '<span class="selected-indicator">Selected</span>'
                          : '<a href="#" class="select-link">Use this</a>'
                      }
                    </div>
                    <div class="card-value">${displayValue}</div>
                  </div>
                    <div class="card-footer">
                      <a href="#" class="open-modal edit-link"
                        data-db-name="${escapeAttr(row.DB_SETTING_NAME)}"
                        data-type="${escapeAttr(row.SETTING_LABEL)}"
                        data-value="${escapeAttr(displayValue)}"
                        data-masked="${row.INPUT_TYPE === 'masked' ? 'TRUE' : 'FALSE'}"
                        data-input-type="${escapeAttr(row.INPUT_TYPE)}"
                        data-description="${escapeAttr(row.SETTING_DESCRIPTION ?? '')}"
                        data-page="${escapeAttr(row.PAGE_NAME)}"
                        data-category="${escapeAttr(row.CATEGORY_NAME)}"
                        data-options="${escapeAttr(row.OPTIONS ?? '')}"
                        data-options-source="${escapeAttr(row.OPTIONS_SOURCE ?? '')}"
                        data-last-updated="${escapeAttr(row.LAST_UPDATED ?? '')}"
                      >Edit</a>
                    </div>
                </div>
              `;

            // Renders a generic settings row with type, value, description, and an edit link for non-auto-responder settings.
            } else {
              return (
                '<div class="dashboard-row settings-row">' +
                  '<div><strong>Type:</strong> ' + (row.SETTING_LABEL ?? row.DB_SETTING_NAME) + '</div>' +
                  '<div><strong>Value:</strong> ' + displayValue + '</div>' +
                  '<div><strong>Description:</strong> ' + (row.SETTING_DESCRIPTION ?? '') + '</div>' +
                  '<div class="col-edit">' +
                    '<a href="#" class="open-modal edit-link"' +
                      ' data-db-name="' + row.DB_SETTING_NAME + '"' +
                      ' data-type="' + row.SETTING_LABEL + '"' +
                      ' data-value="' + displayValue + '"' +
                      ' data-masked="' + (row.INPUT_TYPE === 'masked' ? 'TRUE' : 'FALSE') + '"' +
                      ' data-input-type="' + row.INPUT_TYPE + '"' +
                      ' data-description="' + (row.SETTING_DESCRIPTION ?? '') + '"' +
                      ' data-page="' + row.PAGE_NAME + '"' +
                      ' data-category="' + row.CATEGORY_NAME + '"' +
                      ' data-options="' + (row.OPTIONS ?? '') + '"' +
                      ' data-options-source="' + (row.OPTIONS_SOURCE ?? '') + '"' +
                      ' data-last-updated="' + (row.LAST_UPDATED ?? '') + '"' +
                    '>Edit</a>' +
                  '</div>' +
                '</div>'
              );                                          
            }
          }).join('');

        // Wraps a group of setting rows in a category section with appropriate layout based on the page type.
        if (!rows.trim()) return '';
        if (pageName === 'auto-responder') {
          return `
            <h2 class="mt-2rem">${category}</h2>
            <div class="card-container" data-category="${category}">
              ${rows}
            </div>
          `;
        }
        return (
          '<h2 id="' + categoryAnchor + '" class="mt-2rem category-anchor">' + category + '</h2>' +
          '<div class="dashboard-container' + (isLastCategory ? ' last-category' : '') + '" data-category="' + category + '">' +
            rows +
          '</div>'
        );       
      }).join('');
    }

  // Loads page-specific settings and secret versions, injects any missing auto-responder settings,
  // and generates categorized HTML tables for rendering the settings UI.
    async function renderSettingsSection(env, pageName, globalSettings, globalSettingsResult) {
      const pageSettingsResult = await loadPageSettings(env, pageName);
      const secretVersionResult = await loadSecretVersions(env);
      injectAutoResponderSettings(pageName, pageSettingsResult, globalSettingsResult);
      const categories = extractAndSortCategories(pageSettingsResult.results);
      const settingsTables = generateSettingsTables(pageSettingsResult, categories, pageName, globalSettings);
      return { settingsTables, secretVersionResult, pageSettingsResult };
    }    

    // Ensures that auto-responder settings are present in the page settings result.
    // Injects missing settings from global settings if they are not already included.
    function injectAutoResponderSettings(pageName, pageSettingsResult, globalSettingsResult) {
      if (pageName !== 'auto-responder') return;
      const existingSettingNames = new Set(pageSettingsResult.results.map(row => row.DB_SETTING_NAME));
      const injectedSettings = [
        'auto_responder_after_hours',
        'auto_responder_meeting',
        'auto_responder_custom_1',
        'auto_responder_custom_2',
        'auto_responder_custom_3'
      ]
      .filter(name => !existingSettingNames.has(name))
      .map(name => {
        const globalRow = globalSettingsResult.find(row => row.DB_SETTING_NAME === name);
        return {
          DB_SETTING_NAME: name,
          SETTING_LABEL: globalRow?.SETTING_LABEL ?? '',
          SETTING_VALUE: globalRow?.SETTING_VALUE ?? '',
          SETTING_DESCRIPTION: globalRow?.SETTING_DESCRIPTION ?? '',
          INPUT_TYPE: 'text',
          CATEGORY_NAME: 'Response Options',
          PAGE_NAME: 'auto-responder',
          OPTIONS: '',
          OPTIONS_SOURCE: '',
          LAST_UPDATED: globalRow?.LAST_UPDATED ?? ''
        };
      });
      pageSettingsResult.results.push(...injectedSettings);
    }
    
    // Generates HTML cards for each user, sorted by role.
    // Includes styling and edit controls for managing user data.
    function generateUsersTable(usersResult, globalSettings, userRole) {
      const roleOrder = ['Developer', 'Manager', 'AdvancedSupport', 'Support', 'Guest', 'Inactive'];
        function getRoleClass(role) {
          switch (role) {
            case 'Developer': return 'role-developer';
            case 'Manager': return 'role-manager';
            case 'AdvancedSupport': return 'role-advanced-support';
            case 'Support': return 'role-support';
            case 'Guest': return 'role-guest';
            case 'Inactive': return 'role-inactive';
            default: return '';
          }
        }
        const rows = usersResult.results
          .sort((a, b) => roleOrder.indexOf(a.USER_ROLE) - roleOrder.indexOf(b.USER_ROLE))
          .map(user => {
            const isLocked = user.FAILED_LOGIN_ATTEMPTS >= parseInt(globalSettings['lock_user_failed_attempts'] || '999');
            const lockoutMessage = isLocked && userRole !== 'Guest'
              ? '<div class="lockout-message">User is locked from password login. <a href="#" class="reset-user-link" data-reset-type="LOGIN_ATTEMPTS">Reset failed attempts</a></div>'
              : '';
            const guestSessionExpired =
              user.USER_ROLE === 'Guest' &&
              user.GUEST_SESSION_EXPIRES &&
              new Date(user.GUEST_SESSION_EXPIRES) <= new Date();

            const guestSessionExpiration =
              user.USER_ROLE === 'Guest' &&
              user.GUEST_SESSION_EXPIRES
                ? `<div><strong>Guest Session Expires:</strong> <span class="guest-session-expires" data-utc="${user.GUEST_SESSION_EXPIRES}"></span></div>`
                : '';

            const guestSessionExpiredMessage = guestSessionExpired
              ? '<div class="lockout-message">Guest session expired. <a href="#" class="reset-user-link" data-reset-type="GUEST_SESSION">Reset guest access</a></div>'
              : '';    
                        return `
              <div class="setting-card" data-db-name="${user.SLACK_USER_ID}">
                <div class="card-content">
                  <div class="card-type">
                    <strong>${user.FIRST_LAST}</strong>
                    <span class="selected-indicator ${getRoleClass(user.USER_ROLE)}">${user.USER_ROLE}</span>
                  </div>
                  <div class="card-value">
                    <div><strong>Slack User Id:</strong> ${user.SLACK_USER_ID}</div>
                    <div><strong>Salesforce User Id:</strong> ${user.SF_USER_ID}</div>
                    <div><strong>Username:</strong> ${user.USERNAME}</div>
                    <div><strong>Last Updated:</strong> <span class="last-updated" data-utc="${user.LAST_UPDATED}"></span></div>
                    ${guestSessionExpiration}
                  </div>
                </div>
                <div class="card-footer">
                  ${lockoutMessage}
                  ${guestSessionExpiredMessage}
                  <a href="#" class="open-user-modal edit-link"
                    data-slack-id="${user.SLACK_USER_ID}"
                    data-sf-id="${user.SF_USER_ID}"
                    data-username="${user.USERNAME}"
                    data-name="${user.FIRST_LAST}"
                    data-role="${user.USER_ROLE}"
                    data-last-updated="${user.LAST_UPDATED}">
                    Edit
                  </a>
                </div>            
              </div>
            `;
          }).join('');                
      return `
        <div class="users-action-container">
          <input type="text" id="user-search-box" class="user-search-box" placeholder="Search users..." />
          ${userRole !== 'Guest' ? '<button id="add-user-button" class="masked-button add">Add New User</button>' : ''}
        </div> 
        <h2 class="mt-2rem">Users</h2>
        <div class="card-container" data-category="users">
          ${rows}
        </div>
        <div class="no-results" id="user-no-results" style="display: none;">No results found.</div>
      `;
    }

    // Organizes dashboard entries into sections based on status (e.g., New, In Progress, Closed).
    // Applies sorting and conditional rendering of edit controls based on user permissions.
    function generateDashboardSections(dashboardData, canEdit, helperOptionsString, userRole) {
      function renderSection(title, statuses) {
        const filtered = dashboardData
          .filter(row => statuses.includes(row.STATUS))
          .sort((a, b) => {
            if (a.STATUS === 'Relayed' && b.STATUS !== 'Relayed') return -1;
            if (a.STATUS !== 'Relayed' && b.STATUS === 'Relayed') return 1;
            return 0;
          });
        if (filtered.length === 0) {
          return `<h2 class="mt-2rem">${title}</h2><div class="dashboard-container"><div class="no-results">No results found.</div></div>`;
        }
        const rows = filtered.map(row => `
          <div class="dashboard-row status-${row.STATUS.toLowerCase().replace(/\s+/g, '-')}">
            <div><strong>Case:</strong> ${row.CASE_NUMBER}</div>
            <div><strong>Asset:</strong> ${row.SALESFORCE_ASSET}</div>
            <div><strong>Rep:</strong> ${row.REP_NAME}</div>
            <div><strong>Helper:</strong> ${row.HELPER_NAME}</div>
            <div><strong>Status:</strong> ${row.STATUS}</div>
            <div><strong>Slack URL:</strong> ${
              userRole === 'Guest'
                ? `<a href="#" onclick="alert('Slack links are disabled in Guest Mode.'); return false;">Open</a>`
                : `<a href="${row.URL}" target="_blank">Open</a>`
            }</div>
            <div class="col-bypass"><strong>Bypass SFDC:</strong> ${row.BYPASS_SALESFORCE}</div>
            <div class="col-locked"><strong>Locked Time:</strong> ${row.LOCKED_UNIX_TIMESTAMP}</div>
            <div><strong>Last Updated:</strong> <span class="last-updated" data-utc="${row.LAST_UPDATED}"></span></div>
            ${canEdit ? `
              <div class="col-edit">
                <a href="#" class="open-modal edit-link"
                  data-id="${row.MESSAGE_TIMESTAMP}"
                  data-case="${row.CASE_NUMBER}"
                  data-asset="${row.SALESFORCE_ASSET}"
                  data-rep="${row.REP_NAME}"
                  data-helper="${row.HELPER_NAME}"
                  data-status="${row.STATUS}"
                  data-url="${row.URL}"
                  data-bypass="${row.BYPASS_SALESFORCE}"
                  data-locked="${row.LOCKED_UNIX_TIMESTAMP}"
                  data-last-updated="${row.LAST_UPDATED}"
                  data-options="${helperOptionsString}">
                  Edit
                </a>
              </div>` : ''}
          </div>
        `).join('');
        return `<h2 class="mt-2rem">${title}</h2><div class="dashboard-container">${rows}</div>`;
      }
      return [
        renderSection('Unassigned', ['New', 'Relayed']),
        renderSection('In Progress', ['In Progress']),
        renderSection('Closed', ['Closed'])
      ].join('');
    }

    // Renders buttons for managing masked credentials and Salesforce integration
    function renderCredentialsButtons() {
      return `
        <button id="credentials-add-button" class="masked-button add" style="margin-right: 0.5rem;">Update Masked Value</button>
        <div id="add-masked-modal" class="dropdown-modal hidden"></div>
        <button id="credentials-rotate-button" class="masked-button rotate" style="margin-right: 0.5rem;">Rotate Secret</button>
        <div id="rotate-secret-modal" class="dropdown-modal hidden"></div>
        <button id="credentials-salesforce-button" class="masked-button salesforce" style="margin-right: 0.5rem;">Connect Salesforce</button>
        <div id="salesforce-connect-modal" class="dropdown-modal hidden"></div>
        <button id="credentials-nuke-button" class="masked-button nuke-button" style="margin-right: 0.5rem;">Nuke Users</button>
        <div id="users-nuke-modal" class="dropdown-modal hidden"></div>
      `;
    }
    
    // Renders the toggle switch UI for enabling or disabling the auto-responder feature
    function renderAutoResponderToggle(globalSettings, userRole) {
      const isChecked = globalSettings['auto_responder_toggle'] === 'TRUE' ? 'checked' : '';
      return `
        <div class="auto-responder-toggle-container">
          <span id="auto-responder-status" class="auto-responder-status"></span>
          <label class="switch"> <input type="checkbox" id="auto-responder-toggle" ${isChecked}>
            <span class="slider round"></span>
          </label>
        </div>
      `;
    }

    // Renders the dashboard refresh button and timestamp display
    function renderDashboardRefreshUI() {
      return `
        <div class="dashboard-action-container">
          <span id="dashboard-refresh-message">[Placeholder message]</span>
          <button id="dashboard-refresh-button" class="masked-button salesforce">Refresh</button>
        </div>
      `;
    }

    // Renders the Slack message search input for the /messages page
    function renderMessagesSection(userRole) {
      return (
        '<div class="messages-top-section">' +
          '<div class="messages-action-bar">' +
            '<form class="filter-form">' +
              '<div class="filter-field messages-filter-field">' +
                '<div style="display: flex; align-items: center; gap: 0.75rem;">' +
                  (userRole === 'Guest'
                    ? '<input type="text" id="slack-url-input" class="messages-search-input" value="https://slack.com/demo/message-001" />'
                    : '<input type="text" id="slack-url-input" class="messages-search-input" placeholder="Paste Slack message URL..." />') +
                      '<button type="button" id="slack-search-button" class="messages-search-button">Search</button>' +
                '</div>' +
              '</div>' +
            '</form>' +
          '</div>' +
        '</div>' +
        '<div id="svg-loader" style="display: none; text-align: center; margin-top: 1rem;">' +
        '<svg width="40" height="40" viewBox="0 0 122.8 122.8" xmlns="http://www.w3.org/2000/svg">' +
        '<g transform="rotate(0 61.4 61.4)">' +
        '<animateTransform attributeName="transform" type="rotate" from="0 61.4 61.4" to="360 61.4 61.4" dur="1s" repeatCount="indefinite" />' +
        '<path fill="#36C5F0" d="M30.3 76.8c0 6.2-5 11.2-11.2 11.2S7.9 83 7.9 76.8s5-11.2 11.2-11.2h11.2v11.2z"/>' +
        '<path fill="#36C5F0" d="M35.9 76.8c0-6.2 5-11.2 11.2-11.2s11.2 5 11.2 11.2v28.1c0 6.2-5 11.2-11.2 11.2s-11.2-5-11.2-11.2V76.8z"/>' +
        '<path fill="#2EB67D" d="M46.9 30.3c-6.2 0-11.2-5-11.2-11.2S40.7 7.9 46.9 7.9s11.2 5 11.2 11.2v11.2H46.9z"/>' +
        '<path fill="#2EB67D" d="M46.9 35.9c6.2 0 11.2 5 11.2 11.2s-5 11.2-11.2 11.2H18.8c-6.2 0-11.2-5-11.2-11.2s5-11.2 11.2-11.2h28.1z"/>' +
        '<path fill="#ECB22E" d="M92.5 46.9c0-6.2 5-11.2 11.2-11.2s11.2 5 11.2 11.2-5 11.2-11.2 11.2H92.5V46.9z"/>' +
        '<path fill="#ECB22E" d="M86.9 46.9c0 6.2-5 11.2-11.2 11.2s-11.2-5-11.2-11.2V18.8c0-6.2 5-11.2 11.2-11.2s11.2 5 11.2 11.2v28.1z"/>' +
        '<path fill="#E01E5A" d="M76 92.5c6.2 0 11.2 5 11.2 11.2s-5 11.2-11.2 11.2-11.2-5-11.2-11.2V92.5H76z"/>' +
        '<path fill="#E01E5A" d="M76 86.9c-6.2 0-11.2-5-11.2-11.2s5-11.2 11.2-11.2h28.1c6.2 0 11.2 5 11.2 11.2s-5 11.2-11.2 11.2H76z"/>' +
        '</g>' +
        '</svg>' +        
        '<div style="margin-top: 0.5rem;">Searching Slack...</div>' +
        '</div>' +
        '<div id="slack-message-wrapper">' +
          generateSlackMessageCard('', '', '', '', '', '', '', '') +          
        '</div>'
      );        
    }
    
    // Renders message retreived after searching by Url on messages tab
    function generateSlackMessageCard(rep, asset, customer, caseNum, issue, explanation, examples, help) {    
      return (
        '<div class="card-container" style="justify-content: center;">' +
        '<div class="slack-message-card">' +
        '<div class="card-content">' +
        '<div class="card-type">Message Details</div>' +
        '<div class="card-value">' +
        '<div><strong>Rep:</strong> ' + (rep || '') + '</div>' +
        '<div><strong>Asset:</strong> ' + (asset || '') + '</div>' +
        '<div><strong>Customer:</strong> ' + (customer || '') + '</div>' +
        '<div><strong>Case:</strong> ' + (caseNum || '') + '</div>' +
        '<div><strong>Summarize the issue:</strong><span>' + (issue ?? '') + '</span></div>' +
        '<div><strong>Explain how someone else can see or duplicate the issue:</strong><span>' + (explanation ?? '') + '</span></div>' +
        '<div><strong>Provide examples (links are preferred):</strong><span>' + (examples ?? '') + '</span></div>' +
        '<div><strong>How can we help you:</strong><span>' + (help ?? '') + '</span></div>' +        
        '</div>' +
        '</div>' +
        '<div class="card-footer" style="text-align: right;">' +
        '<a href="#" class="edit-link open-modal" style="pointer-events: none; opacity: 0.5;" ' +
        'data-issue="' + (issue ?? '') + '" ' +
        'data-explanation="' + (explanation ?? '') + '" ' +
        'data-examples="' + (examples ?? '') + '" ' +
        'data-help="' + (help ?? '') + '">' +
        'Edit</a>' +
        '</div>' +        
        '</div>' +
        '</div>'
      );
    }

    // Renders Compose page where a Slack post can be added from within the portal instead of Salesforce
    function renderComposeSection() {
      return `
        <div class="messages-top-section">
          <div class="card-container" style="justify-content: center;">
            <div class="slack-message-card">
              <div class="card-content">
                <div class="card-type">Post a Question in Slack</div>
                <button
                  type="button"
                  id="compose-popout-btn"
                  aria-label="Pop out"
                  title="Pop out"
                >
                  ↗
                </button>
                <div class="card-value compose-form">
                  <div class="compose-row-inline">
                    <div class="compose-label">
                      <strong>Case Number:</strong><span class="required-asterisk">*</span>
                    </div>
                    <input class="compose-input" type="text" id="compose-case-number"/>
                    <div class="field-error" id="error-compose-case-number"></div>
                  </div>
                  <div class="compose-row-inline">
                    <div class="compose-label">
                      <strong>Asset:</strong><span class="required-asterisk">*</span>
                    </div>
                    <input class="compose-input" type="text" id="compose-asset"/>
                    <div class="field-error" id="error-compose-asset"></div>
                  </div>
                  <div class="compose-note">
                  </div>
                  <div class="compose-row">
                    <div class="compose-label">
                      <strong>Customer:</strong><span class="required-asterisk">*</span>
                    </div>
                    <input class="compose-input" type="text" id="compose-customer"/>
                    <div class="field-error" id="error-compose-customer"></div>
                  </div>
                  <div class="compose-row">
                    <div class="compose-label">
                      <strong>Summarize the issue:</strong><span class="required-asterisk">*</span>
                    </div>
                    <textarea class="compose-textarea" id="compose-issue" rows="4"></textarea>
                    <div class="field-error" id="error-compose-issue"></div>
                  </div>
                  <div class="compose-row">
                    <div class="compose-label">
                      <strong>Explain how somone else can see or duplicate the issue:</strong><span class="required-asterisk">*</span>
                    </div>
                    <textarea class="compose-textarea" id="compose-duplicate" rows="4"></textarea>
                    <div class="field-error" id="error-compose-duplicate"></div>
                  </div>
                  <div class="compose-row">
                    <div class="compose-label">
                      <strong>Provide examples (links are preferred):</strong><span class="required-asterisk">*</span>
                    </div>
                    <textarea class="compose-textarea" id="compose-examples" rows="4"></textarea>
                    <div class="field-error" id="error-compose-examples"></div>
                  </div>
                  <div class="compose-row">
                    <div class="compose-label">
                      <strong>How can we help you?</strong><span class="required-asterisk">*</span>
                    </div>
                    <textarea class="compose-textarea" id="compose-help" rows="4"></textarea>
                    <div class="field-error" id="error-compose-help"></div>
                  </div>
                </div>
                <div style="display: flex; justify-content: flex-end; margin-top: 1.25rem;">
                  <button id="compose-submit-btn" class="modal-button save" disabled>Post My Question</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // Provides the HTML template for the modal used to edit settings and users.
    function renderModalTemplate(userRole) {
      return `
      <div id="modal" class="modal">
        <div class="modal-content">
          <h2 id="modal-title">Edit Setting</h2>
          <label for="modal-db-name" class="auto-hide">Database Name</label>
          <input type="text" id="modal-db-name" class="auto-hide" readonly />
          <input type="hidden" id="modal-db-name-hidden" />
          <label for="modal-type">Type <span class="required-asterisk">*</span></label>
          <input type="text" id="modal-type" required />
          <div class="modal-label">Value <span class="required-asterisk">*</span></div>
          <div id="modal-value-container"></div>
          <label for="modal-description">Description <span class="required-asterisk">*</span></label>
          <textarea id="modal-description" rows="4" required></textarea>
          <label for="modal-page" class="auto-hide">Page <span class="required-asterisk">*</span></label>
          <select id="modal-page" class="auto-hide" required>
            <option value="settings">settings</option>
            <option value="credentials">credentials</option>
          </select>
          <label for="modal-category" class="auto-hide">Category <span class="required-asterisk">*</span></label>
          <input type="text" id="modal-category" class="auto-hide" required />
          <label for="modal-last-updated">Last Updated</label>
          <input type="text" id="modal-last-updated" readonly />

          <!-- Additional fields for /users -->
          <label for="modal-name" class="auto-hide">Full Name <span class="required-asterisk">*</span></label>
          <input type="text" id="modal-name" class="auto-hide" />
          <label for="modal-username" class="auto-hide">Username <span class="required-asterisk">*</span></label>
          <input type="text" id="modal-username" class="auto-hide" />
          <label for="modal-slack-id" class="auto-hide">Slack ID <span class="required-asterisk">*</span></label>
          <input type="text" id="modal-slack-id" class="auto-hide" />
          <label for="modal-sf-id" class="auto-hide">SF ID <span class="required-asterisk">*</span></label>
          <input type="text" id="modal-sf-id" class="auto-hide" />
          <label for="modal-role" class="auto-hide">Role <span class="required-asterisk">*</span></label>
          <select id="modal-role" class="auto-hide">
            <option value="">-- Select Role --</option>
            <option value="Developer">Developer</option>
            <option value="Manager">Manager</option>
            <option value="AdvancedSupport">AdvancedSupport</option>
            <option value="Support">Support</option>
            <option value="Guest">Guest</option>
            <option value="Inactive">Inactive</option>
          </select>
    
          <!-- Additional fields for /dashboard -->
          <label for="modal-id" class="auto-hide">ID</label>
          <input type="text" id="modal-id" class="auto-hide" readonly />
          <label for="modal-case" class="auto-hide">Case</label>
          <input type="text" id="modal-case" class="auto-hide" />
          <label for="modal-asset" class="auto-hide">Asset</label>
          <input type="text" id="modal-asset" class="auto-hide" />
          <label for="modal-rep" class="auto-hide">Rep</label>
          <input type="text" id="modal-rep" class="auto-hide" />
          <label for="modal-helper" class="auto-hide">Helper</label>
          <input type="text" id="modal-helper" class="auto-hide" />
          <label for="modal-status" class="auto-hide">Status</label>
          <select id="modal-status" class="auto-hide">
            <option value="New">New</option>
            <option value="Relayed">Relayed</option>
            <option value="In Progress">In-Progress</option>
            <option value="Closed">Closed</option>
          </select>          
          <label for="modal-url" class="auto-hide">URL</label>
          <input type="text" id="modal-url" class="auto-hide" />
          <label for="modal-bypass" class="auto-hide">Bypass SFDC</label>
          <select id="modal-bypass" class="auto-hide">
            <option value="TRUE">TRUE</option>
            <option value="FALSE">FALSE</option>
          </select>          
          <label for="modal-locked" class="auto-hide">Locked Time</label>
          <input type="text" id="modal-locked" class="auto-hide" />
          <div id="modal-footer" style="margin-top: 1.5rem; display: flex; justify-content: space-between; align-items: center;">
          ${userRole === 'Guest'
            ? ''
            : `
              <div id="delete-button-container" style="visibility: hidden;">
                <button id="delete-modal" class="modal-button delete">Delete</button>
              </div>
            `}           
          <div>
            <button id="cancel-modal" class="modal-button cancel">Cancel</button>
            ${userRole === 'Guest' ? '' : '<button id="save-modal" class="modal-button save">Save</button>'}
          </div>
          </div>           
        </div>
      </div>
      `;
    }    

    // Loads error logs and generates HTML for filter dropdowns (type, worker, time) with current selections.

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
    
    async function renderErrorsSection(env, page = 1, pageSize = 25, typeFilter = null, workerFilter = null, timeFilter = null) {
      const { logs: allLogs, types: allTypes, workers: allWorkers } = await loadErrorLogs(env, typeFilter, workerFilter, timeFilter);
      const typeOptionsHtml = allTypes.map(type => 
        `<option value="${type}" ${type === typeFilter ? 'selected' : ''}>${type}</option>`
      ).join('');
      const workerOptionsHtml = allWorkers.map(worker => 
        `<option value="${worker}" ${worker === workerFilter ? 'selected' : ''}>${worker}</option>`
      ).join('');
      const timeOptions = [
        { value: '5m', label: 'Last 5 minutes' },
        { value: '30m', label: 'Last 30 minutes' },
        { value: '1h', label: 'Last 1 hour' },
        { value: '3h', label: 'Last 3 hours' },
        { value: '1d', label: 'Last 1 day' },
        { value: '3d', label: 'Last 3 days' },
        { value: '7d', label: 'Last 7 days' },
        { value: '14d', label: 'Last 14 days' },
      ];
      const timeOptionsHtml = timeOptions.map(opt =>
        `<option value="${opt.value}" ${opt.value === timeFilter ? 'selected' : ''}>${opt.label}</option>`
      ).join('');   
      
      // Calculates pagination and builds the HTML for the error log filter form with dropdowns for type, worker, and time range.
      const totalPages = Math.ceil(allLogs.length / pageSize);
      const start = (page - 1) * pageSize;
      const paginatedLogs = allLogs.slice(start, start + pageSize);    
      const filterFormHtml = `
      <div class="top-section-box filter-form-wrapper">
      <form method="GET" action="/errors" class="filter-form">
        <div class="filter-field">
          <label>
            Type:
            <select name="type">
              <option value="">-- All Types --</option>
              ${typeOptionsHtml}
            </select>
          </label>
        </div>
        <div class="filter-field">
          <label>
            Worker:
            <select name="worker">
              <option value="">-- All Workers --</option>
              ${workerOptionsHtml}
            </select>
          </label>
        </div>
        <div class="filter-field">
          <label>
            Time Range:
            <select name="time">
            <option value="">-- All Time --</option>
            ${timeOptionsHtml}
          </select>          
          </label>
        </div>
        <input type="hidden" name="page" value="1" />
        <div class="filter-buttons">
          <button type="submit">Apply Filters</button>
          <button type="button" onclick="window.location.href='/errors'">Clear</button>
        </div>
      </form>
    </div>   
    `; 
    
      // Builds table rows for paginated error logs with alternating background colors and expandable error messages.
      const rows = paginatedLogs.map((row, index) => {
        const bgColor = index % 2 === 0 ? '#f9f9f9' : 'white';
        return `
        <tr style="background-color: ${bgColor};">
        <td style="padding: 0.50rem; font-size: 0.85rem;">
          <span class="last-updated" data-utc="${row.ERROR_TIMESTAMP_UTC}"></span>
        </td>
        <td style="padding: 0.50rem; font-size: 0.85rem;">${row.ERROR_TYPE}</td>
        <td style="padding: 0.50rem; font-size: 0.85rem;">${row.ERROR_WORKER_NAME}</td>
        <td style="text-align: center;">
          <span class="expand-toggle" onclick="toggleMessage(this)">▶</span>
        </td>
        <td style="padding: 0.50rem; font-size: 0.85rem; word-break: break-word; white-space: normal;">
        <div class="error-message-collapsed">${escapeHtml(row.ERROR_MESSAGE)}</div>
        </td>
      </tr>
        `;
      }).join('');

      // Builds pagination controls for navigating error log pages, preserving current filter selections in URLs.
      let paginationControls = '';
      if (page > 1) {
        paginationControls += `<a href="/errors?page=${page - 1}&type=${typeFilter ?? ''}&worker=${workerFilter ?? ''}&time=${timeFilter ?? ''}">&laquo; Previous</a> `;
      }      
      const maxVisiblePages = 10;
      let startPage = Math.max(1, page - Math.floor(maxVisiblePages / 2));
      let endPage = startPage + maxVisiblePages - 1;
      
      if (endPage > totalPages) {
        endPage = totalPages;
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
      }
      
      for (let i = startPage; i <= endPage; i++) {
        const isActive = i === page ? 'style="font-weight: bold;"' : '';
        paginationControls += `<a href="/errors?page=${i}&type=${typeFilter ?? ''}&worker=${workerFilter ?? ''}&time=${timeFilter ?? ''}" ${isActive}>${i}</a> `;
      }
          
      if (page < totalPages) {
        paginationControls += ` <a href="/errors?page=${page + 1}&type=${typeFilter ?? ''}&worker=${workerFilter ?? ''}&time=${timeFilter ?? ''}">Next &raquo;</a>`;
      }

      // Returns the full HTML for the error logs section, including filter form, logs table, and pagination controls.
      const downloadButtonHtml = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h2 class="mt-2rem">Logs (${allLogs.length} rows)</h2>
        <button id="download-csv-button" class="download-csv-button">Export CSV</button>
      </div>    
    `;    
      return `
      ${filterFormHtml}
      ${downloadButtonHtml}      
        <table style="width: 100%; border-collapse: collapse; margin-top: 1rem;">
          <colgroup>
            <col style="width: 14%;">
            <col style="width: 10%;">
            <col style="width: 14%;">
            <col style="width: 2%;">
            <col style="width: 60%;">
          </colgroup>
          <thead>
          <tr style="background-color: #7299b3; color: white;">
            <th style="padding: 0.50rem; text-align: left;">Timestamp</th>
            <th style="padding: 0.50rem; text-align: left;">Type</th>
            <th style="padding: 0.50rem; text-align: left;">Worker</th>
            <th style="width: 0.50rem;"></th>
            <th style="padding: 0.50rem; text-align: left;">Message</th>
          </tr>
        </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
        <div style="margin-top: 1rem; text-align: center;">
          ${paginationControls}
        </div>
      `;
    }      
    
    // Escapes special characters in help content attributes to ensure safe HTML rendering.
    function renderHelpSection(helpData, userRole) {
      function escapeHelpAttr(str) {
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      // Groups help data rows by their main category, defaulting to 'Uncategorized' if none is provided.
      const grouped = helpData.reduce(function (acc, row) {
        const category = row.HELP_MAIN_CATEGORY || 'Uncategorized';
        if (!acc[category]) acc[category] = [];
        acc[category].push(row);
        return acc;
      }, {});
    
        // Constructs the HTML for the help section's action bar, including a search input and a button to add new help items.
        const helpActionHtml =
        "<div class=\"help-action-bar\">" +
          "<div class=\"help-search-wrapper\">" +
            "<input type=\"text\" id=\"help-search-box\" class=\"help-search-input\" placeholder=\"Search help...\" />" +
            "<ul id=\"help-search-suggestions\" class=\"help-search-suggestions\" style=\"display: none;\"></ul>" +
          "</div>" +
          (userRole === 'Guest'
            ? ''
            : "<button id=\"add-help-button\" class=\"help-add-button\">Add New Help Item</button>") +
        "</div>";     
    
        // Builds HTML sections for each category, assigning anchor IDs for internal navigation.
        const sectionsHtml = Object.entries(grouped).map(function ([category, items], categoryIndex, categoryEntries) {
        const anchorId = category.replace(/\s+/g, '-').toLowerCase();
        const isLastCategory = categoryIndex === categoryEntries.length - 1;

        // Builds HTML for each help subentry, including description and an edit link with metadata for modal editing.
        const cardContent = items.map(function (item) {
          var subcategory = item.HELP_SUB_CATEGORY ?? '';
          return (
            "<div class=\"help-subentry\">" +
            "<h4 class=\"help-subcategory\">" + subcategory + "</h4>" +
            "<p class=\"help-description\">" +
            item.HELP_DESCRIPTION +
            (['Developer', 'Manager', 'AdvancedSupport'].includes(userRole)
              ? " <a href=\"#\" class=\"open-modal edit-link\"" +
                " data-help-item=\"" + escapeHelpAttr(item.HELP_ITEM) + "\"" +
                " data-subcategory=\"" + escapeHelpAttr(subcategory) + "\"" +
                " data-description=\"" + escapeHelpAttr(item.HELP_DESCRIPTION) + "\"" +
                " data-category=\"" + escapeHelpAttr(item.HELP_MAIN_CATEGORY) + "\"" +
                " data-order=\"" + escapeHelpAttr(item.HELP_SUB_CATEGORY_ORDER) + "\"" +
                " data-last-updated=\"" + escapeHelpAttr(item.LAST_UPDATED) + "\">" +
                "Edit" +
                "</a>"
              : "") +
            "</p>" +
            "</div>"
          );                  
        }).join('');
      
        // Wraps each help category and its subentries in a styled container with an anchor for in-page navigation.
        return (
          "<div class=\"help-card" + (isLastCategory ? " last-category" : "") + "\">" +
            "<h3 id=\"" + anchorId + "\" class=\"help-category-heading category-anchor\">" + category + "</h3>" +
            cardContent +
          "</div>"
        );          
      }).join('');        
    
      // Returns the complete help layout HTML, including sidebar navigation and help content sections.
      return (
        "<div class=\"help-layout\">" +
          "<main class=\"help-main\">" +
            helpActionHtml +
            "<div class=\"help-content-wrapper\">" +
              "<div class=\"help-cards\">" +
                sectionsHtml +
              "</div>" +
            "</div>" +
          "</main>" +
        "</div>"
      );        
    }          
    
    // ─── Constants ────────────────────────────────────────────────────────

    // Defines page access permissions for each user role in the system.
    const rolePermissions = {
      Developer: ['dashboard', 'messages', 'compose', 'users', 'auto-responder', 'settings', 'credentials', 'errors', 'help'],
      Manager: ['dashboard', 'messages', 'compose', 'users', 'auto-responder', 'errors', 'help'],
      AdvancedSupport: ['dashboard', 'messages', 'compose', 'errors', 'help'],
      Support: ['dashboard', 'compose', 'help'],
      Guest: ['dashboard', 'messages', 'users', 'auto-responder', 'settings'],
      Inactive: [],
    };

    // Maps URL paths to their corresponding section identifiers for navigation or routing purposes.
    const pathToSection = {
      '/dashboard': 'dashboard',
      '/compose': 'compose',
      '/messages': 'messages',
      '/users': 'users',
      '/auto-responder': 'auto-responder',
      '/settings': 'settings',
      '/credentials': 'credentials',
      '/errors': 'errors',
      '/help': 'help'
    };    

    // ─── Request Validation ────────────────────────────────────────────────────

    // Blocks requests from *.workers.dev domains and normalizes the request path for consistent routing.
    const host = request.headers.get('host');
    if (host && host.endsWith('.workers.dev')) {
      return new Response('Forbidden', { status: 403 });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const normalizedPath = path.toLowerCase();
    
    // Defines a set of URL paths that should be blocked from access or processing.
    const blockedPaths = new Set(['/.git', '/.git/config', '/favicon.ico', '/']);
    if (
      blockedPaths.has(normalizedPath) ||
      normalizedPath.includes('/.git') ||
      normalizedPath === '/favicon.ico' ||
      normalizedPath === '/'
    ) {
      return new Response('Not Found', { status: 404 });
    } 
    
    // Rejects any non-GET requests with a 405 Method Not Allowed response and specifies allowed methods.
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          'Allow': 'GET',
          'Content-Type': 'text/plain',
        },
      });
    }  

  // Attempts to load global settings and page-specific configuration; handles any failures gracefully.
  try {

    // ─── Global & Page Settings ─────────────────────────────────────────────────

    // Loads global settings and extracts the current page name from the URL.
    const { settingsMap: globalSettings, rawResults: globalSettingsResult } = await loadGlobalSettings(env);    
    const pageName = url.pathname.replace(/^\//, '');
    let {
      settingsTables,
      secretVersionResult,
      pageSettingsResult

    // Extracts key global settings needed for authentication and UI rendering
    } = await renderSettingsSection(env, pageName, globalSettings, globalSettingsResult);
    let pageCategories = extractAndSortCategories(pageSettingsResult.results);

    if (pageName === 'settings') {
      const authPreview = await authenticateAndAuthorize(request, env, url, globalSettings['user_cookie_name'], globalSettings['login_page_url']);

      if (!authPreview.error && authPreview.userRole === 'Guest') {
        pageSettingsResult = {
          results: [
            {
              DB_SETTING_NAME: 'error_debug_logs',
              SETTING_LABEL: 'Error Debug Logs',
              SETTING_VALUE: 'FALSE',
              SETTING_DESCRIPTION: 'Turns on additional debugging logs for worker activity.',
              INPUT_TYPE: 'toggle',
              CATEGORY_NAME: 'Errors & Logs',
              PAGE_NAME: 'settings',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T15:10:00.000Z'
            },
            {
              DB_SETTING_NAME: 'errors_max_days_age',
              SETTING_LABEL: 'Errors Max Age',
              SETTING_VALUE: '14',
              SETTING_DESCRIPTION: 'Number of days error records are retained before cleanup.',
              INPUT_TYPE: 'number',
              CATEGORY_NAME: 'Errors & Logs',
              PAGE_NAME: 'settings',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T15:12:00.000Z'
            },

            {
              DB_SETTING_NAME: 'dashboard_page',
              SETTING_LABEL: 'Dashboard Page',
              SETTING_VALUE: 'https://demo.my.site.com/dashboard',
              SETTING_DESCRIPTION: 'URL for the dashboard page.',
              INPUT_TYPE: 'text',
              CATEGORY_NAME: 'General',
              PAGE_NAME: 'settings',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T15:20:00.000Z'
            },
            {
              DB_SETTING_NAME: 'slack_dashboard_max_hours_age',
              SETTING_LABEL: 'Dashboard Max Age',
              SETTING_VALUE: '168',
              SETTING_DESCRIPTION: 'Number of hours Slack posts remain available on the dashboard.',
              INPUT_TYPE: 'number',
              CATEGORY_NAME: 'General',
              PAGE_NAME: 'settings',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T15:22:00.000Z'
            },

            {
              DB_SETTING_NAME: 'allow_password_login',
              SETTING_LABEL: 'Allow Login with Password',
              SETTING_VALUE: 'Everyone',
              SETTING_DESCRIPTION: 'Determines which users may sign in with a password instead of SSO.',
              INPUT_TYPE: 'dropdown',
              CATEGORY_NAME: 'Login',
              PAGE_NAME: 'settings',
              OPTIONS: 'Everyone,Developer,Manager,None',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T15:30:00.000Z'
            },
            {
              DB_SETTING_NAME: 'allow_okta_login',
              SETTING_LABEL: 'Allow Login with Okta',
              SETTING_VALUE: 'TRUE',
              SETTING_DESCRIPTION: 'Determines whether the Okta login option appears.',
              INPUT_TYPE: 'toggle',
              CATEGORY_NAME: 'Login',
              PAGE_NAME: 'settings',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T15:32:00.000Z'
            },

            {
              DB_SETTING_NAME: 'queue_hours_start',
              SETTING_LABEL: 'Queue Hours Start',
              SETTING_VALUE: '15:00:00Z',
              SETTING_DESCRIPTION: 'Time when the Slack support queue opens in UTC.',
              INPUT_TYPE: 'text',
              CATEGORY_NAME: 'Queue Schedule',
              PAGE_NAME: 'settings',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T15:40:00.000Z'
            },
            {
              DB_SETTING_NAME: 'queue_hours_end',
              SETTING_LABEL: 'Queue Hours End',
              SETTING_VALUE: '23:00:00Z',
              SETTING_DESCRIPTION: 'Time when the Slack support queue closes in UTC.',
              INPUT_TYPE: 'text',
              CATEGORY_NAME: 'Queue Schedule',
              PAGE_NAME: 'settings',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T15:42:00.000Z'
            },

            {
              DB_SETTING_NAME: 'salesforce_oauth_base_url',
              SETTING_LABEL: 'Salesforce OAuth URL',
              SETTING_VALUE: 'https://demo.my.salesforce.com/services/oauth2/authorize?response_type=code',
              SETTING_DESCRIPTION: 'Base URL used when authenticating with Salesforce OAuth.',
              INPUT_TYPE: 'text',
              CATEGORY_NAME: 'Salesforce',
              PAGE_NAME: 'settings',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T15:50:00.000Z'
            },
            {
              DB_SETTING_NAME: 'downstream_salesforce_retries',
              SETTING_LABEL: 'Downstream Retries',
              SETTING_VALUE: '3',
              SETTING_DESCRIPTION: 'Number of additional retries for temporary Salesforce API failures.',
              INPUT_TYPE: 'number',
              CATEGORY_NAME: 'Salesforce',
              PAGE_NAME: 'settings',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T15:52:00.000Z'
            },

            {
              DB_SETTING_NAME: 'slack_button_expiration_hours',
              SETTING_LABEL: 'Slack Button Expiration',
              SETTING_VALUE: '12',
              SETTING_DESCRIPTION: 'Number of hours Slack post buttons remain active.',
              INPUT_TYPE: 'number',
              CATEGORY_NAME: 'Slack',
              PAGE_NAME: 'settings',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T16:00:00.000Z'
            },
            {
              DB_SETTING_NAME: 'slack_api_create_message_url',
              SETTING_LABEL: 'Slack Create Msg Endpoint',
              SETTING_VALUE: 'https://demo.my.slack.com/api/chat.postMessage',
              SETTING_DESCRIPTION: 'Slack API endpoint used to create channel messages.',
              INPUT_TYPE: 'text',
              CATEGORY_NAME: 'Slack',
              PAGE_NAME: 'settings',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T16:02:00.000Z'
            }
          ]
        };

        pageCategories = extractAndSortCategories(pageSettingsResult.results);

        settingsTables = generateSettingsTables(
          pageSettingsResult,
          pageCategories,
          pageName,
          globalSettings
        );
      }
    }

    const cookieName = globalSettings['user_cookie_name'];
    const loginPageUrl = globalSettings['login_page_url'];
    const mainNavImageUrl = globalSettings['main_nav_image'];

    // Returns a 500 error if critical global settings required for login flow are missing
    if (!cookieName || !loginPageUrl) {
      return new Response('Required settings not found in database.', { status: 500 });
    }

    // ─── Auth/Role Check ────────────────────────────────────────────────────────

    // Authenticates user and checks access permissions; returns redirect or 403 if unauthorized or forbidden
    const authResult = await authenticateAndAuthorize(request, env, url, cookieName, loginPageUrl);
    if (authResult.error === 'unauthorized') return authResult.redirect;
    if (authResult.error === 'forbidden') return authResult.response;

    // Retrieves user details from the database using Slack ID; falls back to token payload if not found
    const { payload, userRole, currentSection, allowedSections } = authResult;

    // Hides compose tab and rejects direct access when posting from Compose is disabled
    const allowPostFromCompose =
      (globalSettings['allow_post_from_compose'] || '').toUpperCase() === 'TRUE';

    const effectiveAllowedSections = allowPostFromCompose
      ? allowedSections
      : allowedSections.filter(s => s !== 'compose');

    if (currentSection === 'compose' && !allowPostFromCompose) {
      return new Response('Access Denied', { status: 403 });
    }

    const userResult = await env.DB_PRIMARY.prepare(
      `SELECT FIRST_LAST, USERNAME, PASSWORD, USER_ROLE, GUEST_SESSION_EXPIRES
      FROM User
      WHERE SLACK_USER_ID = ?`
    ).bind(payload.User_Id).first();
    const userName = userResult?.FIRST_LAST || payload.User_Id;
    const userUsername = userResult?.USERNAME || '';

    // Verifies user exists and role in DB is not Inactive before proceeding - If Inactive or doesn't exist then redirect to logout path
    if (!userResult || userResult.USER_ROLE === 'Inactive') {
      const origin = new URL(request.url).origin;
      return Response.redirect(origin + '/logout', 302);
    }
    

    // Logs when a user loads the settings or credentials pages
    const userAgent = request.headers.get('User-Agent') || '';
    const logKey = 'log_access_' + currentSection + '_page';
    if (globalSettings[logKey] === 'TRUE') {
      await logErrorToDB(
        env,
        userName + ' accessed ' + currentSection + ' page | User Agent: ' + userAgent,
        'Web',
        currentSection,
        payload.User_Id,
        userUsername
      );      
    }    

    // ─── Salesforce Decryption & OAuth URL ────────────────────────────────────────

    // Extracts Salesforce-related settings from global configuration for OAuth and integration
    const salesforceSettings = Object.fromEntries(
      globalSettingsResult.filter(row => [
          'salesforce_oauth_base_url',
          'salesforce_developer_app_client_id',
          'salesforce_oauth_redirect_uri',
          'salesforce_oauth_scope',
          'salesforce_integration_user_password'
        ].includes(row.DB_SETTING_NAME))
        .map(row => [row.DB_SETTING_NAME, row.SETTING_VALUE])
    );

    // Prepares Salesforce OAuth URL and retrieves encrypted password for later decryption
    let decryptedSalesforcePassword = '';
    let encryptedSalesforcePassword = globalSettings['salesforce_integration_user_password'];
    const oauthUrl = `${salesforceSettings.salesforce_oauth_base_url}&client_id=${salesforceSettings.salesforce_developer_app_client_id}&redirect_uri=${salesforceSettings.salesforce_oauth_redirect_uri}&scope=${salesforceSettings.salesforce_oauth_scope}`;
  
    // ─── Page-Specific Data Loading ─────────────────────────────────────────
    
    // Loads and renders the user management table if the current section is 'users'
    let usersTableHtml;
    if (currentSection === 'users') {
    usersTableHtml = await renderUsersSection(
      env,
      globalSettings,
      userRole,
      payload.User_Id
    );
    }    
    
    // Loads and renders the dashboard table if the current section is 'dashboard'.
    // Fetches users with specific roles so Helper dropdown can be dynamically populate
    let dashboardTableHtml;
    if (currentSection === 'dashboard') {
      let helperOptionsString;

      if (userRole === 'Guest') {
        helperOptionsString = 'Pending,Taylor Reed,Morgan Hayes,Jordan Lee';
      } else {
        const dashboardUserResult = await env.DB_PRIMARY.prepare(
          'SELECT FIRST_LAST FROM User WHERE USER_ROLE != ? AND USER_ROLE != ?'
        ).bind('Inactive', 'Support').all();

        const helperOptions = dashboardUserResult.results.map(row => ({
          label: row.FIRST_LAST,
          value: row.FIRST_LAST
        }));

        helperOptionsString = 'Pending,' + helperOptions.map(opt => opt.value).join(',');
      }

      dashboardTableHtml = await renderDashboardSection(env, userRole, helperOptionsString);
    }     
    
    // Decrypts the Salesforce integration password if the current section is 'credentials'
    if (currentSection === 'credentials' && encryptedSalesforcePassword) {
      decryptedSalesforcePassword = await decryptWithVersion(
        encryptedSalesforcePassword,
        env,
        'SALESFORCE_APIS_ENCRYPTION_SECRET'
      );
    }

    // Loads all user Ids if the current section is 'credentials'
    if (currentSection === 'credentials') {
      const allSlackUserIds = await loadSlackUserIdsForCredentials(env);
      globalSettings.allSlackUserIds = allSlackUserIds;
    }    

    // Loads and renders the error logs table with filters and pagination if the current section is 'errors'
    let errorsTableHtml;
    if (currentSection === 'errors') {
      const pageParam = parseInt(url.searchParams.get('page')) || 1;
      const typeFilter = url.searchParams.get('type') || null;
      const workerFilter = url.searchParams.get('worker') || null;
      const timeFilter = url.searchParams.get('time') ?? null;
      errorsTableHtml = await renderErrorsSection(env, pageParam, 25, typeFilter, workerFilter, timeFilter);
    }
          
    // ─── HTML Rendering ─────────────────────────────────────────────────────

    let helpData = [];

    if (currentSection === 'help') {
      helpData = await loadHelpData(env);
    }

    // Generate navigation links based on allowed sections
    const navLinksHtml = [
      ['dashboard', 'Dashboard'],
      ['compose', 'Compose'],
      ['messages', 'Messages'],
      ['users', 'Users'],
      ['auto-responder', 'Auto Responder'],
      ['settings', 'Settings'],
      ['credentials', 'Credentials'],
      ['help', 'Help'],
      ['errors', 'Errors']
    ].map(([section, label]) => {
      const mainLink = renderNavLink(
        section,
        label,
        currentSection,
        allowedSections,
        effectiveAllowedSections
      );

    if (!mainLink) {
      return '';
    }

    if (section === 'help' && currentSection === 'help') {
      const helpCategories = [
        ...new Set(
          helpData.map(row => row.HELP_MAIN_CATEGORY || 'Uncategorized')
        )
      ];

      const helpSubmenuHtml = helpCategories.map(category => {
        const anchor = category.replace(/\s+/g, '-').toLowerCase();

        return `
          <a href="#${anchor}" class="nav-sub-link">${category}</a>
        `;
      }).join('');

      return `
        ${mainLink}
        <div class="nav-submenu">
          ${helpSubmenuHtml}
        </div>
      `;
    }

    if (
      (section === 'settings' && currentSection === 'settings') ||
      (section === 'credentials' && currentSection === 'credentials')
    ) {
      const categorySubmenuHtml = pageCategories.map(category => {
        const anchor = category.replace(/\s+/g, '-').toLowerCase();

        return `
          <a href="#${anchor}" class="nav-sub-link">${category}</a>
        `;
      }).join('');

      return `
        ${mainLink}
        <div class="nav-submenu">
          ${categorySubmenuHtml}
        </div>
      `;
    }

    return mainLink;
    }).join('');  

    // Generate the main content block based on the current section
    let mainContentHtml = '';
    if (currentSection === 'dashboard') {
      mainContentHtml += '<div id="dashboard-tour-area">';
      mainContentHtml += renderDashboardRefreshUI();
      mainContentHtml += dashboardTableHtml;
      mainContentHtml += '</div>';
    } else if (currentSection === 'auto-responder') {
      if (userRole === 'Guest') {
        const demoAutoResponderSettings = {
          results: [
            {
              DB_SETTING_NAME: 'auto_responder_after_hours',
              SETTING_LABEL: 'After Hours',
              SETTING_VALUE: 'Thanks for reaching out. Our team is currently offline and will follow up during normal support hours.',
              SETTING_DESCRIPTION: 'Response used outside normal support hours.',
              INPUT_TYPE: 'text',
              CATEGORY_NAME: 'Response Options',
              PAGE_NAME: 'auto-responder',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T18:15:00.000Z'
            },
            {
              DB_SETTING_NAME: 'auto_responder_meeting',
              SETTING_LABEL: 'Team Meeting',
              SETTING_VALUE: 'Our support team is currently in a meeting. We will respond as soon as we are available.',
              SETTING_DESCRIPTION: 'Response used while the team is in a meeting.',
              INPUT_TYPE: 'text',
              CATEGORY_NAME: 'Response Options',
              PAGE_NAME: 'auto-responder',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T18:20:00.000Z'
            },
            {
              DB_SETTING_NAME: 'auto_responder_custom_1',
              SETTING_LABEL: 'Custom Response 1',
              SETTING_VALUE: 'Thanks for your message. A member of the team will review it shortly.',
              SETTING_DESCRIPTION: 'Custom auto responder message.',
              INPUT_TYPE: 'text',
              CATEGORY_NAME: 'Response Options',
              PAGE_NAME: 'auto-responder',
              OPTIONS: '',
              OPTIONS_SOURCE: '',
              LAST_UPDATED: '2026-10-03T18:25:00.000Z'
            }
          ]
        };

        const demoGlobalSettings = {
          ...globalSettings,
          auto_responder_toggle: 'TRUE',
          auto_responder_type: 'auto_responder_after_hours'
        };

        const demoCategories = extractAndSortCategories(demoAutoResponderSettings.results);

        mainContentHtml += renderAutoResponderToggle(demoGlobalSettings, userRole);
        mainContentHtml += generateSettingsTables(
          demoAutoResponderSettings,
          demoCategories,
          'auto-responder',
          demoGlobalSettings
        );
      } else {
        mainContentHtml += renderAutoResponderToggle(globalSettings, userRole);
        mainContentHtml += settingsTables;
      }
    } else if (currentSection === 'users') {
      mainContentHtml += usersTableHtml;
    } else if (currentSection === 'errors') {
      mainContentHtml += errorsTableHtml;
    } else if (currentSection === 'help') {
      const helpData = await loadHelpData(env);
      mainContentHtml += renderHelpSection(helpData, userRole);
    } else if (currentSection === 'compose') {
      mainContentHtml += renderComposeSection();
    } else if (currentSection === 'messages') {
      mainContentHtml += renderMessagesSection(userRole);   
    } else {
      mainContentHtml += settingsTables;
    }    

    // Render the modal used for editing settings, users, and credentials
    const modalHtml = renderModalTemplate(userRole);

    // Constructs the full HTML page by combining navigation, user info, section content, and modals
    const html = `<!DOCTYPE html>
    <html>
    <head>
    <meta charset="UTF-8">
    <title>hi.Daisy Demo</title>
    <link rel="icon" href="${mainNavImageUrl}" type="image/png">
    <link rel="stylesheet" href="${globalSettings['css_stylesheet_url']}">
    </head>  
    <body>
      ${renderNavBar(mainNavImageUrl, navLinksHtml, userName, userUsername, userRole)}           

      <! ==================== Main content container for settings, users, dashboard, etc. ==================== >
      <div class="container">
        <div class="card">
          ${userRole === 'Guest' ? `
              <div class="demo-mode-banner">
                You’re in Guest Mode. Sample data is shown, and changes are disabled.
                <span id="guest-session-countdown"></span>
              </div>
          ` : ''}

          ${currentSection === 'credentials' ? `
              <div id="credentials-button-container">
                ${renderCredentialsButtons()}
              </div>
          ` : ''}

          ${mainContentHtml}
        </div>
    </div>

    <! ==================== Modal used for editing settings, users, or credentials ==================== >
      ${modalHtml}

    <! ==================== Spotlight Tour ==================== >
      ${userRole === 'Guest' ? `
        <div id="spotlight-tour-overlay" class="spotlight-tour-overlay"></div>
        <div id="spotlight-tour-focus" class="spotlight-tour-focus"></div>

        <div id="spotlight-tour-message" class="spotlight-tour-message">
          <p id="spotlight-tour-text" class="spotlight-tour-text"></p>
          <button id="spotlight-tour-next" class="spotlight-tour-next">Got it</button>
        </div>

        <button id="spotlight-tour-end" class="spotlight-tour-end">End Tour</button>
      ` : ''}
     
    <! ==================== Script block for injecting global variables and helper functions ==================== >
    <script>
      window.secretVersionData = ${JSON.stringify(secretVersionResult.results)};
      window.salesforceOAuthUrl = ${JSON.stringify(oauthUrl)};
      window.userHashedPassword = ${JSON.stringify(userResult?.PASSWORD ?? '')};
      window.salesforceIntegrationUserUsername = ${JSON.stringify(globalSettings['salesforce_integration_user_username'])};
      window.maskedOptions = ${JSON.stringify(
        pageSettingsResult.results
          .filter(row => (row.INPUT_TYPE || '').toLowerCase().trim() === 'masked')
          .map(row => ({ label: row.SETTING_LABEL, name: row.DB_SETTING_NAME }))
      )};
      window.salesforceSettings = {decrypted_salesforce_password: ${JSON.stringify(decryptedSalesforcePassword)}};
      window.autoResponderSetting = ${JSON.stringify(globalSettings['auto_responder_toggle'] || '')};
      window.autoResponderType = ${JSON.stringify(globalSettings['auto_responder_type'] ?? '')};
      window.userRole = ${JSON.stringify(userRole)};
      window.guestSessionExpires = ${JSON.stringify(userResult?.GUEST_SESSION_EXPIRES ?? '')};
      window.userName = ${JSON.stringify(userName)};
      window.userUsername = ${JSON.stringify(userUsername)};
      window.userId = ${JSON.stringify(payload.User_Id)};
      window.spotlightTourCookieName = 'demo_spotlight_tour_' + window.userId;
      window.sessionToken = ${JSON.stringify(payload.SessionToken)};
      window.allSlackUserIds = ${JSON.stringify(globalSettings.allSlackUserIds)};
      window.internalApiSaveUrl = "${globalSettings['internal_api_save_url']}";
      window.internalApiSaveUrlFallback = "${globalSettings['internal_api_save_url_fallback']}";
      window.internalApiMessagesUrl = "${globalSettings['internal_api_messages_url']}";
      window.internalNewUrl = "${globalSettings['internal_new_url']}";
      window.slackChannelIdSupport = ${JSON.stringify(globalSettings['slack_channel_id_support'])};

    // Positions the Spotlight Tour focus and message around a target element.
    function showSpotlightTour(message, targetSelector, messagePosition = 'side', messageOffsetY = 0) {
      if (window.userRole !== 'Guest') return;

      const focus = document.getElementById('spotlight-tour-focus');
      const overlay = document.getElementById('spotlight-tour-overlay');
      const messageBox = document.getElementById('spotlight-tour-message');
      const messageText = document.getElementById('spotlight-tour-text');
      const endButton = document.getElementById('spotlight-tour-end');
      const target = document.querySelector(targetSelector);

      if (!focus || !overlay || !messageBox || !messageText || !endButton) {
        console.error('Spotlight Tour elements are missing from the page.');
        return;
      }

      if (!target) {
        console.error('Spotlight Tour target was not found:', targetSelector);
        return;
      }

    function positionSpotlightTour() {
      // Do not redraw a Spotlight Tour that has already been completed or ended.
      if (document.cookie.includes(window.spotlightTourCookieName + '=complete')) return;

      const targetRect = target.getBoundingClientRect();
      const padding = 8;
      const screenMargin = 20;
      const messageGap = 22;

      overlay.style.display = 'block';
      messageBox.style.display = 'block';
      endButton.style.display = 'block';

      messageText.textContent = message;

      if (messagePosition === 'center') {
        focus.style.display = 'none';

        overlay.style.background = 'rgba(15, 23, 42, 0.58)';

        messageBox.style.left = 'calc(50vw + 85px)';
        messageBox.style.top = '50vh';
        messageBox.style.transform = 'translate(-50%, -50%)';

        return;
      }

      overlay.style.background = 'transparent';
      messageBox.style.transform = '';

      focus.style.top = (targetRect.top - padding) + 'px';
      focus.style.left = (targetRect.left - padding) + 'px';
      focus.style.width = (targetRect.width + (padding * 2)) + 'px';
      focus.style.height = (targetRect.height + (padding * 2)) + 'px';
      focus.style.display = 'block';

    // Positions the message either beside or below the highlighted element.
    let messageLeft;
    let messageTop;

    if (messagePosition === 'bottom') {
      messageLeft = targetRect.left + 20;

      messageTop = targetRect.bottom + messageGap;
    } else {
      messageLeft = targetRect.right + messageGap;

      // If it would run off-screen, move it to the left of the target.
      if (messageLeft + messageBox.offsetWidth > window.innerWidth - screenMargin) {
        messageLeft = targetRect.left - messageBox.offsetWidth - messageGap;
      }

      messageTop =
        targetRect.top +
        (targetRect.height / 2) -
        (messageBox.offsetHeight / 2);
    }

    // Keep the message inside the viewport horizontally.
    messageLeft = Math.max(
      screenMargin,
      Math.min(
        messageLeft,
        window.innerWidth - messageBox.offsetWidth - screenMargin
      )
    );

      // Keep the message inside the viewport vertically.
      messageTop = Math.max(
        screenMargin,
        Math.min(
          messageTop,
          window.innerHeight - messageBox.offsetHeight - screenMargin
        )
      );

      messageBox.style.left = messageLeft + 'px';
      messageBox.style.top = (messageTop + messageOffsetY) + 'px';
      }

      // Positions the spotlight immediately and keeps it attached to the target on resize.
      positionSpotlightTour();
      window.addEventListener('resize', () => {
          focus.style.transition = 'none';
          positionSpotlightTour();

          requestAnimationFrame(() => {
            focus.style.transition = '';
          });
        });
      }
      
      // Defines modal field configurations for each page, including field types, labels, validation, and options
      const modalFieldConfig = {
        '/settings': [
          { id: 'db_name', label: 'Database Name', type: 'readonly' },
          { id: 'type', label: 'Type', type: 'text', required: true },
          { id: 'value', label: 'Value', type: 'text', required: true },
          { id: 'description', label: 'Description', type: 'textarea', required: true },
          {
            id: 'page',
            label: 'Page',
            type: window.userRole === 'Guest' ? 'text' : 'select',
            options: ['settings', 'credentials'],
            required: true
          },
          { id: 'category', label: 'Category', type: 'text', required: true },
          { id: 'last_updated', label: 'Last Updated', type: 'readonly' }
        ],
        '/credentials': [
          { id: 'db_name', label: 'Database Name', type: 'readonly' },
          { id: 'type', label: 'Type', type: 'text', required: true },
          { id: 'value', label: 'Value', type: 'text', required: true },
          { id: 'description', label: 'Description', type: 'textarea', required: true },
          { id: 'page', label: 'Page', type: 'select', options: ['settings', 'credentials'], required: true },
          { id: 'category', label: 'Category', type: 'text', required: true },
          { id: 'last_updated', label: 'Last Updated', type: 'readonly' }
        ],
        '/users': [
          { id: 'name', label: 'Full Name', type: 'text', required: true },
          { id: 'username', label: 'Username', type: 'text', required: true },
          { id: 'slack_id', label: 'Slack User Id', type: 'text', required: true },
          { id: 'sf_id', label: 'Salesforce User Id', type: 'text', required: true },
          { id: 'role', label: 'Role', type: 'select', options: ['Developer', 'Manager', 'AdvancedSupport', 'Support', 'Guest', 'Inactive'], required: true },
          { id: 'last_updated', label: 'Last Updated', type: 'readonly' }
        ],
        '/dashboard': [
          { id: 'id', label: 'ID', type: 'readonly' },
          { id: 'case', label: 'Case', type: 'text', required: true },
          { id: 'asset', label: 'Asset', type: 'text', required: true },
          { id: 'rep', label: 'Rep', type: 'text', required: true },
          { id: 'helper', label: 'Helper', type: 'select', required: true },
          {
            id: 'status',
            label: 'Status',
            type: 'select',
            options: ['New', 'Relayed', 'In Progress', 'Closed'],
            required: true,
            tooltip: 'Used in backend functions.'
          },
          { id: 'url', label: 'URL', type: 'text', required: true },
          {
            id: 'bypass',
            label: 'Bypass SFDC',
            type: 'select',
            options: ['TRUE', 'FALSE'],
            required: true,
            tooltip: 'Used in backend functions.'
          },
          {
            id: 'locked',
            label: 'Locked Time',
            type: 'number',
            tooltip: 'Used in backend functions.'
          },
          { id: 'last_updated', label: 'Last Updated', type: 'readonly' }
        ],
        '/auto-responder': [
          { id: 'db_name', label: 'Database Name', type: 'hidden' },
          { id: 'type', label: 'Type', type: 'text', required: true },
          { id: 'value', label: 'Response', type: 'textarea', required: true },
          { id: 'description', label: 'Internal Notes', type: 'text', required: true },
          { id: 'last_updated', label: 'Last Updated', type: 'readonly' }
        ],
        '/help': [
          { id: 'help_item', label: 'Help Item', type: 'hidden' },
          { id: 'category', label: 'Main Category', type: 'text', required: true },
          { id: 'subcategory', label: 'Title', type: 'text'},
          { id: 'description', label: 'Description', type: 'textarea', required: true },
          { id: 'order', label: 'Order', type: 'number'},
          { id: 'last_updated', label: 'Last Updated', type: 'readonly' }
        ],
        '/messages': [
          { id: 'issue', label: 'Summarize the issue', type: 'textarea', required: true },
          { id: 'explanation', label: 'Explain how someone else can see or duplicate the issue', type: 'textarea', required: true },
          { id: 'examples', label: 'Provide examples (links are preferred)', type: 'textarea', required: true },
          { id: 'help', label: 'How can we help you', type: 'textarea', required: true },
          { id: 'erase_preview', label: 'Remove preview images, videos, etc.', type: 'checkbox', required: false }
        ]                
      };


      // Sends a PATCH or POST request to the appropriate API endpoint to save settings or user data
      async function apiSaveRequest(params) {
        const endpointSuffix = params.endpointSuffix;
        const method = params.method ?? 'PATCH';
        const payload = params.payload;
        const settingName = payload?.db_setting_name ?? '';
        const useFallback = settingName === 'internal_api_save_url';
        let baseUrl = useFallback
          ? window.internalApiSaveUrlFallback ?? ''
          : window.internalApiSaveUrl ?? '';
        const fullUrl = baseUrl + endpointSuffix;
      
        const userAgent = navigator.userAgent;
        const userName = window.userName ?? 'Unknown';
        const userUsername = window.userUsername ?? 'Unknown';
        const userId = window.userId ?? 'Unknown';
        const userSessionToken = window.sessionToken ?? 'Unknown';
        const currentPage = window.location.pathname.replace('/', '');
      
        // Determine record identifier based on payload type
        let recordIdentifier = '';
        if (payload?.db_setting_name) {
          recordIdentifier = payload.db_setting_name;
        } else if (payload?.slack_user_id) {
          recordIdentifier = payload.slack_user_id;
        } else if (payload?.SLACK_USER_ID) {
          recordIdentifier = payload.SLACK_USER_ID;
        } else if (payload?.message_timestamp) {
          recordIdentifier = payload.message_timestamp;
        } else if (payload?.help_item) {
          recordIdentifier = payload.help_item;
        }        
      
        // Determine action type
        let action = 'updated';
        if (method === 'POST') {
          if (endpointSuffix === '/help') {
            action = 'added a new item';
          } else if (endpointSuffix === '/users/reset') {
            action = 'reset login attempts for';
          } else {
            action = 'added';
          }
        } else if (method === 'PATCH' && endpointSuffix.includes('/credentials/rotate')) {
          action = 'rotated';
        }        
      
        const logs = {
          ERROR_TYPE: "Web",
          ERROR_WORKER_NAME: "pages/" + currentPage,
          ERROR_MESSAGE: userName + " " + action + " " + recordIdentifier +
            " on " + currentPage + " page | User Agent: " + userAgent +
            " | User ID: " + userId + " | Username: " + userUsername
        };
      
        if (payload && !payload.logs) {
          payload.logs = logs;
        }
        
        const updatesAuthCheck = {
          SLACK_USER_ID: userId,
          SESSION_TOKEN: userSessionToken
        };
        
        if (payload && !payload.auth) {
          payload.auth = updatesAuthCheck;
        }          
      
        try {
          const response = await fetch(fullUrl, {
            method: method,
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });
          return response;
        } catch (error) {
          console.error('API request error:', error);
          alert('An unexpected error occurred.');
          throw error;
        }
      }      
                                
    </script>    
    
    <! ==================== Script block for modal behavior and event handling ==================== >
    <script>

      // Verifies a plaintext password against a stored salted hash using PBKDF2 and SHA-256
      async function verifyPassword(password, storedHash) {
        const encoder = new TextEncoder();
        const [salt, hash] = storedHash.split('$');
        const saltBytes = Uint8Array.from(atob(salt), c => c.charCodeAt(0));
        const keyMaterial = await crypto.subtle.importKey(
          'raw',
          encoder.encode(password),
          { name: 'PBKDF2' },
          false,
          ['deriveBits']
        );
        const derivedBits = await crypto.subtle.deriveBits(
          {
            name: 'PBKDF2',
            salt: saltBytes,
            iterations: 100000,
            hash: 'SHA-256'
          },
          keyMaterial,
          256
        );
        const hashBytes = new Uint8Array(derivedBits);
        return btoa(String.fromCharCode(...hashBytes)) === hash;
      }

      // Verifies the user's password before allowing masked values to be updated
      function handlePostPasswordAction(actionType, password) {
        const hashedPassword = window.userHashedPassword;
        if (!hashedPassword) {
          alert('No password found for this user.');
          return;
        }
        verifyPassword(password, hashedPassword).then(isValid => {
          if (!isValid) {
            alert('Incorrect password. Please try again.');
            return;
          }
        }).catch(err => {
          console.error('Error verifying password:', err);
          alert('An error occurred while verifying your password.');
        });
      }

      // Opens modal and fills form fields with data from the clicked button
      // Builds the appropriate input field (text, textarea, or select) based on input type and inserts it into the modal
      let activeButton = null;        
      document.querySelectorAll('.open-modal').forEach(button => {
        button.addEventListener('click', () => {
          activeButton = button;
          const data = {
            db_name: button.getAttribute('data-db-name') || '',
            type: button.getAttribute('data-type') || '',
            value: button.getAttribute('data-value') || '',
            description: button.getAttribute('data-description') || '',
            page: button.getAttribute('data-page') || '',
            category: button.getAttribute('data-category') || '',
            last_updated: button.getAttribute('data-last-updated') || '',
            id: button.getAttribute('data-id') || '',
            case: button.getAttribute('data-case') || '',
            asset: button.getAttribute('data-asset') || '',
            rep: button.getAttribute('data-rep') || '',
            helper: button.getAttribute('data-helper') || '',
            status: button.getAttribute('data-status') || '',
            url: button.getAttribute('data-url') || '',
            bypass: button.getAttribute('data-bypass') || '',
            locked: button.getAttribute('data-locked') || '',
            help_item: button.getAttribute('data-help-item') || '',
            subcategory: button.getAttribute('data-subcategory') ?? '',
            order: button.getAttribute('data-order') ?? '',
            issue: button.getAttribute('data-issue') ?? '',
            explanation: button.getAttribute('data-explanation') ?? '',
            examples: button.getAttribute('data-examples') ?? '',
            help: button.getAttribute('data-help') ?? '',
            erase_preview: false                             
          };
          injectModalFields(data);
          updateModalTitleByPath();
          document.getElementById('modal').style.display = 'flex';
      
          // Shows or hides the delete button in the modal based on the current page context
          var deleteContainer = document.getElementById('delete-button-container');
          if (deleteContainer) {
            if (window.location.pathname === '/dashboard' || window.location.pathname === '/help') {
              deleteContainer.style.visibility = 'visible';
            } else {
              deleteContainer.style.visibility = 'hidden';
            }            
          }
        });
      });                  

      // Closes the modal and ensures the value label is visible again if it was hidden
      function closeModal() {
        document.getElementById('modal').style.display = 'none';
        const modalValueLabel = document.querySelector('label[for="modal-value"]');
        if (modalValueLabel) {
            modalValueLabel.style.display = 'block';
        }        
      } 
         
      // Attaches modal cancel and delete button handlers; prompts user for confirmation before deletion
      document.getElementById('cancel-modal').addEventListener('click', closeModal);
      document.getElementById('delete-modal')?.addEventListener('click', async function () {
        var confirmDelete = confirm('Are you sure you want to delete this item?');

        // If user confirms deletion, begin constructing the payload for the delete request
        if (confirmDelete) {
          var payload;
      
        // Handles deletion for dashboard items by validating timestamp and building the payload
        if (window.location.pathname === '/dashboard') {
          var messageTimestamp = document.getElementById('modal-id')?.value ?? '';
          if (!messageTimestamp) {
            alert('Missing message timestamp.');
            return;
          }
          payload = {
            table: 'Dashboard',
            message_timestamp: messageTimestamp
          };

        // Handles deletion for help items by validating ID and building the payload
        } else if (window.location.pathname === '/help') {
          var helpItem = document.getElementById('modal-help_item')?.value ?? '';
          if (!helpItem) {
            alert('Missing Help Item ID.');
            return;
          }
          payload = {
            table: 'Help',
            help_item: helpItem
          };

          // Aborts deletion if the current page does not support delete operations
          } else {
            alert('Delete is not supported on this page.');
            return;
          }
      
          // Sends DELETE request to the appropriate endpoint based on page context and payload
          try {
            const endpoint = window.location.pathname === '/help'
              ? window.internalApiSaveUrl + '/help'
              : window.internalApiSaveUrl + '/dashboard';
              const userAgent = navigator.userAgent;
              const userName = window.userName ?? 'Unknown';
              const userUsername = window.userUsername ?? 'Unknown';
              const userSessionToken = window.sessionToken ?? 'Unknown';
              const userId = window.userId ?? 'Unknown';
              const currentPage = window.location.pathname.replace('/', '');  

              let recordIdentifier = '';
              if (payload?.message_timestamp) {
                recordIdentifier = payload.message_timestamp;
              } else if (payload?.help_item) {
                recordIdentifier = payload.help_item;
              }
              const logs = {
                ERROR_TYPE: "Web",
                ERROR_WORKER_NAME: "pages/" + currentPage,
                ERROR_MESSAGE: userName + " deleted " + recordIdentifier +
                  " on " + currentPage + " page | User Agent: " + userAgent +
                  " | User ID: " + userId + " | Username: " + userUsername
              };
              
              payload.logs = logs;
              
              if (!payload.auth) {
                payload.auth = {
                  SLACK_USER_ID: userId,
                  SESSION_TOKEN: userSessionToken
                };
              }              
              
            const response = await fetch(endpoint, {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(payload)
            });
      
            // Reloads page on successful deletion; otherwise shows error message from response or logs unexpected errors
            if (response.ok) {
              location.reload();
            } else {
              const errorText = await response.text();
              alert('Failed to delete item: ' + errorText);
            }
          } catch (error) {
            console.error('Delete request error:', error);
            alert('An error occurred while deleting.');
          }
        }
      });
              
      // Enables modal close behavior when clicking outside the modal content area
        const modal = document.getElementById('modal');
        const modalContent = document.querySelector('.modal-content');
        let mouseDownOnBackdrop = false;
        modal.addEventListener('mousedown', (e) => {
          mouseDownOnBackdrop = (e.target === modal);
        });
        modal.addEventListener('mouseup', (e) => {
          if (mouseDownOnBackdrop && e.target === modal) {
            closeModal();
          }
          mouseDownOnBackdrop = false;
        }); 

        // Handles creation of a new user by collecting form input and building the user object       
        document.getElementById('save-modal')?.addEventListener('click', async () => {          
        const isAddUser = document.getElementById('modal-title').textContent === 'Add New User';
        if (isAddUser) {
          const newUser = {
            SLACK_USER_ID: document.getElementById('modal-slack_id')?.value.trim(),
            SF_USER_ID: document.getElementById('modal-sf_id')?.value.trim(),
            FIRST_LAST: document.getElementById('modal-name')?.value.trim(),
            USERNAME: document.getElementById('modal-username')?.value.trim(),
            USER_ROLE: document.getElementById('modal-role')?.value
          };

          // Validates that all required fields for new user creation are filled before proceeding
          const missing = Object.entries(newUser).filter(([_, v]) => !v);
          if (missing.length > 0) {
            alert('Please fill in all required fields.');
            return;
          }

          // Sends POST request to create a new user; reloads on success or shows error on failure
          try {
            const response = await apiSaveRequest({
              endpointSuffix: '/users',
              method: 'POST',
              payload: newUser
            });    
            if (response.ok) {
              alert('User added successfully!');
              location.reload();
            } else {
              const errorText = await response.text();
              alert('Failed to add user: ' + errorText);
            }
          } catch (err) {
            console.error('Add user error:', err);
            alert('An error occurred while adding the user.');
          }
          closeModal();
          return;
        }

        // Checks if the modal is in 'Add New Help Item' mode and constructs a new help item object from form input values.
        const isAddHelp = document.getElementById('modal-title').textContent === 'Add New Help Item';
        if (isAddHelp) {
          var newHelpItem = {
            HELP_DESCRIPTION: document.getElementById('modal-description')?.value.trim(),
            HELP_MAIN_CATEGORY: document.getElementById('modal-category')?.value.trim(),
            HELP_SUB_CATEGORY: document.getElementById('modal-subcategory')?.value.trim(),
            HELP_SUB_CATEGORY_ORDER: document.getElementById('modal-order')?.value.trim()
          };
        
          // Extracts the IDs of all required fields from the modal configuration for the /help page.
          var helpRequiredFields = (modalFieldConfig['/help'] || [])
            .filter(function (field) {
              return field.required;
            })
            .map(function (field) {
              return field.id;
            });
        
          // Checks each required field to see if it's missing (i.e., the input is empty or not present in the DOM).
          var missing = helpRequiredFields.filter(function (key) {
            var el = document.getElementById('modal-' + key);
            return el && !el.value.trim();
          });
        
          // If any required fields are missing, alert the user and stop further processing.
          if (missing.length > 0) {
            alert('Please fill in all required fields.');
            return;
          }              
            
          // Sends a POST request to save the new help item; handles success, failure, and unexpected errors, then closes the modal.
          try {
            var response = await apiSaveRequest({
              endpointSuffix: '/help',
              method: 'POST',
              payload: newHelpItem
            });
            if (response.ok) {
              alert('Help item added successfully!');
              location.reload();
            } else {
              var errorText = await response.text();
              alert('Failed to add help item: ' + errorText);
            }
          } catch (err) {
            console.error('Add help item error:', err);
            alert('An error occurred while adding the help item.');
          }
          closeModal();
          return;
        }

        // Determines the current page context by checking the URL path and sets flags for conditional logic.
        const currentPath = window.location.pathname;
        const isUsersPage = currentPath === '/users';
        const isDashboardPage = currentPath === '/dashboard';
        const isAutoResponderPage = currentPath === '/auto-responder';
        
        // Determines if the selected setting is masked by checking the 'data-masked' attribute on the active button.
        let isMasked = false;
        if (activeButton) {
          isMasked = activeButton.getAttribute('data-masked') === 'TRUE';
        }      

        // Defines the list of required modal fields; includes 'value' only if the field is not masked.
        const requiredFields = ['modal-type', 'modal-description', 'modal-page', 'modal-category'];
        if (!isMasked) {
          requiredFields.push('modal-value');
        }

        // Filters out required fields that are visible but have no value entered by the user.
        const missingFields = requiredFields.filter(id => {
          const el = document.getElementById(id);
          return el && el.offsetParent !== null && !el.value.trim(); // skip hidden fields
        });

        // If any required fields are missing, alert the user and exit early to prevent saving incomplete data.
        if (missingFields.length > 0) {
          alert('Please fill in all required fields.');
          return;
        }
        
        // Determines if the current page is the auto-responder settings page based on the URL path. This may be redundant.
        const isAutoResponder = window.location.pathname === '/auto-responder';

        let payload;

        // Builds the payload object for updating a user record, collecting updated values from the modal form.
          if (isUsersPage) {
            const slackId = window.originalSlackId ?? '';         
            const updatedSlackId = document.getElementById('modal-slack_id')?.value ?? 'missing';
            const updatedSfId = document.getElementById('modal-sf_id')?.value ?? 'missing';
            const updatedName = document.getElementById('modal-name')?.value ?? 'missing';
            const updatedUsername = document.getElementById('modal-username')?.value ?? 'missing';
            const updatedRole = document.getElementById('modal-role')?.value ?? 'Inactive';
            payload = {
              table: 'User',
              slack_user_id: slackId,
              updates: {
                SLACK_USER_ID: updatedSlackId,
                SF_USER_ID: updatedSfId,
                FIRST_LAST: updatedName,
                USERNAME: updatedUsername,
                USER_ROLE: updatedRole
              }
            };

          // Builds the payload object for updating a dashboard record, pulling values from the modal form fields.
          } else if (isDashboardPage) {
            payload = {
              table: 'Dashboard',
              message_timestamp: document.getElementById('modal-id')?.value ?? '',
              updates: {
                CASE_NUMBER: document.getElementById('modal-case')?.value ?? '',
                SALESFORCE_ASSET: document.getElementById('modal-asset')?.value ?? '',
                REP_NAME: document.getElementById('modal-rep')?.value ?? '',
                HELPER_NAME: document.getElementById('modal-helper')?.value ?? '',
                STATUS: document.getElementById('modal-status')?.value ?? '',
                URL: document.getElementById('modal-url')?.value ?? '',
                BYPASS_SALESFORCE: document.getElementById('modal-bypass')?.value ?? '',
                LOCKED_UNIX_TIMESTAMP: document.getElementById('modal-locked')?.value ?? ''
              }
            };

          // Builds the payload object for updating a help item, using values from the modal form fields.
          } else if (window.location.pathname === '/help') {
            payload = {
              table: 'Help',
              help_item: document.getElementById('modal-help_item')?.value ?? '',
              updates: {
                HELP_SUB_CATEGORY: document.getElementById('modal-subcategory')?.value ?? '',
                HELP_DESCRIPTION: document.getElementById('modal-description')?.value ?? '',
                HELP_MAIN_CATEGORY: document.getElementById('modal-category')?.value ?? '',
                HELP_SUB_CATEGORY_ORDER: document.getElementById('modal-order')?.value ?? ''
              }
            };

          // On the /messages page, checks if any required visible fields are empty after removing whitespace and invisible characters.
          } else if (window.location.pathname === '/messages') {
            const requiredMessageFields = ['modal-issue', 'modal-explanation', 'modal-examples', 'modal-help'];
            const missing = requiredMessageFields.filter(id => {
              const el = document.getElementById(id);
              if (!el || el.offsetParent === null) return false;
              const cleaned = (el.value || '').replace(/\s+/g, '').replace(/\u200B/g, '');
              return cleaned.length === 0;
            });

            // If any required message fields are empty, alert the user and stop the submission process.
            if (missing.length > 0) {
              alert('Please fill in all required fields.');
              return;
            }
            
            // Escapes special characters before populating input fields on the edit messages modal
            function encodeText(str) {
              return '\\n' + str
                .replace(/\\n/g, '\\n')
                .replace(/\\t/g, '\\t');
            }            
            
            // Encodes and assigns updated message details from the modal form to the original Slack message object.
            window.originalSlackMessage.issue_summary = encodeText(document.getElementById('modal-issue')?.value ?? '');
            window.originalSlackMessage.duplication_steps = encodeText(document.getElementById('modal-explanation')?.value ?? '');
            window.originalSlackMessage.examples = encodeText(document.getElementById('modal-examples')?.value ?? '');
            window.originalSlackMessage.rep_question = encodeText(document.getElementById('modal-help')?.value ?? '');
            const erasePreviewCheckbox = document.getElementById('modal-erase_preview');
            window.originalSlackMessage.clear_attachments = (erasePreviewCheckbox && erasePreviewCheckbox.checked) ? true : false;
          
            // Sends a PATCH request to save the updated Slack message; handles success, error response, and unexpected failures.
            try {

              const userAgent = navigator.userAgent;
              const userName = window.userName ?? 'Unknown';
              const userUsername = window.userUsername ?? 'Unknown';
              const userId = window.userId ?? 'Unknown';
              const currentPage = window.location.pathname.replace('/', '');
              
              const logs = {
                ERROR_TYPE: "Web",
                ERROR_WORKER_NAME: "pages/" + currentPage,
                ERROR_MESSAGE: userName + " updated " + window.originalSlackMessage.message_ts +
                  " on " + currentPage + " page | User Agent: " + userAgent +
                  " | User ID: " + userId + " | Username: " + userUsername
              };
        
              window.originalSlackMessage.logs = logs;
              const now = new Date().toLocaleString('en-US', { timeZone: 'America/Phoenix' });
              const modifier = '\\nMessage modified by ' + window.userName + ' at ' + now + ' GMT-7';
              if (typeof window.originalSlackMessage.modified_by !== 'string') {
                window.originalSlackMessage.modified_by = '';
              }
              window.originalSlackMessage.modified_by += modifier;
              window.originalSlackMessage.auth = {
                SLACK_USER_ID: window.userId,
                SESSION_TOKEN: window.sessionToken
              };
              const response = await fetch(window.internalApiMessagesUrl, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(window.originalSlackMessage)
              });              
              if (response.ok) {
                alert('Message saved successfully!');
                location.reload();
              } else {
                const errorText = await response.text();
                alert(errorText);
              }
            } catch (err) {
              console.error('Message save error:', err);
              alert('An error occurred while saving the message.');
            }
            closeModal();
            return;

          // Builds the payload object for updating a settings record, using values from the modal form inputs.
          } else {
            payload = {
              table: 'Settings',
              db_setting_name: document.getElementById('modal-db-name-hidden').value,
              updates: {
                SETTING_LABEL: document.getElementById('modal-type').value,
                SETTING_DESCRIPTION: document.getElementById('modal-description').value
              }
            };

            // If the setting is not masked, retrieve the value from the modal and include it in the payload update.
            if (!isMasked) {
              const valueElement = document.getElementById('modal-value');
              payload.updates.SETTING_VALUE = valueElement ? valueElement.value : '';              
            }

            // If not on the auto-responder page, include page and category info in the settings update payload.
            if (!isAutoResponder) {
              payload.updates.PAGE_NAME = document.getElementById('modal-page').value;
              payload.updates.CATEGORY_NAME = document.getElementById('modal-category').value;
            }
          }   

          // Sets the API endpoint based on the current page, sends the PATCH request with the payload, and reloads the page on success.
          try {
            let endpointSuffix = '/settings';
            if (isUsersPage) {
              endpointSuffix = '/users';
            } else if (isDashboardPage) {
              endpointSuffix = '/dashboard';
            } else if (window.location.pathname === '/help') {
              endpointSuffix = '/help';
            }                                
            const response = await apiSaveRequest({
              endpointSuffix,
              method: 'PATCH',
              payload
            });                                 
            if (response.ok) {
              alert('Settings saved successfully!');
              location.reload();
            } else {
              let errorMessage = 'Failed to save settings.';
              try {
                const contentType = response.headers.get('Content-Type') || '';
                if (contentType.includes('application/json')) {
                  const errorData = await response.json();
                  errorMessage = errorData?.message || errorMessage;
                } else {
                  errorMessage = await response.text();
                }
              } catch (e) {
                console.warn('Failed to parse error response:', e);
              }
              alert(errorMessage);
            }     
          } catch (error) {
            console.error('Error:', error);
            alert('An error occurred while saving.');
          }
          closeModal();
        });

        // Opens the password confirmation modal and resets the input field; stores the callback to execute after confirmation.
        let pendingAction = null;
        function openPasswordModal(actionCallback) {
          pendingAction = actionCallback;
          const passwordInput = document.getElementById('confirm-password');
          if (!passwordInput) {
            console.error("Error: Password input field not found!");
            return;
          }
          passwordInput.value = ''; // This is where the error occurs if the element is null
          document.getElementById('password-modal').style.display = 'flex';
        }        
        
        // Closes the password confirmation modal and clears the pending action callback.
        function closePasswordModal() {
          document.getElementById('password-modal').style.display = 'none';
          pendingAction = null;
        }

        // Attaches a one-time click handler for saving masked values, validating required inputs before proceeding.
        let maskedSaveHandlerAttached = false;
        function attachMaskedSaveHandler() {
          if (maskedSaveHandlerAttached) return;
          maskedSaveHandlerAttached = true;
          document.addEventListener('click', (e) => {
            if (e.target && e.target.id === 'save-masked-value') {
              e.preventDefault();
              const dropdown = document.getElementById('masked-dropdown');
              const input = document.getElementById('masked-input');
              if (!dropdown.value || !input.value.trim()) {
                alert('Please fill in all required fields.');
                return;
              }

          // Prompts the user for their password, verifies it, and proceeds only if the password is correct.
          openPasswordModal((password) => {
            verifyPassword(password, window.userHashedPassword)
              .then(isValid => {
                if (!isValid) {
                  alert('Incorrect password. Please try again.');
                  return;
                }

         // Closes the password modal and sends a PATCH request to update the selected credential setting in the database
          closePasswordModal();
          apiSaveRequest({
            endpointSuffix: '/credentials',
            method: 'PATCH',
            payload: {
              table: 'Settings',
              db_setting_name: dropdown.value,
              updates: {
                SETTING_VALUE: input.value
              }
            },
          })  

          // Handles the response from the PATCH request: shows success alert and reloads page, or parses and displays error message
          .then(async response => {
            if (response.ok) {
              alert('Masked value updated successfully!');
              location.reload(); // <-- This forces the page to refresh
            } else {
              let errorMessage = 'Failed to update.';
              try {
                const contentType = response.headers.get('Content-Type') || '';
                if (contentType.includes('application/json')) {
                  const errorData = await response.json();
                  errorMessage = errorData?.message || errorMessage;
                } else {
                  errorMessage = await response.text();
                }
              } catch (e) {
                console.warn('Failed to parse error response:', e);
              }
              alert(errorMessage);
            }
          })

            // Catches and logs errors from the PATCH request itself
            .catch(error => {
              console.error('PATCH error:', error);
              alert('An error occurred while sending the PATCH.');
            });
          })

            // Catches and logs errors from the verification process
            .catch(err => {
              console.error('Verification error:', err);
              alert('An error occurred. Please try again.');
            });
          });
        }
      });
      }

      // Injects modal input fields based on the current page path and predefined configuration
      function injectModalFields(data = {}) {
        const path = window.location.pathname;
        const config = modalFieldConfig[path] || [];
        const modalContent = document.querySelector('.modal-content');
      
        // Removes all child elements from the modal content except those with preserved IDs
        const preserved = ['modal-title', 'modal-footer', 'modal-db-name-hidden'];
        Array.from(modalContent.children).forEach(child => {
          if (!preserved.includes(child.id)) {
            modalContent.removeChild(child);
          }
        });          
      
        // Skips processing the 'last_updated' field if it's not present in the data
        config.forEach(function(field) {
          if (field.id === 'last_updated' && !data.last_updated) {
            return;
          }    

          // Ensures dropdown options for Helper on dashboard edit modal shows Helper names
          if (field.id === 'helper' && activeButton && window.location.pathname === '/dashboard') {
            var options = (activeButton.getAttribute('data-options') || '')
              .split(',')
              .map(opt => opt.trim())
              .filter(opt => opt.length > 0);
            field.type = 'select';
            field.options = options;
          }  

        // Checks if the current field is 'value' and not on the auto-responder page, then extracts input type and options from the active button
        if (field.id === 'value' && activeButton && window.location.pathname !== '/auto-responder') {
          var inputType = activeButton.getAttribute('data-input-type');
          var options = (activeButton.getAttribute('data-options') || '').split(',').map(function(opt) {
            return opt.trim();
          }).filter(function(opt) {
            return opt.length > 0;
          });

          // Retrieves the source type from the active button and filters secretVersionData to match that source
          var source = activeButton.getAttribute('data-options-source');
          var secretOptions = (window.secretVersionData ?? [])
          .filter(function(s) {
            return s.SECRET_TYPE === source;
          })
          
          // Maps filtered secrets to their names, appending '(deleted)' to labels for entries marked as deleted
          .map(function(s) {
            var label = s.SECRET_NAME;
            if (s.DELETED === 'TRUE') {
              label += ' (deleted)';
            }
            return label;
          });    

          // If the input type is 'options', convert the field to a select dropdown and assign the available options
            if (inputType === 'options') {
              field.type = 'select';
              field.options = options;

            // If the input type is 'options_source', convert the field to a select dropdown and populate it with filtered secret options
            } else if (inputType === 'options_source') {
              field.type = 'select';
              field.options = secretOptions;
              
            // If the input type is 'textarea', set the field type accordingly
            } else if (inputType === 'textarea') {
              field.type = 'textarea';

            // Defaults the field type to 'text' if no specific type is matched
            } else {
              field.type = 'text';
            }
          }      

        // Creates a wrapper div element for the modal field and assigns the appropriate class
        var wrapper = document.createElement('div');
        wrapper.className = 'modal-field';

        if (field.id === 'erase_preview') {
          wrapper.classList.add('erase-preview-field');
        }

        // Creates and configures a label element for non-hidden modal fields
        if (field.type !== 'hidden') {
          var label = document.createElement('label');
          label.setAttribute('for', 'modal-' + field.id);
          var labelHtml = field.label;

          // Appends a required asterisk to the label HTML if the field is marked as required
          if (field.required) {
            labelHtml += ' <span class="required-asterisk">*</span>';
          }

          // Adds a tooltip icon to the label if a tooltip is defined for the field
          if (field.tooltip) {
            labelHtml += ' <span class="tooltip-icon" title="' + field.tooltip + '">&#9888;</span>';
          }

          label.innerHTML = labelHtml;
          wrapper.appendChild(label);                      
        }

          var input;

          if (field.type === 'checkbox') {
            input = document.createElement('input');
            input.type = 'checkbox';
            const val = data[field.id];
            input.checked = val === true || val === 'true' || val === 'TRUE';
          }

          // Creates a textarea input element if the field type is 'textarea' and sets default row count 
          if (field.type === 'textarea') {
            input = document.createElement('textarea');
            input.rows = 4;

          // Creates a select input element and populates it with options, disabling any marked as deleted
          } else if (field.type === 'select') {
            input = document.createElement('select');
            (field.options || []).forEach(function(opt) {
              var option = document.createElement('option');
              var isDeleted = opt.endsWith(' (deleted)');
              option.value = opt;
              option.textContent = opt;
              if (isDeleted) {
                option.disabled = true;
              }
              input.appendChild(option);
            });
            
          // Only for the 'role' field on the '/users' page, remove 'Developer' option if user is not a Developer
          if (field.id === 'role' && window.userRole !== 'Developer') {
            const developerOption = Array.from(input.options).find(opt => opt.value === 'Developer');
            if (developerOption) {
              input.removeChild(developerOption);
            }
          }

           // Creates a standard input element, handling special cases for 'readonly' and 'locked' number fields
          } else {
            input = document.createElement('input');
            input.type = field.type === 'readonly' ? 'text' : field.type;
            if (field.type === 'readonly') {
              input.readOnly = true;
            }
            if (field.id === 'locked' && field.type === 'number') {
              input.min = '0';
              input.step = '1';
            }
          } 

          // Makes the 'value' input read-only if the active button indicates the value is masked, and hides the required asterisk
          if (field.id === 'value' && activeButton && activeButton.getAttribute('data-masked') === 'TRUE') {
            input.setAttribute('readonly', 'readonly');
            input.removeAttribute('required');
            var labelEl = wrapper.querySelector('label');
            if (labelEl) {
              var asterisk = labelEl.querySelector('.required-asterisk');
              if (asterisk) {
                asterisk.style.display = 'none';
              }
            }
          }

          // Sets the input ID and updates the hidden 'db_name' field if present, using data from the modal
          input.id = 'modal-' + field.id;
          if (field.id === 'db_name') {
            const hiddenDbName = document.getElementById('modal-db-name-hidden');
            if (hiddenDbName) {
              hiddenDbName.value = data.db_name || '';
            }
          }

          // Preprocesses and sets the input value for specific message fields by cleaning and formatting the retrieved data
          if (window.location.pathname === '/messages' && ['issue', 'explanation', 'examples', 'help'].includes(field.id)) {
            let value = data[field.id] ?? '';
            value = value
              .replace(/&/g, '&')
              .replace(/\\t/g, ' ')
              .replace(/\\n/g, '\\n')
              .replace(/^\\n/, '');
            input.value = value;

          // Sets the input value using the corresponding data field, or defaults to an empty string if undefined
          } else {
            input.value = data[field.id] ?? '';
          }          

          // Appends the input to the wrapper and inserts it into the modal before the footer if present, otherwise appends it at the end
          wrapper.appendChild(input);
          var footer = document.getElementById('modal-footer');
          if (footer && modalContent.contains(footer)) {
            modalContent.insertBefore(wrapper, footer);
          } else {
            modalContent.appendChild(wrapper);
          }
        });        
      }      

        // Updates the modal title based on the current page path to reflect the appropriate edit context
        function updateModalTitleByPath() {
          const modalTitle = document.getElementById('modal-title');
          const path = window.location.pathname;
          if (!modalTitle) return;
          switch (path) {
            case '/credentials':
              modalTitle.textContent = 'Edit Credential';
              break;
            case '/settings':
              modalTitle.textContent = 'Edit Setting';
              break;
            case '/auto-responder':
              modalTitle.textContent = 'Edit Response';
              break;
            case '/users':
              modalTitle.textContent = 'Edit User';
              break;
            case '/dashboard':
              modalTitle.textContent = 'Edit Dashboard Item';
              break;
            case '/help':
              modalTitle.textContent = 'Edit Help Item';
              break;
            case '/messages':
              modalTitle.textContent = 'Edit Message';
              break;                          
            default:
              modalTitle.textContent = 'Edit';
          }
        }  

        // ========== DOMContentLoaded event which handles page specific logic ==========
        document.addEventListener('DOMContentLoaded', () => {

        // ========== Session expiry countdown for Guests ==========
        if (window.userRole === 'Guest' && window.guestSessionExpires) {
          const countdownEl = document.getElementById('guest-session-countdown');

          function updateGuestSessionCountdown() {
            if (!countdownEl) return;

            const expiresAt = new Date(window.guestSessionExpires).getTime();
            const remainingMs = expiresAt - Date.now();

            if (remainingMs <= 0) {
              countdownEl.textContent = ' Guest access has expired.';
              return;
            }

            const totalSeconds = Math.floor(remainingMs / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;

            countdownEl.textContent =
              ' Guest access expires in ' +
              hours + 'h ' +
              minutes + 'm ' +
              seconds + 's.';
          }

          updateGuestSessionCountdown();
          setInterval(updateGuestSessionCountdown, 1000);
        }
        
        // ========================= Spotlight Tours =========================

        // Ends the Spotlight Tour from any page and restores normal page interaction.
        const spotlightEndButton = document.getElementById('spotlight-tour-end');

        if (spotlightEndButton) {
          spotlightEndButton.addEventListener('click', () => {
            document.cookie =
              window.spotlightTourCookieName + '=complete; path=/; max-age=31536000; SameSite=Lax';

            const overlay = document.getElementById('spotlight-tour-overlay');
            const focus = document.getElementById('spotlight-tour-focus');
            const messageBox = document.getElementById('spotlight-tour-message');

            if (overlay) overlay.style.display = 'none';
            if (focus) focus.style.display = 'none';
            if (messageBox) messageBox.style.display = 'none';

            spotlightEndButton.style.display = 'none';

            // Restores any control that may have been raised above the tour blocker.
            const searchButton = document.getElementById('slack-search-button');
            const toggleSwitch = document.querySelector('.switch');

            if (searchButton) {
              searchButton.style.position = '';
              searchButton.style.zIndex = '';
            }

            if (toggleSwitch) {
              toggleSwitch.style.position = '';
              toggleSwitch.style.zIndex = '';
            }
          });
        }

        // Dashboard Spotlight Tour
        if (
          window.userRole === 'Guest' &&
          window.location.pathname === '/dashboard' &&
          !document.cookie.includes(window.spotlightTourCookieName + '=complete')
        ) {
          let dashboardSpotlightStep = 0;

          showSpotlightTour(
            'Welcome! This short tour will show you how the demo works and where the main tools are.',
            '.nav-links a.active',
            'center'
          );

          const dashboardTourNextButton = document.getElementById('spotlight-tour-next');

          if (dashboardTourNextButton) {
            dashboardTourNextButton.textContent = 'Start Tour';
          }

            document.getElementById('spotlight-tour-next')?.addEventListener('click', () => {
              if (dashboardSpotlightStep === 0) {
                dashboardSpotlightStep = 1;

                const nextButton = document.getElementById('spotlight-tour-next');

                showSpotlightTour(
                  'The Dashboard shows Slack support requests in one place so the team can see what’s new, what’s being worked, and what’s finished.',
                  '.nav-links a.active'
                );

                if (nextButton) {
                  nextButton.textContent = 'Got it';
                }

                return;
              }

              if (dashboardSpotlightStep === 1) {
              dashboardSpotlightStep = 2;

              showSpotlightTour(
                'Each row is a support request from Slack and shows who’s working it, the status, and related case information.',
                '.dashboard-row.status-new',
                'bottom'
              );

              return;
            }

            if (dashboardSpotlightStep === 2) {
              dashboardSpotlightStep = 3;

              showSpotlightTour(
                'Edit lets the team clean up or correct what appears on the Dashboard, without changing information inside Slack.',
                '.dashboard-row.status-new .edit-link'
              );

              const nextButton = document.getElementById('spotlight-tour-next');

              if (nextButton) {
                nextButton.textContent = 'Next Page';
              } else {
                console.error('Spotlight Tour Next button was not found.');
              }

              return;
            }

            if (dashboardSpotlightStep === 3) {
              window.location.href = '/messages';
            }
          });
        }

        // Messages Spotlight Tour
        if (
          window.userRole === 'Guest' &&
          window.location.pathname === '/messages' &&
          !document.cookie.includes(window.spotlightTourCookieName + '=complete')
        ) {
          let messagesSpotlightStep = 1;

          showSpotlightTour(
            'Messages lets you find a support request inside Slack and quickly correct the information in the main message.',
            '.nav-links a.active'
          );

          document.getElementById('spotlight-tour-next')?.addEventListener('click', () => {
            if (messagesSpotlightStep === 1) {
              messagesSpotlightStep = 2;

              showSpotlightTour(
                'Paste the Slack message link here to find the request you want to update.',
                '#slack-url-input',
                'bottom'
              );

              return;
            }

            if (messagesSpotlightStep === 2) {
              messagesSpotlightStep = 3;

              const searchButton = document.getElementById('slack-search-button');
              const messageBox = document.getElementById('spotlight-tour-message');

              if (!searchButton || !messageBox) {
                console.error('Messages Spotlight Tour could not find the Search button or message box.');
                return;
              }

            // Highlights Search and tells the Guest to use the real button.
            showSpotlightTour(
              'Click here to search Slack.',
              '#slack-search-button'
            );
            messageBox.style.top = (parseFloat(messageBox.style.top) + 20) + 'px';

            const nextButton = document.getElementById('spotlight-tour-next');

            if (nextButton) {
              nextButton.style.display = 'none';
            } else {
              console.error('Messages Spotlight Tour Next button was not found.');
            }

              // Raises only Search above the page blocker so it can be clicked.
              searchButton.style.position = 'relative';
              searchButton.style.zIndex = '2000';

              // Continues the Spotlight Tour after the Guest actually clicks Search.
              searchButton.addEventListener('click', () => {
                setTimeout(() => {
                  searchButton.style.position = '';
                  searchButton.style.zIndex = '';

                  showSpotlightTour(
                    'Edit can be used to correct information in the Slack message, like anything sensitive added by mistake.',
                    '.slack-message-card .edit-link'
                  );

                  messageBox.style.display = 'block';
                  messageBox.style.top = (parseFloat(messageBox.style.top) - 45) + 'px';
                  messagesSpotlightStep = 4;

                  const nextButton = document.getElementById('spotlight-tour-next');

                  if (nextButton) {
                    nextButton.style.display = 'block';
                    nextButton.textContent = 'Next Page';
                  } else {
                    console.error('Messages Spotlight Tour Next button was not found.');
                  }
                }, 600);
              }, { once: true });
            }

            if (messagesSpotlightStep === 4) {
              window.location.href = '/users';
            }
          });
        }

        // Users Spotlight Tour
        if (
          window.userRole === 'Guest' &&
          window.location.pathname === '/users' &&
          !document.cookie.includes(window.spotlightTourCookieName + '=complete')
        ) {
          let usersSpotlightStep = 1;

          showSpotlightTour(
            'Users show who has access and the role assigned to each person.',
            '.nav-links a.active'
          );

          document.getElementById('spotlight-tour-next')?.addEventListener('click', () => {
            if (usersSpotlightStep === 1) {
              usersSpotlightStep = 2;

              showSpotlightTour(
                'Roles control what each person can see and do.',
                '.setting-card .selected-indicator',
                'bottom'
              );

              return;
            }

              if (usersSpotlightStep === 2) {
                usersSpotlightStep = 3;

              showSpotlightTour(
                'Edit lets an administrator update a user’s account details and role.',
                '.setting-card:nth-of-type(2) .open-user-modal'
              );

                return;
              }

              if (usersSpotlightStep === 3) {
                usersSpotlightStep = 4;

                showSpotlightTour(
                  'Search makes it easy to find a specific user.',
                  '#user-search-box'
                );

                const nextButton = document.getElementById('spotlight-tour-next');

                if (nextButton) {
                  nextButton.textContent = 'Next Page';
                } else {
                  console.error('Users Spotlight Tour Next button was not found.');
                }

                return;
              }

              if (usersSpotlightStep === 4) {
                window.location.href = '/auto-responder';
              }
          });
        }

        // Auto Responder Spotlight Tour
        if (
          window.userRole === 'Guest' &&
          window.location.pathname === '/auto-responder' &&
          !document.cookie.includes(window.spotlightTourCookieName + '=complete')
        ) {
          let autoResponderSpotlightStep = 1;

          showSpotlightTour(
            'Auto Responder can automatically reply to new Slack support requests when the team isn’t available.',
            '.nav-links a.active'
          );

          document.getElementById('spotlight-tour-next')?.addEventListener('click', () => {
            if (autoResponderSpotlightStep === 1) {
              autoResponderSpotlightStep = 2;

              showSpotlightTour(
                'Choose which message should be used when Auto Responder is turned on.',
                '.setting-card .selected-indicator',
                'bottom'
              );

              return;
            }

            if (autoResponderSpotlightStep === 2) {
              autoResponderSpotlightStep = 3;

              showSpotlightTour(
                'Click here to turn the Auto Responder off.',
                '.switch'
              );

              const nextButton = document.getElementById('spotlight-tour-next');

              if (nextButton) {
                nextButton.style.display = 'none';
              } else {
                console.error('Auto Responder Spotlight Tour Next button was not found.');
              }

              const toggle = document.getElementById('auto-responder-toggle');
              const toggleSwitch = document.querySelector('.switch');

              if (!toggle || !toggleSwitch) {
                console.error('Auto Responder Spotlight Tour toggle was not found.');
                return;
              }

              toggleSwitch.style.position = 'relative';
              toggleSwitch.style.zIndex = '2000';

              // Advances the tour after the Guest actually changes the toggle.
              toggle.addEventListener('change', () => {
                setTimeout(() => {
                  toggleSwitch.style.position = '';
                  toggleSwitch.style.zIndex = '';

                  showSpotlightTour(
                    'Edit lets you change the message that will be sent.',
                    '.setting-card:nth-of-type(2) .edit-link'
                  );

                  const nextButton = document.getElementById('spotlight-tour-next');

                  if (nextButton) {
                    nextButton.style.display = 'block';
                    nextButton.textContent = 'Next Page';
                  } else {
                    console.error('Auto Responder Spotlight Tour Next button was not found.');
                  }

                  autoResponderSpotlightStep = 4;
                }, 250);
              }, { once: true });
            }
              if (autoResponderSpotlightStep === 4) {
                window.location.href = '/settings';
              }
          });
        }

        // Settings Spotlight Tour
        if (
          window.userRole === 'Guest' &&
          window.location.pathname === '/settings' &&
          !document.cookie.includes(window.spotlightTourCookieName + '=complete')
        ) {
          let settingsSpotlightStep = 1;

          showSpotlightTour(
            'Settings control how different parts of the portal behave and connect with other systems.',
            '.nav-links a.active'
          );

          document.getElementById('spotlight-tour-next')?.addEventListener('click', () => {
            if (settingsSpotlightStep === 1) {
              settingsSpotlightStep = 2;

              showSpotlightTour(
                'Settings are grouped by category so related options are easy to find.',
                '.nav-links a.active + .nav-submenu'
              );

              return;
            }

            if (settingsSpotlightStep === 2) {
              settingsSpotlightStep = 3;

              showSpotlightTour(
                'Edit lets an administrator update the selected setting.',
                '.settings-row .edit-link'
              );

              const nextButton = document.getElementById('spotlight-tour-next');

              if (nextButton) {
                nextButton.textContent = 'Finish Tour';
              } else {
                console.error('Settings Spotlight Tour Next button was not found.');
              }

              return;
            }

            if (settingsSpotlightStep === 3) {
              document.cookie =
                window.spotlightTourCookieName + '=complete; path=/; max-age=31536000; SameSite=Lax';

              document.getElementById('spotlight-tour-overlay').style.display = 'none';
              document.getElementById('spotlight-tour-focus').style.display = 'none';
              document.getElementById('spotlight-tour-message').style.display = 'none';
              document.getElementById('spotlight-tour-end').style.display = 'none';
            }
          });
        }
          
        const activeNavLink = document.querySelector('.nav-links a.active');

        if (
          activeNavLink &&
          activeNavLink.nextElementSibling?.classList.contains('nav-submenu')
        ) {
          const submenu = activeNavLink.nextElementSibling;

          activeNavLink.addEventListener('click', (event) => {
            event.preventDefault();

            submenu.style.display =
              submenu.style.display === 'none' ? 'flex' : 'none';
          });
        }
        if (window.location.pathname === '/compose') {
          const btn = document.getElementById('compose-submit-btn');
          if (!btn) return;

          btn.addEventListener('click', () => {
            fetch(window.internalNewUrl + '/api/v1/new', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                salesforce_rep: window.userName,
                salesforce_asset: document.getElementById('compose-asset')?.value.trim() ?? '',
                customer: document.getElementById('compose-customer')?.value.trim() ?? '',
                case_number: document.getElementById('compose-case-number')?.value.trim() ?? '',
                issue_summary: document.getElementById('compose-issue')?.value.trim() ?? '',
                duplication_steps: document.getElementById('compose-duplicate')?.value.trim() ?? '',
                examples: document.getElementById('compose-examples')?.value.trim() ?? '',
                rep_question: document.getElementById('compose-help')?.value.trim() ?? '',
                action_id: 'action_name:New',
                value: 'case_id:xxxxxxxx, slack_post_id:xxxxxxxx, lifecycle_id:xxxxxxxx',
                auth: {
                SLACK_USER_ID: window.userId,
                SESSION_TOKEN: window.sessionToken
              }
              })
            })
            .then(async (response) => {
              if (response.ok) {
                alert('Your question was successfully submitted.');
                window.location.reload();
              } else {
                let errorText = '';
                const rawText = await response.text();

                try {
                  const errorJson = JSON.parse(rawText);
                  errorText = errorJson.message || rawText;
                } catch {
                  errorText = rawText;
                }

                alert(errorText || 'An unexpected error occurred.');
              }
            })
            .catch((err) => {
              alert(err.message || 'An unexpected error occurred.');
            });
          });
        }

        // On page load, hides elements with the 'auto-hide' class if the current path is '/auto-responder'
        if (window.location.pathname === '/auto-responder') {
          document.querySelectorAll('.auto-hide').forEach(el => {
            el.style.display = 'none';
          });
        }

        // Shows or hides the credentials button container based on the current path, then attaches the save handler for masked inputs
        const credentialsButtonContainer = document.getElementById("credentials-button-container");
        if (credentialsButtonContainer) {
          if (window.location.pathname === "/credentials") {
            credentialsButtonContainer.style.removeProperty("display");
            credentialsButtonContainer.style.removeProperty("justifyContent");
          } else {
            credentialsButtonContainer.style.display = "none";
          }
        }                         
        attachMaskedSaveHandler();
          
        // Adds live search functionality to filter user cards on the /users page based on input; shows a message if no matches are found
        const userSearchBox = document.getElementById('user-search-box');
        const userCards = document.querySelectorAll('.setting-card');
        if (window.location.pathname === '/users' && userSearchBox && userCards.length > 0) {
          const noResultsMessage = document.getElementById('user-no-results');
          userSearchBox.addEventListener('input', () => {
            const query = userSearchBox.value.toLowerCase().trim();
            let visibleCount = 0;
            userCards.forEach(card => {
              const text = card.textContent.toLowerCase();
              const matches = text.includes(query);
              card.style.display = matches ? 'flex' : 'none';
              if (matches) visibleCount++;
            });
            if (noResultsMessage) {
              noResultsMessage.style.display = visibleCount === 0 ? 'block' : 'none';
            }
          });
        }

        // Sends a request to save/reset to reset failed login attempts or guest session expiration
        if (window.location.pathname === '/users') {
          document.querySelectorAll('.reset-user-link').forEach(link => {
            link.addEventListener('click', function (e) {
              e.preventDefault();
              const card = link.closest('.setting-card');
              const name = card?.querySelector('.card-type strong')?.textContent || 'Unknown';
              const slackId = card?.getAttribute('data-db-name') || '';
              const resetType = link.getAttribute('data-reset-type') || '';
              if (!slackId) return;
                const confirmMessage =
                  resetType === 'GUEST_SESSION'
                    ? 'Are you sure you want to reset guest access for ' + name + '?'
                    : 'Are you sure you want to reset failed login attempts for ' + name + '?';

                const confirmed = confirm(confirmMessage);
              if (!confirmed) return;
              apiSaveRequest({
                endpointSuffix: '/users/reset',
                method: 'POST',
                  payload: {
                    SLACK_USER_ID: slackId,
                    RESET_TYPE: resetType
                  }
              }).then(response => {
                  if (response.ok) {
                    alert(
                      resetType === 'GUEST_SESSION'
                        ? 'Guest access reset successfully.'
                        : 'Login attempts reset successfully.'
                    );
                    location.reload();
                } else {
                  alert(
                    resetType === 'GUEST_SESSION'
                      ? 'Failed to reset guest access.'
                      : 'Failed to reset login attempts.'
                  );
                }
              }).catch(error => {
                alert('Error sending reset request.');
                console.error(error);
              });
            });
          });
        }

        // Opens the modal to add a new help item, initializes empty field values, and hides the delete button
        if (['Developer', 'Manager', 'AdvancedSupport'].includes(window.userRole)) {
          const addHelpButton = document.getElementById('add-help-button');
          if (addHelpButton) {
            addHelpButton.addEventListener('click', function () {
              var data = {
                help_item: '',
                description: '',
                category: '',
                subcategory: '',
                order: ''
              };
              injectModalFields(data);
              document.getElementById('modal-title').textContent = 'Add New Help Item';
              document.getElementById('modal').style.display = 'flex';
              var deleteContainer = document.getElementById('delete-button-container');
              if (deleteContainer) {
                deleteContainer.style.visibility = 'hidden';
              }
            });
          }
        }
        
        if (window.userRole === 'Support') {
          const addHelpButton = document.getElementById('add-help-button');
          if (addHelpButton) {
            addHelpButton.disabled = true;
            addHelpButton.classList.add('disabled-add-help-button');
            addHelpButton.title = "You don't have permission to add help items.";
          }
        }        
          
        // Adds live search functionality to the help section.
        // Filters help entries based on user input and displays matching suggestions with highlighted context.        
          const helpSearchBox = document.getElementById('help-search-box');
          if (helpSearchBox) {
            const suggestionsBox = document.getElementById('help-search-suggestions');
            const helpEntries = document.querySelectorAll('.help-subentry');
            helpSearchBox.addEventListener('input', function () {
              const query = helpSearchBox.value.toLowerCase().trim();
              suggestionsBox.innerHTML = '';
              suggestionsBox.style.display = 'none';
              if (!query) return;
              const matches = [];
              helpEntries.forEach(function (entry) {
                const subcategory = (entry.querySelector('.help-subcategory')?.textContent || '').toLowerCase();
                const description = (entry.querySelector('.help-description')?.textContent || '').toLowerCase();
                const categoryHeading = (entry.closest('.help-card')?.querySelector('.help-category-heading')?.textContent || '');
                if (subcategory.includes(query) || description.includes(query)) {
                  const matchIndex = description.indexOf(query);
                  let snippet = description;
                  if (matchIndex !== -1) {
                    const contextRadius = 40;
                    const start = Math.max(0, matchIndex - contextRadius);
                    const end = Math.min(description.length, matchIndex + query.length + contextRadius);
                    const before = description.slice(start, matchIndex);
                    const match = description.slice(matchIndex, matchIndex + query.length);
                    const after = description.slice(matchIndex + query.length, end);
                    snippet = (start > 0 ? '...' : '') +
                      before +
                      '<span class="highlight">' + match + '</span>' +
                      after +
                      (end < description.length ? '...' : '');
                  }
                  matches.push({
                    element: entry,
                    category: categoryHeading,
                    snippet: snippet
                  });
                }
              });
          
              // Displays up to 10 matching help entries as clickable suggestions.
              // Highlights the matched text and scrolls to the selected entry on click.              
              if (matches.length > 0) {
                matches.slice(0, 10).forEach(function (match) {
                  const li = document.createElement('li');
                  li.innerHTML =
                    '<strong>' + match.category + '</strong><br>' +
                    '<span style="font-size: 0.85em;">' + match.snippet + '</span>';
                  li.addEventListener('click', function () {
                    match.element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    suggestionsBox.style.display = 'none';
                  });
                  suggestionsBox.appendChild(li);
                });
                suggestionsBox.style.display = 'block';
              }
            });
          
            // Hides the suggestions dropdown when clicking outside the search box or suggestions list.
            document.addEventListener('click', function (e) {
              const isClickInside = helpSearchBox.contains(e.target) || suggestionsBox.contains(e.target);
              if (!isClickInside) {
                suggestionsBox.style.display = 'none';
              }
            });
          }

          // Decodes HTML entities in a string by leveraging the browser's parsing via a temporary textarea element.
          function decodeHtmlEntities(str) {
            const txt = document.createElement('textarea');
            txt.innerHTML = str;
            return txt.value;
          }                            

          // Populates the Slack message card with formatted data values.
          // Decodes HTML entities, strips tags, and formats line breaks and tabs for display.          
          function populateSlackMessageCard(data) {
            const fieldMap = {
              "Rep:": data.salesforce_rep,
              "Asset:": data.salesforce_asset,
              "Customer:": data.customer,
              "Case:": data.case_number,
              "Summarize the issue:": data.issue_summary,
              "Explain how someone else can see or duplicate the issue:": data.duplication_steps,
              "Provide examples (links are preferred):": data.examples,
              "How can we help you:": data.rep_question
            };
          
            const cardFields = document.querySelectorAll('.slack-message-card .card-value > div');
          
            cardFields.forEach(field => {
              const labelEl = field.querySelector('strong');
              if (!labelEl) return;
          
              const label = labelEl.textContent.trim();
              const value = fieldMap[label] ?? '';
          
              const formattedValue = value
                .replace(/\\n/g, '<br>')
                .replace(/\\t/g, ' ')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
          
              const subvalueEl = field.querySelector('.message-subvalue');
              if (subvalueEl) {
                subvalueEl.innerHTML = formattedValue;
              } else {
                field.innerHTML = labelEl.outerHTML + ' <div class="message-subvalue">' + formattedValue + '</div>';
              }
            });
          
          
          // Enables the Slack message edit link and attaches message data attributes for modal editing.
          const editLink = document.querySelector('.slack-message-card .edit-link');
          if (editLink) {
            editLink.setAttribute('data-issue', data.issue_summary ?? '');
            editLink.setAttribute('data-explanation', data.duplication_steps ?? '');
            editLink.setAttribute('data-examples', data.examples ?? '');
            editLink.setAttribute('data-help', data.rep_question ?? '');
            editLink.style.pointerEvents = 'auto';
            editLink.style.opacity = '1';
          }            
        }          
          
        // Handles Slack message search button click.
        // Validates input, shows loading spinner, and clears previous message content if input is empty.        
          const slackSearchButton = document.getElementById("slack-search-button");
          if (slackSearchButton) {           
            slackSearchButton.addEventListener("click", function () {
              const input = document.getElementById("slack-url-input");
              const slackUrl = input ? input.value.trim() : "";
              document.getElementById("svg-loader").style.display = "block";
              
              if (window.userRole === 'Guest') {
                setTimeout(function () {
                  populateSlackMessageCard({
                    salesforce_rep: 'Alex Morgan',
                    salesforce_asset: 'Demo Account',
                    customer: 'Jordan Lee',
                    case_number: '100245',
                    issue_summary: 'Customer is unable to complete an expected workflow.',
                    duplication_steps: 'Open the sample account, follow the documented workflow, and attempt the final action.',
                    examples: 'https://example.com/demo/sample',
                    rep_question: 'Please review the behavior and confirm the expected next step.'
                  });

                  document.getElementById("svg-loader").style.display = "none";
                }, 500);

                return;
              }

              if (!slackUrl) {
                // Clear previous message values and disable edit link
                const card = document.querySelector('.slack-message-card .card-value');
                if (card) {
                  const fields = card.querySelectorAll('div');
                  fields.forEach(function (field) {
                    const parts = field.innerHTML.split('</strong>');
                    if (parts.length === 2) {
                      field.innerHTML = parts[0] + '</strong> ';
                    }
                  });
                }

          // Disables the Slack message edit link and dims its appearance when no valid message is loaded.
          const editLink = document.querySelector('.slack-message-card .edit-link');
          if (editLink) {
            editLink.style.pointerEvents = 'none';
            editLink.style.opacity = '0.5';
          }

          // Hides the loading spinner and alerts the user if the Slack URL input is empty, then exits early.
          document.getElementById("svg-loader").style.display = "none";                
          alert("Please enter a Slack message URL.");
          return;
         }
              
         // Validates the Slack URL format using a regex pattern.
         // If invalid, clears previous message content and disables the edit link.         
          const slackUrlPattern = /^https:\\/\\/[\\w.-]+\\.slack\\.com\\/archives\\/[A-Z0-9]+\\/p\\d{16}$/;
          if (!slackUrlPattern.test(slackUrl)) {
            // Clear previous message values and disable edit link
            const card = document.querySelector('.slack-message-card .card-value');
            if (card) {
              const fields = card.querySelectorAll('div');
              fields.forEach(function (field) {
                const parts = field.innerHTML.split('</strong>');
                if (parts.length === 2) {
                  field.innerHTML = parts[0] + '</strong> ';
                }
              });
            }

          // Disables the edit link again in case of invalid Slack URL input.
          const editLink = document.querySelector('.slack-message-card .edit-link');
          if (editLink) {
            editLink.style.pointerEvents = 'none';
            editLink.style.opacity = '0.5';
          }
           
          // Checks if the URL is a threaded Slack message and alerts accordingly.
          // Hides the loading spinner and exits if the URL is invalid or unsupported.          
          const isThreaded = slackUrl.includes('?thread_ts=');
          if (isThreaded) {
            alert("Threaded Slack messages are not currently supported. Please use the main message URL.");
          } else {
            alert("Invalid Slack message URL. Please enter a valid message link from Slack.");
          }
          document.getElementById("svg-loader").style.display = "none";
          return;
         }              
        
         // Extracts channel ID and timestamp from the Slack URL using regex.
         // If the match fails, clears previous message content and disables the edit link.         
        const match = slackUrl.match(/^https:\\/\\/[\\w.-]+\\.slack\\.com\\/archives\\/([A-Z0-9]+)\\/p(\\d{16})$/);
        if (!match) {
          // Clear previous message values and disable edit link
          const card = document.querySelector('.slack-message-card .card-value');
          if (card) {
            const fields = card.querySelectorAll('div');
            fields.forEach(function (field) {
              const parts = field.innerHTML.split('</strong>');
              if (parts.length === 2) {
                field.innerHTML = parts[0] + '</strong> ';
              }
            });
          }

          // Disables the edit link, hides the loading spinner, and alerts the user if the Slack URL is invalid, then exits.
          const editLink = document.querySelector('.slack-message-card .edit-link');
          if (editLink) {
            editLink.style.pointerEvents = 'none';
            editLink.style.opacity = '0.5';
          }
          document.getElementById("svg-loader").style.display = "none";        
          alert("Please enter a valid Slack message URL.");
          return;
         }

         // Extracts channel ID and timestamp from the Slack URL.
         // Verifies the channel is allowed; if not, hides the loader and alerts the user.         
          const channelId = match[1];
          const timestamp = match[2];
          const allowedChannelIds = [
          window.slackChannelIdSupport,
          ];
            if (!allowedChannelIds.includes(channelId)) {
              document.getElementById("svg-loader").style.display = "none";
              alert("This page cannot retrieve messages from the Slack channel Id in your URL.");
              return;
            }              
            
          // Sends a POST request to the internal API to fetch Slack message details using the extracted channel ID and timestamp.
          fetch(window.internalApiMessagesUrl, {
            method: "POST",
            headers: {
              'Content-Type': 'application/json'
            },
              body: JSON.stringify({
                channel_id: channelId,
                timestamp: timestamp,
                auth: {
                  SLACK_USER_ID: window.userId,
                  SESSION_TOKEN: window.sessionToken
                }
              })
          })

          // Handles the API response: hides the loader, parses error messages if the response is not OK, and alerts the user.
          .then(async response => {
            document.getElementById("svg-loader").style.display = "none";
            if (!response.ok) {
              const contentType = response.headers.get('Content-Type') || '';
              let errorMessage = 'Failed to retrieve message details.';
              try {
                if (contentType.includes('application/json')) {
                  const errorData = await response.json();
                  errorMessage = errorData?.message || errorMessage;
                } else {
                  errorMessage = await response.text();
                }
              } catch (e) {
                console.warn('Failed to parse error response:', e);
              }
              alert(errorMessage);
              return;
            }

            // Parses the successful API response and populates the Slack message card with retrieved data.
              const data = await response.json();
              window.originalSlackMessage = data;
              populateSlackMessageCard(data);
            })

            // Catches and handles fetch errors, hides the loader, and alerts the user if the request fails.
            .catch(error => {
              console.error("Error fetching Slack message data:", error);
              alert("Failed to retrieve message details.");
              document.getElementById("svg-loader").style.display = "none";
            });                                                             
          });
          }          
          
          // Initializes the "Add New User" modal on the /users page.
          // Prepares empty user data, sets the modal title, and displays the modal form.          
          if (window.location.pathname === '/users') {
            const addUserButton = document.getElementById('add-user-button');
            if (addUserButton) {
              addUserButton.addEventListener('click', function () {
                const data = {
                  name: '',
                  username: '',
                  slack_id: '',
                  sf_id: '',
                  role: ''
                };
                window.originalSlackId = '';
                injectModalFields(data);
                document.getElementById('modal-title').textContent = 'Add New User';
                delete data.last_updated;
                document.getElementById('modal').style.display = 'flex';
              });
            } 
            
            // Opens the "Edit User" modal when a user card is clicked.
            // Prevents editing of Developer roles by non-developers, loads user data into the form, and displays the modal.            
          document.querySelectorAll('.open-user-modal').forEach(link => {
            link.addEventListener('click', () => {
              const targetUserRole = link.getAttribute('data-role');
              const currentUserRole = window.userRole;
              if (targetUserRole === 'Developer' && currentUserRole !== 'Developer') {
                alert('Only developers can edit other developers.');
                return;
              }
              const data = {
                name: link.getAttribute('data-name') || '',
                username: link.getAttribute('data-username') || '',
                slack_id: link.getAttribute('data-slack-id') || '',
                sf_id: link.getAttribute('data-sf-id') || '',
                role: link.getAttribute('data-role') || '',
                last_updated: link.getAttribute('data-last-updated') || ''
              };
              window.originalSlackId = data.slack_id;
              injectModalFields(data);
              updateModalTitleByPath();
              document.getElementById('modal').style.display = 'flex';
            });
          });
          }

          // Gets references to the auto-responder toggle input and its status message element.
          const toggleInput = document.getElementById('auto-responder-toggle');
          const statusMessageEl = document.getElementById('auto-responder-status');
  
          // Updates the auto-responder status message based on the toggle state.          
          function updateToggleUI(settingValue) {
            if (!toggleInput || !statusMessageEl) return;
            statusMessageEl.textContent = 'Auto Responder is currently ' + (settingValue === 'TRUE' ? 'ON' : 'OFF');
            statusMessageEl.className = 'auto-responder-status ' + (settingValue === 'TRUE' ? 'on' : 'off');
          }
          toggleInput?.addEventListener('change', async function () {
          const newValue = toggleInput.checked ? 'TRUE' : 'FALSE';

            if (window.userRole === 'Guest') {
              updateToggleUI(newValue);
              return;
            }

          // Sends a PATCH request to save the new setting value when the toggle is changed.
          try {
            const response = await apiSaveRequest({
              endpointSuffix: '/settings',
              method: 'PATCH',
              payload: {
                table: 'Settings',
                db_setting_name: 'auto_responder_toggle',
                updates: { SETTING_VALUE: newValue }
              },
            });

            // If the API update is successful, reflect the new toggle state in the UI.
            if (response.ok) {
              updateToggleUI(newValue);

            // If the API update fails, attempts to extract and display a detailed error message from the response.
            } else {
              let errorMessage = 'Failed to update Auto Responder setting.';
              try {
                const contentType = response.headers.get('Content-Type') || '';
                if (contentType.includes('application/json')) {
                  const errorData = await response.json();
                  errorMessage = errorData?.message || errorMessage;
                } else {
                  errorMessage = await response.text();
                }
              } catch (e) {
                console.warn('Failed to parse error response:', e);
              }
              alert(errorMessage);                
            }

          // Catches unexpected errors during the toggle update process, logs them, and alerts the user.
          } catch (error) {
            console.error('Auto Responder error:', error);
            alert('An error occurred while updating.');
          }
          });

        // Initializes the auto-responder toggle UI with the current setting value.
        // Adds click handlers to "select" links to update the selected auto-responder type.          
        const settingValue = window.userRole === 'Guest'
          ? 'TRUE'
          : (window.autoResponderSetting || 'FALSE');
        updateToggleUI(settingValue);

        document.querySelectorAll('.select-link').forEach(link => {
          link.addEventListener('click', async (e) => {
            e.preventDefault();

            const card = e.target.closest('.setting-card');
            const dbName = card?.getAttribute('data-db-name');
            if (!dbName) return;

              if (window.userRole === 'Guest') {
                function selectGuestCard(selectedCard) {
                  document.querySelectorAll('.setting-card').forEach(card => {
                    const cardType = card.querySelector('.card-type');
                    if (!cardType) return;

                    cardType.querySelector('.selected-indicator')?.remove();
                    cardType.querySelector('.select-link')?.remove();

                    if (card === selectedCard) {
                      const indicator = document.createElement('span');
                      indicator.className = 'selected-indicator';
                      indicator.textContent = 'Selected';
                      cardType.appendChild(indicator);
                    } else {
                      const link = document.createElement('a');
                      link.href = '#';
                      link.className = 'select-link';
                      link.textContent = 'Use this';

                      link.addEventListener('click', e => {
                        e.preventDefault();
                        selectGuestCard(card);
                      });

                      cardType.appendChild(link);
                    }
                  });
                }

                selectGuestCard(card);
                return;
              }

          // Sends a PATCH request to update the selected auto-responder type in the settings table.
          try {
            const response = await apiSaveRequest({
              endpointSuffix: '/settings',
              method: 'PATCH',
              payload: {
                table: 'Settings',
                db_setting_name: 'auto_responder_type',
                updates: { SETTING_VALUE: dbName }
              },
            });   
                
              // Reloads the page to reflect the updated auto-responder type if the update was successful.  
              if (response.ok) {
                location.reload();

              // Handles failed auto-responder type update by parsing and displaying a detailed error message from the response.
              } else {
                let errorMessage = 'Failed to update selection.';
                  try {
                    const contentType = response.headers.get('Content-Type') || '';
                    if (contentType.includes('application/json')) {
                      const errorData = await response.json();
                      errorMessage = errorData?.message || errorMessage;
                    } else {
                      errorMessage = await response.text();
                    }
                  } catch (e) {
                    console.warn('Failed to parse error response:', e);
                  }
                  alert(errorMessage);
                }   
              } catch (error) {
                console.error('Error updating selection:', error);
                alert('An error occurred while updating.');
                }
              });
            });          
          
            // Update the auto responder setting by sending a PATCH request to the settings endpoint
            async function updateAutoResponderSetting(value) {
              try {
                const response = await apiSaveRequest({
                  endpointSuffix: '/settings',
                  method: 'PATCH',
                  payload: {
                    table: 'Settings',
                    db_setting_name: 'auto_responder_toggle',
                    updates: {
                      SETTING_VALUE: value
                    }
                  },
                }); 

              // If the response is successful, update the UI to reflect the new toggle state
              if (response.ok) {
                updateToggleUI(newValue);

              // If the response is not successful, attempt to extract and display a detailed error message
              } else {
                let errorMessage = 'Failed to update Auto Responder setting.';
                try {
                  const contentType = response.headers.get('Content-Type') || '';
                  if (contentType.includes('application/json')) {
                    const errorData = await response.json();
                    errorMessage = errorData?.message || errorMessage;
                  } else {
                    errorMessage = await response.text();
                  }
                } catch (e) {
                  console.warn('Failed to parse error response:', e);
                }
                alert(errorMessage);
              }

              // Catch any unexpected errors during the update process and alert the user
              } catch (error) {
                console.error('Auto Responder error:', error);
                alert('An error occurred while updating.');
              }
            }   

          // Attach a click event to the cancel button to close the password modal if the button exists
          const cancelPasswordBtn = document.getElementById('cancel-password');
          if (cancelPasswordBtn) {
            cancelPasswordBtn.addEventListener('click', closePasswordModal);
          }

          // Set up the submit button to validate password input and execute the pending action if valid
          const submitPasswordBtn = document.getElementById('submit-password');
          if (submitPasswordBtn) {
            submitPasswordBtn.addEventListener('click', () => {
              const password = document.getElementById('confirm-password').value.trim();
              if (!password) {
                alert('Please enter your password.');
                return;
              }
              if (typeof pendingAction === 'function') {
                pendingAction(password);
              }
            });
          }
        });

        // Disable credential-related buttons and open the add masked modal when the add button is clicked
        const addMaskedBtn = document.getElementById('credentials-add-button');
        const addMaskedModal = document.getElementById('add-masked-modal');
          if (addMaskedBtn && addMaskedModal) {
            addMaskedBtn.addEventListener('click', (e) => {
              e.preventDefault();
              document.getElementById('credentials-rotate-button').disabled = true;
              document.getElementById('credentials-salesforce-button').disabled = true;
              document.getElementById('credentials-nuke-button').disabled = true;
               
        // If the modal is hidden, position it near the button and populate it with input fields and action buttons
        const isHidden = addMaskedModal.classList.contains('hidden');
          if (isHidden) {
            const rect = addMaskedBtn.getBoundingClientRect();
            addMaskedModal.style.top = (rect.bottom + window.scrollY + 4) + "px";
            addMaskedModal.style.right = (window.innerWidth - rect.right - window.scrollX) + "px";            
            addMaskedModal.innerHTML =
              '<div class="modal-url-wrapper">' +
              '<label for="masked-dropdown" class="modal-label">Select Type <span class="required-asterisk">*</span></label>' +
              '<select id="masked-dropdown" class="modal-content" required>' +
              '<option value="" disabled selected>-- Select an option --</option>' +
              '</select>' +
              '</div>' +
              '<div class="modal-url-wrapper">' +
              '<label for="masked-input" class="modal-label">Enter Value <span class="required-asterisk">*</span></label>' +
              '<input type="text" id="masked-input" class="modal-content" placeholder="Enter value" required />' +
              '</div>' +
              '<div style="margin-top: 1.5rem; text-align: right;">' +
              '<button id="cancel-masked-value" class="modal-button cancel" style="margin-right: 0.5rem;">Cancel</button>' +
              '<button id="save-masked-value" class="modal-button save">Save</button>' +
              '</div>';
              
            // Reload the page when the cancel button in the masked modal is clicked
            const cancelMaskedBtn = document.getElementById('cancel-masked-value');
            if (cancelMaskedBtn) {
              cancelMaskedBtn.addEventListener('click', function () {
                window.location.reload();
              });
            }

            // Populate the dropdown with masked options from the global window object
            const dropdown = document.getElementById('masked-dropdown');
            if (window.maskedOptions && dropdown) {
              window.maskedOptions.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.name;
                option.textContent = opt.label;
                option.setAttribute('data-db-name', opt.name);
                dropdown.appendChild(option);
              });
            }
          }
              if (isHidden) {
                addMaskedModal.classList.remove('hidden');
              }            
            });
          }      

        // Set up click event for rotating credentials; disables other credential-related buttons during the process
        const rotateSecretBtn = document.getElementById('credentials-rotate-button');
        const rotateSecretModal = document.getElementById('rotate-secret-modal');
        if (rotateSecretBtn && rotateSecretModal) {
          rotateSecretBtn.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('credentials-add-button').disabled = true;
            document.getElementById('credentials-salesforce-button').disabled = true;
            document.getElementById('credentials-nuke-button').disabled = true;

        // Display and position the rotate secret modal with dropdowns and action buttons if it's currently hidden
        const isHidden = rotateSecretModal.classList.contains('hidden');
        if (isHidden) {
          const rect = rotateSecretBtn.getBoundingClientRect();
          rotateSecretModal.style.top = (rect.bottom + window.scrollY + 4) + "px";
          rotateSecretModal.style.right = (window.innerWidth - rect.right - window.scrollX) + "px";              
          rotateSecretModal.innerHTML =
          '<div class="modal-url-wrapper">' +
            '<label for="rotate-dropdown" class="modal-label">Type <span class="required-asterisk">*</span></label>' +
            '<select id="rotate-dropdown" class="modal-content" required>' +
              '<option value="" disabled selected>-- Select an option --</option>' +
            '</select>' +
          '</div>' +
          '<div class="modal-url-wrapper">' +
          '<label for="rotate-secret-dropdown" class="modal-label">Select Secret <span class="required-asterisk">*</span></label>' +
          '<select id="rotate-secret-dropdown" class="modal-content" required>' +
          '<option value="" disabled selected>-- Select a secret --</option>' +
          '</select>' +
          '</div>' +
          '<p class="modal-url-note"> &#9888; Choosing the wrong secret will cause decryption issues!</p>' +
          '</div>' +           
          '<div style="margin-top: 1.5rem; text-align: right;">' +
            '<button id="cancel-rotate-secret" class="modal-button cancel" style="margin-right: 0.5rem;">Cancel</button>' +
            '<button id="save-rotate-secret" class="modal-button save">Save</button>' +
          '</div>';

          // Reload the page when the cancel button for rotating the secret is clicked
          const cancelRotateBtn = document.getElementById('cancel-rotate-secret');
          if (cancelRotateBtn) {
            cancelRotateBtn.addEventListener('click', function () {
              window.location.reload();
            });
          }              
         
          // Populate the rotate dropdown with masked options from the global window object
          const rotateDropdown = document.getElementById('rotate-dropdown');
          if (window.maskedOptions && rotateDropdown) {
            window.maskedOptions.forEach(opt => {
              const option = document.createElement('option');
              option.value = opt.name;
              option.textContent = opt.label;
              option.setAttribute('data-db-name', opt.name);
              rotateDropdown.appendChild(option);
            });
          }

          // Populate the secret dropdown with non-deleted secret names from the global secretVersionData
          const secretDropdown = document.getElementById('rotate-secret-dropdown');
          if (window.secretVersionData && secretDropdown) {
            window.secretVersionData
              .filter(secret => secret.DELETED !== 'TRUE')
              .forEach(secret => {
                const option = document.createElement('option');
                option.value = secret.SECRET_NAME;
                option.textContent = secret.SECRET_NAME;
                secretDropdown.appendChild(option);
              });
          }                          

          // Validate dropdown selections before proceeding with the save operation for rotating the secret
          const saveRotateBtn = document.getElementById('save-rotate-secret');
          if (saveRotateBtn) {
            saveRotateBtn.addEventListener('click', function () {
              const dropdown = document.getElementById('rotate-dropdown');
              const secretDropdown = document.getElementById('rotate-secret-dropdown');                  
              if (!dropdown.value || !secretDropdown.value.trim()) {
                alert('Please fill in all required fields.');
                return;
              }
              
          // Prompt for password and verify it before proceeding; alert if incorrect
          openPasswordModal(function (password) {
            verifyPassword(password, window.userHashedPassword)
              .then(isValid => {
                if (!isValid) {
                  alert('Incorrect password. Please try again.');
                  return;
                }
              closePasswordModal();
              
          // Send a PATCH request to update the selected secret name for credential rotation
          apiSaveRequest({
            endpointSuffix: '/credentials/rotate',
            method: 'PATCH',
            payload: {
              table: 'Settings',
              db_setting_name: dropdown.value,
              updates: {
                SECRET_NAME: secretDropdown.value
              }
            }
          })
              
          // Handle the response from the secret rotation request, showing success or detailed error messages
          .then(async response => {
            if (response.ok) {
              alert('Secret rotated successfully!');
              window.location.reload();
            } else {
              const errorText = await response.text();
              alert('Failed to rotate secret: ' + errorText);
            }
          })

          //Catch and report any unexpected errors during verification or request execution
            .catch(error => {
              console.error('Error rotating secret:', error);
              alert('An error occurred while rotating the secret.');
            });
          })
            .catch(err => {
              console.error('Verification error:', err);
              alert('An error occurred. Please try again.');
            });
          });
        });
      }}

        // Show the rotate secret modal if it was previously hidden
        if (isHidden) {
          rotateSecretModal.classList.remove('hidden');
        }            
      });
      }

      // Opens the Salesforce credentials modal when the "Connect Salesforce" button is clicked.
      // Disables other credential buttons, positions the modal near the button, and populates it with OAuth URL, username, and masked password fields.      
      const connectBtn = document.getElementById('credentials-salesforce-button');
      const dropdownModal = document.getElementById('salesforce-connect-modal');
      if (connectBtn && dropdownModal) {
        connectBtn.addEventListener('click', (e) => {
          e.preventDefault();
          document.getElementById('credentials-add-button').disabled = true;
          document.getElementById('credentials-rotate-button').disabled = true; 
          document.getElementById('credentials-nuke-button').disabled = true;           
          const isHidden = dropdownModal.classList.contains('hidden');
          if (isHidden) {
            const rect = connectBtn.getBoundingClientRect();
            dropdownModal.style.top = (rect.bottom + window.scrollY + 4) + "px";
            dropdownModal.style.right = (window.innerWidth - rect.right - window.scrollX) + "px";              
            dropdownModal.innerHTML =
            '<div class="modal-url-wrapper">' +
            '<label for="salesforce-url-field" class="modal-label">Salesforce OAuth URL</label>' +
            '<div class="input-copy-row">' +
            '<input type="text" id="salesforce-url-field" readonly value="' + window.salesforceOAuthUrl + '" />' +
            '<button id="salesforce-copy-button" class="copy-button">Copy</button>' +
            '</div>' +
            '<p class="modal-url-note">&#9888; Please use the copied URL in an incognito window</p>' +
            '</div>' +
            '<div class="modal-url-wrapper">' +
            '<label for="salesforce-username-field" class="modal-label">Integration Username</label>' +
            '<div class="input-copy-row">' +
            '<input type="text" id="salesforce-username-field" readonly value="' + window.salesforceIntegrationUserUsername + '" />' +
            '<button id="salesforce-username-copy" class="copy-button">Copy</button>' +
            '</div>' +
            '</div>' +
            '<div class="modal-url-wrapper">' +
            '<label for="salesforce-password-field" class="modal-label">Integration Password</label>' +
            '<div class="input-copy-row">' +
            '<input type="text" id="salesforce-password-field" readonly value="************" />' +
            '<button id="salesforce-password-copy" class="copy-button">Reveal</button>' +
            '</div>' +
            '</div>' +
            '<div style="margin-top: 1.5rem; text-align: right;">' +
            '<button id="cancel-salesforce-modal" class="modal-button cancel">Close</button>' +
            '</div>';


              
              // Closes the Salesforce modal and reloads the page when the "Close" button is clicked.
              const cancelSalesforceBtn = document.getElementById('cancel-salesforce-modal');
              if (cancelSalesforceBtn) {
                cancelSalesforceBtn.addEventListener('click', function () {
                  window.location.reload();
                });
              }              

              // Reveals the decrypted Salesforce password after verifying the user's password.
              // Replaces the "Reveal" button with a "Copy" button that copies the password to clipboard.
              const revealBtn = document.getElementById('salesforce-password-copy');
              if (revealBtn) {
                revealBtn.addEventListener('click', () => {
                  openPasswordModal((password) => {
                    verifyPassword(password, window.userHashedPassword)
                      .then(isValid => {
                        if (!isValid) {
                          alert('Incorrect password. Please try again.');
                          return;
                        }
                        closePasswordModal();
                        const passwordField = document.getElementById('salesforce-password-field');
                        if (passwordField) {
                          passwordField.value = window.salesforceSettings?.decrypted_salesforce_password ?? 'Unavailable';
                        }
                        if (revealBtn) {
                          const newCopyBtn = revealBtn.cloneNode(true);
                          newCopyBtn.textContent = 'Copy';
                          newCopyBtn.addEventListener('click', () => {
                            navigator.clipboard.writeText(passwordField.value)
                              .then(() => {
                                const originalText = newCopyBtn.textContent;
                                newCopyBtn.textContent = 'Copied!';
                                newCopyBtn.disabled = true;
                                setTimeout(() => {
                                  newCopyBtn.textContent = originalText;
                                  newCopyBtn.disabled = false;
                                }, 1500);
                              })
                              .catch(() => {
                                newCopyBtn.textContent = 'Error';
                                setTimeout(() => {
                                  newCopyBtn.textContent = 'Copy';
                                }, 1500);
                              });
                          });
                          revealBtn.parentNode.replaceChild(newCopyBtn, revealBtn);
                        }
                      })
                      .catch(err => {
                        console.error('Verification error:', err);
                        alert('An error occurred. Please try again.');
                      });
                  });
                });
              }

              // Copies the Salesforce OAuth URL to the clipboard when the "Copy" button is clicked.
              // Temporarily changes the button text to "Copied!" or "Error" based on the result.              
              const copyBtn = document.getElementById('salesforce-copy-button');
              const inputField = document.getElementById('salesforce-url-field');
              if (copyBtn && inputField) {
                copyBtn.addEventListener('click', () => {
                  navigator.clipboard.writeText(inputField.value)
                    .then(() => {
                      const originalText = copyBtn.textContent;
                      copyBtn.textContent = 'Copied!';
                      copyBtn.disabled = true;
                      setTimeout(() => {
                        copyBtn.textContent = originalText;
                        copyBtn.disabled = false;
                      }, 1500);
                    })
                    .catch(() => {
                      copyBtn.textContent = 'Error';
                      setTimeout(() => {
                        copyBtn.textContent = 'Copy';
                      }, 1500);
                    });
                });
              }

              // Copies the Salesforce integration username to the clipboard when the "Copy" button is clicked.
              // Temporarily updates the button text to indicate success or failure.              
              const copyUsernameBtn = document.getElementById('salesforce-username-copy');
              const usernameField = document.getElementById('salesforce-username-field');
              if (copyUsernameBtn && usernameField) {
                copyUsernameBtn.addEventListener('click', () => {
                  navigator.clipboard.writeText(usernameField.value)
                    .then(() => {
                      const originalText = copyUsernameBtn.textContent;
                      copyUsernameBtn.textContent = 'Copied!';
                      copyUsernameBtn.disabled = true;
                      setTimeout(() => {
                        copyUsernameBtn.textContent = originalText;
                        copyUsernameBtn.disabled = false;
                      }, 1500);
                    })
                    .catch(() => {
                      copyUsernameBtn.textContent = 'Error';
                      setTimeout(() => {
                        copyUsernameBtn.textContent = 'Copy';
                      }, 1500);
                    });
                });
              }
            }
            if (isHidden) {
              dropdownModal.classList.remove('hidden');
            }            
          });
        }

        // Opens the Nuke users modal when the "Nuke Users" button is clicked.
        const nukeButton = document.getElementById('credentials-nuke-button');
        const nukeModal = document.getElementById('users-nuke-modal');
        if (nukeButton && nukeModal) {
          nukeButton.addEventListener('click', function (e) {
            e.preventDefault();
            document.getElementById('credentials-add-button').disabled = true;
            document.getElementById('credentials-rotate-button').disabled = true;
            document.getElementById('credentials-salesforce-button').disabled = true;
            const isHidden = nukeModal.classList.contains('hidden');
            if (isHidden) {
              const rect = nukeButton.getBoundingClientRect();
              nukeModal.style.top = (rect.bottom + window.scrollY + 4) + "px";
              nukeModal.style.right = (window.innerWidth - rect.right - window.scrollX) + "px";
              nukeModal.innerHTML =
                '<div class="modal-url-wrapper">' +
                  '<label for="nuke-dropdown-session-tokens" class="modal-label">Clear all user session tokens? <span class="required-asterisk">*</span></label>' +
                  '<select id="nuke-dropdown-session-tokens" class="modal-content" required>' +
                    '<option value="TRUE">TRUE</option>' +
                    '<option value="FALSE" selected>FALSE</option>' +
                  '</select>' +
                '</div>' +
                '<div class="modal-url-wrapper">' +
                  '<label for="nuke-dropdown-passwords" class="modal-label">Clear all user passwords? <span class="required-asterisk">*</span></label>' +
                  '<select id="nuke-dropdown-passwords" class="modal-content" required>' +
                  '<option value="TRUE">TRUE</option>' +
                  '<option value="FALSE" selected>FALSE</option>' +
                  '</select>' +
                '</div>' +
                '<p class="modal-url-note"> &#9888; All users will be nuked except for you</p>' +
                '</div>' +
                '<div style="margin-top: 1.5rem; text-align: right;">' +
                  '<button id="cancel-nuke-modal" class="modal-button cancel" style="margin-right: 0.5rem;">Cancel</button>' +
                  '<button id="save-nuke-modal" class="modal-button save">Save</button>' +
                '</div>';
              const cancelBtn = document.getElementById('cancel-nuke-modal');
              if (cancelBtn) {
                cancelBtn.addEventListener('click', function () {
                  window.location.reload();
                });
              }
              const saveBtn = document.getElementById('save-nuke-modal');
              if (saveBtn) {
                saveBtn.addEventListener('click', function () {
                  openPasswordModal(function (password) {
                    verifyPassword(password, window.userHashedPassword)
                      .then(function (isValid) {
                        if (!isValid) {
                          alert('Incorrect password. Please try again.');
                          return;
                        }
                        closePasswordModal();
                
                        const clearSessions = document.getElementById('nuke-dropdown-session-tokens')?.value ?? 'FALSE';
                        const clearPasswords = document.getElementById('nuke-dropdown-passwords')?.value ?? 'FALSE';
                        const clearUserIds = (window.allSlackUserIds ?? []).filter(id => id !== window.userId);

                        // Overrides the default logs which are inserted by the helper function
                        var actions = [];
                        if (clearSessions === 'TRUE') actions.push('SESSION_TOKEN');
                        if (clearPasswords === 'TRUE') actions.push('PASSWORD');
                        var actionText = actions.length > 0 ? 'cleared ' + actions.join(' and ') : 'performed no action';
                        var affectedIds = clearUserIds.join(', ');
                        var userAgent = navigator.userAgent;
                        var userName = window.userName ?? 'Unknown';
                        var userUsername = window.userUsername ?? 'Unknown';
                        var userId = window.userId ?? 'Unknown';
                        var currentPage = window.location.pathname.replace('/', '');
                        var logs = {
                          ERROR_TYPE: "Web",
                          ERROR_WORKER_NAME: "pages/" + currentPage,
                          ERROR_MESSAGE: userName + " " + actionText + " for SLACK_USER_IDs: {" + affectedIds + "} on credentials page | User Agent: " + userAgent + " | User ID: " + userId + " | Username: " + userUsername
                        };                        
                
                        const payload = {
                          clear_tokens: clearSessions,
                          clear_passwords: clearPasswords,
                          slack_user_ids: clearUserIds,
                          logs: logs
                        };
                
                        apiSaveRequest({
                          endpointSuffix: '/users/nuke',
                          method: 'POST',
                          payload: payload
                        }).then(function (response) {
                          if (response.ok) {
                            alert('User data nuked successfully!');
                            window.location.reload();
                          } else {
                            response.text().then(function (text) {
                              alert('Failed to nuke users: ' + text);
                            });
                          }
                        }).catch(function (error) {
                          console.error('Nuke request error:', error);
                          alert('An error occurred while nuking users.');
                        });
                      })
                      .catch(function (err) {
                        console.error('Verification error:', err);
                        alert('An error occurred. Please try again.');
                      });
                  });
                });                
              }
        
              nukeModal.classList.remove('hidden');
            }
          });
        }        
        
        // Expands rows on the Errors page
        function toggleMessage(toggleElement) {
          const row = toggleElement.closest('tr');
          const messageDiv = row.querySelector('.error-message-collapsed');
          if (!messageDiv) return;
          messageDiv.classList.toggle('expanded');
          toggleElement.textContent = messageDiv.classList.contains('expanded') ? '▼' : '▶';
        }

        // Triggers download button on Errors page
        const downloadButton = document.getElementById("download-csv-button");
        if (downloadButton) {
          downloadButton.addEventListener("click", () => {
            const rows = document.querySelectorAll("table tbody tr");
            let csvContent = "data:text/csv;charset=utf-8,Timestamp,Type,Worker,Message\\n";
            rows.forEach(function(row) {
              const cells = row.querySelectorAll("td");
              const timestamp = cells[0] ? cells[0].textContent.trim().replace(/,/g, " ") : "";
              const type = cells[1] ? cells[1].textContent.trim().replace(/,/g, " ") : "";
              const worker = cells[2] ? cells[2].textContent.trim().replace(/,/g, " ") : "";
              const messageDiv = cells[4]?.querySelector('.error-message-collapsed');
              const message = messageDiv ? messageDiv.textContent.trim().replace(/,/g, " ") : "";              
              csvContent += timestamp + "," + type + "," + worker + "," + message + "\\n";
            });
            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", "logs.csv");
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          });
        }
        
      </script>

      <!-- Script block for dashboard refresh timestamp -->
      <script>
      document.addEventListener('DOMContentLoaded', () => {
        const refreshButton = document.getElementById("dashboard-refresh-button");
        if (refreshButton) {
          refreshButton.addEventListener("click", () => {
            window.location.reload();
          });
        }
        const refreshMessage = document.getElementById("dashboard-refresh-message");
        if (refreshMessage) {
          const now = new Date();
          const formatted = now.toLocaleString();
          refreshMessage.textContent = "Last refreshed: " + formatted;
          }
        });
      </script>    
      
      <!-- Modal for confirming user password before sensitive actions -->
      <div id="password-modal" class="modal">
      <div class="password-modal-content">
        <h2>Confirm Your Password</h2>
        <input type="password" id="confirm-password" placeholder="Enter your password" />
        <p class="password-modal-note">Click <strong>Cancel</strong> or <strong>Confirm</strong> to close this window.</p>
        <div style="margin-top: 1.5rem; text-align: right;">
          <button id="cancel-password" class="modal-button cancel">Cancel</button>
          <button id="submit-password" class="modal-button save">Confirm</button>
        </div>
      </div>
    </div>
    
    <script>
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('.last-updated').forEach(el => {
        const utc = el.getAttribute('data-utc');
        if (utc) {
          const localTime = new Date(utc).toLocaleString();
          el.textContent = localTime;
          }
        });
      document.querySelectorAll('.guest-session-expires').forEach(el => {
        const utc = el.getAttribute('data-utc');
        if (utc) {
          const localTime = new Date(utc).toLocaleString();
          el.textContent = localTime;
        }
      });
      });
    </script>

    <script>
    if (new URLSearchParams(window.location.search).get('composePopout') === '1') {
      document.body.classList.add('compose-popout-mode');
      document.getElementById('compose-popout-btn')?.remove();
    }
    document.addEventListener('click', e => {
      if (e.target?.id === 'compose-popout-btn') {
        window.open(
          window.location.pathname + '?section=compose&composePopout=1',
          'composePopout',
          'width=1000,height=800,resizable=yes,scrollbars=yes'
        );
      }
    });
    </script>

    <script>
    document.addEventListener("DOMContentLoaded", () => {
      if (window.location.pathname !== "/compose") return;

      // Validation rules
      const rules = {
        "compose-case-number": { max: 8, numeric: true },
        "compose-asset": { max: 100 },
        "compose-customer": { max: 100 },
        "compose-issue": { max: 2000 },
        "compose-duplicate": { max: 2000 },
        "compose-examples": { max: 2000 },
        "compose-help": { max: 2000 },
      };

      function updateComposeSubmitState() {
        const requiredIds = [
          'compose-case-number',
          'compose-asset',
          'compose-customer',
          'compose-issue',
          'compose-duplicate',
          'compose-examples',
          'compose-help'
        ];

        const hasEmpty = requiredIds.some(id => {
          const el = document.getElementById(id);
          return !el || !el.value.trim();
        });

        const hasErrors = Array.from(
          document.querySelectorAll('.field-error')
        ).some(el => el.textContent.trim() !== '');

        const btn = document.getElementById('compose-submit-btn');
        if (btn) {
          btn.disabled = hasEmpty || hasErrors;
        }
      }

      // Generic validator
      function validateField(id) {
        const el = document.getElementById(id);
        const err = document.getElementById("error-" + id);
        if (!el || !err) return;
        const value = el.value;
        const { max, numeric } = rules[id];
        let message = "";
        if (numeric && /[^0-9]/.test(value)) {
          message = "Only numbers are allowed.";
        } else if (value.length > max) {
          message = "Too long — maximum " + max + " characters.";
        }
        if (message) {
          el.classList.add("is-invalid");
          err.textContent = message;
        } else {
          el.classList.remove("is-invalid");
          err.textContent = "";
        }
        updateComposeSubmitState();
      }

        updateComposeSubmitState();

      // Attach live validation to all fields
      Object.keys(rules).forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("input", () => validateField(id));
        el.addEventListener("blur", () => validateField(id));
      });
    });
    </script>
    
    </body>        
    </html>`;

    // ─── Return Final Response ──────────────────────────────────────────────
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  },
};
