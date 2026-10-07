export default {
  async fetch(request) {
    const css = `

/* ---------- Login page ---------- */
.login-container {
  background: white;
  padding: 40px;
  border-radius: 10px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.1);
  width: 100%;
  max-width: 360px;
  box-sizing: border-box;
  margin: auto;
}

/* ---------- Login page ---------- */
.login-container h1 {
  text-align: center;
  margin-bottom: 20px;
}

/* ---------- Login page ---------- */
.mobile-notice {
  display: none;
  text-align: center;
  font-size: 0.85em;
  color: #667788;
  margin: -8px 0 18px;
}

/* ---------- Login page ---------- */
@media (max-width: 768px) {
  .mobile-notice {
    display: block;
  }
}

/* ---------- Login page ---------- */
.reset-link {
  margin-top: 20px;
  text-align: center;
  font-size: 0.9em;
}

/* ---------- Login page ---------- */
.reset-link a {
  color: #3498db;
  text-decoration: none;
}

/* ---------- Login page ---------- */
.reset-link a:hover {
  text-decoration: underline;
}

/* ---------- Login page ---------- */
.error {
  color: #e74c3c;
  text-align: center;
  margin-bottom: 10px;
  font-size: 0.95em;
}

/* ---------- Login page ---------- */
.lockoutWarning {
  text-align: center;
  margin-bottom: 12px;
  font-size: 0.95em;
  font-style: italic;
}

/* ---------- Login page ---------- */
.login-page .login-button {
  display: block;
  width: 100%;
  padding: 12px;
  background-color: #3498db;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 1em;
  font-weight: bold;
  cursor: pointer;
  text-align: center;
  text-decoration: none;
}

/* ---------- Login page ---------- */
.google-login-button {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: #ffffff;
  color: #3c4043;
  border: 1px solid #dadce0;
  border-radius: 4px;
  padding: 10px 14px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

/* ---------- Login page ---------- */
.google-login-button:hover {
  background: #f8f9fa;
}

/* ---------- Login page ---------- */
.google-g {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ---------- Login page ---------- */
.login-page .login-button.developer {
  background-color: #111;
  color: white;
}

/* ---------- Login page ---------- */
.login-page .login-button.developer:hover {
  background-color: #333;
}

/* ---------- Login page ---------- */
.login-page .login-button.everyone {
  background-color: #e67e22; /* darker than #f39c12 */
  color: white;
}

/* ---------- Login page ---------- */
.login-page .login-button.everyone:hover {
  background-color: #d35400;
}

/* ---------- Login page ---------- */
.login-page .login-button.guest {
  background-color: #27ae60;
  color: white;
}

/* ---------- Login page ---------- */
.login-page .login-button.guest:hover {
  background-color: #219150;
}

/* ---------- Login page ---------- */
.login-page .login-button:hover {
  background-color: #2980b9;
}

/* ---------- Login page ---------- */
.login-button:disabled {
  background-color: #ccc;
  cursor: not-allowed;
  opacity: 0.6;
}

/* ---------- Login page ---------- */
.login-page {
  font-family: 'Segoe UI', sans-serif;
  margin: 0;
  background: #f0f4f8;
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
}

/* ---------- Reset Password page ---------- */
.reset-page-body {
  font-family: 'Segoe UI', sans-serif;
  margin: 0;
  background: #f0f4f8;
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
}

/* ---------- Reset Password page ---------- */
.reset-button {
  display: inline-block;
  padding: 12px;
  background-color: #3498db;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 1em;
  font-weight: bold;
  cursor: pointer;
  text-align: center;
  text-decoration: none;
}

/* ---------- Reset Password page ---------- */
.reset-button:hover {
  background-color: #2980b9;
}

/* ---------- Reset Password page ---------- */
.reset-button[disabled],
input[disabled] {
  background-color: #ccc;
  cursor: not-allowed;
}

/* ---------- All internal pages ---------- */
body {
  font-family: 'Segoe UI', sans-serif;
  margin: 0;
  background: #f0f4f8;
}

/* ---------- All internal pages ---------- */
nav {
  position: fixed;
  top: 0;
  left: 0;
  width: 170px;
  height: 100vh;
  background-color: #1f2937;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 1.5rem 1rem;
  z-index: 1000;
}

/* ---------- All internal pages ---------- */
.logo {
  width: 82%;
  height: 82%;
  object-fit: contain;
  margin: 0;
}

/* ---------- All internal pages ---------- */
.user-info {
  padding: 0 0.5rem 1.5rem 0.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.15);
  color: white;
}

/* ---------- All internal pages ---------- */
.user-name {
  font-size: 1rem;
  font-weight: bold;
  margin-bottom: 0.3rem;
}

/* ---------- All internal pages ---------- */
.user-role {
  font-size: 0.8rem;
  color: #9ca3af;
  margin-bottom: 0.2rem;
}

/* ---------- All internal pages ---------- */
.user-username {
  font-size: 0.75rem;
  color: #9ca3af;
}

/* ---------- All internal pages ---------- */
.nav-links {
  display: flex;
  flex-direction: column;
  margin-top: 1.5rem;
  gap: 0.3rem;
}

/* ---------- All internal pages ---------- */
.nav-links a {
  display: block;
  color: #d1d5db;
  text-decoration: none;
  padding: 0.7rem 0.8rem;
  border-radius: 6px;
  font-weight: 600;
  font-size: 0.9rem;
  margin: 0;
  transition: background-color 0.15s ease, color 0.15s ease;
}

/* ---------- All internal pages ---------- */
.nav-links a:hover {
  background-color: rgba(255, 255, 255, 0.08);
  color: white;
  text-decoration: none;
}

/* ---------- All internal pages ---------- */
.user-name {
  font-weight: bold;
}

/* ---------- All internal pages ---------- */
.logout-button {
  margin-top: 0.5rem;
}

/* ---------- All internal pages ---------- */
.logout-button a {
  background-color: #111;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
  padding: 0.4rem 0.8rem;
  font-size: 0.8rem;
}

/* ---------- All internal pages ---------- */
.logout-button a:hover {
  background-color: #444;
}

/* ---------- All internal pages ---------- */
.mt-2rem {
  margin-top: 2rem;
}

/* ---------- All internal pages ---------- */
.category-anchor {
  scroll-margin-top: 1.2rem;
}

/* ---------- All internal pages ---------- */
.last-category {
  min-height: calc(100vh - 8rem);
}

/* ---------- Guest Demo Mode ---------- */
.demo-mode-banner {
  margin-bottom: 1.5rem;
  padding: 0.85rem 1rem;
  background-color: #fff4df;
  border: 1px solid #eda260;
  border-radius: 6px;
  color: #6b4a17;
  font-size: 0.95rem;
  font-weight: 600;
  text-align: center;
}

/* ---------- Possibly not used ---------- */
.section-divider {
  margin: 1.5rem 0;
  border-top: 2px solid #ccc;
}

/* ---------- Dashboard page ---------- */
.dashboard-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-top: 1rem;
}

/* ---------- Dashboard page ---------- */
.dashboard-action-container {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 1rem;
  margin: 2rem 0 0 0;
}

/* ---------- Dashboard page ---------- */
.dashboard-row {
  display: grid;
grid-template-columns:
  minmax(75px, 0.8fr)   /* Case */
  minmax(75px, 0.8fr)   /* Asset */
  minmax(80px, 1fr)     /* Rep */
  minmax(80px, 1fr)     /* Helper */
  minmax(85px, 0.9fr)   /* Status */
  minmax(75px, 0.8fr)   /* Slack URL */
  minmax(105px, 1fr)    /* Bypass SFDC */
  minmax(145px, 1.4fr)  /* Locked Time */
  minmax(145px, 1.4fr)  /* Last Updated */
  auto;                  /* Edit */
  gap: 0.5rem;
  padding: 0.75rem;
  background-color: #f9f9f9;
  border-radius: 6px;
  font-size: 0.9rem;
  line-height: 1.2;
  border: 1px solid #ccc;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

/* ---------- Dashboard page ---------- */
.dashboard-row div {
  display: flex;
  flex-direction: column;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- Dashboard page ---------- */
.dashboard-row a {
  color: #3f6f9f;
  text-decoration: underline;
  word-break: break-word;
}

/* ---------- Dashboard page ---------- */
.dashboard-row.status-relayed {
  background-color: #ffe08a;
}
.dashboard-row.status-new {
  background-color: #c8f2dc;
}
.dashboard-row.status-in-progress {
  background-color: #b9dcff;
}
.dashboard-row.status-closed {
  background-color: #dddddd;
}

/* ---------- Dashboard page ---------- */
.dashboard-row:hover {
  transform: translateY(-4px);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.2);
  border-color: #3498db;
}

/* ---------- Dashboard, Help, Errors, & Auto Responder pages ---------- */

input[type=number]::-webkit-inner-spin-button,
input[type=number]::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

/* ---------- Dashboard, Help, Errors, & Auto Responder pages ---------- */
input[type=number] {
  -moz-appearance: textfield;
}

/* ---------- Dashboard page ---------- */
.no-results {
  padding: 1rem;
  color: #666;
  font-style: italic;
  text-align: center;
}

/* ---------- Dashboard page ---------- */
.dashboard-row.settings-row {
  display: grid;
  grid-template-columns: 1fr 1.5fr 3fr auto;
  gap: 1rem;
  padding: 0.75rem;
  background-color: #f9f9f9;
  border-radius: 6px;
  font-size: 0.9rem;
  line-height: 1.2;
  border: 1px solid #ccc;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

/* ---------- Dashboard page ---------- */
.dashboard-row.settings-row div {
  display: flex;
  flex-direction: column;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- Dashboard page ---------- */
.dashboard-row.settings-row div:nth-child(2),
.dashboard-row.settings-row div:nth-child(3) {
  white-space: normal;
  overflow: visible;
  text-overflow: unset;
  word-break: break-word;
}

/* ---------- Credentials page ---------- */
.dropdown-modal input,
.dropdown-modal select {
  display: block;
  width: 100%;
  padding: 0.5rem;
  margin-top: 0.25rem;
  box-sizing: border-box;
  text-align: left;
  font-size: 0.95rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}

/* ---------- Credentials page ---------- */
.dropdown-modal input:focus,
.dropdown-modal select:focus {
  border-color: #3498db;
  outline: none;
  box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.2);
}

/* ---------- Dashboard, Settings, & Credentials pages ---------- */
.tooltip-icon {
  margin-left: 4px;
  cursor: help;
  font-size: 1.2em;
  vertical-align: middle;
  font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
  font-weight: normal;
  color: inherit;
}

/* ---------- Credentials page ---------- */
#credentials-button-container {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 0rem;
  margin-top: 2rem;
  margin-bottom: 2rem;
}

/* ---------- Auto Responder page ---------- */
.switch {
  position: relative;
  display: inline-block;
  width: 60px;
  height: 34px;
  margin-right: 1rem;
}

/* ---------- Auto Responder page ---------- */
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

/* ---------- Auto Responder page ---------- */
.slider {
  position: absolute;
  cursor: pointer;
  top: 0; left: 0;
  right: 0; bottom: 0;
  background-color: #ccc;
  transition: .4s;
  border-radius: 34px;
}

/* ---------- Auto Responder page ---------- */
.slider:before {
  position: absolute;
  content: "";
  height: 26px; width: 26px;
  left: 4px; bottom: 4px;
  background-color: white;
  transition: .4s;
  border-radius: 50%;
}

/* ---------- Auto Responder page ---------- */
input:checked + .slider {
  background-color: #3498db;
}

/* ---------- Auto Responder page ---------- */
input:checked + .slider:before {
  transform: translateX(26px);
}

/* ---------- Auto Responder, Users, & Messages pages ---------- */
.card-container {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-top: 1rem;
  justify-content: flex-start;
}

/* ---------- Auto Responder, Users, & Messages pages ---------- */
.setting-card {
  background: #ffffff;
  border: 1px solid #ccc;
  border-radius: 10px;
  padding: 1rem;
  width: calc(25% - 0.75rem);
  min-width: 250px;
  max-width: 360px;
  min-height: 190px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  overflow: hidden;
}

/* ---------- Auto Responder, Users, & Messages pages ---------- */
.setting-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.2);
  border-color: #3498db;
}

/* ---------- Users page ---------- */
.selected-indicator.role-developer {
  background-color: #111;
}

/* ---------- Users page ---------- */
.selected-indicator.role-manager {
  background-color: #483D8B;
}

/* ---------- Users page ---------- */
.selected-indicator.role-advanced-support {
  background-color: #4682B4;
}

/* ---------- Users page ---------- */
.selected-indicator.role-support {
  background-color: #ADD8E6;
  color: #000;
}

/* ---------- Users page ---------- */
.selected-indicator.role-guest {
  background-color: #eda260ff;
  color: #fff;
}

/* ---------- Users page ---------- */
.selected-indicator.role-inactive {
  background-color: #D3D3D3;
  color: #000;
}

/* ---------- Users page ---------- */
.lockout-message {
  color: #e74c3c;
  font-size: 0.8rem;
  font-weight: bold;
  text-align: left;
  margin-top: 0.5rem;
}

/* ---------- Users page ---------- */
.reset-attempt-link {
  font-size: 0.8rem;
  font-weight: normal;
  color: #3f6f9f;
  cursor: pointer;
}

/* ---------- Auto Responder, Users, & Messages pages ---------- */
.card-content > div {
  margin-bottom: 0.5rem;
  font-size: 0.9rem;
}

/* ---------- Auto Responder, Users, & Messages pages ---------- */
.card-value > div {
  margin-bottom: 0.4rem;
}

/* ---------- Auto Responder, Users, & Messages pages ---------- */
.card-type {
  font-weight: bold;
  font-size: 1.2rem;
  color: #333;
  padding-bottom: 0.6rem;
  border-bottom: 3px solid #3498db;
  margin-bottom: 0.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* ---------- Auto Responder & Users pages ---------- */
.selected-indicator {
  font-size: 0.85rem;
  color: #ffffff;
  background-color: #3498db;
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  margin-left: 1rem;
  line-height: 1.2;
  display: flex;
  align-items: center;
  height: 100%;
}

/* ---------- Auto Responder, Users, & Messages pages ---------- */
.card-value {
  font-size: 0.9rem;
  color: #333;
  word-break: break-word;
  overflow-wrap: anywhere;
}

/* ---------- Auto Responder, Users, & Messages pages ---------- */
.card-footer {
  text-align: right;
  margin-top: auto;
  position: relative;
  min-height: 1.2rem;
}

/* ---------- Users page ---------- */
.setting-card .card-footer .edit-link {
  position: absolute;
  right: 0;
  bottom: 0;
}

/* ---------- All internal pages ---------- */
.edit-link {
  font-size: 0.85rem;
  color: #3f6f9f;
  text-decoration: underline;
  cursor: pointer;
}

/* ---------- All internal pages ---------- */
.col-edit {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  height: 75%;
}

/* ---------- All internal pages ---------- */
.col-edit a {
  white-space: nowrap;
}

/* ---------- Credentials, Dashboard, Users, & Help pages (modals) ---------- */
.modal-label {
  display: block;
  font-weight: 600;
  margin-bottom: 0.25rem;
  font-size: 0.85rem;
  text-align: left;
  align-self: flex-start;
}

/* ---------- Credentials, Dashboard, Users, & Help pages (modals) ---------- */
.modal-url-wrapper {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.25rem;
  margin-bottom: 0.25rem;
}

/* ---------- Credentials page ---------- */
#salesforce-url-field {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 0.9rem;
  background: #f9f9f9;
  color: #333;
}

/* ---------- Credentials page ---------- */
.modal-url-note {
  font-size: 0.8rem;
  color: #555;
  margin: 0.15rem 0 0.5rem 0;
}

/* ---------- Credentials page ---------- */
#salesforce-username-field {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 0.9rem;
  background: #f9f9f9;
  color: #333;
}

/* ---------- Credentials page ---------- */
#salesforce-password-field {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 0.9rem;
  background: #f9f9f9;
  color: #333;
}

/* ---------- All internal pages ---------- */
.container {
  margin-left: 210px;
  padding: 1rem;
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
  box-sizing: border-box;
}

/* ---------- Credentials page ---------- */
.dropdown-modal {
  position: absolute;
  min-width: 250px;
  background: white;
  border: 1px solid #ccc;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  padding: 1rem;
  z-index: 1000;
  animation: fadeDown 0.25s ease-out;
}

/* ---------- Credentials, Users, Messages & Help pages (modals) ---------- */
.hidden {
  display: none;
}

/* ---------- Credentials page ---------- */
@keyframes fadeDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ---------- All internal pages ---------- */
.card {
  background: white;
  padding: 1rem 3rem 1rem 2rem;
  border-radius: 10px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.1);
  width: 90vw;
  height: 92vh;
  box-sizing: border-box;
  overflow: auto;
}

/* ---------- All internal pages ---------- */
.nav-links a.active {
  background-color: #3498db;
  color: white;
}

/* ---------- All internal pages ---------- */
.nav-submenu {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  margin: 0.25rem 0 0.5rem 0.75rem;
}

/* ---------- All internal pages ---------- */
.nav-links .nav-sub-link {
  padding: 0.35rem 0.6rem;
  font-size: 0.8rem;
  font-weight: 500;
  color: #9ca3af;
  border-radius: 4px;
}

/* ---------- All internal pages ---------- */
.nav-footer {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
}

/* ---------- All internal pages ---------- */
.nav-avatar {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background-color: white;
  border: 2px solid #3498db;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

/* ---------- Errors page ---------- */
table {
  border-radius: 10px;
  overflow: hidden;
  border-collapse: separate;
  border-spacing: 0;
}

/* ---------- Errors page ---------- */
.download-csv-button {
  background-color: #555555;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
  font-weight: bold;
  cursor: pointer;
  transition: background-color 0.3s ease;
}

.download-csv-button:hover {
  background-color: #333333;
}

/* ---------- All internal pages ---------- */
h1 {
  font-size: 1.5rem;
}

/* ---------- Dashboard, Settings & Credentials pages ---------- */
.edit-cell {
  text-align: center;
}

/* ---------- All internal pages ---------- */
.modal {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.5);
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

/* ---------- All internal pages ---------- */
.modal-content {
  background: white;
  padding: 2rem;
  border-radius: 10px;
  max-width: 700px;
  width: 95%;
  max-height: 100vh;
  overflow-y: auto;
  box-sizing: border-box;
}

/* ---------- Credentials page ---------- */
.input-copy-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

/* ---------- Credentials page ---------- */
.input-copy-row input {
  flex: 1;
}

/* ---------- All internal pages ---------- */
.modal-content label {
  display: block;
  margin-top: 1rem;
  font-weight: bold;
  text-align: left;
}

/* ---------- All internal pages ---------- */
.modal-content select,
.modal-content input,
.modal-content input[readonly] {
  height: 2.5rem;
}

/* ---------- All internal pages ---------- */
.modal-content input,
.modal-content textarea {
  display: block;
  width: 100%;
  padding: 0.5rem;
  margin-top: 0.25rem;
  box-sizing: border-box;
  text-align: left;
  font-size: 0.95rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
  resize: vertical;
}

/* ---------- All internal pages ---------- */
.modal-content input:focus,
.modal-content textarea:focus {
  border-color: #3498db;
  outline: none;
  box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.2);
}

/* ---------- All internal pages ---------- */
.modal-content select {
  display: block;
  width: 100%;
  padding: 0.5rem;
  margin-top: 0.25rem;
  box-sizing: border-box;
  text-align: left;
  font-size: 0.95rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}

/* ---------- All internal pages ---------- */
.modal-content select:focus {
  border-color: #3498db;
  outline: none;
  box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.2);
}

/* ---------- All internal pages ---------- */
input[readonly] {
  background-color: #f0f0f0;
  color: #555;
  border: 1px solid #ccc;
}

/* ---------- All internal pages ---------- */
.required-asterisk {
  color: red;
  margin-left: 2px;
}

/* ---------- All internal pages ---------- */
.modal-button {
  padding: 0.5rem 1rem;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  transition: background-color 0.3s ease;
}

/* ---------- Credentials page ---------- */
.masked-button.off {
  background-color: #e74c3c;
}

/* ---------- Credentials page ---------- */
.masked-button.off:hover {
  background-color: #c0392b;
}

/* ---------- Credentials page ---------- */
.masked-button:disabled {
  background-color: #ccc !important;
  color: #777 !important;
  cursor: not-allowed;
  opacity: 0.6;
}

/* ---------- Credentials page ---------- */
.masked-button.nuke-button {
  background-color: #f39c12;
  color: #000000;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: background-color 0.3s ease;
  padding: 0.5rem 1rem;
}

.masked-button.nuke-button:hover {
  background-color: #e67e22;
}

/* ---------- Users page ---------- */
.users-action-container {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 1rem;
}

/* ---------- Users page ---------- */
#add-user-button {
  background-color: #3498db;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 1rem;
  margin: 2rem 0 0 0;
}

/* ---------- Users page ---------- */
#add-user-button:hover {
  background-color: #2980b9;
}

/* ---------- Users page ---------- */
.user-search-box {
  padding: 0.5rem 1rem;
  font-size: 0.95rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  margin-right: 1rem;
  max-width: 250px;
  height: 2.1rem;
  box-sizing: border-box;
  align-self: flex-end;
}

/* ---------- Auto Responder page ---------- */
.auto-responder-toggle-container {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 1rem;
  margin: 2rem 0 0 0;
}

/* ---------- Auto Responder page ---------- */
.auto-responder-status {
  align-self: center;
  margin-left: 1rem;
  font-weight: bold;
  font-size: 0.95rem;
  color: #555;
}

/* ---------- Auto Responder page ---------- */
.auto-responder-status.on {
  color: #3498db;
}

/* ---------- Auto Responder page ---------- */
.auto-responder-status.off {
  color: #6b7280;
}

/* ---------- All internal pages ---------- */
.modal-button.cancel {
  background-color: #95a5a6;
  margin-right: 0.5rem;
}

/* ---------- All internal pages ---------- */
.modal-button.cancel:hover {
  background-color: #7f8c8d;
}

/* ---------- All internal pages ---------- */
.modal-button.save {
  background-color: #3498db;
}

/* ---------- All internal pages ---------- */  
.modal-button.save:hover {
  background-color: #2980b9;
}

/* ---------- All internal pages ---------- */
.modal-button.delete {
  background-color: #d9534f;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
  border-radius: 4px;
  cursor: pointer;
}

/* ---------- All internal pages ---------- */
.modal-button.delete:hover {
  background-color: #c9302c;
}

/* ---------- Help page ---------- */
.add-new-button-container {
margin-top: 1.5rem;
text-align: right;
margin-right: 0.5rem
}

/* ---------- Help page ---------- */
.disabled-add-help-button {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---------- Credentials page ---------- */
.masked-button {
  padding: 0.5rem 1rem;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: bold;
  transition: background-color 0.3s ease;
}

/* ---------- Users & credentials pages ---------- */
.masked-button.add {
  background-color: #27ae60;
}

/* ---------- Users & credentials pages ---------- */
.masked-button.add:hover {
  background-color: #219150;
}

/* ---------- Credentials pages ---------- */
.masked-button.rotate {
  background-color: #9b59b6;
}

/* ---------- Credentials page ---------- */
.masked-button.rotate:hover {
  background-color: #8e44ad;
}

/* ---------- Credentials page ---------- */
.masked-button.reveal {
  background-color: #7e57c2;
}

/* ---------- Credentials page ---------- */
.masked-button.reveal:hover {
  background-color: #6a1b9a;
}

/* ---------- Credentials page ---------- */
.masked-button.salesforce {
  background-color: #3498db;
}

/* ---------- Credentials page ---------- */
.masked-button.salesforce:hover {
  background-color: #2980b9;
}

/* ---------- Credentials page ---------- */
.salesforce-wrapper-vertical {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

/* ---------- Credentials page ---------- */
.salesforce-wrapper-horizontal {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* ---------- Credentials page ---------- */
.copy-button {
  background-color: #ccc;
  color: #000;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 0.9rem;
  font-family: inherit;
  font-weight: 500;
  padding: 0.5rem 1rem;
  height: 2.2rem;
  line-height: 1;
  min-width: 100px;
  transition: background-color 0.3s ease;
}

/* ---------- Credentials page ---------- */
.copy-button:hover {
  background-color: #999;
}

/* ---------- Credentials page ---------- */
.password-modal-content {
  background: white;
  padding: 2rem;
  border-radius: 10px;
  max-width: 400px;
  width: 95%;
  box-sizing: border-box;
}

/* ---------- Credentials page ---------- */
.password-modal-content input {
  display: block;
  width: 100%;
  padding: 0.5rem;
  margin-top: 0.25rem;
  box-sizing: border-box;
  text-align: left;
  font-size: 0.95rem;
}

/* ---------- Credentials page ---------- */
.password-modal-note {
  font-size: 0.85rem;
  color: #666;
  margin-top: 0.5rem;
}

/* ---------- Credentials page ---------- */
#add-masked-modal input,
#add-masked-modal select {
  height: auto;
  padding: 0.5rem;
  font-size: 0.9rem;
  border-radius: 4px;
}

/* ---------- Credentials page ---------- */
input[type="text"],
input[type="password"] {
  padding: 12px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 1em;
  box-sizing: border-box;
  width: 100%;
}

/* ---------- Compose page ---------- */
.compose-row-inline input[type="text"] {
  width: 30%;
  min-width: 30%;
}
/* ---------- Help & Errors pages ---------- */
form {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 1rem;
}

/* ---------- Help page ---------- */
.top-section-box {
  background-color: white;
  padding: 1rem 1.5rem;

}

/* ---------- Help page ---------- */
.top-section-box.toc {
  margin-top: 0rem;
  margin-bottom: 0rem;
  padding-top: 0.25rem;
  padding-bottom: 0.5rem;
}

/* ---------- Compose page ---------- */
.compose-form {
  display: flex;
  flex-direction: column;
}

/* ---------- Compose page ---------- */
body.compose-popout-mode .compose-form {
  transform: none;
  transform-origin: top center;
  padding-top: 1.5rem;
}

/* ---------- Compose page ---------- */
#compose-popout-btn {
  display: block;
  margin-left: auto;
  width: 34px;
  height: 34px;
  padding: 0;
  background-color: #3498db;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
}

/* --- Compose popout mode --- */
html:has(body) {
}

/* --- Compose popout mode --- */
body.compose-popout-mode .top-nav,
body.compose-popout-mode nav,
body.compose-popout-mode .container > .card:not(:has(.compose-form)) {
  display: none !important;
}

/* --- Compose popout mode --- */
body.compose-popout-mode .container {
  margin-left: 0;
}

/* --- Compose popout mode --- */
body.compose-popout-mode .compose-form {
  display: flex;
}

/* ---------- Compose page ---------- */
.compose-row-inline {
  display: grid;
  grid-template-columns: 125px minmax(400px, 1fr);
  align-items: center;
  column-gap: 0.5rem;
}

/* ---------- Compose page ---------- */
.compose-row {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

/* ---------- Compose page ---------- */
.compose-label {
  margin: 0;
  text-align: left;
  white-space: normal;
}

/* ---------- Compose page ---------- */
.compose-input,
.compose-textarea {
  padding: 0.5rem;
  box-sizing: border-box;
  text-align: left;
  font-size: 0.95rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}

/* ---------- Compose page ---------- */
.compose-input {
  width: 100%;
  min-width: 0;
  height: 2.5rem;
}

/* ---------- Compose page ---------- */
.compose-textarea {
  width: 100%;
  resize: vertical;
}

/* ---------- Compose page ---------- */
.compose-input:focus,
.compose-textarea:focus {
  border-color: #3498db;
  outline: none;
  box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.2);
}

/* ---------- Compose page ---------- */
.compose-note {
  margin: 0.25rem 0;
}

/* ---------- Compose page ---------- */
.compose-input.is-invalid,
.compose-textarea.is-invalid {
  border-color: #e74c3c !important;
  box-shadow: 0 0 0 2px rgba(231, 76, 60, 0.15) !important;
}

/* ---------- Compose page ---------- */
.field-error {
  margin-top: 0.25rem;
  font-size: 0.85rem;
  color: #e74c3c;
  text-align: left;
}

/* ---------- Compose page ---------- */
.compose-row-inline .field-error {
  grid-column: 2 / 3;
}

/* ---------- Compose page ---------- */
#compose-submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---------- Messages page ---------- */
.messages-top-section {
  background-color: white;
  padding: 1rem 1.5rem;
  margin-top: 1rem;
  margin-bottom: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0rem;
}

/* ---------- Messages page ---------- */
.messages-action-bar {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  width: 100%;
  margin-top: 1rem;
  margin-bottom: 1.5rem;
}

/* ---------- Messages page ---------- */
.messages-action-bar .filter-form {
  width: 100%;
  max-width: 1000px;
  margin: 0 auto;
}

/* ---------- Messages page ---------- */
.messages-search-input {
  flex: 1;
  min-width: 0px;
  max-width: 1400px;
  font-size: 0.95rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  box-sizing: border-box;
}

/* ---------- Messages page ---------- */
.messages-top-section label[for="slack-url-input"] {
  margin-left: 0.25rem;
  margin-bottom: 0.5rem;
  display: inline-block;
  font-size: 0.9rem;
}

/* ---------- Messages page ---------- */
.messages-search-button {
  background-color: #3498db;
  color: white;
  border: none;
  padding: 0.5rem 1.2rem !important;
  font-size: 0.9rem !important;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.3s ease;
}

/* ---------- Messages page ---------- */
.messages-search-button:hover {
  background-color: #2980b9;
}

/* ---------- Messages page ---------- */
.messages-action-bar .messages-filter-field {
  width: 100%;
}

/* ---------- Messages page ---------- */
.slack-message-card {
  background: #ffffff;
  border: 1px solid #ccc;
  border-radius: 10px;
  padding: 0.9rem;
  width: 80%;
  min-width: 250px;
  max-width: 1000px;
  height: 60%;
  min-width: 250px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  font-size: 1rem;
}

/* ---------- Messages page ---------- */
.slack-message-card .card-value > div {
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
}

/* ---------- Messages page ---------- */
.message-subvalue {
  display: block;
  margin-top: 0.25rem;
  white-space: pre-wrap;
}

/* ---------- Messages page ---------- */
.erase-preview-field input[type="checkbox"]:focus {
  border-color: transparent !important;
  outline: none !important;
  box-shadow: none !important;
}

/* ---------- Messages page ---------- */
.erase-preview-field {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
  justify-content: flex-start;
  width: fit-content;
  margin-top: 0.75rem; /* align vertically with above fields */
}

/* ---------- Messages page ---------- */
.erase-preview-field label {
  margin: 0;
}

/* ---------- Messages page ---------- */
.erase-preview-field input[type="checkbox"] {
  transform: scale(1.1);
  margin-right: 0.4rem;
  order: -1;
}

/* ---------- Errors & Messages pages ---------- */
.filter-field {
  margin-right: 1rem;
  margin-bottom: 0rem;
  display: inline-block;
  width: 20%;
}

/* ---------- Errors page ---------- */
.filter-form-wrapper {
  margin-top: 0.5rem;
}

/* ---------- Errors page ---------- */
.filter-form label {
  display: flex;
  flex-direction: column;
  font-weight: bold;
  font-size: 0.85rem;
  color: #333;
  gap: 0.40rem;
}

/* ---------- Errors page ---------- */
.filter-form select {
  padding: 0.35rem 0.5rem;
  font-size: 0.85rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}

/* ---------- Errors page ---------- */
.filter-form select:focus {
  border-color: #3498db;
  box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.2);
  outline: none;
}

/* ---------- Errors page ---------- */
.filter-buttons {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-start;
  align-items: flex-end;
  margin-bottom: 0.20rem;
}

/* ---------- Errors page ---------- */
.filter-form button {
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  background-color: #3498db;
  color: white;
  transition: background-color 0.3s ease;
  white-space: nowrap;
  flex-shrink: 0;
  max-width: 120px;
  width: fit-content  
}

/* ---------- Errors page ---------- */
.filter-form button:hover {
  background-color: #2980b9;
}

/* ---------- Errors page ---------- */
.error-message-collapsed {
  max-height: 3em;
  overflow: hidden;
  position: relative;
  cursor: pointer;
  padding-right: 5rem;
}

/* ---------- Errors page ---------- */
.error-message-collapsed.expanded {
  max-height: none;
  white-space: pre-wrap;
  background: none;
  padding-bottom: 1rem;
  min-height: 25px;
}

/* ---------- Errors page ---------- */
.expand-toggle {
  cursor: pointer;
  font-size: 1.2rem;
  color: #3498db;
  font-weight: bold;
  user-select: none;
}

/* ---------- Errors page ---------- */
.expand-toggle:hover {
  color: #2980b9;
}

/* ---------- Help page ---------- */
.help-cards {
  column-count: 1;
  column-gap: 2rem;
}

/* ---------- Help page ---------- */
.help-card {
  background: #ffffff;
  border: 1px solid #ccc;
  border-radius: 10px;
  padding: 1rem;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  break-inside: avoid;
  margin-bottom: 2rem;
}

/* ---------- Help page ---------- */
.help-category-heading {
  font-size: 1.3rem;
  font-weight: bold;
  color: #2c3e50;
  margin-bottom: 0.5rem;
  margin-top: 0.5rem;
  border-bottom: 3px solid #7299b3;
  padding-bottom: 0.5rem;
  scroll-margin-top: 3.5rem;
}

/* ---------- Help page ---------- */
.help-subentry {
  border-bottom: 1px solid #eee;
  padding-bottom: 1rem;
  margin-bottom: 0.5rem;
}

/* ---------- Help page ---------- */
.help-subentry:last-child {
  border-bottom: none;
  margin-bottom: 0.5rem;
  padding-bottom: 0;
}

/* ---------- Help page ---------- */
.help-subcategory {
  font-size: 1.1rem;
  font-weight: bold;
  color: #333;
  margin-bottom: 0rem;
}

/* ---------- Help page ---------- */
.help-description {
  font-size: 0.95rem;
  color: #555;
  margin-bottom: 0.5rem;
  white-space: pre-wrap;
}

/* ---------- Help page ---------- */
.help-actions {
  text-align: right;
}

/* ---------- Help page ---------- */
.help-actions .edit-link {
  font-size: 0.85rem;
  color: #3f6f9f;
  text-decoration: underline;
  cursor: pointer;
}

/* ---------- Help page ---------- */
.help-action-container {
  display: flex;
  flex-wrap: nowrap;
  gap: 1rem;
  align-items: center;
}

/* ---------- Help page ---------- */
.help-layout {
  display: flex;
  flex-direction: row;
  gap: 2rem;
  align-items: flex-start;
}

/* ---------- Help page ---------- */
.help-sidebar {
  display: inline-block;
  background: #ffffff;
  border: 1px solid #ccc;
  border-radius: 10px;
  padding: 1rem 2rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
  position: sticky;
  top: 1rem;
  height: fit-content;
  width: 30%;
  text-align: left;
}

/* ---------- Help page ---------- */
.help-sidebar ul {
  list-style: none;
  margin: 0;
}

/* ---------- Help page ---------- */
.help-sidebar li {
  margin-bottom: 0.5rem;
}

/* ---------- Help page ---------- */
.help-sidebar a {
  color: #3498db;
  text-decoration: none;
  font-weight: 500;
}

/* ---------- Help page ---------- */
.help-sidebar a:hover {
  text-decoration: underline;
}

/* ---------- Help page ---------- */
.help-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}

/* ---------- Help page ---------- */
.help-content-wrapper {
  display: flex;
  flex-direction: row;
  gap: 2rem;
  align-items: flex-start;
  margin-top: 2rem;
}

/* ---------- Help page ---------- */
.help-action-bar {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  width: 100%;
  margin-top: 2rem;
  margin-bottom: 2rem;
  position: relative;
}

/* ---------- Help page ---------- */
.help-search-input {
  flex: 1;
  min-width: 350px;
  max-width: 1000px;
  padding: 0.6rem 1rem;
  font-size: 1rem;
  border: 1px solid #ccc;
  border-radius: 6px;
  box-sizing: border-box;
  width: 100%;
}

/* ---------- Help page ---------- */
.help-search-wrapper {
  position: relative;
  width: 100%;
  max-width: 1000px;
  flex: 1;
}

/* ---------- Help page ---------- */
.help-search-suggestions {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: white;
  border: 1px solid #ccc;
  max-height: 200px;
  overflow-y: auto;
  width: 100%;
  z-index: 1000;
  list-style: none;
  padding: 0;
  margin: 0;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
  box-sizing: border-box;
}

/* ---------- Help page ---------- */
.highlight {
  background-color: #fff3b0;
  font-weight: bold;
}

/* ---------- Help page ---------- */
.help-search-suggestions li {
  padding: 0.5rem;
  cursor: pointer;
  border-bottom: 1px solid #eee;
}

/* ---------- Help page ---------- */
.help-search-suggestions li:hover {
  background-color: #f0f0f0;
}

/* ---------- Help page ---------- */
.help-add-button {
  background-color: #3498db;
  color: white;
  border: none;
  padding: 0.5rem 1.2rem;
  font-size: 0.9rem;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.3s ease;
}

/* ---------- Help page ---------- */
.help-add-button:hover {
  background-color: #2980b9;
}

/* ---------- Callback page ---------- */
.callback-page-body {
  font-family: Arial, sans-serif;
  background-color: #f4f4f4;
  margin: 0;
  padding: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
}

/* ---------- Callback page ---------- */
.callback-page-card {
  background-color: white;
  padding: 2rem;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  max-width: 400px;
  text-align: center;
}

/* ---------- Callback page ---------- */
.callback-page-logo {
  max-width: 150px;
  margin-bottom: 1rem;
}

/* ---------- Callback page ---------- */
.callback-page-title {
  color: #333;
  margin-bottom: 1rem;
}

/* ---------- Callback page ---------- */
.callback-page-message {
  color: #555;
}

/* ---------- Help page ---------- */
@media (max-width: 768px) {
  .help-cards {
    column-count: 1;
  }
}

/* ---------- Users, Auto Responder, Help & Messages pages ---------- */
@media (max-width: 768px) {
  .setting-card {
    width: 100%;
  }
}

/* ---------- Dashboard page ---------- */
@media (max-width: 1400px) {

  .dashboard-container {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .dashboard-row {
    display: flex;
    flex-direction: column;
    width: calc(33.333% - 0.67rem);
    min-width: 280px;
    box-sizing: border-box;
  }

  .dashboard-row > div {
    flex-direction: row;
    gap: 0.35rem;
    white-space: normal;
    overflow: visible;
  }

  .dashboard-row .col-bypass,
  .dashboard-row .col-locked {
    display: none;
  }

}

/* ---------- Spotlight Tour ---------- */
.spotlight-tour-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 1900;
  background: transparent;
  cursor: default;
}

/* ---------- Spotlight Tour ---------- */
.spotlight-tour-focus {
  display: none;
  position: fixed;
  z-index: 1950;
  border-radius: 10px;
  box-shadow:
    0 0 0 4px rgba(255, 255, 255, 0.95),
    0 0 0 9999px rgba(15, 23, 42, 0.58);
  pointer-events: none;
  transition:
    top 0.28s ease,
    left 0.28s ease,
    width 0.28s ease,
    height 0.28s ease;
}

/* ---------- Spotlight Tour ---------- */
.spotlight-tour-message {
  display: none;
  position: fixed;
  z-index: 2050;
  width: 300px;
  padding: 1rem;
  background: #f6f9fc;
  border: 2px solid #667788;
  border-radius: 14px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16);
  box-sizing: border-box;
}

/* ---------- Spotlight Tour ---------- */
.spotlight-tour-text {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.45;
  color: #333333;
}

/* ---------- Spotlight Tour ---------- */
.spotlight-tour-next {
  display: block;
  margin: 0.85rem 0 0 auto;
  border: 0;
  border-radius: 4px;
  padding: 0.45rem 0.85rem;
  background: #3498db;
  color: #ffffff;
  font-size: 0.85rem;
  cursor: pointer;
}

/* ---------- Spotlight Tour ---------- */
.spotlight-tour-end {
  display: none;
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 2200;
  padding: 0.55rem 1rem;
  border: 1px solid rgba(255, 255, 255, 0.7);
  border-radius: 20px;
  background: rgba(31, 41, 55, 0.92);
  color: #ffffff;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  transition: background 0.2s ease, transform 0.2s ease;
}

/* ---------- Spotlight Tour ---------- */
.spotlight-tour-end:hover {
  background: #374151;
  transform: translateY(-1px);
}
    `;
    return new Response(css, {
      headers: { 'Content-Type': 'text/css' },
    });
  },
};
